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
9. **Create Close WhatsApp Activity** — Lead suchen, Activity, Call mit `recording_url` = `$json.presignedUrl` oder `$json.url` (https, ohne `:9000`)

Nur **ein** Webhook: Evolution → POST `whatsapp-close`. Close braucht für den Call-Player keine zweite n8n-URL.

## Logik

- Lokale WhatsApp-Nummer: `GET {server_url}/instance/fetchInstances?instanceName=…` (`owner` / `number`). Fallback: Webhook-`sender`, danach optionales Config-Feld `my_whatsapp_number`
- Telefonvarianten: `49160…`, `+49160…`, `160…`, `0160…`
- Incoming: zuständiger User zuerst aus dem Custom Field, sonst letzte **Outbound**-Activity, sonst WA-/Call-History
- Outgoing: Close-User aus `/me/`
- Bilder, Video, GIF, Dokument, Sticker: öffentliche Evolution-`mediaUrl` (S3, mit `X-Amz-Signature`) als Markdown-Link in der WhatsApp-Activity. Nur wenn die URL fehlt: Evolution `getBase64FromMediaMessage` → Close Files
- Voice:
  1. **Convert Voice to MP3**: OGA laden, ffmpeg → MP3, Binary `data`. Kein MinIO, kein Close. Extra ffmpeg-Versuche: OGG/Opus/WebM, `analyzeduration`/`probesize` für Pipes.
  2. **Prepare MinIO Upload**: presigned PUT + `presignedUrl` (GET der MP3)
  3. **Upload MP3 MinIO**: HTTP Request PUT (JSON bleibt, Antwort in `minio_put`)
  4. **Create Close WhatsApp Activity**: Lead finden, WhatsApp-Hinweis, Call mit `recording_url` aus `presignedUrl` oder Community-MinIO-Feld `url` (immer `https://`, Port `9000` entfernt)
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
| `s3_endpoint` | Optional. Für den **PUT** aus n8n, z. B. `http://minio:9000`. Close braucht **https** auf Port 443 — die GET-URL kommt von der öffentlichen `mediaUrl` (`https://s3.…`) oder wird aus `http://s3.…:9000` umgeschrieben. |
| `s3_bucket` | Optional. Leer = erster Pfadteil der `mediaUrl` (`evolution`). |
| `s3_region` | Default `us-east-1` (wie Evolution/MinIO). |

In n8n: **Workflows → Import from File** (bestehenden Workflow ersetzen) und den Workflow **aktivieren**. In **Config** Close-Key **und** MinIO-Keys eintragen. Close und MinIO-Presign lesen die Keys per `$('Config').first().json.close_api_key` (nicht aus dem Input des jeweiligen Nodes). Die Config-Node muss den Webhook-Body behalten (`keepOnlySet` aus).

Nach dem Import eine **neue** Sprachnachricht testen. Close muss eine `recording_url` mit **https://** ohne Port **9000** haben (Close lehnt `http://` ab; `https://s3.…:9000` scheitert an TLS, weil 9000 intern HTTP ist). MinIO intern darf HTTP bleiben; Caddy/`s3.…` terminiert TLS. Evolution: öffentliche mediaUrl mit `https://s3.…`, nicht `http://minio:9000`.

### Community-MinIO-Node

Der Community-Node gibt oft nur `{ "url": "http://minio:9000/…" }` oder `{ "url": "http://s3.…:9000/…" }` zurück. Close liest `$json.url` und schreibt auf `https://s3.…` um (Host aus der Evolution-`mediaUrl`, Port 9000 weg).

Damit die Signatur nach dem Umschreiben noch gilt, müssen die **n8n-MinIO-Credentials** schon gegen den öffentlichen Host signieren:

- Endpoint: `s3.orgasmic.live` (ohne `http://minio` und ohne `:9000`)
- Port: `443`
- SSL / useSSL: an

Sonst PUT intern gegen `http://minio:9000` und Close-GET über `https://s3.…` — Host-Header in der SigV4-Signatur passt dann nicht (MinIO 403). Alternative: den mitgelieferten Node **Prepare MinIO Upload** nutzen, der PUT intern und GET öffentlich getrennt presigned.

```bash
cd n8n-whatsapp-close
python3 -m unittest test_message_parse.py -v
python3 generate_workflow.py
```

Den im Webhook-Body mitgelieferten `apikey` (Evolution/Meta) nicht ins Git und nicht nach Close schicken. Wenn er im Chat lag, rotieren.
