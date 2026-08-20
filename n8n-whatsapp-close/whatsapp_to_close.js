/**
 * WhatsApp Webhook → Close Lead Activity (n8n Code-Node, JavaScript)
 *
 * Nur Evolution API: send.message / messages.upsert.
 *
 * n8n-Setup:
 *  1. Webhook-Node (POST /whatsapp-close), Response: Immediately
 *  2. Optional Filter: event ist send.message oder messages.upsert
 *  3. Set-Node mit Config, Include Other Input Fields = an
 *  4. Dieser Code-Node: Run Once for All Items, JavaScript
 *
 * Medien: Evolution legt eine öffentliche S3-mediaUrl in data.message.mediaUrl.
 * Voice/Call: Close-Player akzeptiert nur MP3. Ablauf:
 *  1. OGA von Evolution-S3 laden
 *  2. ffmpeg → MP3
 *  3. MP3 nach MinIO legen (dieselben Keys wie Evolution)
 *  4. signierte GET-URL als Close recording_url
 * Andere Medien: S3-Link in der WhatsApp-Activity.
 *
 * Config:
 *  close_api_key, create_task,
 *  excluded_phone_number, excluded_user_id, field_id_responsible_user,
 *  evolution_base_url, evolution_api_key, upload_media,
 *  s3_access_key, s3_secret_key (MinIO). s3_endpoint / s3_bucket optional
 *  (sonst aus mediaUrl). s3_region default us-east-1.
 *  my_whatsapp_number nur optional, falls Evolution die Nummer nicht liefert
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
const MEDIA_UPLOAD_KINDS = ["image", "video", "gif", "audio", "voice", "document", "sticker"];
const MAX_MEDIA_BYTES = 20 * 1024 * 1024;
const EVOLUTION_STRIP_KEYS = [
  "jpegThumbnail",
  "waveform",
  "firstScanSidecar",
  "streamingSidecar",
  "interactiveAnnotations",
  "annotations",
  "processedVideos",
  "messageContextInfo",
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

function needsMediaUpload(kind) {
  return MEDIA_UPLOAD_KINDS.includes(kind);
}

function stripMime(mime) {
  return String(mime || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
}

function filenameFromUrl(url) {
  try {
    const name = decodeURIComponent(new URL(url).pathname.split("/").pop() || "");
    return name.replace(/[^\w.\-]+/g, "_");
  } catch (e) {
    return "";
  }
}

function looksLikeMp3(buffer) {
  if (!buffer || buffer.length < 3) return false;
  if (buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33) return true;
  return buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0;
}

function isMp3Audio(buffer, mime, filename) {
  if (looksLikeMp3(buffer)) return true;
  const m = stripMime(mime);
  if (m === "audio/mpeg" || m === "audio/mp3") return true;
  return /\.mp3(\?|$)/i.test(String(filename || ""));
}

function needsMp3ForCloseRecording(url, mime) {
  const m = stripMime(mime);
  if (m === "audio/mpeg" || m === "audio/mp3") return false;
  let path = "";
  try {
    path = new URL(String(url || "")).pathname.toLowerCase();
  } catch (e) {
    path = String(url || "").toLowerCase();
  }
  if (path.endsWith(".mp3")) return false;
  if (m.startsWith("audio/") || m === "application/ogg" || m === "video/mp4" || m === "audio/mp4") return true;
  return [".oga", ".ogg", ".opus", ".m4a", ".wav", ".aac"].some((ext) => path.endsWith(ext));
}

async function downloadBinary(url, timeout = 60000) {
  if (typeof fetch === "function") {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Download HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
  if (httpHelper) {
    const result = await httpHelper({
      method: "GET",
      url,
      encoding: "arraybuffer",
      json: false,
      returnFullResponse: true,
      ignoreHttpStatusErrors: true,
      timeout,
    });
    const status = result && result.statusCode;
    const body = result && typeof result === "object" && "body" in result ? result.body : result;
    if (status && status >= 400) throw new Error(`Download HTTP ${status}`);
    if (Buffer.isBuffer(body)) return body;
    if (body instanceof ArrayBuffer) return Buffer.from(body);
    if (typeof body === "string") return Buffer.from(body, "binary");
    return Buffer.from(body || []);
  }
  throw new Error("Kein HTTP-Helper für Binary-Download");
}

function tryFfmpegToMp3(buffer) {
  if (!buffer || !buffer.length) return null;
  let execFileSync;
  try {
    execFileSync = require("child_process").execFileSync;
  } catch (e) {
    log(`ffmpeg: child_process nicht erlaubt (${e.message || e})`);
    return null;
  }
  const attempts = [
    ["-y", "-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-vn", "-ac", "1", "-ar", "16000", "-codec:a", "libmp3lame", "-b:a", "32k", "-f", "mp3", "pipe:1"],
    ["-y", "-hide_banner", "-loglevel", "error", "-f", "ogg", "-i", "pipe:0", "-vn", "-ac", "1", "-ar", "16000", "-codec:a", "libmp3lame", "-b:a", "32k", "-f", "mp3", "pipe:1"],
  ];
  for (let i = 0; i < attempts.length; i++) {
    try {
      const out = execFileSync("ffmpeg", attempts[i], {
        input: buffer,
        timeout: 45000,
        maxBuffer: MAX_MEDIA_BYTES,
      });
      if (out && out.length > 64 && looksLikeMp3(out)) return Buffer.from(out);
    } catch (e) {
      log(`ffmpeg Versuch ${i + 1}: ${String(e.message || e).slice(0, 200)}`);
    }
  }
  return null;
}

function parseS3MediaUrl(url) {
  const raw = String(url || "").trim();
  if (!raw.startsWith("http")) return null;
  try {
    const u = new URL(raw.split("?")[0]);
    const parts = u.pathname.split("/").filter(Boolean).map((p) => {
      try {
        return decodeURIComponent(p);
      } catch (e) {
        return p;
      }
    });
    if (!parts.length) return { endpoint: `${u.protocol}//${u.host}`, bucket: "", key: "" };
    return {
      endpoint: `${u.protocol}//${u.host}`,
      bucket: parts[0],
      key: parts.slice(1).join("/"),
    };
  } catch (e) {
    return null;
  }
}

function mp3KeyFromSource(key, msgId) {
  let raw = String(key || "").split("?")[0].replace(/^\//, "");
  if (raw) {
    if (/\.(oga|ogg|opus|m4a|aac|wav|mp4)$/i.test(raw)) return raw.replace(/\.[^.]+$/, ".mp3");
    if (/\.mp3$/i.test(raw)) return raw;
    return `${raw}.mp3`;
  }
  const id = String(msgId || "voice").replace(/[^\w.-]/g, "");
  return `evolution-api/close-mp3/${Date.now()}_${id}.mp3`;
}

function bytesToHex(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < arr.length; i++) s += arr[i].toString(16).padStart(2, "0");
  return s;
}

function toUtf8Bytes(str) {
  return new TextEncoder().encode(String(str));
}

function awsUriEncode(input, encodeSlash) {
  const s = String(input);
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (
      (ch >= "A" && ch <= "Z") ||
      (ch >= "a" && ch <= "z") ||
      (ch >= "0" && ch <= "9") ||
      ch === "_" ||
      ch === "-" ||
      ch === "~" ||
      ch === "."
    ) {
      out += ch;
    } else if (ch === "/" && !encodeSlash) {
      out += "/";
    } else {
      out += `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  return out;
}

function amzTimestamps() {
  const iso = new Date().toISOString();
  const amzDate = iso.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

async function sha256Hex(data) {
  const bytes = Buffer.isBuffer(data) ? new Uint8Array(data) : data instanceof Uint8Array ? data : toUtf8Bytes(data);
  if (globalThis.crypto && crypto.subtle) {
    return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
  }
  const c = require("crypto");
  return c.createHash("sha256").update(Buffer.from(bytes)).digest("hex");
}

async function hmacSha256(keyBytes, data) {
  const key = keyBytes instanceof Uint8Array ? keyBytes : new Uint8Array(keyBytes);
  const payload = typeof data === "string" ? toUtf8Bytes(data) : data instanceof Uint8Array ? data : new Uint8Array(data);
  if (globalThis.crypto && crypto.subtle) {
    const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, payload));
  }
  const c = require("crypto");
  return new Uint8Array(c.createHmac("sha256", Buffer.from(key)).update(Buffer.from(payload)).digest());
}

async function awsSigningKey(secret, dateStamp, region, service) {
  const kDate = await hmacSha256(toUtf8Bytes(`AWS4${secret}`), dateStamp);
  const kRegion = await hmacSha256(kDate, region);
  const kService = await hmacSha256(kRegion, service);
  return hmacSha256(kService, "aws4_request");
}

function s3Host(endpoint) {
  return new URL(endpoint).host;
}

function s3ObjectUrl(endpoint, bucket, key) {
  const base = String(endpoint).replace(/\/+$/, "");
  const path = `/${awsUriEncode(bucket, true)}/${awsUriEncode(key, false)}`;
  return `${base}${path}`;
}

function s3CanonicalUri(bucket, key) {
  return `/${awsUriEncode(bucket, true)}/${awsUriEncode(key, false)}`;
}

async function putMinioObject({ endpoint, bucket, key, body, accessKey, secretKey, region, contentType }) {
  const { amzDate, dateStamp } = amzTimestamps();
  const host = s3Host(endpoint);
  const payloadHash = await sha256Hex(body);
  const canonicalUri = s3CanonicalUri(bucket, key);
  const headersLower = {
    "content-type": contentType || "application/octet-stream",
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  const signedHeaders = Object.keys(headersLower).sort().join(";");
  const canonicalHeaders = Object.keys(headersLower)
    .sort()
    .map((k) => `${k}:${headersLower[k]}\n`)
    .join("");
  const canonicalRequest = ["PUT", canonicalUri, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256Hex(canonicalRequest)].join("\n");
  const signingKey = await awsSigningKey(secretKey, dateStamp, region, "s3");
  const signature = bytesToHex(await hmacSha256(signingKey, stringToSign));
  const auth = `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const url = s3ObjectUrl(endpoint, bucket, key);
  const headers = {
    "Content-Type": headersLower["content-type"],
    Host: host,
    "X-Amz-Content-Sha256": payloadHash,
    "X-Amz-Date": amzDate,
    Authorization: auth,
  };
  if (typeof fetch === "function") {
    const res = await fetch(url, { method: "PUT", headers, body });
    const text = await res.text();
    return { status: res.status, data: text };
  }
  return httpCall("PUT", url, { headers, body, json: false, timeout: 60000 });
}

async function presignMinioGet({ endpoint, bucket, key, accessKey, secretKey, region, expires }) {
  const { amzDate, dateStamp } = amzTimestamps();
  const host = s3Host(endpoint);
  const canonicalUri = s3CanonicalUri(bucket, key);
  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const credential = `${accessKey}/${scope}`;
  const query = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": credential,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(expires || 604800),
    "X-Amz-SignedHeaders": "host",
  };
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((k) => `${awsUriEncode(k, true)}=${awsUriEncode(query[k], true)}`)
    .join("&");
  const canonicalRequest = ["GET", canonicalUri, canonicalQuery, `host:${host}\n`, "host", "UNSIGNED-PAYLOAD"].join("\n");
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256Hex(canonicalRequest)].join("\n");
  const signingKey = await awsSigningKey(secretKey, dateStamp, region, "s3");
  const signature = bytesToHex(await hmacSha256(signingKey, stringToSign));
  return `${s3ObjectUrl(endpoint, bucket, key)}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

async function uploadMp3ToMinio({ mediaUrl, mp3, msgId, accessKey, secretKey, region, endpointCfg, bucketCfg }) {
  const parsedS3 = parseS3MediaUrl(mediaUrl);
  const endpoint = String(endpointCfg || (parsedS3 && parsedS3.endpoint) || "").replace(/\/+$/, "");
  const bucket = String(bucketCfg || (parsedS3 && parsedS3.bucket) || "").trim();
  if (!endpoint || !bucket) {
    throw new Error("s3_endpoint / s3_bucket fehlen (oder mediaUrl ohne Bucket-Pfad)");
  }
  if (!accessKey || !secretKey) {
    throw new Error("s3_access_key / s3_secret_key fehlen in Config (MinIO-Keys wie bei Evolution)");
  }
  const key = mp3KeyFromSource(parsedS3 && parsedS3.key, msgId);
  const putRes = await putMinioObject({
    endpoint,
    bucket,
    key,
    body: mp3,
    accessKey,
    secretKey,
    region: region || "us-east-1",
    contentType: "audio/mpeg",
  });
  if (putRes.status !== 200 && putRes.status !== 204) {
    const detail = typeof putRes.data === "string" ? putRes.data.slice(0, 180) : "";
    throw new Error(`MinIO PUT HTTP ${putRes.status}${detail ? `: ${detail}` : ""}`);
  }
  const url = await presignMinioGet({
    endpoint,
    bucket,
    key,
    accessKey,
    secretKey,
    region: region || "us-east-1",
    expires: 604800,
  });
  return { url, bucket, key };
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
    { image: "photo", video: "video", gif: "gif", audio: "audio", voice: "voice", document: "document", sticker: "sticker" }[
      kind
    ] || "media";
  return `${prefix}.${ext}`;
}

function jidToPhone(jid) {
  const local = String(jid || "").split("@")[0];
  return cleanPhone(local.split(":")[0]);
}

function isNumericKeyedObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((k) => /^\d+$/.test(k));
}

function numericKeyedToBase64(value) {
  const keys = Object.keys(value).map(Number);
  const max = Math.max.apply(null, keys);
  const buf = Buffer.alloc(max + 1);
  keys.forEach((idx) => {
    buf[idx] = Number(value[String(idx)]) & 255;
  });
  return buf.toString("base64");
}

function isLongObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (!keys.length || !Object.prototype.hasOwnProperty.call(value, "low")) return false;
  return keys.every((k) => k === "low" || k === "high" || k === "unsigned");
}

function longToNumber(value) {
  const low = Number(value.low) >>> 0;
  const high = Number(value.high) || 0;
  if (!high) return value.unsigned ? low : low | 0;
  return high * 0x100000000 + low;
}

function normalizeForEvolution(node, depth) {
  depth = depth || 0;
  if (node === undefined || node === null) return node;
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(node)) return node.toString("base64");
  if (Array.isArray(node)) return node.map((item) => normalizeForEvolution(item, depth + 1));
  if (typeof node !== "object") return node;
  if (isLongObject(node)) return longToNumber(node);
  if (isNumericKeyedObject(node)) {
    const size = Object.keys(node).length;
    if (size > 64) return undefined;
    return numericKeyedToBase64(node);
  }
  const out = {};
  Object.keys(node).forEach((key) => {
    if (EVOLUTION_STRIP_KEYS.includes(key)) return;
    const val = normalizeForEvolution(node[key], depth + 1);
    if (val !== undefined) out[key] = val;
  });
  return out;
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

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (ch) => {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
  });
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

function firstPublicMediaUrl() {
  const candidates = [];
  for (let i = 0; i < arguments.length; i++) {
    const cand = arguments[i];
    if (!cand) continue;
    if (Array.isArray(cand)) {
      for (let j = 0; j < cand.length; j++) candidates.push(cand[j]);
    } else {
      candidates.push(cand);
    }
  }
  for (let i = 0; i < candidates.length; i++) {
    const pub = publicMediaUrl(candidates[i]);
    if (pub) return pub;
  }
  return null;
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
  if (kind === "gif") {
    const body = caption || "🎞️ GIF empfangen";
    return `${body}${createMediaLink(link, "▶️", "GIF ansehen")}`;
  }
  if (kind === "audio" || kind === "voice") {
    const dur = extra ? ` (${extra})` : "";
    return `🎤 Sprachnachricht empfangen${dur}${createMediaLink(link, "▶️", "Abspielen")}`;
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
    const isGif = Boolean(vid.gifPlayback);
    return {
      kind: isGif ? "gif" : "video",
      caption: String(vid.caption || vid.accessibilityLabel || ""),
      link: vid.url || vid.mediaUrl || null,
      extra: "",
      mimetype: vid.mimetype || "video/mp4",
      filename: isGif ? "gif.mp4" : "",
    };
  }
  if (inner.audioMessage) {
    const aud = inner.audioMessage;
    const secs = Number(aud.seconds);
    return {
      kind: aud.ptt ? "voice" : "audio",
      caption: "",
      link: aud.url || aud.mediaUrl || null,
      extra: Number.isFinite(secs) && secs > 0 ? `${Math.round(secs)}s` : "",
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

  const rawMessage = data.message || {};
  const inner = unwrapMessage(rawMessage);
  const { kind, caption, link, extra, mimetype, filename } = evolutionContent(inner, data.messageType || "");
  const mediaUrl = firstPublicMediaUrl(
    inner.mediaUrl,
    rawMessage.mediaUrl,
    data.mediaUrl,
    data.media_url,
    link
  );
  let text = messageTextFromParts(kind, caption, mediaUrl, extra);
  if (!String(text).trim()) {
    if (kind === "reaction") return { skip: true, reason: "Reaction removed", id: msgId };
    text = `[Mediennachricht: ${kind || data.messageType || "unknown"}]`;
  }

  const remotePhone = jidToPhone(remoteJid);
  const senderPhone = jidToPhone(payload.sender);
  return {
    id: msgId,
    is_incoming: !fromMe,
    remote_phone: remotePhone,
    local_phone: senderPhone || cleanPhone(defaultLocalPhone),
    type: kind,
    text,
    media_url: mediaUrl,
    timestamp: data.messageTimestamp,
    instance: payload.instance,
    event,
    mimetype: mimetype || "",
    filename: filename || "",
    server_url: payload.server_url || "",
    from_name: data.pushName || "",
    duration_seconds:
      inner.audioMessage && Number.isFinite(Number(inner.audioMessage.seconds))
        ? Math.round(Number(inner.audioMessage.seconds))
        : 0,
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

async function httpCall(method, url, { headers = {}, body, qs, timeout = 20000, json = true, followRedirect = true, maxRedirects } = {}) {
  const options = {
    method,
    url,
    headers,
    json,
    ignoreHttpStatusErrors: true,
    returnFullResponse: true,
    timeout,
    followRedirect,
  };
  if (maxRedirects !== undefined) options.maxRedirects = maxRedirects;
  if (body !== undefined) options.body = body;
  if (qs !== undefined) options.qs = qs;

  if (httpHelper) {
    const result = await httpHelper(options);
    if (result && typeof result === "object" && "statusCode" in result) {
      return { status: result.statusCode, data: result.body, headers: result.headers || {} };
    }
    return { status: 200, data: result, headers: {} };
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
      redirect: followRedirect ? "follow" : "manual",
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
    const headersOut = {};
    if (res.headers && typeof res.headers.forEach === "function") {
      res.headers.forEach((value, key) => {
        headersOut[key] = value;
      });
    }
    return { status: res.status, data, headers: headersOut };
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
    const k = (it && it.body && it.body.apikey) || (it && it.apikey) || (it && it._evo_apikey);
    if (k) return String(k).trim();
  }
  return "";
}

function pickEvolutionBase(payload) {
  return normalizeEvolutionBase(
    pick("evolution_base_url", "EVOLUTION_BASE_URL", "") ||
      (payload && payload.server_url) ||
      inputItem.server_url ||
      (inputItem.body && inputItem.body.server_url) ||
      ""
  );
}

function pickEvolutionKey(payload) {
  return (
    String(pick("evolution_api_key", "EVOLUTION_API_KEY", "")).trim() ||
    String((payload && payload.apikey) || "").trim() ||
    String(inputItem._evo_apikey || "").trim() ||
    pickEvolutionApiKeyFromWebhook()
  );
}

function phoneFromInstanceInfo(data, instanceName) {
  const want = String(instanceName || "").toLowerCase();
  let rows = [];
  if (Array.isArray(data)) rows = data;
  else if (data && typeof data === "object") {
    if (Array.isArray(data.instance)) rows = data.instance;
    else rows = [data];
  }
  const phones = [];
  for (const row of rows) {
    const inst = (row && row.instance) || row || {};
    const name = String(inst.instanceName || inst.name || "").toLowerCase();
    const owner = inst.owner || inst.ownerJid || inst.wuid || inst.wid || inst.number || "";
    const phone = jidToPhone(owner) || cleanPhone(inst.number);
    if (!phone) continue;
    if (want && name && name !== want) continue;
    phones.push(phone);
    if (want && name === want) return phone;
  }
  return phones[0] || "";
}

async function fetchEvolutionInstancePhone({ baseUrl, apiKey, instance }) {
  if (!baseUrl || !apiKey || !instance) return "";
  const headers = { apikey: apiKey, Accept: "application/json" };
  const urls = [
    `${baseUrl}/instance/fetchInstances?instanceName=${encodeURIComponent(instance)}`,
    `${baseUrl}/instance/fetchInstances`,
  ];
  let last = null;
  for (const url of urls) {
    const res = await httpJson("GET", url, { headers, timeout: 15000 });
    last = res;
    if (res.status >= 200 && res.status < 300) {
      const phone = phoneFromInstanceInfo(res.data, instance);
      if (phone) return phone;
    }
  }
  const errDetail = last && last.data && (last.data.message || last.data.error);
  if (last && last.status && last.status >= 400) {
    log(`fetchInstances HTTP ${last.status}${errDetail ? `: ${errDetail}` : ""}`);
  }
  return "";
}

function isCloseAppFileUrl(url) {
  const raw = String(url || "");
  if (!raw) return false;
  try {
    const host = new URL(raw).hostname.toLowerCase();
    return host === "app.close.com" || host === "api.close.com" || host.endsWith(".close.com");
  } catch (e) {
    return /close\.com\/go\/file/i.test(raw);
  }
}

function headerGet(headers, name) {
  if (!headers || typeof headers !== "object") return "";
  const want = String(name || "").toLowerCase();
  const keys = Object.keys(headers);
  for (const key of keys) {
    if (String(key).toLowerCase() === want) {
      const val = headers[key];
      if (Array.isArray(val)) return String(val[0] || "");
      return String(val || "");
    }
  }
  return "";
}

function isPublicRecordingUrl(url) {
  const raw = String(url || "").trim();
  if (!raw.startsWith("https://")) return false;
  if (isCloseAppFileUrl(raw)) return false;
  return /[?&](X-Amz-Signature|X-Amz-Credential|Key-Pair-Id|AWSAccessKeyId)=/i.test(raw);
}

function headersForUrl(url, authHeaders) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host === "api.close.com" || host === "app.close.com" || host.endsWith(".close.com")) {
      return authHeaders || {};
    }
  } catch (e) {
    /* ignore */
  }
  return {};
}

async function fetchRedirectLocation(url, headers) {
  if (typeof fetch === "function") {
    const res = await fetch(url, {
      method: "GET",
      headers: headers || {},
      redirect: "manual",
    });
    const loc = (res.headers && typeof res.headers.get === "function" && res.headers.get("location")) || "";
    return { status: res.status, location: loc };
  }
  const res = await httpCall("GET", url, {
    headers: headers || {},
    json: false,
    timeout: 20000,
    followRedirect: false,
    maxRedirects: 0,
  });
  return { status: res.status, location: headerGet(res.headers, "location") };
}

function extractS3Location(s3Res) {
  const loc = headerGet(s3Res && s3Res.headers, "location");
  if (loc && loc.startsWith("http")) return loc;
  const body = typeof (s3Res && s3Res.data) === "string" ? s3Res.data : "";
  const xml = /<Location>([^<]+)<\/Location>/i.exec(body);
  if (xml) return xml[1].replace(/&amp;/g, "&");
  return "";
}

function attachmentUrl(att) {
  if (!att || typeof att !== "object") return "";
  return String(att.url || att.download_url || att.href || "").trim();
}

async function resolvePublicRecordingUrl(downloadUrl, authHeaders) {
  let current = String(downloadUrl || "").trim();
  if (!current.startsWith("https://")) return "";
  for (let i = 0; i < 5; i++) {
    if (isPublicRecordingUrl(current)) return current;
    try {
      const hop = await fetchRedirectLocation(current, headersForUrl(current, authHeaders));
      const loc = String(hop.location || "").trim();
      log(`Recording-Redirect ${hop.status} ${current.split("?")[0]} → ${loc ? loc.split("?")[0] : "-"}`);
      if (!loc) return "";
      current = loc.startsWith("http") ? loc : new URL(loc, current).toString();
    } catch (e) {
      log(`Public recording URL: ${e.message || e}`);
      return "";
    }
  }
  return isPublicRecordingUrl(current) ? current : "";
}

async function fetchEvolutionMedia({ baseUrl, apiKey, instance, key, message, convertAudio }) {
  const inst = encodeURIComponent(instance);
  const headers = { apikey: apiKey, Accept: "application/json", "Content-Type": "application/json" };
  const keyOnly = {
    id: key && key.id,
    remoteJid: key && key.remoteJid,
    fromMe: Boolean(key && key.fromMe),
  };
  const convertOrder = convertAudio ? [true, false] : [false, true];
  const bodies = [];
  for (const convertToMp4 of convertOrder) {
    bodies.push({ message: { key: keyOnly }, convertToMp4 });
    bodies.push({
      message: { key: keyOnly, message: normalizeForEvolution(message) },
      convertToMp4,
    });
  }
  const paths = [`/chat/getBase64FromMediaMessage/${inst}`, `/message/getBase64FromMediaMessage/${inst}`];
  let last = null;
  for (const p of paths) {
    for (const body of bodies) {
      const res = await httpJson("POST", `${baseUrl}${p}`, { headers, body, timeout: 60000 });
      last = res;
      if (res.status >= 200 && res.status < 300) {
        const decoded = decodeEvolutionBase64(res.data);
        if (decoded) return decoded;
      }
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
    followRedirect: false,
    maxRedirects: 0,
  });
  if (s3.status !== 201 && s3.status !== 200 && s3.status !== 204) {
    throw new Error(`Close S3 upload HTTP ${s3.status}`);
  }
  const s3Location = extractS3Location(s3);
  const publicUrl =
    (isPublicRecordingUrl(s3Location) ? s3Location : "") ||
    (await resolvePublicRecordingUrl(downloadUrl, authHeaders));
  return {
    url: downloadUrl,
    filename,
    size: buffer.length,
    content_type: contentType,
    public_url: publicUrl || "",
  };
}

function closeFileAttachment(file) {
  return {
    url: file.url,
    filename: file.filename,
    size: file.size,
    content_type: file.content_type,
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
  const configLocalPhone = cleanPhone(pick("my_whatsapp_number", "MY_WHATSAPP_NUMBER", ""));
  const shouldUploadMedia = pickBool("upload_media", "WA_UPLOAD_MEDIA", true);
  const s3AccessKey = String(pick("s3_access_key", "S3_ACCESS_KEY", "")).trim();
  const s3SecretKey = String(pick("s3_secret_key", "S3_SECRET_KEY", "")).trim();
  const s3Region = String(pick("s3_region", "S3_REGION", "us-east-1")).trim() || "us-east-1";
  const s3EndpointCfg = String(pick("s3_endpoint", "S3_ENDPOINT", "")).trim();
  const s3BucketCfg = String(pick("s3_bucket", "S3_BUCKET", "")).trim();

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
  const parsed = parseWebhook(payload, configLocalPhone);
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

  const evolutionBase = pickEvolutionBase(payload);
  const evolutionKey = pickEvolutionKey(payload);

  if (evolutionBase && evolutionKey && parsed.instance) {
    try {
      const evoPhone = await fetchEvolutionInstancePhone({
        baseUrl: evolutionBase,
        apiKey: evolutionKey,
        instance: parsed.instance,
      });
      if (evoPhone) {
        parsed.local_phone = evoPhone;
        log(`Step 1b: Instanz-Nummer ${evoPhone} (${parsed.instance})`);
      } else {
        log(`Step 1b: fetchInstances ohne Nummer, Fallback ${parsed.local_phone || "leer"}`);
      }
    } catch (e) {
      log(`Step 1b: Instanz-Nummer fehlgeschlagen: ${e.message || e}`);
    }
  }
  if (!parsed.local_phone && configLocalPhone) parsed.local_phone = configLocalPhone;

  log(`Step 1: ${parsed.is_incoming ? "incoming" : "outgoing"} ${parsed.remote_phone} (${parsed.type}) local=${parsed.local_phone || "?"}`);

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

  async function findResponsibleUserFromOutbound(leadId) {
    try {
      const res = await httpJson("GET", "https://api.close.com/api/v1/activity/", {
        headers: closeHeaders,
        qs: {
          lead_id: leadId,
          _limit: 50,
          _order_by: "-date_created",
          _fields: "id,_type,direction,created_by,user_id,created_by_name,user_name,date_created",
        },
      });
      if (res.status !== 200 || !res.data || !Array.isArray(res.data.data)) return null;
      const outbound = ["outbound", "outgoing", "sent"];
      for (const act of res.data.data) {
        const userId = act.created_by || act.user_id;
        if (!userId || (excludedUserId && userId === excludedUserId)) continue;
        const dir = String(act.direction || "").toLowerCase();
        if (outbound.includes(dir)) {
          return { userId, source: "last_outbound_activity", matchId: act.id };
        }
      }
      for (const act of res.data.data) {
        const userId = act.created_by || act.user_id;
        if (!userId || (excludedUserId && userId === excludedUserId)) continue;
        return { userId, source: "most_recent_activity", matchId: act.id };
      }
    } catch (e) {
      log(`Outbound History Error: ${e.message || e}`);
    }
    return null;
  }

  async function findOpenTask(leadId, assignedTo, text) {
    const res = await httpJson("GET", "https://api.close.com/api/v1/task/", {
      headers: closeHeaders,
      qs: {
        lead_id: leadId,
        assigned_to: assignedTo,
        is_complete: false,
        _limit: 20,
      },
    });
    if (res.status !== 200 || !res.data || !Array.isArray(res.data.data)) return null;
    const want = String(text || "").trim();
    return res.data.data.find((t) => String(t.text || "").trim() === want) || null;
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
      const outbound = await findResponsibleUserFromOutbound(leadId);
      const hist = outbound || (await findResponsibleUserFromHistory(leadId));
      if (hist) {
        responsibleUserId = hist.userId;
        log(`Step 5: User via ${hist.source} (${responsibleUserId})`);
      } else {
        log("Step 5: Kein zuständiger User (Custom Field leer/excluded, History leer)");
      }
    }
  }

  const activityAt = isoFromTimestamp(parsed.timestamp, payload.date_time);
  const isVoice = parsed.type === "voice";
  const taskText = isVoice ? "WhatsApp Voice beantworten" : "WhatsApp beantworten";

  if (isVoice) {
    const recentCalls = await httpJson("GET", "https://api.close.com/api/v1/activity/call/", {
      headers: closeHeaders,
      qs: {
        lead_id: leadId,
        _limit: 20,
        _order_by: "-date_created",
        _fields: "id,note,note_html",
      },
    });
    const callDup = ((recentCalls.data && recentCalls.data.data) || []).find((c) =>
      String((c && (c.note_html || c.note)) || "").includes(parsed.id)
    );
    if (callDup) {
      log(`Step 6: Duplicate Call ${callDup.id}`);
      return result({
        success: true,
        lead_id: leadId,
        action: "skipped_duplicate",
        duplicate_activity_id: callDup.id,
        activity_type: "call",
      });
    }
  } else {
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
  }

  let attachments = [];
  let mediaUploadError = "";
  let voiceRecordingUrl = "";

  if (isVoice) {
    try {
      let source = null;
      if (parsed.media_url) {
        source = {
          buffer: await downloadBinary(parsed.media_url),
          mimetype: parsed.mimetype || "audio/ogg",
          fileName: filenameFromUrl(parsed.media_url) || "voice.oga",
        };
        log(`Step 7: S3-Audio geladen (${source.buffer.length} bytes, ${source.fileName})`);
      } else if (shouldUploadMedia && evolutionBase && evolutionKey && parsed.instance) {
        source = await fetchEvolutionMedia({
          baseUrl: evolutionBase,
          apiKey: evolutionKey,
          instance: parsed.instance,
          key: parsed.raw_key || { id: parsed.id },
          message: parsed.raw_message,
          convertAudio: true,
        });
        log(`Step 7: Evolution-Audio geladen (${source.buffer.length} bytes, ${source.mimetype})`);
      } else {
        mediaUploadError = "Keine Audio-Quelle für MP3-Konvertierung";
        log(`Step 7: ${mediaUploadError}`);
      }

      if (source && source.buffer && source.buffer.length) {
        if (source.buffer.length > MAX_MEDIA_BYTES) {
          mediaUploadError = `Datei zu groß (${source.buffer.length} bytes)`;
          log(`Step 7: Media übersprungen (${mediaUploadError})`);
        } else {
          let mp3 = isMp3Audio(source.buffer, source.mimetype, source.fileName)
            ? source.buffer
            : tryFfmpegToMp3(source.buffer);
          if (!mp3 && parsed.media_url && evolutionBase && evolutionKey && parsed.instance) {
            try {
              const converted = await fetchEvolutionMedia({
                baseUrl: evolutionBase,
                apiKey: evolutionKey,
                instance: parsed.instance,
                key: parsed.raw_key || { id: parsed.id },
                message: parsed.raw_message,
                convertAudio: true,
              });
              if (converted && converted.buffer) {
                log(`Step 7: Evolution convertToMp4 (${converted.mimetype || "?"}, ${converted.buffer.length} bytes)`);
                mp3 = isMp3Audio(converted.buffer, converted.mimetype, converted.fileName)
                  ? converted.buffer
                  : tryFfmpegToMp3(converted.buffer);
              }
            } catch (e) {
              log(`Step 7: Evolution-Konvertierung: ${e.message || e}`);
            }
          }
          if (mp3) {
            log(`Step 7a: MP3 erzeugt (${mp3.length} bytes)`);
            const uploaded = await uploadMp3ToMinio({
              mediaUrl: parsed.media_url || "",
              mp3,
              msgId: parsed.id,
              accessKey: s3AccessKey,
              secretKey: s3SecretKey,
              region: s3Region,
              endpointCfg: s3EndpointCfg,
              bucketCfg: s3BucketCfg,
            });
            voiceRecordingUrl = uploaded.url;
            log(`Step 7b: MP3 nach MinIO ${uploaded.bucket}/${uploaded.key}`);
          } else {
            mediaUploadError =
              "Close zeigt im Call-Player nur MP3, keine OGA/OGG/Opus. ffmpeg auf dem n8n-Host fehlt oder die Konvertierung ist fehlgeschlagen.";
            log(`Step 7: ${mediaUploadError}`);
          }
        }
      }
    } catch (e) {
      mediaUploadError = String(e.message || e);
      log(`Step 7: Voice-MP3 fehlgeschlagen: ${mediaUploadError}`);
    }
  } else {
    const needBinaryUpload = shouldUploadMedia && needsMediaUpload(parsed.type) && !parsed.media_url;
    if (parsed.media_url && needsMediaUpload(parsed.type) && !needBinaryUpload) {
      log("Step 7: Öffentliche S3-mediaUrl, kein Close-Files-Upload");
    } else if (needBinaryUpload) {
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
            convertAudio: false,
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
            const uploaded = await uploadCloseFile({
              authHeaders: closeHeaders,
              filename,
              contentType,
              buffer: media.buffer,
            });
            attachments.push(closeFileAttachment(uploaded));
            log(`Step 7: Media hochgeladen (${contentType}, ${uploaded.size} bytes)`);
          }
        } catch (e) {
          mediaUploadError = String(e.message || e);
          log(`Step 7: Media-Upload fehlgeschlagen: ${mediaUploadError}`);
        }
      }
    }
  }

  let newActivity = {};
  let hintActivity = {};
  let activityType = "whatsapp_message";

  function buildWhatsAppPayload(messageMarkdown) {
    const activityData = {
      organization_id: lead.organization_id,
      lead_id: leadId,
      contact_id: contactId,
      status: parsed.is_incoming ? "received" : "sent",
      direction: parsed.is_incoming ? "incoming" : "outgoing",
      activity_at: activityAt,
      local_phone: `+${parsed.local_phone}`,
      remote_phone: `+${parsed.remote_phone}`,
      message_markdown: messageMarkdown,
      external_whatsapp_message_id: parsed.id,
    };
    if (attachments.length) activityData.attachments = attachments;
    if (parsed.is_incoming && responsibleUserId) activityData.user_id = responsibleUserId;
    else if (!parsed.is_incoming && currentUserId) activityData.user_id = currentUserId;
    return activityData;
  }

  async function createWhatsAppActivity(messageMarkdown) {
    const createUrl = parsed.is_incoming
      ? "https://api.close.com/api/v1/activity/whatsapp_message/?send_to_inbox=true"
      : "https://api.close.com/api/v1/activity/whatsapp_message/";
    return httpJson("POST", createUrl, {
      headers: closeHeadersJson,
      body: buildWhatsAppPayload(messageMarkdown),
    });
  }

  if (isVoice) {
    const fromName = parsed.from_name || "WhatsApp";
    const closeFileUrl = attachments[0] && attachments[0].url ? attachments[0].url : "";
    const playUrl = voiceRecordingUrl || parsed.media_url || closeFileUrl;
    let hintMarkdown = parsed.text || "🎤 Sprachnachricht empfangen";
    if (playUrl && String(hintMarkdown).indexOf(playUrl) === -1) {
      hintMarkdown += `\n\n[▶️ Sprachdatei abspielen](${playUrl})`;
    }

    const hintRes = await createWhatsAppActivity(hintMarkdown);
    if (hintRes.status >= 200 && hintRes.status < 300) {
      hintActivity = hintRes.data || {};
      log(`Step 8a: WhatsApp-Hinweis ${hintActivity.id || "ok"}`);
      if (!voiceRecordingUrl) {
        const hintUrls = (hintActivity.attachments || []).map(attachmentUrl).filter(Boolean);
        for (const hintUrl of hintUrls) {
          voiceRecordingUrl = await resolvePublicRecordingUrl(hintUrl, closeHeaders);
          if (voiceRecordingUrl) break;
        }
        if (voiceRecordingUrl) {
          log(`Step 8a: Öffentliche Recording-URL aus Hinweis (${voiceRecordingUrl.split("?")[0]})`);
          mediaUploadError = "";
        }
      }
    } else {
      log(`Step 8a: WhatsApp-Hinweis fehlgeschlagen HTTP ${hintRes.status}`);
    }

    const playHtml = playUrl
      ? `<p><a href="${escapeHtml(playUrl)}">▶️ Sprachdatei abspielen</a></p>`
      : "";
    const callData = {
      lead_id: leadId,
      contact_id: contactId,
      source: "External",
      direction: parsed.is_incoming ? "inbound" : "outbound",
      status: "completed",
      duration: parsed.duration_seconds || 0,
      phone: `+${parsed.remote_phone}`,
      note_html: `<body><p>WhatsApp Sprachnachricht von ${escapeHtml(fromName)} ${
        parsed.is_incoming ? "empfangen" : "gesendet"
      }</p>${playHtml}<p>wa:${escapeHtml(parsed.id)}</p></body>`,
    };
    if (voiceRecordingUrl) callData.recording_url = voiceRecordingUrl;
    if (parsed.is_incoming && responsibleUserId) {
      callData.user_id = responsibleUserId;
      callData.created_by = responsibleUserId;
    } else if (!parsed.is_incoming && currentUserId) {
      callData.user_id = currentUserId;
      callData.created_by = currentUserId;
    }

    const createRes = await httpJson("POST", "https://api.close.com/api/v1/activity/call/", {
      headers: closeHeadersJson,
      body: callData,
    });
    if (createRes.status < 200 || createRes.status >= 300) {
      return result({
        success: false,
        lead_id: leadId,
        error: "Call creation failed",
        details: createRes.data,
        http_status: createRes.status,
        hint_activity_id: hintActivity.id,
      });
    }
    newActivity = createRes.data || {};
    activityType = "call";
    log("Step 8b: Call Activity Created");
  } else {
    const createRes = await createWhatsAppActivity(parsed.text);
    if (createRes.status < 200 || createRes.status >= 300) {
      return result({
        success: false,
        lead_id: leadId,
        error: "Creation failed",
        details: createRes.data,
        http_status: createRes.status,
      });
    }
    newActivity = createRes.data || {};
    log("Step 8: Activity Created");
  }

  let taskCreated = false;
  let taskReason = "";
  if (parsed.is_incoming) {
    if (shouldCreateTask) {
      if (responsibleUserId) {
        const existing = await findOpenTask(leadId, responsibleUserId, taskText);
        if (existing) {
          taskReason = `Skipped duplicate task ${existing.id}`;
        } else {
          const taskRes = await httpJson("POST", "https://api.close.com/api/v1/task/", {
            headers: closeHeadersJson,
            body: {
              text: taskText,
              lead_id: leadId,
              assigned_to: responsibleUserId,
              due_date: String(activityAt).split("T")[0],
              is_complete: false,
            },
          });
          taskCreated = taskRes.status >= 200 && taskRes.status < 300;
          taskReason = taskCreated ? "Created successfully" : `Task HTTP ${taskRes.status}`;
        }
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
    activity_type: activityType,
    hint_activity_id: isVoice ? hintActivity.id : undefined,
    task_created: taskCreated,
    task_reason: taskReason,
    media_url: parsed.media_url || voiceRecordingUrl || undefined,
    media_type: parsed.type,
    media_uploaded: Boolean(attachments.length) || Boolean(isVoice && voiceRecordingUrl),
    media_linked: Boolean(parsed.media_url),
    media_upload_error: mediaUploadError || undefined,
    recording_url: isVoice ? voiceRecordingUrl || undefined : undefined,
    recording_format: isVoice && voiceRecordingUrl ? "mp3" : undefined,
    direction: parsed.is_incoming ? (isVoice ? "inbound" : "incoming") : isVoice ? "outbound" : "outgoing",
    remote_phone: parsed.remote_phone,
    local_phone: parsed.local_phone,
    instance: parsed.instance,
  });
}

return await main();
