/**
 * WhatsApp Webhook → Close Lead Activity (n8n Code-Node, JavaScript)
 *
 * Nur Evolution API: send.message / messages.upsert.
 *
 * n8n-Setup:
 *  1. Webhook-Node (POST), Response: Immediately
 *  2. Optional Filter: event ist send.message oder messages.upsert
 *  3. Set-Node mit Config, Include Other Input Fields = an
 *  4. Dieser Code-Node: Run Once for All Items, JavaScript
 *
 * Config:
 *  close_api_key, my_whatsapp_number, create_task,
 *  excluded_phone_number, excluded_user_id, field_id_responsible_user
 */

const RELEVANT_EVENTS = ["send.message", "messages.upsert"];
const SKIP_JID_MARKERS = ["@g.us", "@broadcast", "@newsletter"];
const WHATSAPP_CDN = ["mmg.whatsapp.net", "media.whatsapp.com", "pps.whatsapp.net"];
const WRAPPER_KEYS = [
  "ephemeralMessage",
  "viewOnceMessage",
  "viewOnceMessageV2",
  "viewOnceMessageV2Extension",
  "documentWithCaptionMessage",
];

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
  if (fromItem !== undefined && fromItem !== null && fromItem !== "") return fromItem;
  const fromEnv = envGet(envKey);
  if (fromEnv) return fromEnv;
  return fallback;
}

function pickBool(key, envKey, fallback = true) {
  const v = pick(key, envKey, fallback);
  if (v === false || v === "false" || v === 0 || v === "0") return false;
  if (v === true || v === "true" || v === 1 || v === "1") return true;
  return Boolean(fallback);
}

const CLOSE_KEY_HINT =
  "In Close: Settings → Developer → API Keys. Den Klartext-Key verwenden (beginnt mit api_), nicht den gehashten Key/Fingerprint aus der Liste.";

function closeAuthHeader(apiKey) {
  const key = String(apiKey || "").trim();
  if (!key) return "";
  if (/^basic\s+/i.test(key)) return key;
  return `Basic ${Buffer.from(`${key}:`, "utf8").toString("base64")}`;
}

function closeKeyLooksHashed(apiKey) {
  const key = String(apiKey || "").trim();
  if (!key || /^basic\s+/i.test(key)) return false;
  if (key.includes("*")) return true;
  if (/^[0-9a-f]{32,64}$/i.test(key)) return true;
  if (/^\$2[aby]\$/.test(key)) return true;
  return false;
}

function closeAuthFailed(status) {
  return status === 401 || status === 403;
}

function cleanPhone(phone) {
  if (!phone) return "";
  return String(phone).replace(/\D/g, "");
}

function phoneSearchVariants(remotePhone) {
  const digits = cleanPhone(remotePhone);
  if (!digits) return [];
  const variants = [digits, `+${digits}`];
  if (digits.length > 2) {
    const rest = digits.slice(2);
    variants.push(rest, `0${rest}`);
  }
  return [...new Set(variants.filter(Boolean))];
}

function phonesMatch(a, b) {
  const da = cleanPhone(a);
  const db = cleanPhone(b);
  if (!da || !db) return false;
  if (da === db) return true;
  const tailA = da.slice(-8);
  const tailB = db.slice(-8);
  return Boolean(tailA) && tailA === tailB;
}

function isGroupOrBroadcast(jid) {
  const s = String(jid || "").toLowerCase();
  return SKIP_JID_MARKERS.some((m) => s.includes(m));
}

function publicMediaUrl(url) {
  if (!url || !String(url).startsWith("http")) return null;
  const host = String(url).split("/")[2] || "";
  if (WHATSAPP_CDN.some((cdn) => host.includes(cdn))) return null;
  return String(url);
}

function unwrapMessage(message) {
  if (!message || typeof message !== "object") return {};
  for (const wrapper of WRAPPER_KEYS) {
    if (message[wrapper] && typeof message[wrapper] === "object") {
      const inner = message[wrapper].message || message[wrapper];
      return unwrapMessage(inner);
    }
  }
  return message;
}

function createMediaLink(url, icon, label) {
  const publicUrl = publicMediaUrl(url);
  return publicUrl ? `\n\n[${icon} ${label}](${publicUrl})` : "";
}

function messageTextFromParts(kind, caption, link, extra) {
  if (kind === "text") return caption || extra || "";
  if (kind === "image") {
    const body = caption || "📷 Foto empfangen";
    return `${body}${createMediaLink(link, "🖼️", "Bild ansehen")}`;
  }
  if (kind === "video") {
    const body = caption || "🎥 Video empfangen";
    return `${body}${createMediaLink(link, "▶️", "Video ansehen")}`;
  }
  if (kind === "audio" || kind === "voice") {
    return `🎤 Sprachnachricht empfangen${createMediaLink(link, "▶️", "Abspielen")}`;
  }
  if (kind === "document") {
    const body = caption || "📄 Dokument empfangen";
    const filename = extra || "Dokument";
    return `${body}${createMediaLink(link, "⬇️", filename)}`;
  }
  if (kind === "reaction") {
    const emoji = String(caption || "").trim();
    return emoji ? `${emoji} (Reaktion)` : "";
  }
  if (kind === "sticker") {
    return `🎨 Sticker empfangen${createMediaLink(link, "🖼️", "Sticker ansehen")}`;
  }
  if (kind === "location") return caption || "📍 Standort empfangen";
  if (kind === "contact") return caption || "👤 Kontakt empfangen";
  return caption || extra || `[Nachrichtentyp: ${kind}]`;
}

function evolutionContent(inner, messageType) {
  if (inner.conversation) return { kind: "text", caption: String(inner.conversation), link: null, extra: "" };
  if (inner.extendedTextMessage) {
    return { kind: "text", caption: String(inner.extendedTextMessage.text || ""), link: null, extra: "" };
  }
  if (inner.imageMessage) {
    const img = inner.imageMessage;
    return { kind: "image", caption: String(img.caption || ""), link: img.url || img.mediaUrl || null, extra: "" };
  }
  if (inner.videoMessage) {
    const vid = inner.videoMessage;
    return { kind: "video", caption: String(vid.caption || ""), link: vid.url || vid.mediaUrl || null, extra: "" };
  }
  if (inner.audioMessage) {
    const aud = inner.audioMessage;
    return {
      kind: aud.ptt ? "voice" : "audio",
      caption: "",
      link: aud.url || aud.mediaUrl || null,
      extra: "",
    };
  }
  if (inner.documentMessage) {
    const doc = inner.documentMessage;
    return {
      kind: "document",
      caption: String(doc.caption || ""),
      link: doc.url || doc.mediaUrl || null,
      extra: String(doc.fileName || doc.filename || "Dokument"),
    };
  }
  if (inner.stickerMessage) {
    const st = inner.stickerMessage;
    return { kind: "sticker", caption: "", link: st.url || st.mediaUrl || null, extra: "" };
  }
  if (inner.reactionMessage) {
    return { kind: "reaction", caption: String(inner.reactionMessage.text || ""), link: null, extra: "" };
  }
  if (inner.locationMessage) {
    const loc = inner.locationMessage;
    return { kind: "location", caption: String(loc.name || loc.address || ""), link: null, extra: "" };
  }
  if (inner.contactMessage) {
    return { kind: "contact", caption: String(inner.contactMessage.displayName || ""), link: null, extra: "" };
  }
  if (messageType === "conversation") return { kind: "text", caption: "", link: null, extra: "" };
  return { kind: messageType || "unknown", caption: "", link: null, extra: "" };
}

function parseEvolution(payload, defaultLocalPhone) {
  const event = payload.event;
  if (!RELEVANT_EVENTS.includes(event)) return null;

  let data = payload.data || payload;
  if (Array.isArray(data)) data = data[0] || {};
  if (!data || typeof data !== "object") return null;

  const key = data.key || {};
  const remoteJid = key.remoteJid || data.remoteJid || "";
  if (isGroupOrBroadcast(remoteJid)) return null;

  const fromMe = Boolean(key.fromMe || data.fromMe);
  const msgId = key.id || data.id;
  if (!msgId) return null;

  const inner = unwrapMessage(data.message || {});
  const { kind, caption, link, extra } = evolutionContent(inner, data.messageType || "");
  let text = messageTextFromParts(kind, caption, link, extra);
  if (!String(text).trim()) {
    if (kind === "reaction") return { skip: true, reason: "Reaction removed", id: msgId };
    text = `[Mediennachricht: ${kind || data.messageType || "unknown"}]`;
  }

  const remotePhone = cleanPhone(String(remoteJid).split("@")[0]);
  return {
    id: msgId,
    is_incoming: !fromMe,
    remote_phone: remotePhone,
    local_phone: cleanPhone(defaultLocalPhone),
    type: kind,
    text,
    media_url: publicMediaUrl(link),
    timestamp: data.messageTimestamp,
    instance: payload.instance,
    event,
  };
}

function collectEvolutionPayloads(raw, depth) {
  depth = depth || 0;
  if (depth > 8 || raw === undefined || raw === null) return [];
  if (typeof raw === "string") {
    try {
      return collectEvolutionPayloads(JSON.parse(raw), depth + 1);
    } catch (e) {
      return [];
    }
  }
  if (Array.isArray(raw)) {
    const found = [];
    for (const item of raw) found.push(...collectEvolutionPayloads(item, depth + 1));
    return found;
  }
  if (typeof raw !== "object") return [];
  if (typeof raw.event === "string" && raw.data) return [raw];
  const found = [];
  if (raw.json) found.push(...collectEvolutionPayloads(raw.json, depth + 1));
  if (raw.body) found.push(...collectEvolutionPayloads(raw.body, depth + 1));
  return found;
}

function jsonFromNode(name) {
  try {
    if (typeof $ === "function") {
      const ref = $(name);
      if (ref && typeof ref.all === "function") {
        return ref.all().map((row) => row.json).filter(Boolean);
      }
      if (ref && typeof ref.first === "function") {
        const first = ref.first();
        return first && first.json ? [first.json] : [];
      }
    }
  } catch (e) {
    /* node not in this execution */
  }
  try {
    if (typeof $items === "function") {
      return $items(name).map((row) => row.json).filter(Boolean);
    }
  } catch (e) {
    /* ignore */
  }
  try {
    if (typeof $node !== "undefined" && $node[name] && $node[name].json) {
      return [$node[name].json];
    }
  } catch (e) {
    /* ignore */
  }
  return [];
}

function extractPayloads(item) {
  const chunks = [];
  try {
    chunks.push(...$input.all().map((row) => row.json));
  } catch (e) {
    /* ignore */
  }
  if (item) chunks.push(item);
  const names = ["Unwrap Evolution Body", "WhatsApp Webhook", "Message Events Only"];
  for (const name of names) chunks.push(...jsonFromNode(name));
  return collectEvolutionPayloads(chunks);
}

function parseWebhook(payload, defaultLocalPhone) {
  return parseEvolution(payload, defaultLocalPhone);
}

function isoFromTimestamp(ts, fallbackIso) {
  if (ts === undefined || ts === null || ts === "") {
    return fallbackIso || new Date().toISOString();
  }
  let n = Number(ts);
  if (!Number.isFinite(n)) return fallbackIso || new Date().toISOString();
  if (n > 1e12) n = n / 1000;
  return new Date(n * 1000).toISOString();
}

function getCustomFieldValue(lead, fieldId) {
  if (!lead || !fieldId) return null;
  if (lead.custom && lead.custom[fieldId]) return lead.custom[fieldId];
  if (lead[`custom.${fieldId}`]) return lead[`custom.${fieldId}`];
  return null;
}

async function httpJson(method, url, { headers = {}, body, qs } = {}) {
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
  if (qs !== undefined) options.qs = qs;

  if (httpHelper) {
    const result = await httpHelper(options);
    if (result && typeof result === "object" && "statusCode" in result) {
      return { status: result.statusCode, data: result.body };
    }
    return { status: 200, data: result };
  }
  if (typeof fetch === "function") {
    let fetchUrl = url;
    if (qs) {
      const u = new URL(url);
      Object.keys(qs).forEach((key) => {
        if (qs[key] !== undefined && qs[key] !== null) u.searchParams.set(key, String(qs[key]));
      });
      fetchUrl = u.toString();
    }
    const res = await fetch(fetchUrl, {
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
  throw new Error("Kein HTTP-Helper in diesem Code-Node.");
}

function result(extra) {
  return [{ json: { logs, ...extra } }];
}

async function main() {
  const closeApiKey = String(pick("close_api_key", "CLOSE_API_KEY", "")).trim();
  const auth = closeAuthHeader(closeApiKey);
  const closeHeaders = { Authorization: auth, Accept: "application/json" };
  const closeHeadersJson = {
    ...closeHeaders,
    "Content-Type": "application/json",
  };

  if (!closeApiKey) {
    return result({ success: false, error: "close_api_key fehlt" });
  }
  if (closeKeyLooksHashed(closeApiKey)) {
    return result({
      success: false,
      error: `close_api_key sieht gehasht/maskiert aus. ${CLOSE_KEY_HINT}`,
    });
  }

  const excludedPhone = cleanPhone(pick("excluded_phone_number", "WA_EXCLUDED_PHONE", "16416666880"));
  const excludedUserId = String(
    pick("excluded_user_id", "WA_EXCLUDED_USER_ID", "user_JLZiYec3UhCAKchqWJLr3AMa3MeYlQeX2J0c0Ule6e0")
  ).trim();
  const responsibleField = String(
    pick("field_id_responsible_user", "CLOSE_FIELD_RESPONSIBLE_USER", "cf_XNUTqdtJkSXJIt2XdfS61YyinahAvTWplVfvI8qMZkK")
  )
    .trim()
    .replace(/^custom\./, "");
  const shouldCreateTask = pickBool("create_task", "WA_CREATE_TASK", true);
  const localPhone = cleanPhone(pick("my_whatsapp_number", "MY_WHATSAPP_NUMBER", "491758925279"));

  let payloads = [];
  try {
    payloads = extractPayloads(inputItem);
  } catch (e) {
    return result({ success: false, error: "JSON Invalid" });
  }

  if (!payloads.length) {
    return result({
      success: true,
      action: "skipped_irrelevant",
      event: (inputItem.body && inputItem.body.event) || inputItem.event || null,
      hint: "Kein Evolution-Body (event + data) gefunden. Die Config-Node hat oft das Webhook-Item ersetzt — Workflow neu importieren.",
      input_keys: Object.keys(inputItem || {}),
    });
  }

  const seenIds = new Set();
  const uniquePayloads = [];
  for (const p of payloads) {
    const msgId = (p.data && p.data.key && p.data.key.id) || (p.data && p.data.id) || "";
    const dedupe = msgId || `${p.event}:${p.date_time || ""}`;
    if (seenIds.has(dedupe)) continue;
    seenIds.add(dedupe);
    uniquePayloads.push(p);
  }

  const payload = uniquePayloads[0];
  const parsed = parseWebhook(payload, localPhone);
  if (!parsed) {
    return result({
      success: true,
      action: "skipped_irrelevant",
      event: payload.event || null,
    });
  }
  if (parsed.skip) {
    return result({ success: true, action: "skipped", reason: parsed.reason, message_id: parsed.id });
  }

  log(`Step 1: ${parsed.is_incoming ? "incoming" : "outgoing"} ${parsed.remote_phone} (${parsed.type})`);

  const meProbe = await httpJson("GET", "https://api.close.com/api/v1/me/", { headers: closeHeaders });
  if (closeAuthFailed(meProbe.status)) {
    return result({
      success: false,
      error: `Close API-Key ungültig (HTTP ${meProbe.status}). ${CLOSE_KEY_HINT}`,
      close_status: meProbe.status,
    });
  }

  async function getCurrentUser() {
    try {
      const r = await httpJson("GET", "https://api.close.com/api/v1/me/", { headers: closeHeaders });
      if (r.status === 200 && r.data && r.data.id) return r.data.id;
    } catch (e) {
      log(`GET /me failed: ${e.message || e}`);
    }
    return null;
  }

  function filterActivities(activities, sourceName) {
    if (!activities || !activities.length) return null;
    for (const act of activities) {
      const localP = cleanPhone(act.local_phone);
      const remoteP = cleanPhone(act.remote_phone);
      const userId = act.user_id || act.created_by;
      if (excludedPhone && (localP.includes(excludedPhone) || remoteP.includes(excludedPhone))) continue;
      if (excludedUserId && userId === excludedUserId) continue;
      if (!userId) continue;
      return { userId, source: sourceName, matchId: act.id };
    }
    return null;
  }

  async function findResponsibleUserFromHistory(leadId) {
    try {
      const wa = await httpJson("GET", "https://api.close.com/api/v1/activity/whatsapp_message/", {
        headers: closeHeaders,
        qs: {
          lead_id: leadId,
          _limit: 5,
          _order_by: "-date_created",
          _fields: "user_id,created_by,local_phone,remote_phone,id",
        },
      });
      if (wa.status === 200 && wa.data) {
        const match = filterActivities(wa.data.data, "history_whatsapp");
        if (match) return match;
      }
      const call = await httpJson("GET", "https://api.close.com/api/v1/activity/call/", {
        headers: closeHeaders,
        qs: {
          lead_id: leadId,
          _limit: 5,
          _order_by: "-date_created",
          _fields: "user_id,created_by,local_phone,remote_phone,id",
        },
      });
      if (call.status === 200 && call.data) {
        const match = filterActivities(call.data.data, "history_call");
        if (match) return match;
      }
    } catch (e) {
      log(`History Search Error: ${e.message || e}`);
    }
    return null;
  }

  let searchData = null;
  for (const p of phoneSearchVariants(parsed.remote_phone)) {
    const url = `https://api.close.com/api/v1/lead/?query=${encodeURIComponent(`phone:"${p}"`)}`;
    const res = await httpJson("GET", url, { headers: closeHeaders });
    if (closeAuthFailed(res.status)) {
      return result({
        success: false,
        error: `Close API-Key ungültig (HTTP ${res.status}). ${CLOSE_KEY_HINT}`,
        close_status: res.status,
      });
    }
    if (res.status === 200 && res.data && res.data.data && res.data.data.length) {
      searchData = res.data;
      log(`Step 2: Lead gefunden mit ${p}`);
      break;
    }
  }

  if (!searchData || !searchData.data.length) {
    return result({
      success: false,
      error: "No lead found",
      remote_phone: parsed.remote_phone,
    });
  }

  const lead = searchData.data[0];
  const leadId = lead.id;
  let contactId = null;
  if (lead.contacts) {
    for (const c of lead.contacts) {
      if (c.phones && c.phones.some((ph) => phonesMatch(ph.phone, parsed.remote_phone))) {
        contactId = c.id;
        break;
      }
    }
    if (!contactId && lead.contacts.length) contactId = lead.contacts[0].id;
  }
  if (!contactId) {
    return result({ success: false, lead_id: leadId, error: "No contact ID" });
  }

  const currentUserId = parsed.is_incoming ? null : await getCurrentUser();
  let responsibleUserId = null;
  if (parsed.is_incoming) {
    const cfUser = getCustomFieldValue(lead, responsibleField);
    if (cfUser && cfUser !== excludedUserId) {
      responsibleUserId = cfUser;
      log(`Step 5: User via Custom Field (${responsibleUserId})`);
    } else {
      const hist = await findResponsibleUserFromHistory(leadId);
      if (hist) {
        responsibleUserId = hist.userId;
        log(`Step 5: User via ${hist.source} (${responsibleUserId})`);
      } else {
        log("Step 5: Kein zuständiger User (Custom Field leer/excluded, History leer)");
      }
    }
  }

  const activityAt = isoFromTimestamp(parsed.timestamp, payload.date_time);
  const activityData = {
    organization_id: lead.organization_id,
    lead_id: leadId,
    contact_id: contactId,
    status: parsed.is_incoming ? "received" : "sent",
    direction: parsed.is_incoming ? "incoming" : "outgoing",
    activity_at: activityAt,
    local_phone: `+${parsed.local_phone}`,
    remote_phone: `+${parsed.remote_phone}`,
    message_markdown: parsed.text,
    external_whatsapp_message_id: parsed.id,
  };
  if (parsed.is_incoming && responsibleUserId) activityData.user_id = responsibleUserId;
  else if (!parsed.is_incoming && currentUserId) activityData.user_id = currentUserId;

  const checkRes = await httpJson("GET", "https://api.close.com/api/v1/activity/whatsapp_message/", {
    headers: closeHeaders,
    qs: { external_whatsapp_message_id: parsed.id },
  });
  if (checkRes.data && checkRes.data.data && checkRes.data.data.length) {
    const duplicateId = checkRes.data.data[0].id;
    log(`Step 6: Duplicate ${duplicateId}`);
    return result({
      success: true,
      lead_id: leadId,
      action: "skipped_duplicate",
      duplicate_activity_id: duplicateId,
    });
  }

  const createUrl = parsed.is_incoming
    ? "https://api.close.com/api/v1/activity/whatsapp_message/?send_to_inbox=true"
    : "https://api.close.com/api/v1/activity/whatsapp_message/";
  const createRes = await httpJson("POST", createUrl, { headers: closeHeadersJson, body: activityData });
  if (createRes.status < 200 || createRes.status >= 300) {
    return result({
      success: false,
      lead_id: leadId,
      error: "Creation failed",
      details: createRes.data,
      http_status: createRes.status,
    });
  }
  const newActivity = createRes.data || {};
  log("Step 8: Activity Created");

  let taskCreated = false;
  let taskReason = "";
  if (parsed.is_incoming) {
    if (shouldCreateTask) {
      if (responsibleUserId) {
        const taskRes = await httpJson("POST", "https://api.close.com/api/v1/task/", {
          headers: closeHeadersJson,
          body: {
            text: "WhatsApp beantworten",
            lead_id: leadId,
            assigned_to: responsibleUserId,
            due_date: String(activityAt).split("T")[0],
            is_complete: false,
          },
        });
        taskCreated = taskRes.status >= 200 && taskRes.status < 300;
        taskReason = taskCreated ? "Created successfully" : `Task HTTP ${taskRes.status}`;
      } else {
        taskReason = "Skipped: No valid responsible user found";
      }
    } else {
      taskReason = "Skipped: create_task parameter set to false";
    }
  }

  return result({
    success: true,
    lead_id: leadId,
    activity_id: newActivity.id,
    task_created: taskCreated,
    task_reason: taskReason,
    media_url: parsed.media_url,
    media_type: parsed.type,
    direction: activityData.direction,
    remote_phone: parsed.remote_phone,
  });
}

return await main();
