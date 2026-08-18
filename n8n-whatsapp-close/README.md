# WhatsApp → Close Activity (n8n)

Nur **Evolution API**. Webhooks `send.message` und `messages.upsert` werden zu Close-Aktivitäten. Incoming-Nachrichten erzeugen optional eine Task.

- Text, Bild, Video, GIF, Dokument, Sticker → WhatsApp-Activity (Medien als Anhang)
- Sprachnachricht (`ptt`) → zuerst WhatsApp-Hinweis mit Anhang/Abspiel-Link, danach **Call-Activity** mit Aufzeichnung (wie die zwei Zapier-Scripts)

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

1. **WhatsApp Webhook** — POST, antwortet sofort
2. **Unwrap Evolution Body** — holt `event`/`data` aus n8n-`headers`+`body`-Arrays
3. **Message Events Only** — nur `send.message` und `messages.upsert`
4. **Config** — Close-Key und Nummern
5. **Create Close WhatsApp Activity** — Lead suchen, Activity, bei Incoming Task
6. **Close Recording Download** (GET, eigener Trigger) — liefert Close die Audiodatei

## Logik

- Telefonvarianten: `49160…`, `+49160…`, `160…`, `0160…`
- Incoming: zuständiger User zuerst aus dem Custom Field, sonst letzte **Outbound**-Activity, sonst WA-/Call-History
- Outgoing: Close-User aus `/me/`
- Bilder, Video, GIF, Dokument, Sticker: Evolution `getBase64FromMediaMessage` → Close Files → WhatsApp-`attachments`
- Voice (Zapier-Port):
  1. WhatsApp-Activity als **Hinweis** (`🎤 Sprachnachricht empfangen` + `[▶️ Sprachdatei abspielen]`, Audio als Close-Files-Anhang)
  2. Call mit `note_html`, `duration`, `recording_url` (öffentlicher GET-Webhook, analog zu Zapier `voice.link`)
  3. Task „WhatsApp Voice beantworten“ ohne Duplikat
- Der Workflow muss **aktiv** sein, sonst kann Close die Recording-URL nicht abholen
- WhatsApp-CDN-URLs (`mmg.whatsapp.net`) werden nicht als Markdown verlinkt
- Duplikate: gleiche `wamid` → skip (vor dem Media-Download)

## Config

| Feld | Bedeutung |
| --- | --- |
| `close_api_key` | Close **Klartext**-API-Key (beginnt mit `api_`). Nicht den Hash/Fingerprint aus der Key-Liste. Nicht committen. |
| `my_whatsapp_number` | lokale WhatsApp-Nummer ohne `+` (steht in Close als `local_phone`) |
| `create_task` | `true`/`false` |
| `excluded_phone_number` / `excluded_user_id` | History-Filter, falls das Custom Field leer ist |
| `field_id_responsible_user` | Close Custom Field auf dem Lead; wenn gesetzt, hat es Vorrang vor der History |
| `evolution_base_url` | Evolution-Server, z. B. `https://evo.example.com` (ohne Slash am Ende) |
| `evolution_api_key` | Evolution-`apikey`. Fallback: `apikey` aus dem originalen Webhook |
| `upload_media` | `true`/`false`, Default `true` |

In n8n: **Workflows → Import from File** (bestehenden Workflow ersetzen) und den Workflow **aktivieren**. In **Config** `close_api_key` und `my_whatsapp_number` eintragen. Die Config-Node muss den Webhook-Body behalten (`keepOnlySet` aus).

Nach dem Import erscheint in der Ausführung `recording_url` wie `https://…/webhook/whatsapp-close-recording?t=…`. Wenn der Call ohne Player ankommt, steht der Grund in `media_upload_error`.

```bash
cd n8n-whatsapp-close
python3 -m unittest test_message_parse.py -v
python3 generate_workflow.py
```

Den im Webhook-Body mitgelieferten `apikey` (Evolution/Meta) nicht ins Git und nicht nach Close schicken. Wenn er im Chat lag, rotieren.
