/**
 * Odoo account.move Webhook → Close Opportunity Status (n8n Code-Node, JavaScript)
 *
 * Filter davor: display_name does not contain "Draft Invoice".
 *
 * n8n-Setup:
 *  1. Webhook-Node (POST), Response: Immediately
 *  2. Filter: display_name enthält nicht "Draft Invoice"
 *  3. Set-Node mit Config, "Include Other Input Fields" = an
 *  4. Dieser Code-Node: Mode = "Run Once for All Items", Language = JavaScript
 *
 * Config:
 *  close_api_key, field_id_residual, status_id_partial, status_id_paid,
 *  field_id_deposit_date, field_id_full_pay_date
 */

const PAID_STATES = ["paid", "in_payment"];
const RESIDUAL_PAID_THRESHOLD = 0.01;

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

function stripCustomPrefix(fieldId) {
  let fid = String(fieldId || "").trim();
  if (fid.startsWith("custom.")) fid = fid.slice("custom.".length);
  return fid;
}

function closeCustomKey(fieldId) {
  const fid = stripCustomPrefix(fieldId);
  return fid ? `custom.${fid}` : "";
}

function isDraftInvoice(displayName) {
  return String(displayName || "").toLowerCase().includes("draft invoice");
}

function isFullyPaid(paymentState, amountResidual) {
  const state = String(paymentState || "").toLowerCase().trim();
  return PAID_STATES.includes(state) || amountResidual <= RESIDUAL_PAID_THRESHOLD;
}

function readCustomField(opportunity, fieldId) {
  const fid = stripCustomPrefix(fieldId);
  const nested = opportunity && opportunity.custom ? opportunity.custom[fid] : undefined;
  if (nested !== undefined && nested !== null && nested !== "") return nested;
  const flat = opportunity ? opportunity[`custom.${fid}`] : undefined;
  if (flat !== undefined && flat !== null && flat !== "") return flat;
  return null;
}

function decideClosePayload({
  paymentState,
  amountResidual,
  currentDepositDate,
  fieldIdResidual,
  statusIdPaid,
  statusIdPartial,
  fieldIdDeposit,
  fieldIdFullPay,
  today,
}) {
  const payload = {};
  const residualKey = closeCustomKey(fieldIdResidual);
  if (residualKey) payload[residualKey] = amountResidual;

  const state = String(paymentState || "").toLowerCase().trim();
  const depositKey = closeCustomKey(fieldIdDeposit);
  const fullKey = closeCustomKey(fieldIdFullPay);

  if (isFullyPaid(state, amountResidual)) {
    if (statusIdPaid) payload.status_id = statusIdPaid;
    if (fullKey) payload[fullKey] = today;
    if (depositKey && !currentDepositDate) payload[depositKey] = today;
  } else if (state === "partial") {
    if (statusIdPartial) payload.status_id = statusIdPartial;
    if (depositKey && !currentDepositDate) payload[depositKey] = today;
  }
  return payload;
}

function extractInvoice(item) {
  const parsed = [];
  if (item.raw_json) {
    parsed.push(typeof item.raw_json === "string" ? JSON.parse(item.raw_json) : item.raw_json);
  }
  if (item.body !== undefined) {
    parsed.push(typeof item.body === "string" ? JSON.parse(item.body) : item.body);
  }
  parsed.push(item);
  for (const candidate of parsed) {
    if (
      candidate &&
      typeof candidate === "object" &&
      (candidate.x_studio_close_opp_id ||
        candidate.payment_state ||
        candidate._model === "account.move")
    ) {
      return candidate;
    }
  }
  return parsed[0] || item;
}

function todayIso() {
  try {
    if (typeof $now !== "undefined") {
      if (typeof $now.toISODate === "function") return $now.toISODate();
      if (typeof $now.toFormat === "function") return $now.toFormat("yyyy-MM-dd");
    }
  } catch (e) {
    /* ignore */
  }
  return new Date().toISOString().slice(0, 10);
}

function closeAuthHeader(apiKey) {
  const token = Buffer.from(`${apiKey}:`, "utf8").toString("base64");
  return `Basic ${token}`;
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

  throw new Error("Kein HTTP-Helper in diesem Code-Node (this.helpers.httpRequest oder fetch).");
}

function result(status, extra) {
  return [{ json: { status, logs, ...extra } }];
}

async function main() {
  const closeApiKey = String(pick("close_api_key", "CLOSE_API_KEY", "")).trim();
  const fieldIdResidual = String(pick("field_id_residual", "CLOSE_FIELD_RESIDUAL", "")).trim();
  const statusIdPartial = String(pick("status_id_partial", "CLOSE_STATUS_PARTIAL", "")).trim();
  const statusIdPaid = String(pick("status_id_paid", "CLOSE_STATUS_PAID", "")).trim();
  const fieldIdDeposit = String(
    pick(
      "field_id_deposit_date",
      "CLOSE_FIELD_DEPOSIT_DATE",
      "cf_OxCaftVBRHVJM1vIIVrVqRTtdjoQJ3f8yGnOUU0YpZY"
    )
  ).trim();
  const fieldIdFullPay = String(
    pick(
      "field_id_full_pay_date",
      "CLOSE_FIELD_FULL_PAY_DATE",
      "cf_JH04OF409wsXMK0ATa20Wn9aPW7w8pdAsQHFMSamnMU"
    )
  ).trim();

  if (!closeApiKey) {
    return result("error", { msg: "API Key fehlt" });
  }

  let invoice;
  try {
    invoice = extractInvoice(inputItem);
  } catch (e) {
    return result("error", { msg: "JSON Invalid" });
  }

  const displayName = invoice.display_name || "";
  if (isDraftInvoice(displayName)) {
    log(`⏭️ Draft Invoice übersprungen: ${displayName}`);
    return result("skipped", { reason: "Draft Invoice", display_name: displayName });
  }

  const oppId = invoice.x_studio_close_opp_id;
  const paymentState = String(invoice.payment_state || "").toLowerCase();
  let amountResidual = 0.0;
  try {
    amountResidual = parseFloat(invoice.amount_residual);
    if (!Number.isFinite(amountResidual)) amountResidual = 0.0;
  } catch (e) {
    amountResidual = 0.0;
  }

  if (!oppId) {
    return result("skipped", { reason: "No Opp ID", display_name: displayName });
  }

  const headers = {
    Authorization: closeAuthHeader(closeApiKey),
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  const url = `https://api.close.com/api/v1/opportunity/${oppId}/`;

  log(`🚀 Close Opportunity ${oppId} | ${displayName} | ${paymentState} | residual=${amountResidual}`);

  let currentDepositDate = null;
  try {
    const getRes = await httpJson("GET", url, { headers });
    if (getRes.status === 200 && getRes.data) {
      currentDepositDate = readCustomField(getRes.data, fieldIdDeposit);
      log(`   Anzahlungsdatum bisher: ${currentDepositDate || "(leer)"}`);
    } else {
      log(`GET Error: ${JSON.stringify(getRes.data)}`);
    }
  } catch (e) {
    log(`GET Exception: ${e.message || e}`);
  }

  const payload = decideClosePayload({
    paymentState,
    amountResidual,
    currentDepositDate,
    fieldIdResidual,
    statusIdPaid,
    statusIdPartial,
    fieldIdDeposit,
    fieldIdFullPay,
    today: todayIso(),
  });

  const depositKey = closeCustomKey(fieldIdDeposit);

  try {
    const putRes = await httpJson("PUT", url, { headers, body: payload });
    if (putRes.status !== 200) {
      return result("error", {
        msg: putRes.data,
        opp_id: oppId,
        payload,
        http_status: putRes.status,
      });
    }
    return result("success", {
      opp_id: oppId,
      display_name: displayName,
      payment_state: paymentState,
      amount_residual: amountResidual,
      read_deposit_before: currentDepositDate,
      updated_deposit: Boolean(depositKey && Object.prototype.hasOwnProperty.call(payload, depositKey)),
      payload,
    });
  } catch (e) {
    return result("error", { msg: String(e.message || e), opp_id: oppId });
  }
}

return await main();
