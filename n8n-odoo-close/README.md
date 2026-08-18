# Odoo Rechnung → Close Opportunity (n8n)

Odoo-Webhook auf `account.move` setzt in Close den Opportunity-Status und die Zahlungsdaten, sobald eine Rechnung (teil-)bezahlt ist.

## Filter

Node **Not Draft Invoice**: `display_name` enthält **nicht** `Draft Invoice` (Groß/Klein egal). Entwürfe kommen nicht in Close. Das Code-Node filtert denselben Fall noch einmal.

## Logik (wie Zapier)

| Odoo `payment_state` | Close |
| --- | --- |
| `paid` oder `in_payment`, oder `amount_residual` ≤ 0,01 | Status **paid**, Restbetrag, Vollzahlungsdatum = heute |
| `partial` | Status **partial**, Restbetrag |
| sonst | nur Restbetrag, Status unverändert |

Anzahlungsdatum wird **nur geschrieben, wenn es in Close noch leer ist**. Das Vollzahlungsdatum wird bei jeder Vollzahlung auf heute gesetzt.

Das Zapier-Feld `field_id_residual` war `custom.cf_…`. Beim PUT wird das Präfix `custom.` nur einmal gesetzt (`custom.custom.cf_…` passiert nicht).

## n8n einrichten

1. `Odoo_Close_Invoice_Status.json` importieren.
2. In **Config** den Close API-Key eintragen (`close_api_key`). Field- und Status-IDs sind schon aus Zapier übernommen.
3. Production-Webhook-URL in Odoo (Automation auf `account.move`) eintragen. Payload wie:

```json
{
  "_model": "account.move",
  "display_name": "INV/2026/00113",
  "payment_state": "paid",
  "amount_residual": 0.0,
  "amount_total": 4500.0,
  "x_studio_close_opp_id": "oppo_…"
}
```

Ohne Import: Webhook → Filter (`display_name` not contains `Draft Invoice`) → Set → Code aus `odoo_to_close.js`.

Environment-Variablen (optional statt Set-Node): `CLOSE_API_KEY`, `CLOSE_FIELD_RESIDUAL`, `CLOSE_STATUS_PARTIAL`, `CLOSE_STATUS_PAID`, `CLOSE_FIELD_DEPOSIT_DATE`, `CLOSE_FIELD_FULL_PAY_DATE`.

```bash
cd n8n-odoo-close
python3 -m unittest test_close_status_logic.py -v
python3 generate_workflow.py
```

Den Close API-Key nicht ins Git schreiben. Wenn der Key in Zapier oder im Chat lag, in Close rotieren und nur in n8n Credentials/Config hinterlegen.
