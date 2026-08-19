# WhatsApp → Close Activity (n8n)

Nur **Evolution API**. Webhooks `send.message` und `messages.upsert` werden zu Close-Aktivitäten. Incoming-Nachrichten erzeugen optional eine Task.

- Text, Bild, Video, GIF, Dokument, Sticker → WhatsApp-Activity mit **S3-Link** (`data.message.mediaUrl`)
- Sprachnachricht (`ptt`) → WhatsApp-Hinweis mit S3-Link, danach **Call-Activity** mit `recording_url` = dieselbe öffentliche S3-URL

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
4. **Config** — Close-Key (die WhatsApp-Nummer kommt von Evolution)
5. **Create Close WhatsApp Activity** — Instanz-Nummer per `GET /instance/fetchInstances`, Lead suchen, Activity, bei Incoming Task. Bei Voice: `message.mediaUrl` (S3) als Close-`recording_url`.

Nur **ein** Webhook: Evolution → POST `whatsapp-close`. Close braucht für den Call-Player keine zweite n8n-URL.

## Logik

- Lokale WhatsApp-Nummer: `GET {server_url}/instance/fetchInstances?instanceName=…` (`owner` / `number`). Fallback: Webhook-`sender`, danach optionales Config-Feld `my_whatsapp_number`
- Telefonvarianten: `49160…`, `+49160…`, `160…`, `0160…`
- Incoming: zuständiger User zuerst aus dem Custom Field, sonst letzte **Outbound**-Activity, sonst WA-/Call-History
- Outgoing: Close-User aus `/me/`
- Bilder, Video, GIF, Dokument, Sticker: öffentliche Evolution-`mediaUrl` (S3, mit `X-Amz-Signature`) als Markdown-Link in der WhatsApp-Activity. Nur wenn die URL fehlt: Evolution `getBase64FromMediaMessage` → Close Files
- Voice:
  1. WhatsApp-Activity als **Hinweis** (`🎤 Sprachnachricht empfangen` + S3-Abspiel-Link)
  2. Call mit `note_html`, `duration`, `recording_url` = `message.mediaUrl` (Close lädt die Datei selbst herunter)
  3. Task „WhatsApp Voice beantworten“ ohne Duplikat
- Close holt `recording_url` **sofort und ohne Login**. WhatsApp-CDN (`mmg.whatsapp.net`) ist verschlüsselt und unbrauchbar; `app.close.com/go/file` ebenfalls. Die signierte S3-URL von Evolution ist der direkte Weg (wie früher Zapier `voice.link`).
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

In n8n: **Workflows → Import from File** (bestehenden Workflow ersetzen) und den Workflow **aktivieren**. In **Config** den Close-Klartext-Key eintragen. Die Config-Node muss den Webhook-Body behalten (`keepOnlySet` aus).

Nach dem Import eine **neue** Sprachnachricht testen. In der n8n-Ausführung muss `recording_url` die Evolution-S3-URL sein (`s3.…` mit `X-Amz-Signature`), `media_linked: true`. Der WhatsApp-Hinweis enthält denselben Abspiel-Link. Close erwartet intern oft MP3; Evolution liefert `.oga` (OGG/Opus) — wenn der Player die Datei lädt, sie aber nicht abspielt, liegt es am Format.

```bash
cd n8n-whatsapp-close
python3 -m unittest test_message_parse.py -v
python3 generate_workflow.py
```

Den im Webhook-Body mitgelieferten `apikey` (Evolution/Meta) nicht ins Git und nicht nach Close schicken. Wenn er im Chat lag, rotieren.
