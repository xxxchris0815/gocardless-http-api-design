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
 *  excluded_phone_number, excluded_user_id, field_id_responsible_user,
 *  evolution_base_url, evolution_api_key, upload_media
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
const MEDIA_UPLOAD_KINDS = ["image", "video", "audio", "voice", "document", "sticker"];
const MAX_MEDIA_BYTES = 20 * 1024 * 1024;

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

function needsMediaUpload(kind) {
  return MEDIA_UPLOAD_KINDS.includes(kind);
}

function stripMime(mime) {
  return String(mime || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
}

function filenameForMedia(kind, mime, given) {
  const givenName = String(given || "").trim();
  if (givenName) return givenName.replace(/[^\w.\-]+/g, "_");
  const map = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "audio/ogg": "ogg",
    "audio/opus": "ogg",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "audio/aac": "aac",
    "video/mp4": "mp4",
    "video/3gpp": "3gp",
    "application/pdf": "pdf",
  };
  const clean = stripMime(mime);
  let ext = map[clean];
  if (!ext && clean.includes("/")) ext = clean.split("/")[1].replace(/[^a-z0-9]/g, "") || "bin";
  if (!ext) ext = "bin";
  const prefix =
    { image: "photo", video: "video", audio: "audio", voice: "voice", document: "document", sticker: "sticker" }[
      kind
    ] || "media";
  return `${prefix}.${ext}`;
}

function decodeEvolutionBase64(data) {
  if (!data) return null;
  let payload = data;
  if (typeof data === "string") {
    try {
      payload = JSON.parse(data);
    } catch (e) {
      payload = { base64: data };
    }
  }
  if (typeof payload !== "object") return null;
  const nested = payload.data && typeof payload.data === "object" ? payload.data : null;
  const b64raw = payload.base64 || payload.buffer || (nested && (nested.base64 || nested.buffer));
  if (!b64raw || typeof b64raw !== "string") return null;
  let b64 = b64raw.replace(/\s/g, "");
  let mimeFromUri = "";
  const uri = /^data:([^;]+);base64,(.+)$/i.exec(b64);
  if (uri) {
    mimeFromUri = uri[1];
    b64 = uri[2];
  }
  const buffer = Buffer.from(b64, "base64");
  if (!buffer.length) return null;
  return {
    buffer,
    mimetype: stripMime(payload.mimetype || payload.mimeType || (nested && nested.mimetype) || mimeFromUri),
    fileName: payload.fileName || payload.filename || (nested && (nested.fileName || nested.filename)) || "",
    mediaType: payload.mediaType || (nested && nested.mediaType) || "",
  };
}

function buildMultipart(fields, filename, contentType, buffer) {
  const boundary = `----CloseUpload${Date.now()}${Math.random().toString(16).slice(2)}`;
  const parts = [];
  Object.keys(fields || {}).forEach((key) => {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${fields[key]}\r\n`,
        "utf8"
      )
    );
  });
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
      "utf8"
    )
  );
  parts.push(buffer);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"));
  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    body: Buffer.concat(parts),
  };
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
  if (inner.conversation) {
    return { kind: "text", caption: String(inner.conversation), link: null, extra: "", mimetype: "", filename: "" };
  }
  if (inner.extendedTextMessage) {
    return {
      kind: "text",
      caption: String(inner.extendedTextMessage.text || ""),
      link: null,
      extra: "",
      mimetype: "",
      filename: "",
    };
  }
  if (inner.imageMessage) {
    const img = inner.imageMessage;
    return {
      kind: "image",
      caption: String(img.caption || ""),
      link: img.url || img.mediaUrl || null,
      extra: "",
      mimetype: img.mimetype || "image/jpeg",
      filename: "",
    };
  }
  if (inner.videoMessage) {
    const vid = inner.videoMessage;
    return {
      kind: "video",
      caption: String(vid.caption || ""),
      link: vid.url || vid.mediaUrl || null,
      extra: "",
      mimetype: vid.mimetype || "video/mp4",
      filename: "",
    };
  }
  if (inner.audioMessage) {
    const aud = inner.audioMessage;
    return {
      kind: aud.ptt ? "voice" : "audio",
      caption: "",
      link: aud.url || aud.mediaUrl || null,
      extra: "",
      mimetype: aud.mimetype || "audio/ogg",
      filename: "",
    };
  }
  if (inner.documentMessage) {
    const doc = inner.documentMessage;
    return {
      kind: "document",
      caption: String(doc.caption || ""),
      link: doc.url || doc.mediaUrl || null,
      extra: String(doc.fileName || doc.filename || "Dokument"),
      mimetype: doc.mimetype || "application/octet-stream",
      filename: String(doc.fileName || doc.filename || ""),
    };
  }
  if (inner.stickerMessage) {
    const st = inner.stickerMessage;
    return {
      kind: "sticker",
      caption: "",
      link: st.url || st.mediaUrl || null,
      extra: "",
      mimetype: st.mimetype || "image/webp",
      filename: "",
    };
  }
  if (inner.reactionMessage) {
    return {
      kind: "reaction",
      caption: String(inner.reactionMessage.text || ""),
      link: null,
      extra: "",
      mimetype: "",
      filename: "",
    };
  }
  if (inner.locationMessage) {
    const loc = inner.locationMessage;
    return {
      kind: "location",
      caption: String(loc.name || loc.address || ""),
      link: null,
      extra: "",
      mimetype: "",
      filename: "",
    };
  }
  if (inner.contactMessage) {
    return {
      kind: "contact",
      caption: String(inner.contactMessage.displayName || ""),
      link: null,
      extra: "",
      mimetype: "",
      filename: "",
    };
  }
  if (messageType === "conversation") {
    return { kind: "text", caption: "", link: null, extra: "", mimetype: "", filename: "" };
  }
  return { kind: messageType || "unknown", caption: "", link: null, extra: "", mimetype: "", filename: "" };
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
  const { kind, caption, link, extra, mimetype, filename } = evolutionContent(inner, data.messageType || "");
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
    mimetype: mimetype || "",
    filename: filename || "",
    raw_key: key,
    raw_message: data.message || {},
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

async function httpCall(method, url, { headers = {}, body, qs, timeout = 20000, json = true } = {}) {
  const options = {
    method,
    url,
    headers,
    json,
    ignoreHttpStatusErrors: true,
    returnFullResponse: true,
    timeout,
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
    const fetchHeaders = { ...headers };
    let fetchBody;
    if (body !== undefined) {
      if (json) {
        if (!fetchHeaders["Content-Type"] && !fetchHeaders["content-type"]) {
          fetchHeaders["Content-Type"] = "application/json";
        }
        fetchBody = JSON.stringify(body);
      } else {
        fetchBody = body;
      }
    }
    const res = await fetch(fetchUrl, {
      method,
      headers: fetchHeaders,
      body: fetchBody,
    });
    let data = null;
    if (json) {
      try {
        data = await res.json();
      } catch (e) {
        data = null;
      }
    } else {
      data = await res.text();
    }
    return { status: res.status, data };
  }
  throw new Error("Kein HTTP-Helper in diesem Code-Node.");
}

async function httpJson(method, url, opts = {}) {
  return httpCall(method, url, { ...opts, json: true });
}

function normalizeEvolutionBase(url) {
  return String(url || "")
    .trim()
    .replace(/\/+$/, "");
}

function pickEvolutionApiKeyFromWebhook() {
  const items = jsonFromNode("WhatsApp Webhook");
  for (const it of items) {
    const k = (it && it.body && it.body.apikey) || (it && it.apikey);
    if (k) return String(k).trim();
  }
  return "";
}

async function fetchEvolutionMedia({ baseUrl, apiKey, instance, key, message }) {
  const inst = encodeURIComponent(instance);
  const headers = { apikey: apiKey, Accept: "application/json", "Content-Type": "application/json" };
  const body = {
    message: {
      key: {
        id: key && key.id,
        remoteJid: key && key.remoteJid,
        fromMe: Boolean(key && key.fromMe),
      },
      message,
    },
    convertToMp4: false,
  };
  const paths = [`/chat/getBase64FromMediaMessage/${inst}`, `/message/getBase64FromMediaMessage/${inst}`];
  let last = null;
  for (const p of paths) {
    const res = await httpJson("POST", `${baseUrl}${p}`, { headers, body, timeout: 60000 });
    last = res;
    if (res.status >= 200 && res.status < 300) {
      const decoded = decodeEvolutionBase64(res.data);
      if (decoded) return decoded;
    }
  }
  const errDetail =
    last && last.data && (last.data.message || last.data.error || last.data.status);
  throw new Error(`Evolution media HTTP ${last && last.status}${errDetail ? `: ${errDetail}` : ""}`);
}

async function uploadCloseFile({ authHeaders, filename, contentType, buffer }) {
  const metaRes = await httpJson("POST", "https://api.close.com/api/v1/files/upload/", {
    headers: { ...authHeaders, "Content-Type": "application/json" },
    body: { filename, content_type: contentType },
    timeout: 20000,
  });
  if (metaRes.status < 200 || metaRes.status >= 300 || !metaRes.data || !metaRes.data.upload) {
    throw new Error(`Close files/upload HTTP ${metaRes.status}`);
  }
  const downloadUrl = metaRes.data.download && metaRes.data.download.url;
  if (!downloadUrl) throw new Error("Close files/upload ohne download.url");
  const multipart = buildMultipart(metaRes.data.upload.fields || {}, filename, contentType, buffer);
  const s3 = await httpCall("POST", metaRes.data.upload.url, {
    headers: { "Content-Type": multipart.contentType },
    body: multipart.body,
    json: false,
    timeout: 60000,
  });
  if (s3.status !== 201 && s3.status !== 200 && s3.status !== 204) {
    throw new Error(`Close S3 upload HTTP ${s3.status}`);
  }
  return {
    url: downloadUrl,
    filename,
    size: buffer.length,
    content_type: contentType,
  };
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
  const evolutionBase = normalizeEvolutionBase(pick("evolution_base_url", "EVOLUTION_BASE_URL", ""));
  const evolutionKey =
    String(pick("evolution_api_key", "EVOLUTION_API_KEY", "")).trim() || pickEvolutionApiKeyFromWebhook();
  const shouldUploadMedia = pickBool("upload_media", "WA_UPLOAD_MEDIA", true);

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

  let attachments = [];
  let mediaUploadError = "";
  if (shouldUploadMedia && needsMediaUpload(parsed.type)) {
    if (!evolutionBase) {
      mediaUploadError = "evolution_base_url fehlt";
      log(`Step 7: Media-Upload übersprungen (${mediaUploadError})`);
    } else if (!evolutionKey) {
      mediaUploadError = "evolution_api_key fehlt";
      log(`Step 7: Media-Upload übersprungen (${mediaUploadError})`);
    } else if (!parsed.instance) {
      mediaUploadError = "instance fehlt im Webhook";
      log(`Step 7: Media-Upload übersprungen (${mediaUploadError})`);
    } else {
      try {
        const media = await fetchEvolutionMedia({
          baseUrl: evolutionBase,
          apiKey: evolutionKey,
          instance: parsed.instance,
          key: parsed.raw_key || { id: parsed.id },
          message: parsed.raw_message,
        });
        if (media.buffer.length > MAX_MEDIA_BYTES) {
          mediaUploadError = `Datei zu groß (${media.buffer.length} bytes)`;
          log(`Step 7: Media-Upload übersprungen (${mediaUploadError})`);
        } else {
          const contentType =
            stripMime(media.mimetype || parsed.mimetype) || "application/octet-stream";
          const filename = filenameForMedia(
            parsed.type,
            contentType,
            media.fileName || parsed.filename
          );
          attachments.push(
            await uploadCloseFile({
              authHeaders: closeHeaders,
              filename,
              contentType,
              buffer: media.buffer,
            })
          );
          log(`Step 7: Media hochgeladen (${contentType}, ${attachments[0].size} bytes)`);
        }
      } catch (e) {
        mediaUploadError = String(e.message || e);
        log(`Step 7: Media-Upload fehlgeschlagen: ${mediaUploadError}`);
      }
    }
  }

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
  if (attachments.length) activityData.attachments = attachments;
  if (parsed.is_incoming && responsibleUserId) activityData.user_id = responsibleUserId;
  else if (!parsed.is_incoming && currentUserId) activityData.user_id = currentUserId;

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
    media_uploaded: Boolean(attachments.length),
    media_upload_error: mediaUploadError || undefined,
    direction: activityData.direction,
    remote_phone: parsed.remote_phone,
  });
}

return await main();
