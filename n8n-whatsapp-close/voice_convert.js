/**
 * Convert Voice to MP3 (n8n Code-Node)
 *
 * Nur Audio → MP3. JSON durchreichen, Binary `data` = voice.mp3.
 * Kein MinIO, kein Close.
 *
 * ffmpeg: OGA/Opus/WebM, Probe für Pipes ohne Header, libmp3lame.
 * n8n: NODE_FUNCTION_ALLOW_BUILTIN=child_process, ffmpeg mit libmp3lame.
 */

const MAX_MEDIA_BYTES = 20 * 1024 * 1024;
const WHATSAPP_CDN = ["mmg.whatsapp.net", "media.whatsapp.com", "pps.whatsapp.net"];
const WRAPPERS = [
  "ephemeralMessage",
  "viewOnceMessage",
  "viewOnceMessageV2",
  "viewOnceMessageV2Extension",
  "documentWithCaptionMessage",
];

const logs = [];
function log(msg) {
  logs.push(String(msg));
  console.log(msg);
}

function collect(raw, depth) {
  depth = depth || 0;
  if (depth > 8 || raw === undefined || raw === null) return [];
  if (typeof raw === "string") {
    try {
      return collect(JSON.parse(raw), depth + 1);
    } catch (e) {
      return [];
    }
  }
  if (Array.isArray(raw)) {
    const found = [];
    for (const item of raw) found.push.apply(found, collect(item, depth + 1));
    return found;
  }
  if (typeof raw !== "object") return [];
  if (typeof raw.event === "string" && raw.data) return [raw];
  const found = [];
  if (raw.json) found.push.apply(found, collect(raw.json, depth + 1));
  if (raw.body) found.push.apply(found, collect(raw.body, depth + 1));
  return found;
}

function unwrap(message) {
  if (!message || typeof message !== "object") return {};
  for (const key of WRAPPERS) {
    if (message[key] && typeof message[key] === "object") {
      return unwrap(message[key].message || message[key]);
    }
  }
  return message;
}

function isCdn(url) {
  const host = String(url || "").split("/")[2] || "";
  return WHATSAPP_CDN.some((cdn) => host.includes(cdn));
}

function publicUrl(url) {
  const raw = String(url || "").trim();
  if (!raw.startsWith("http") || isCdn(raw)) return "";
  return raw;
}

function findVoice(item) {
  const payloads = collect(item);
  for (const payload of payloads) {
    const data = payload.data || {};
    const inner = unwrap(data.message || {});
    const aud = inner.audioMessage;
    if (!aud || typeof aud !== "object" || !aud.ptt) continue;
    const mediaUrl = publicUrl(
      inner.mediaUrl || data.mediaUrl || data.media_url || aud.mediaUrl || aud.url
    );
    const msgId = (data.key && data.key.id) || data.id || "";
    return {
      mediaUrl,
      msgId,
      mimetype: String(aud.mimetype || "audio/ogg; codecs=opus"),
    };
  }
  return null;
}

function looksLikeMp3(buffer) {
  if (!buffer || buffer.length < 3) return false;
  if (buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33) return true;
  return buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0;
}

async function downloadBinary(url) {
  if (typeof fetch === "function") {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Download HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
  if (this.helpers && typeof this.helpers.httpRequest === "function") {
    const result = await this.helpers.httpRequest({
      method: "GET",
      url,
      encoding: "arraybuffer",
      json: false,
      returnFullResponse: true,
      ignoreHttpStatusErrors: true,
      timeout: 60000,
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

function ffmpegToMp3(buffer) {
  if (!buffer || !buffer.length) return null;
  let execFileSync;
  try {
    execFileSync = require("child_process").execFileSync;
  } catch (e) {
    log(`ffmpeg: child_process nicht erlaubt (${e.message || e})`);
    return null;
  }
  const probe = ["-analyzeduration", "20000000", "-probesize", "20000000"];
  const out = [
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-c:a",
    "libmp3lame",
    "-b:a",
    "32k",
    "-id3v2_version",
    "3",
    "-write_xing",
    "1",
    "-f",
    "mp3",
    "pipe:1",
  ];
  const attempts = [
    ["-y", "-hide_banner", "-loglevel", "error", ...probe, "-i", "pipe:0", ...out],
    ["-y", "-hide_banner", "-loglevel", "error", ...probe, "-f", "ogg", "-i", "pipe:0", ...out],
    ["-y", "-hide_banner", "-loglevel", "error", ...probe, "-f", "opus", "-i", "pipe:0", ...out],
    ["-y", "-hide_banner", "-loglevel", "error", ...probe, "-f", "webm", "-i", "pipe:0", ...out],
    [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      ...probe,
      "-f",
      "ogg",
      "-c:a",
      "libopus",
      "-i",
      "pipe:0",
      ...out,
    ],
    [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      ...probe,
      "-fflags",
      "+genpts+discardcorrupt",
      "-i",
      "pipe:0",
      "-vn",
      "-ac",
      "1",
      "-ar",
      "22050",
      "-c:a",
      "libmp3lame",
      "-b:a",
      "48k",
      "-id3v2_version",
      "3",
      "-f",
      "mp3",
      "pipe:1",
    ],
  ];
  for (let i = 0; i < attempts.length; i++) {
    try {
      const mp3 = execFileSync("ffmpeg", attempts[i], {
        input: buffer,
        timeout: 45000,
        maxBuffer: MAX_MEDIA_BYTES,
      });
      if (mp3 && mp3.length > 64 && looksLikeMp3(mp3)) return Buffer.from(mp3);
    } catch (e) {
      log(`ffmpeg Versuch ${i + 1}: ${String(e.message || e).slice(0, 180)}`);
    }
  }
  return null;
}

async function main() {
  const inputItem = $input.first() ? $input.first().json || {} : {};
  const outJson = Object.assign({}, inputItem, {
    needs_minio_upload: false,
    media_upload_error: "",
    convert_logs: logs,
    voice_media_url: "",
    voice_msg_id: "",
  });

  const voice = findVoice(inputItem);
  if (!voice) return [{ json: outJson }];
  if (!voice.mediaUrl) {
    outJson.media_upload_error = "Keine öffentliche mediaUrl für Voice";
    outJson.convert_logs = logs.slice();
    return [{ json: outJson }];
  }

  try {
    const buffer = await downloadBinary.call(this, voice.mediaUrl);
    log(`Convert: Audio geladen (${buffer.length} bytes)`);
    if (!buffer.length) {
      outJson.media_upload_error = "Leere Audiodatei";
      outJson.convert_logs = logs.slice();
      return [{ json: outJson }];
    }
    if (buffer.length > MAX_MEDIA_BYTES) {
      outJson.media_upload_error = `Datei zu groß (${buffer.length} bytes)`;
      outJson.convert_logs = logs.slice();
      return [{ json: outJson }];
    }

    const mp3 = looksLikeMp3(buffer) ? buffer : ffmpegToMp3(buffer);
    if (!mp3) {
      outJson.media_upload_error = "ffmpeg fehlt oder Konvertierung fehlgeschlagen";
      outJson.convert_logs = logs.slice();
      return [{ json: outJson }];
    }
    log(`Convert: MP3 erzeugt (${mp3.length} bytes)`);

    if (!this.helpers || typeof this.helpers.prepareBinaryData !== "function") {
      outJson.media_upload_error = "prepareBinaryData fehlt";
      outJson.convert_logs = logs.slice();
      return [{ json: outJson }];
    }
    const binaryData = await this.helpers.prepareBinaryData(mp3, "voice.mp3", "audio/mpeg");
    outJson.needs_minio_upload = true;
    outJson.voice_media_url = voice.mediaUrl;
    outJson.voice_msg_id = voice.msgId;
    outJson.convert_logs = logs.slice();
    return [{ json: outJson, binary: { data: binaryData } }];
  } catch (e) {
    outJson.media_upload_error = String(e.message || e);
    outJson.convert_logs = logs.slice();
    log(`Convert: ${outJson.media_upload_error}`);
    return [{ json: outJson }];
  }
}

return await main();
