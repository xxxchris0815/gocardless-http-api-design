#!/usr/bin/env python3
"""Embed gocardless_to_odoo.js into an importable n8n workflow JSON."""

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
JS = (ROOT / "gocardless_to_odoo.js").read_text(encoding="utf-8")

WEBHOOK_ID = "a7c3e1b0-9d24-4c8f-b1e6-6f0c1d2e3a01"
SET_ID = "b18f44d2-6aa1-4e90-9c31-7a1b2c3d4e02"
CODE_ID = "c29a55e3-7bb2-4f01-8d42-8b2c3d4e5f03"

ASSIGNMENTS = [
    ("odoo_url", "https://example.odoo.com"),
    ("odoo_db", ""),
    ("odoo_api_key", ""),
    ("journal_id", "0"),
    ("odoo_gc_field", "x_gocardless_customer_id"),
    ("gocardless_token", ""),
    ("gocardless_env", "live"),
]


def assignment(name: str, value: str, index: int) -> dict:
    return {
        "id": f"cfg-{index}",
        "name": name,
        "value": value,
        "type": "string",
    }


workflow = {
    "name": "GoCardless → Odoo Bankjournal",
    "nodes": [
        {
            "parameters": {
                "httpMethod": "POST",
                "path": "gocardless-odoo",
                "responseMode": "onReceived",
                "options": {},
            },
            "id": WEBHOOK_ID,
            "name": "GoCardless Webhook",
            "type": "n8n-nodes-base.webhook",
            "typeVersion": 2,
            "position": [240, 300],
            "webhookId": "gocardless-odoo",
            "notes": "Production-URL in GoCardless als Webhook-Endpoint eintragen. Antwort erfolgt sofort, die Buchung läuft danach.",
        },
        {
            "parameters": {
                "assignments": {
                    "assignments": [
                        assignment(name, value, i) for i, (name, value) in enumerate(ASSIGNMENTS)
                    ]
                },
                "includeOtherFields": True,
                "options": {},
            },
            "id": SET_ID,
            "name": "Config",
            "type": "n8n-nodes-base.set",
            "typeVersion": 3.4,
            "position": [500, 300],
            "notes": "Zugangsdaten hier oder als n8n-Environment-Variablen setzen (ODOO_URL, ODOO_DB, ODOO_API_KEY, ODOO_JOURNAL_ID, ODOO_GC_FIELD, GOCARDLESS_TOKEN, GOCARDLESS_ENV).",
        },
        {
            "parameters": {
                "mode": "runOnceForAllItems",
                "language": "javaScript",
                "jsCode": JS,
            },
            "id": CODE_ID,
            "name": "Payments Payouts Failed",
            "type": "n8n-nodes-base.code",
            "typeVersion": 2,
            "position": [760, 300],
            "notes": "Einheitliches Script: payments.confirmed / failed / charged_back, payouts.paid / failed. Retry nach Fehlschlag erzeugt eine neue Odoo-Zeile.",
        },
    ],
    "connections": {
        "GoCardless Webhook": {
            "main": [[{"node": "Config", "type": "main", "index": 0}]]
        },
        "Config": {
            "main": [[{"node": "Payments Payouts Failed", "type": "main", "index": 0}]]
        },
    },
    "active": False,
    "settings": {"executionOrder": "v1"},
    "pinData": {},
    "meta": {"templateCredsSetupCompleted": False},
}

out = ROOT / "GoCardless_Odoo_Webhook.json"
out.write_text(json.dumps(workflow, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(f"Wrote {out}")
