/**
 * Prepare MinIO Upload (n8n Code-Node)
 *
 * Nimmt die MP3-Binary aus Convert, baut presigned PUT/GET.
 * Keys: $('Config').first().json.s3_access_key usw.
 * JSON + Binary durchreichen. Kein ffmpeg, kein Close.
 */

const logs = [];
function log(msg) {
  logs.push(String(msg));
  console.log(msg);
}

function configJson() {
  try {
    return $('Config').first().json || {};
  } catch (e) {
    return {};
  }
}

function pickConfig(key, fallback) {
  const v = configJson()[key];
  if (v !== undefined && v !== null && v !== "") return String(v);
  return fallback || "";
}

function pick(item, key, fallback) {
  const v = item && item[key];
  if (v !== undefined && v !== null && v !== "") return String(v);
  return fallback || "";
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
  let raw = String(key || "")
    .split("?")[0]
    .replace(/^\//, "");
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
  return `${base}/${awsUriEncode(bucket, true)}/${awsUriEncode(key, false)}`;
}

function s3CanonicalUri(bucket, key) {
  return `/${awsUriEncode(bucket, true)}/${awsUriEncode(key, false)}`;
}

async function presign({ method, endpoint, bucket, key, accessKey, secretKey, region, expires, signedHeaderNames, extraHeaders }) {
  const { amzDate, dateStamp } = amzTimestamps();
  const host = s3Host(endpoint);
  const canonicalUri = s3CanonicalUri(bucket, key);
  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const credential = `${accessKey}/${scope}`;
  const signedHeaders = signedHeaderNames;
  const query = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": credential,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(expires),
    "X-Amz-SignedHeaders": signedHeaders,
  };
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((k) => `${awsUriEncode(k, true)}=${awsUriEncode(query[k], true)}`)
    .join("&");
  const headerLines = Object.assign({ host }, extraHeaders || {});
  const canonicalHeaders = Object.keys(headerLines)
    .sort()
    .map((k) => `${k}:${headerLines[k]}\n`)
    .join("");
  const canonicalRequest = [method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, "UNSIGNED-PAYLOAD"].join("\n");
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256Hex(canonicalRequest)].join("\n");
  const signingKey = await awsSigningKey(secretKey, dateStamp, region, "s3");
  const signature = bytesToHex(await hmacSha256(signingKey, stringToSign));
  return `${s3ObjectUrl(endpoint, bucket, key)}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

async function main() {
  const item = $input.first() || { json: {}, binary: {} };
  const inputItem = item.json || {};
  const outJson = Object.assign({}, inputItem, { s3_put_url: "", s3_get_url: "", presignedUrl: "", presign_logs: logs });
  const binary = item.binary && item.binary.data ? { data: item.binary.data } : null;

  try {
    const mediaUrl = pick(inputItem, "voice_media_url") || pick(inputItem, "media_url");
    const parsedS3 = parseS3MediaUrl(mediaUrl);
    const endpoint = (pickConfig("s3_endpoint") || (parsedS3 && parsedS3.endpoint) || "").replace(/\/+$/, "");
    const bucket = (pickConfig("s3_bucket") || (parsedS3 && parsedS3.bucket) || "").trim();
    const accessKey = pickConfig("s3_access_key").trim();
    const secretKey = pickConfig("s3_secret_key").trim();
    const region = pickConfig("s3_region", "us-east-1") || "us-east-1";
    if (!endpoint || !bucket) throw new Error("s3_endpoint / s3_bucket fehlen (oder mediaUrl ohne Bucket-Pfad)");
    if (!accessKey || !secretKey) throw new Error("s3_access_key / s3_secret_key fehlen in Config");
    const key = mp3KeyFromSource(parsedS3 && parsedS3.key, pick(inputItem, "voice_msg_id"));
    const putUrl = await presign({
      method: "PUT",
      endpoint,
      bucket,
      key,
      accessKey,
      secretKey,
      region,
      expires: 600,
      signedHeaderNames: "content-type;host",
      extraHeaders: { "content-type": "audio/mpeg" },
    });
    const getUrl = await presign({
      method: "GET",
      endpoint,
      bucket,
      key,
      accessKey,
      secretKey,
      region,
      expires: 604800,
      signedHeaderNames: "host",
      extraHeaders: {},
    });
    outJson.s3_put_url = putUrl;
    outJson.s3_get_url = getUrl;
    outJson.presignedUrl = getUrl;
    outJson.s3_bucket = bucket;
    outJson.s3_key = key;
    log(`Presign: ${bucket}/${key}`);
    outJson.presign_logs = logs.slice();
    return binary ? [{ json: outJson, binary }] : [{ json: outJson }];
  } catch (e) {
    outJson.needs_minio_upload = false;
    outJson.media_upload_error = String(e.message || e);
    log(`Presign: ${outJson.media_upload_error}`);
    outJson.presign_logs = logs.slice();
    return binary ? [{ json: outJson, binary }] : [{ json: outJson }];
  }
}

return await main();
