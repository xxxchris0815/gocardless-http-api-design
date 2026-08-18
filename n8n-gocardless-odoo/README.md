# GoCardless Webhooks → Odoo (n8n)

Ein Workflow ersetzt die drei Zapier-Scripts (Payment confirmed, Payment failed, Payout). Er verarbeitet in einem Lauf:

| Event | Odoo-Buchung |
| --- | --- |
| `payments` / `confirmed` | Plusbetrag im GC-Journal |
| `payments` / `failed` (endgültig) | Minusbetrag, **nur** wenn vorher ein unmatched `confirmed` existiert |
| `payments` / `charged_back` | wie failed (Rücklastschrift) |
| `payments` / `cancelled` | Storno, nur wenn etwas zu stornieren ist |
| `payouts` / `paid` plus `paid_out` / `surcharge_fee_debited` / `late_failure_settled` | Gebühren, Rückbuchungen, Transfer an die Bank |
| `payouts` / `failed` | kein Transfer, nur Log |

`failed` mit `details.will_attempt_retry: true` wird ignoriert. GoCardless versucht denselben Payment erneut; gebucht wird erst das endgültige `confirmed` oder `failed`.

## Der Retry-Bug (keine neue Zeile nach erneutem Einzug)

Die Zapier-Scripts nutzten:

```text
unique_import_id = "{payment_id}_CONFIRMED"
```

Ein manueller oder automatischer Retry **behält dieselbe Payment-ID**. Nach einer Late Failure existierte die alte CONFIRMED-Id bereits, die Suche fand sie, und der erfolgreiche Wiedereinzug wurde übersprungen.

Neue Ids sind event-bezogen:

```text
{payment_id}_CONFIRMED_{event_id}
{payment_id}_FAILED_{event_id}
```

Logik:

1. `confirmed` → buchen, wenn dieses Event noch nicht gebucht ist **und** es keine offene (nicht stornierte) Bestätigung gibt.
2. Nach `failed`/`charged_back` ist die Bestätigung ausgeglichen → das nächste `confirmed` (erneuter Einzug) erzeugt eine **neue** Zeile. `payment_ref` beginnt dann mit `ERNEUTER EINZUG (2)`.
3. Alte Zapier-Ids (`PM…_CONFIRMED` ohne Event-Id) werden weiter erkannt, damit bestehende Zeilen nicht doppelt landen.

Zusätzlich: ein endgültiges `failed` ohne vorheriges `confirmed` erzeugt **keine** negative Phantomzeile. Sonst würde ein späterer erfolgreicher Einzug netto 0 ergeben.

Payout-Chargebacks (`chargeback`, `payment_refunded`, …) werden übersprungen, wenn `payments.failed` denselben Payment schon storniert hat (keine Doppelbuchung).

## n8n einrichten

1. Workflow importieren: `GoCardless_Odoo_Webhook.json` (n8n → *Workflows* → *Import*).
2. Node **Config** ausfüllen:
   - `odoo_url` — z. B. `https://meinefirma.odoo.com` (ohne Slash am Ende)
   - `odoo_db`
   - `odoo_api_key` — Bearer-Key für `/json/2/`
   - `journal_id` — ID des GoCardless-Bankjournals
   - `odoo_gc_field` — optionales Partner-Feld für die GoCardless-Customer-Id
   - `gocardless_token`
   - `gocardless_env` — `live` oder `sandbox`
3. Alternativ dieselben Werte als n8n-Environment: `ODOO_URL`, `ODOO_DB`, `ODOO_API_KEY`, `ODOO_JOURNAL_ID`, `ODOO_GC_FIELD`, `GOCARDLESS_TOKEN`, `GOCARDLESS_ENV`.
4. Webhook-Node aktivieren, Production-URL in GoCardless unter *Developers → Webhook endpoints* eintragen.
5. Code-Node: **Run Once for All Items**, Language **JavaScript**. Der Webhook antwortet sofort (`onReceived`), die Buchung läuft danach — GoCardless wartet max. ~10 s.

Ohne Import: Webhook → Set (Felder wie oben, *Include Other Input Fields*) → Code, Inhalt aus `gocardless_to_odoo.js` einfügen.

## Dateien

| Datei | Zweck |
| --- | --- |
| `gocardless_to_odoo.js` | n8n Code-Node (hier einfügen) |
| `GoCardless_Odoo_Webhook.json` | Importierbarer Workflow |
| `booking_logic.py` | Dieselbe Buchungsentscheidung, testbar |
| `test_booking_logic.py` | Retry-, Failed- und Payout-Fälle |
| `generate_workflow.py` | Schreibt die JSON neu, wenn sich das JS ändert |

```bash
cd n8n-gocardless-odoo
python3 -m unittest test_booking_logic.py -v
python3 generate_workflow.py
```

## Alte Fehlbuchungen

Wenn Zapier bei einem Erstversuch ohne `confirmed` schon `{payment_id}_FAILED` als Minuszeile geschrieben hat, bleibt diese Zeile stehen. Den Phantom-Storno in Odoo einmalig löschen, sonst ist der Saldo nach dem erfolgreichen Wiedereinzug um genau diesen Betrag zu niedrig.

## Weitere Workflows

Odoo-Rechnung bezahlt → Close-Opportunity: [`n8n-odoo-close/`](../n8n-odoo-close/README.md)
