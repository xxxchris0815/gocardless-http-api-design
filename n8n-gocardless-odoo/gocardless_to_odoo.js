/**
 * GoCardless Webhook → Odoo Bankauszug (n8n Code-Node, JavaScript)
 *
 * Vereinheitlicht die drei Zapier-Scripts (payment confirmed / failed / payout).
 *
 * n8n-Setup:
 *  1. Webhook-Node (POST), Response: Immediately
 *  2. Set-Node mit den Config-Feldern unten, "Include Other Input Fields" = an
 *  3. Dieser Code-Node: Mode = "Run Once for All Items", Language = JavaScript
 *
 * Config (Set-Node oder n8n Env-Variablen):
 *  odoo_url, odoo_db, odoo_api_key, journal_id, odoo_gc_field,
 *  gocardless_token, gocardless_env  (live | sandbox)
 *
 * Retry-Fix:
 *  unique_import_id ist event-bezogen ({payment_id}_CONFIRMED_{event_id}).
 *  Nach failed + erneutem Einzug wird eine NEUE CONFIRMED-Zeile geschrieben.
 */

const FAILED_LIKE = ["FAILED", "CHARGEDBACK", "CANCELLED"];
const PAYOUT_FEE_TYPES = ["gocardless_fee", "app_fee", "surcharge_fee"];
const PAYOUT_REVERSAL_TYPES = [
  "payment_refunded",
  "refund",
  "chargeback",
  "failure_fee",
  "late_failure_settled",
];
const PAYOUT_TRIGGER_PAYMENT_ACTIONS = [
  "paid_out",
  "surcharge_fee_debited",
  "late_failure_settled",
];
const PAYMENT_BOOK_ACTIONS = ["confirmed", "failed", "charged_back", "cancelled"];

const httpHelper = (() => {
  if (this && this.helpers && typeof this.helpers.httpRequest === "function") {
    return this.helpers.httpRequest.bind(this.helpers);
  }
  try {
    if (typeof $helpers !== "undefined" && typeof $helpers.httpRequest === "function") {
      return $helpers.httpRequest.bind($helpers);
    }
  } catch (e) {
    /* ignore */
  }
  return null;
})();

const inputItem = $input.first().json || {};
const logs = [];

function log(msg) {
  logs.push(String(msg));
  console.log(msg);
}

function envGet(key) {
  try {
    if (typeof $env !== "undefined" && $env[key]) return String($env[key]);
  } catch (e) {
    /* ignore */
  }
  return "";
}

function pick(key, envKey, fallback = "") {
  const fromItem = inputItem[key];
  if (fromItem !== undefined && fromItem !== null && fromItem !== "") {
    return fromItem;
  }
  const fromEnv = envGet(envKey);
  if (fromEnv) return fromEnv;
  return fallback;
}

function asInt(value, fallback = 0) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function likeEscape(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

function lineKind(uniqueImportId, paymentId) {
  const prefix = `${paymentId}_`;
  if (!uniqueImportId || !String(uniqueImportId).startsWith(prefix)) return null;
  const rest = String(uniqueImportId).slice(prefix.length);
  if (rest === "CONFIRMED" || rest.startsWith("CONFIRMED_")) return "confirmed";
  if (FAILED_LIKE.some((p) => rest === p || rest.startsWith(p))) {
    return "failed";
  }
  return null;
}

function countPaymentLines(paymentId, existingUids) {
  let confirmed = 0;
  let failed = 0;
  for (const uid of existingUids) {
    const kind = lineKind(uid, paymentId);
    if (kind === "confirmed") confirmed += 1;
    else if (kind === "failed") failed += 1;
  }
  return { confirmed, failed };
}

function uniqueIdFor(paymentId, suffix, eventId) {
  return `${paymentId}_${suffix}_${eventId}`;
}

function payoutReversalUniqueId(paymentId, payoutId, itemType) {
  return `${paymentId}_FAILED_payout_${payoutId}_${itemType}`;
}

function decidePaymentBooking({ action, willAttemptRetry, eventId, paymentId, existingUids }) {
  const { confirmed, failed } = countPaymentLines(paymentId, existingUids);

  if (action === "confirmed") {
    const uid = uniqueIdFor(paymentId, "CONFIRMED", eventId);
    if (existingUids.includes(uid)) {
      return { kind: "skip", reason: "event already booked", uniqueImportId: uid };
    }
    if (confirmed > failed) {
      return {
        kind: "skip",
        reason: "unmatched confirmation already exists (duplicate webhook)",
        uniqueImportId: uid,
      };
    }
    return {
      kind: "book",
      reason: "confirmed",
      uniqueImportId: uid,
      amountSign: 1,
      suffix: "CONFIRMED",
      retryIndex: failed,
    };
  }

  const suffixByAction = {
    failed: "FAILED",
    charged_back: "CHARGEDBACK",
    cancelled: "CANCELLED",
  };
  if (!suffixByAction[action]) {
    return { kind: "skip", reason: `irrelevant payment action: ${action}` };
  }
  if (action === "failed" && willAttemptRetry) {
    return { kind: "skip", reason: "GoCardless will_attempt_retry — wait for next attempt" };
  }
  const suffix = suffixByAction[action];
  const uid = uniqueIdFor(paymentId, suffix, eventId);
  if (existingUids.includes(uid)) {
    return { kind: "skip", reason: "event already booked", uniqueImportId: uid };
  }
  if (confirmed <= failed) {
    return {
      kind: "skip",
      reason: "nothing to reverse (never confirmed or already reversed)",
      uniqueImportId: uid,
    };
  }
  return {
    kind: "book",
    reason: `reverse after ${action}`,
    uniqueImportId: uid,
    amountSign: -1,
    suffix,
    retryIndex: 0,
  };
}

function decidePayoutReversal(paymentId, existingUids, reversalUid) {
  if (existingUids.includes(reversalUid)) {
    return { kind: "skip", reason: "payout reversal already booked", uniqueImportId: reversalUid };
  }
  const { confirmed, failed } = countPaymentLines(paymentId, existingUids);
  if (confirmed <= failed) {
    return {
      kind: "skip",
      reason: "payment already reversed — skip payout chargeback to avoid double count",
      uniqueImportId: reversalUid,
    };
  }
  return {
    kind: "book",
    reason: "payout reversal",
    uniqueImportId: reversalUid,
    amountSign: -1,
  };
}

function extractEvents(item) {
  if (item.webhook_raw_json) {
    const parsed =
      typeof item.webhook_raw_json === "string"
        ? JSON.parse(item.webhook_raw_json)
        : item.webhook_raw_json;
    return parsed.events || [];
  }
  const body = item.body !== undefined ? item.body : item;
  if (typeof body === "string") {
    return JSON.parse(body).events || [];
  }
  if (body && Array.isArray(body.events)) return body.events;
  if (Array.isArray(item.events)) return item.events;
  return [];
}

async function httpJson(method, url, { headers = {}, body } = {}) {
  const options = {
    method,
    url,
    headers,
    json: true,
    ignoreHttpStatusErrors: true,
    returnFullResponse: true,
    timeout: 20000,
  };
  if (body !== undefined) options.body = body;

  if (httpHelper) {
    const result = await httpHelper(options);
    if (result && typeof result === "object" && "statusCode" in result) {
      return { status: result.statusCode, data: result.body };
    }
    return { status: 200, data: result };
  }

  if (typeof fetch === "function") {
    const res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try {
      data = await res.json();
    } catch (e) {
      data = null;
    }
    return { status: res.status, data };
  }

  throw new Error(
    "Kein HTTP-Helper in diesem Code-Node. this.helpers.httpRequest oder fetch wird benötigt."
  );
}

function unwrapOdoo(jsonRes) {
  if (jsonRes === undefined || jsonRes === null) return [];
  if (Array.isArray(jsonRes)) return jsonRes;
  if (typeof jsonRes === "object") {
    if (jsonRes.error) {
      log(`⚠️ Odoo API Error: ${JSON.stringify(jsonRes.error)}`);
      return [];
    }
    if (jsonRes.result !== undefined) {
      const r = jsonRes.result;
      if (Array.isArray(r)) return r;
      if (r === null || r === false) return [];
      return [r];
    }
  }
  return [jsonRes];
}

async function main() {
  const odooUrl = String(pick("odoo_url", "ODOO_URL", "")).replace(/\/$/, "");
  const odooDb = String(pick("odoo_db", "ODOO_DB", ""));
  const odooKey = String(pick("odoo_api_key", "ODOO_API_KEY", ""));
  const journalId = asInt(pick("journal_id", "ODOO_JOURNAL_ID", 0), 0);
  const customFieldName = pick("odoo_gc_field", "ODOO_GC_FIELD", "") || "";
  const gcToken = String(pick("gocardless_token", "GOCARDLESS_TOKEN", ""));
  const gcEnv = String(pick("gocardless_env", "GOCARDLESS_ENV", "live"));
  const gcBaseUrl =
    gcEnv === "sandbox" || gcEnv === "test"
      ? "https://api-sandbox.gocardless.com"
      : "https://api.gocardless.com";

  if (!odooUrl || !odooKey || !gcToken || !journalId) {
    throw new Error(
      "Config unvollständig: odoo_url, odoo_api_key, gocardless_token, journal_id werden benötigt."
    );
  }

  const events = extractEvents(inputItem);
  log(`📦 Untersuche ${events.length} Events...`);

  const gcHeaders = {
    Authorization: `Bearer ${gcToken}`,
    "GoCardless-Version": "2015-07-06",
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  const odooHeaders = {
    Authorization: `Bearer ${odooKey}`,
    "X-Odoo-Database": odooDb,
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  async function odooApi(model, method, params) {
    const endpoint = `${odooUrl}/json/2/${model}/${method}`;
    try {
      const res = await httpJson("POST", endpoint, { headers: odooHeaders, body: params });
      if (res.status !== 200) {
        log(`⚠️ Odoo HTTP ${res.status} ${model}.${method}: ${JSON.stringify(res.data)}`);
        return [];
      }
      return unwrapOdoo(res.data);
    } catch (e) {
      log(`⚠️ Odoo Exception ${model}.${method}: ${e.message || e}`);
      return [];
    }
  }

  function getFirst(res) {
    return Array.isArray(res) && res.length ? res[0] : false;
  }

  async function gcGet(path) {
    const url = path.startsWith("http") ? path : `${gcBaseUrl}${path}`;
    const res = await httpJson("GET", url, { headers: gcHeaders });
    return res;
  }

  async function fetchPaymentLines(paymentId) {
    const pattern = `${likeEscape(paymentId)}\\_%`;
    const rows = await odooApi("account.bank.statement.line", "search_read", {
      domain: [["unique_import_id", "=like", pattern]],
      fields: ["unique_import_id", "amount"],
      limit: 200,
    });
    if (rows.length && typeof rows[0] === "object" && rows[0].unique_import_id) {
      return rows.map((r) => r.unique_import_id);
    }
    const ids = await odooApi("account.bank.statement.line", "search", {
      domain: [["unique_import_id", "=like", pattern]],
      limit: 200,
    });
    if (!ids.length) {
      const legacyIds = await odooApi("account.bank.statement.line", "search", {
        domain: [
          [
            "unique_import_id",
            "in",
            [
              `${paymentId}_CONFIRMED`,
              `${paymentId}_FAILED`,
              `${paymentId}_CHARGEDBACK`,
              `${paymentId}_CANCELLED`,
            ],
          ],
        ],
      });
      if (!legacyIds.length) return [];
      return readUids(legacyIds);
    }
    return readUids(ids);
  }

  async function readUids(ids) {
    const recs = await odooApi("account.bank.statement.line", "read", {
      ids,
      fields: ["unique_import_id"],
    });
    return recs.map((r) => r.unique_import_id).filter(Boolean);
  }

  async function lineExists(uniqueImportId) {
    const found = await odooApi("account.bank.statement.line", "search", {
      domain: [["unique_import_id", "=", uniqueImportId]],
      limit: 1,
    });
    return Boolean(found && found.length);
  }

  async function createStatementLine(vals) {
    const created = await odooApi("account.bank.statement.line", "create", {
      vals_list: [vals],
    });
    return getFirst(created);
  }

  async function resolvePartner({ gcCustomerId, customerEmail, customerName }) {
    let partnerId = null;
    if (customFieldName && gcCustomerId) {
      const s = await odooApi("res.partner", "search", {
        domain: [[customFieldName, "=", gcCustomerId]],
        limit: 1,
      });
      if (s && s.length) partnerId = s[0];
    }
    if (!partnerId && customerEmail) {
      const s = await odooApi("res.partner", "search", {
        domain: [["email", "=ilike", customerEmail.trim()]],
        limit: 1,
      });
      if (s && s.length) {
        partnerId = s[0];
        if (customFieldName && gcCustomerId) {
          await odooApi("res.partner", "write", {
            ids: [partnerId],
            vals: { [customFieldName]: gcCustomerId },
          });
        }
      }
    }
    if (!partnerId && customerEmail) {
      const vals = { name: customerName, email: customerEmail, customer_rank: 1 };
      if (customFieldName && gcCustomerId) vals[customFieldName] = gcCustomerId;
      const created = await odooApi("res.partner", "create", { vals_list: [vals] });
      partnerId = getFirst(created);
    }
    return partnerId || false;
  }

  async function loadCustomerFromMandate(mandateId) {
    const result = {
      customerEmail: null,
      customerName: "GoCardless Kunde",
      gcCustomerId: null,
    };
    if (!mandateId) return result;
    const resM = await gcGet(`/mandates/${mandateId}`);
    if (resM.status !== 200 || !resM.data || !resM.data.mandates) return result;
    const mandate = resM.data.mandates;
    result.gcCustomerId = (mandate.links && mandate.links.customer) || null;
    if (!result.gcCustomerId) return result;
    const resC = await gcGet(`/customers/${result.gcCustomerId}`);
    if (resC.status !== 200 || !resC.data || !resC.data.customers) return result;
    const cust = resC.data.customers;
    result.customerEmail = cust.email || null;
    result.customerName =
      `${cust.given_name || ""} ${cust.family_name || ""}`.trim() ||
      cust.company_name ||
      "Kunde";
    return result;
  }

  async function fetchAllPayoutItems(payoutId) {
    const items = [];
    let after = null;
    for (let page = 0; page < 20; page += 1) {
      const qs = new URLSearchParams({ payout: payoutId, limit: "500" });
      if (after) qs.set("after", after);
      const res = await gcGet(`/payout_items?${qs.toString()}`);
      if (res.status !== 200 || !res.data) break;
      const batch = res.data.payout_items || [];
      items.push(...batch);
      after = res.data.meta && res.data.meta.cursors && res.data.meta.cursors.after;
      if (!after || batch.length === 0) break;
    }
    return items;
  }

  const processed = [];
  const skipped = [];
  const errors = [];
  const processedPayouts = new Set();

  async function handlePaymentEvent(ev) {
    const action = ev.action;
    const paymentId = ev.links && ev.links.payment;
    const eventId = ev.id || `NOEV_${paymentId}_${action}`;
    const details = ev.details || {};
    if (!paymentId) return;
    if (!PAYMENT_BOOK_ACTIONS.includes(action)) return;

    const existingUids = await fetchPaymentLines(paymentId);
    const decision = decidePaymentBooking({
      action,
      willAttemptRetry:
        details.will_attempt_retry === true ||
        details.will_attempt_retry === "true" ||
        details.will_attempt_retry === "True",
      eventId,
      paymentId,
      existingUids,
    });

    if (decision.kind === "skip") {
      log(`   ⏭️ Payment ${paymentId} ${action}: ${decision.reason}`);
      skipped.push({ payment_id: paymentId, action, reason: decision.reason });
      return;
    }

    log(`🚀 Payment ${paymentId} (${action}) event=${eventId}`);

    const resP = await gcGet(`/payments/${paymentId}`);
    if (resP.status !== 200 || !resP.data || !resP.data.payments) {
      log(`❌ GC Error bei ${paymentId}: ${JSON.stringify(resP.data)}`);
      errors.push({ payment_id: paymentId, error: "gocardless_payment_fetch_failed" });
      return;
    }
    const payment = resP.data.payments;
    const rawAmount = Number(payment.amount) / 100.0;
    const description = payment.description || "GoCardless Lastschrift";
    const mandateId = payment.links && payment.links.mandate;
    let dateStr = payment.charge_date;
    if (action !== "confirmed") {
      dateStr = String(ev.created_at || "").slice(0, 10) || dateStr;
    }

    const customer = await loadCustomerFromMandate(mandateId);
    const partnerId = await resolvePartner(customer);
    const amount = rawAmount * decision.amountSign;
    const failureReason = details.cause || action;
    let descPrefix = "";
    if (decision.suffix === "FAILED") descPrefix = `FEHLGESCHLAGEN (${failureReason}) | `;
    if (decision.suffix === "CHARGEDBACK") descPrefix = `RÜCKLASTSCHRIFT (${failureReason}) | `;
    if (decision.suffix === "CANCELLED") descPrefix = `STORNIERT | `;
    if (decision.suffix === "CONFIRMED" && decision.retryIndex > 0) {
      descPrefix = `ERNEUTER EINZUG (${decision.retryIndex + 1}) | `;
    }

    if (await lineExists(decision.uniqueImportId)) {
      log(`   ℹ️ ${decision.uniqueImportId} existiert bereits.`);
      skipped.push({ payment_id: paymentId, action, reason: "unique_import_id exists" });
      return;
    }

    await createStatementLine({
      date: dateStr,
      payment_ref: `${descPrefix}${description} | ${customer.customerName} | ${paymentId}`,
      amount,
      journal_id: journalId,
      unique_import_id: decision.uniqueImportId,
      partner_id: partnerId || false,
    });
    log(`   ✅ Gebucht: ${amount} EUR (${decision.uniqueImportId})`);
    processed.push({
      type: "payment",
      payment_id: paymentId,
      action,
      unique_import_id: decision.uniqueImportId,
      amount,
    });
  }

  async function handlePayoutFailed(ev) {
    const payoutId = ev.links && ev.links.payout;
    const failDetail =
      (ev.details && (ev.details.description || ev.details.cause || ev.details.reason_code)) || "";
    log(`⚠️ Payout ${payoutId || "?"} action=failed — kein Transfer gebucht. ${failDetail}`);
    skipped.push({
      payout_id: payoutId,
      action: "failed",
      reason: "payout failed — transfer not booked",
    });
  }

  async function handlePayout(ev, isPayoutEvent) {
    const payoutId = isPayoutEvent
      ? ev.links && ev.links.payout
      : ev.links && ev.links.payout;
    if (!payoutId) return;
    if (processedPayouts.has(payoutId)) return;
    processedPayouts.add(payoutId);

    log(`🚀 Bearbeite Payout: ${payoutId}`);
    const transferId = `${payoutId}_TRANSFER`;

    const resP = await gcGet(`/payouts/${payoutId}`);
    if (resP.status !== 200 || !resP.data || !resP.data.payouts) {
      log(`❌ Fehler beim Laden von Payout ${payoutId}`);
      errors.push({ payout_id: payoutId, error: "gocardless_payout_fetch_failed" });
      return;
    }
    const po = resP.data.payouts;
    if (po.status !== "paid") {
      log(`   ℹ️ Payout-Status ist noch ${po.status}, warte auf 'paid'.`);
      skipped.push({ payout_id: payoutId, reason: `status=${po.status}` });
      return;
    }

    const dateStr = po.arrival_date;
    const netPayoutAmount = Number(po.amount) / 100.0;
    const items = await fetchAllPayoutItems(payoutId);
    log(`   🔍 Analysiere ${items.length} Posten...`);

    for (const item of items) {
      const amt = Number(item.amount || 0) / 100.0;
      const typ = item.type;
      const linkedPm = (item.links && item.links.payment) || "NoRef";

      if (PAYOUT_FEE_TYPES.includes(typ)) {
        const uniqueFeeId = `${payoutId}_${typ}_${linkedPm}_${Math.abs(amt)}`;
        if (await lineExists(uniqueFeeId)) continue;
        await createStatementLine({
          date: dateStr,
          payment_ref: `GC Gebühr (${typ}) | ${linkedPm}`,
          amount: amt,
          journal_id: journalId,
          unique_import_id: uniqueFeeId,
          partner_id: false,
        });
        log(`   ✅ Gebühr gebucht: ${amt} EUR (${typ})`);
        processed.push({ type: "fee", payout_id: payoutId, unique_import_id: uniqueFeeId, amount: amt });
      } else if (PAYOUT_REVERSAL_TYPES.includes(typ) && linkedPm !== "NoRef") {
        const existingUids = await fetchPaymentLines(linkedPm);
        const reversalUid = payoutReversalUniqueId(linkedPm, payoutId, typ);
        const decision = decidePayoutReversal(linkedPm, existingUids, reversalUid);
        if (decision.kind === "skip") {
          log(`   ⏭️ Rückbuchung ${linkedPm} (${typ}): ${decision.reason}`);
          continue;
        }
        if (await lineExists(reversalUid)) continue;
        await createStatementLine({
          date: dateStr,
          payment_ref: `Rückbuchung/Korrektur (${typ}) | ${linkedPm}`,
          amount: amt,
          journal_id: journalId,
          unique_import_id: reversalUid,
          partner_id: false,
        });
        log(`   ✅ Rückbuchung gebucht: ${amt} EUR (${typ})`);
        processed.push({
          type: "reversal",
          payout_id: payoutId,
          payment_id: linkedPm,
          unique_import_id: reversalUid,
          amount: amt,
        });
      } else if (PAYOUT_REVERSAL_TYPES.includes(typ)) {
        const uniqueErrId = `${payoutId}_${typ}_${linkedPm}_${Math.abs(amt)}`;
        if (await lineExists(uniqueErrId)) continue;
        await createStatementLine({
          date: dateStr,
          payment_ref: `Rückbuchung/Korrektur (${typ}) | ${linkedPm}`,
          amount: amt,
          journal_id: journalId,
          unique_import_id: uniqueErrId,
          partner_id: false,
        });
        processed.push({ type: "reversal", payout_id: payoutId, unique_import_id: uniqueErrId, amount: amt });
      }
    }

    if (await lineExists(transferId)) {
      log("   ⏭️ Transfer war schon gebucht, Posten wurden trotzdem abgeglichen.");
      return;
    }
    await createStatementLine({
      date: dateStr,
      payment_ref: `Transfer an Bankkonto | ${payoutId}`,
      amount: -netPayoutAmount,
      journal_id: journalId,
      unique_import_id: transferId,
    });
    log(`   ✅ Transfer gebucht: ${-netPayoutAmount} EUR`);
    processed.push({
      type: "transfer",
      payout_id: payoutId,
      unique_import_id: transferId,
      amount: -netPayoutAmount,
    });
  }

  for (const ev of events) {
    const resType = ev.resource_type;
    const action = ev.action;
    try {
      if (resType === "payments" && PAYMENT_BOOK_ACTIONS.includes(action)) {
        await handlePaymentEvent(ev);
      }
      if (resType === "payouts" && action === "failed") {
        await handlePayoutFailed(ev);
      }
      const isPayoutPaid = resType === "payouts" && action === "paid";
      const isPaymentPayoutTrigger =
        resType === "payments" && PAYOUT_TRIGGER_PAYMENT_ACTIONS.includes(action);
      if (isPayoutPaid || isPaymentPayoutTrigger) {
        await handlePayout(ev, isPayoutPaid);
      }
    } catch (e) {
      log(`❌ Fehler bei Event ${ev.id || "?"}: ${e.message || e}`);
      errors.push({ event_id: ev.id, error: String(e.message || e) });
    }
  }

  if (!processed.length && !skipped.length) {
    return [
      {
        json: {
          status: "no_relevant_events_found",
          processed: [],
          skipped,
          errors,
          logs,
        },
      },
    ];
  }

  return [
    {
      json: {
        status: errors.length ? "partial" : "success",
        processed,
        skipped,
        errors,
        logs,
      },
    },
  ];
}

return await main();
