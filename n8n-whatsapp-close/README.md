# WhatsApp → Close Activity (n8n)

Nur **Evolution API**. Webhooks `send.message` und `messages.upsert` werden zu Close-Aktivitäten. Incoming-Nachrichten erzeugen optional eine Task.

- Text, Bild, Video, GIF, Dokument, Sticker → WhatsApp-Activity mit **S3-Link** (`data.message.mediaUrl`)
- Sprachnachricht (`ptt`) → WhatsApp-Hinweis mit S3-Link, danach **Call-Activity**. Close spielt nur **MP3**; `.oga` wird per ffmpeg konvertiert.

```json
{
  "event": "send.message",
  "instance": "WA-B1",
  "data": {
    "key": { "fromMe": true, "id": "wamid.…", "remoteJid": "491601865421@s.whatsapp.net" },
    "message": { "conversation": "was genau findest du toll" },
    "messageType": "conversation",
    "messageTimestamp": 1787049466
  }
}
```

Andere Events (`connection.update`, Receipts, …) werden ignoriert. Gruppen (`@g.us`) und Broadcasts ebenfalls.

Das n8n-Webhook-Item wird mit ausgepackt — also genau diese Form:

```json
[
  {
    "headers": {},
    "body": {
      "event": "send.message",
      "instance": "WA-B1",
      "data": { "key": { "fromMe": true, "id": "wamid.…", "remoteJid": "49160…@s.whatsapp.net" }, "message": { "conversation": "…" } }
    }
  }
]
```

## Ablauf

1. **WhatsApp Webhook** (POST `/whatsapp-close`) — Evolution schickt Nachrichten hierhin. Antwortet sofort mit 200, damit Evolution nicht in Timeouts läuft.
2. **Unwrap Evolution Body** — holt `event`/`data` aus n8n-`headers`+`body`-Arrays
3. **Message Events Only** — nur `send.message` und `messages.upsert`
4. **Config** — Close-Key und MinIO-Keys (die WhatsApp-Nummer kommt von Evolution)
5. **Convert Voice to MP3** — nur bei Voice: OGA laden, ffmpeg → MP3, Binary + presigned MinIO-URLs. Sonst JSON durchreichen.
6. **Voice MP3?** — IF: `needs_minio_upload`
7. **Upload MP3 MinIO** — HTTP Request PUT der MP3 (nur Voice-Zweig)
8. **Create Close WhatsApp Activity** — Instanz-Nummer per `GET /instance/fetchInstances`, Lead suchen, Activity, bei Incoming Task. Bei Voice: Call mit `recording_url` = MinIO-GET-URL.

Nur **ein** Webhook: Evolution → POST `whatsapp-close`. Close braucht für den Call-Player keine zweite n8n-URL.

## Logik

- Lokale WhatsApp-Nummer: `GET {server_url}/instance/fetchInstances?instanceName=…` (`owner` / `number`). Fallback: Webhook-`sender`, danach optionales Config-Feld `my_whatsapp_number`
- Telefonvarianten: `49160…`, `+49160…`, `160…`, `0160…`
- Incoming: zuständiger User zuerst aus dem Custom Field, sonst letzte **Outbound**-Activity, sonst WA-/Call-History
- Outgoing: Close-User aus `/me/`
- Bilder, Video, GIF, Dokument, Sticker: öffentliche Evolution-`mediaUrl` (S3, mit `X-Amz-Signature`) als Markdown-Link in der WhatsApp-Activity. Nur wenn die URL fehlt: Evolution `getBase64FromMediaMessage` → Close Files
- Voice (drei Nodes, nicht ein Mega-Script):
  1. **Convert Voice to MP3**: OGA von Evolution-S3 laden, ffmpeg → MP3, Binary `data`, `s3_put_url` / `s3_get_url`
  2. **Upload MP3 MinIO**: HTTP Request PUT nach MinIO (dieselben Keys wie Evolution)
  3. **Create Close WhatsApp Activity**: Lead finden, WhatsApp-Hinweis mit S3-Link, Call mit `recording_url` = signierte MP3-GET-URL (7 Tage)
- Close-Files-Upload für Voice entfällt (HTTP 400 / Login-URLs). Close holt die MinIO-URL ohne Login und spielt nur MP3.
- n8n-Container braucht `ffmpeg` (libmp3lame) und `NODE_FUNCTION_ALLOW_BUILTIN=child_process`.
- MinIO-Keys in Config: dieselben wie Evolution (`S3_ACCESS_KEY` / `S3_SECRET_KEY`). Endpoint und Bucket kommen aus `mediaUrl`, wenn die Config-Felder leer sind.
- WhatsApp-CDN-URLs werden nicht als Markdown verlinkt
- Duplikate: gleiche `wamid` → skip (vor dem Media-Download)

## Config

| Feld | Bedeutung |
| --- | --- |
| `close_api_key` | Close **Klartext**-API-Key (beginnt mit `api_`). Nicht den Hash/Fingerprint aus der Key-Liste. Nicht committen. |
| `my_whatsapp_number` | Optional. Nur Fallback, wenn Evolution die Instanz-Nummer nicht liefert. |
| `create_task` | `true`/`false` |
| `excluded_phone_number` / `excluded_user_id` | History-Filter, falls das Custom Field leer ist |
| `field_id_responsible_user` | Close Custom Field auf dem Lead; wenn gesetzt, hat es Vorrang vor der History |
| `evolution_base_url` | Evolution-Server, z. B. `https://evo.example.com` (ohne Slash am Ende) |
| `evolution_api_key` | Evolution-`apikey`. Fallback: `apikey` aus dem originalen Webhook |
| `upload_media` | `true`/`false`, Default `true`. Nur Fallback, wenn im Webhook **keine** öffentliche `mediaUrl` steckt. |
| `s3_access_key` / `s3_secret_key` | MinIO-Zugang, **dieselben Keys wie Evolution**. Nicht committen. |
| `s3_endpoint` | Optional, z. B. `https://s3.example.com`. Leer = Host aus `mediaUrl`. |
| `s3_bucket` | Optional. Leer = erster Pfadteil der `mediaUrl` (`evolution`). |
| `s3_region` | Default `us-east-1` (wie Evolution/MinIO). |

In n8n: **Workflows → Import from File** (bestehenden Workflow ersetzen) und den Workflow **aktivieren**. In **Config** Close-Key **und** MinIO-Keys eintragen. Die Config-Node muss den Webhook-Body behalten (`keepOnlySet` aus).

Nach dem Import eine **neue** Sprachnachricht testen. Execution: Convert (`Convert: MP3 erzeugt`) → HTTP PUT (Status 200) → Close (`Step 7: recording_url von MinIO`). `recording_url` muss auf eure MinIO-Domain zeigen, Datei `.mp3`, Query mit `X-Amz-Signature`.

```bash
cd n8n-whatsapp-close
python3 -m unittest test_message_parse.py -v
python3 generate_workflow.py
```

Den im Webhook-Body mitgelieferten `apikey` (Evolution/Meta) nicht ins Git und nicht nach Close schicken. Wenn er im Chat lag, rotieren.
