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
5. **Convert Voice to MP3** — nur ffmpeg: Voice laden, MP3 als Binary ausgeben. Sonst JSON durchreichen.
6. **Voice MP3?** — IF: `needs_minio_upload`
7. **Prepare MinIO Upload** — presigned PUT/GET (nur Voice)
8. **Upload MP3 MinIO** — HTTP Request PUT der MP3
9. **Create Close WhatsApp Activity** — Lead suchen, Activity, Call. Output: `call_activity_id` (Close Call), `hint_activity_id` (WhatsApp-Hinweis), `activity_id` (Call bei Voice, sonst WhatsApp)

Nur **ein** Webhook: Evolution → POST `whatsapp-close`. Close braucht für den Call-Player keine zweite n8n-URL.

## Logik

- Lokale WhatsApp-Nummer: `GET {server_url}/instance/fetchInstances?instanceName=…` (`owner` / `number`). Fallback: Webhook-`sender`, danach optionales Config-Feld `my_whatsapp_number`
- Telefonvarianten: `49160…`, `+49160…`, `160…`, `0160…`
- Incoming: zuständiger User zuerst aus dem Custom Field, sonst letzte **Outbound**-Activity, sonst WA-/Call-History
- Outgoing: Close-User aus `/me/`
- Bilder, Video, GIF, Dokument, Sticker: öffentliche Evolution-`mediaUrl` (S3, mit `X-Amz-Signature`) als Markdown-Link in der WhatsApp-Activity. Nur wenn die URL fehlt: Evolution `getBase64FromMediaMessage` → Close Files
- Voice:
  1. **Convert Voice to MP3**: Jede `audioMessage` (PTT **und** Audio-Datei, `ptt: false`) laden, ffmpeg → MPEG-1-MP3 (**44.1 kHz, 64 kbit CBR, mono**). Gruppen (`@g.us`) konvertiert der Node, Close legt sie trotzdem nicht an. 16 kHz / 32 kbit ist MPEG-2.5; Close zeigt dann oft „Unable to play audio file“. Extra ffmpeg-Versuche: OGG/Opus/WebM.
  2. **Prepare MinIO Upload**: presigned PUT + `presignedUrl` (GET der MP3)
  3. **Upload MP3 MinIO**: HTTP Request PUT (JSON bleibt, Antwort in `minio_put`)
  4. **Create Close WhatsApp Activity**: Lead finden, WhatsApp-Hinweis, Call. JSON enthält `call_activity_id` für den nächsten n8n-Step (`{{ $json.call_activity_id }}`). Bei Duplikat dieselbe ID.
- Close-Files-Upload für Voice entfällt (HTTP 400 / Login-URLs). Close holt die MinIO-URL ohne Login und spielt nur MP3.
- n8n-Container braucht `ffmpeg` (libmp3lame) und `NODE_FUNCTION_ALLOW_BUILTIN=child_process`.
- Close-Player ist HTML5: Datei muss **MPEG-1 Layer III** sein (44.1 oder 48 kHz). MinIO muss `Content-Type: audio/mpeg` liefern. CORS für `https://app.close.com` (GET/HEAD). Wenn die URL im Browser-Tab spielt, in Close aber nicht: CORS. Wenn sie auch im Tab nicht spielt: Format oder Content-Type.
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
| `s3_endpoint` | Optional. Für den **PUT** aus n8n, z. B. `http://minio:9000`. Close braucht **https** auf Port 443 — die GET-URL kommt von der öffentlichen `mediaUrl` (`https://s3.…`) oder wird aus `http://s3.…:9000` umgeschrieben. |
| `s3_bucket` | Optional. Leer = erster Pfadteil der `mediaUrl` (`evolution`). |
| `s3_region` | Default `us-east-1` (wie Evolution/MinIO). |

In n8n: **Workflows → Import from File** (bestehenden Workflow ersetzen) und den Workflow **aktivieren**. In **Config** Close-Key **und** MinIO-Keys eintragen. Close und MinIO-Presign lesen die Keys per `$('Config').first().json.close_api_key` (nicht aus dem Input des jeweiligen Nodes). Die Config-Node muss den Webhook-Body behalten (`keepOnlySet` aus).

Nach dem Import eine **neue** Sprachnachricht testen. Close muss eine `recording_url` mit **https://** ohne Port **9000** haben (Close lehnt `http://` ab; `https://s3.…:9000` scheitert an TLS, weil 9000 intern HTTP ist). MinIO intern darf HTTP bleiben; Caddy/`s3.…` terminiert TLS. Evolution: öffentliche mediaUrl mit `https://s3.…`, nicht `http://minio:9000`.

### Community-MinIO-Node

Der Community-Node gibt oft nur `{ "url": "http://…" }` zurück. Close liest `$json.url`.

**Object Name** muss der echte MinIO-Pfad sein, nicht die n8n-Binary-ID (`e8a1…-1`). Sonst PUT/GET gegen `/evolution/<hash>-1` → `NoSuchKey`.

Im MinIO-Node:

- Bucket: `evolution` oder `{{ $json.s3_bucket }}`
- Object Name: `{{ $json.s3_key }}`  
  Beispiel: `evolution-api/<instance-id>/…/audioMessage/<id>.mp3`
- Binary Property: `data`
- Content-Type: `audio/mpeg`

`$json.s3_key` kommt vom Convert-Node (gleiche Datei wie die Evolution-`.oga`, nur `.mp3`).

Credentials:

- Endpoint: `s3.orgasmic.live`
- Port: `443`
- SSL / useSSL: an

```bash
cd n8n-whatsapp-close
python3 -m unittest test_message_parse.py -v
python3 generate_workflow.py
```

Den im Webhook-Body mitgelieferten `apikey` (Evolution/Meta) nicht ins Git und nicht nach Close schicken. Wenn er im Chat lag, rotieren.
