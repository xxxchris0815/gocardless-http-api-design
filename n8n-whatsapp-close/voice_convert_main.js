/**
 * n8n Code-Node "Convert Voice to MP3".
 * Helpers kommen aus whatsapp_to_close.js (alles vor main()).
 * Nicht-Voice: JSON durchreichen, needs_minio_upload=false.
 * Voice: OGA laden, ffmpeg → MP3, Binary data + s3_put_url / s3_get_url.
 */
async function main() {
  const configLocalPhone = cleanPhone(pick("my_whatsapp_number", "MY_WHATSAPP_NUMBER", ""));
  const s3AccessKey = String(pick("s3_access_key", "S3_ACCESS_KEY", "")).trim();
  const s3SecretKey = String(pick("s3_secret_key", "S3_SECRET_KEY", "")).trim();
  const s3Region = String(pick("s3_region", "S3_REGION", "us-east-1")).trim() || "us-east-1";
  const s3EndpointCfg = String(pick("s3_endpoint", "S3_ENDPOINT", "")).trim();
  const s3BucketCfg = String(pick("s3_bucket", "S3_BUCKET", "")).trim();

  const outJson = Object.assign({}, inputItem, {
    needs_minio_upload: false,
    s3_put_url: "",
    s3_get_url: "",
    media_upload_error: "",
    convert_logs: logs,
  });

  let payloads = [];
  try {
    payloads = extractPayloads(inputItem);
  } catch (e) {
    outJson.media_upload_error = "JSON Invalid";
    return [{ json: outJson }];
  }
  if (!payloads.length) return [{ json: outJson }];

  const payload = payloads[0];
  const parsed = parseWebhook(payload, configLocalPhone);
  if (!parsed || parsed.skip || parsed.type !== "voice") {
    return [{ json: outJson }];
  }

  const evolutionBase = pickEvolutionBase(payload);
  const evolutionKey = pickEvolutionKey(payload);

  try {
    let source = null;
    if (parsed.media_url) {
      source = {
        buffer: await downloadBinary(parsed.media_url),
        mimetype: parsed.mimetype || "audio/ogg",
        fileName: filenameFromUrl(parsed.media_url) || "voice.oga",
      };
      log(`Convert: S3-Audio geladen (${source.buffer.length} bytes, ${source.fileName})`);
    } else if (evolutionBase && evolutionKey && parsed.instance) {
      source = await fetchEvolutionMedia({
        baseUrl: evolutionBase,
        apiKey: evolutionKey,
        instance: parsed.instance,
        key: parsed.raw_key || { id: parsed.id },
        message: parsed.raw_message,
        convertAudio: true,
      });
      log(`Convert: Evolution-Audio geladen (${source.buffer.length} bytes)`);
    } else {
      outJson.media_upload_error = "Keine Audio-Quelle für MP3-Konvertierung";
      outJson.convert_logs = logs.slice();
      return [{ json: outJson }];
    }

    if (!source.buffer || !source.buffer.length) {
      outJson.media_upload_error = "Leere Audiodatei";
      outJson.convert_logs = logs.slice();
      return [{ json: outJson }];
    }
    if (source.buffer.length > MAX_MEDIA_BYTES) {
      outJson.media_upload_error = `Datei zu groß (${source.buffer.length} bytes)`;
      outJson.convert_logs = logs.slice();
      return [{ json: outJson }];
    }

    let mp3 = isMp3Audio(source.buffer, source.mimetype, source.fileName)
      ? source.buffer
      : tryFfmpegToMp3(source.buffer);
    if (!mp3 && parsed.media_url && evolutionBase && evolutionKey && parsed.instance) {
      const converted = await fetchEvolutionMedia({
        baseUrl: evolutionBase,
        apiKey: evolutionKey,
        instance: parsed.instance,
        key: parsed.raw_key || { id: parsed.id },
        message: parsed.raw_message,
        convertAudio: true,
      });
      if (converted && converted.buffer) {
        mp3 = isMp3Audio(converted.buffer, converted.mimetype, converted.fileName)
          ? converted.buffer
          : tryFfmpegToMp3(converted.buffer);
      }
    }
    if (!mp3) {
      outJson.media_upload_error =
        "Close zeigt im Call-Player nur MP3. ffmpeg fehlt oder die Konvertierung ist fehlgeschlagen.";
      outJson.convert_logs = logs.slice();
      return [{ json: outJson }];
    }
    log(`Convert: MP3 erzeugt (${mp3.length} bytes)`);

    const prepared = await prepareMinioMp3Upload({
      mediaUrl: parsed.media_url || "",
      msgId: parsed.id,
      accessKey: s3AccessKey,
      secretKey: s3SecretKey,
      region: s3Region,
      endpointCfg: s3EndpointCfg,
      bucketCfg: s3BucketCfg,
    });
    outJson.needs_minio_upload = true;
    outJson.s3_put_url = prepared.putUrl;
    outJson.s3_get_url = prepared.getUrl;
    outJson.s3_bucket = prepared.bucket;
    outJson.s3_key = prepared.key;
    log(`Convert: MinIO PUT vorbereitet ${prepared.bucket}/${prepared.key}`);
    outJson.convert_logs = logs.slice();

    let binaryData = null;
    if (this.helpers && typeof this.helpers.prepareBinaryData === "function") {
      binaryData = await this.helpers.prepareBinaryData(mp3, "voice.mp3", "audio/mpeg");
    }
    if (!binaryData) {
      outJson.needs_minio_upload = false;
      outJson.media_upload_error = "prepareBinaryData fehlt — HTTP-Request kann die MP3 nicht senden";
      return [{ json: outJson }];
    }
    return [{ json: outJson, binary: { data: binaryData } }];
  } catch (e) {
    outJson.media_upload_error = String(e.message || e);
    outJson.convert_logs = logs.slice();
    log(`Convert: ${outJson.media_upload_error}`);
    return [{ json: outJson }];
  }
}

return await main();
