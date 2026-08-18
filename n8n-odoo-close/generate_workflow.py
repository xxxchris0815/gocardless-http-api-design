#!/usr/bin/env python3
"""Embed odoo_to_close.js into an importable n8n workflow JSON."""

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
JS = (ROOT / "odoo_to_close.js").read_text(encoding="utf-8")

WEBHOOK_ID = "d40b66f4-8cc3-4a12-9e70-1a2b3c4d5e11"
FILTER_ID = "e51c77a5-9dd4-4b23-8f81-2b3c4d5e6f22"
SET_ID = "f62d88b6-0ee5-4c34-9a92-3c4d5e6f7a33"
CODE_ID = "a73e99c7-1ff6-4d45-8b03-4d5e6f7a8b44"

# Field / status IDs from the existing Zapier config. The Close API key stays empty.
ASSIGNMENTS = [
    ("close_api_key", ""),
    ("field_id_residual", "cf_q6Ho0eoB1QNrxnVRpZMg4AVQGSSYVyoijjHGlEG9Ipf"),
    ("status_id_partial", "stat_UYfeivz3DkREtA8Zg3gXCDxdYO97Z99rlln5uDIHQkM"),
    ("status_id_paid", "stat_tbowGdRIqnF0bDsZeNmcEyiefUkdWfp1cap4PVD9Ive"),
    ("field_id_deposit_date", "cf_OxCaftVBRHVJM1vIIVrVqRTtdjoQJ3f8yGnOUU0YpZY"),
    ("field_id_full_pay_date", "cf_JH04OF409wsXMK0ATa20Wn9aPW7w8pdAsQHFMSamnMU"),
]


def assignment(name: str, value: str, index: int) -> dict:
    return {
        "id": f"close-cfg-{index}",
        "name": name,
        "value": value,
        "type": "string",
    }


workflow = {
    "name": "Odoo Rechnung → Close Opportunity",
    "nodes": [
        {
            "parameters": {
                "httpMethod": "POST",
                "path": "odoo-invoice-close",
                "responseMode": "onReceived",
                "options": {},
            },
            "id": WEBHOOK_ID,
            "name": "Odoo Invoice Webhook",
            "type": "n8n-nodes-base.webhook",
            "typeVersion": 2,
            "position": [200, 300],
            "webhookId": "odoo-invoice-close",
            "notes": "Odoo Automation/Webhook auf account.move hierhin zeigen. Antwort erfolgt sofort.",
        },
        {
            "parameters": {
                "conditions": {
                    "options": {
                        "caseSensitive": False,
                        "leftValue": "",
                        "typeValidation": "loose",
                        "version": 2,
                    },
                    "conditions": [
                        {
                            "id": "not-draft-invoice",
                            "leftValue": "={{ $json.body.display_name || $json.display_name || '' }}",
                            "rightValue": "Draft Invoice",
                            "operator": {
                                "type": "string",
                                "operation": "notContains",
                            },
                        }
                    ],
                    "combinator": "and",
                },
                "options": {},
            },
            "id": FILTER_ID,
            "name": "Not Draft Invoice",
            "type": "n8n-nodes-base.filter",
            "typeVersion": 2.2,
            "position": [460, 300],
            "notes": "Entwürfe (display_name enthält 'Draft Invoice') werden nicht nach Close geschickt.",
        },
        {
            "parameters": {
                "assignments": {
                    "assignments": [assignment(name, value, i) for i, (name, value) in enumerate(ASSIGNMENTS)]
                },
                "includeOtherFields": True,
                "options": {},
            },
            "id": SET_ID,
            "name": "Config",
            "type": "n8n-nodes-base.set",
            "typeVersion": 3.4,
            "position": [720, 300],
            "notes": "close_api_key = Klartext-Key (api_…), nicht der Hash aus der Close-UI (oder CLOSE_API_KEY als n8n-Environment). Field/Status-IDs stammen aus Zapier.",
        },
        {
            "parameters": {
                "mode": "runOnceForAllItems",
                "language": "javaScript",
                "jsCode": JS,
            },
            "id": CODE_ID,
            "name": "Update Close Opportunity",
            "type": "n8n-nodes-base.code",
            "typeVersion": 2,
            "position": [980, 300],
            "notes": "paid/in_payment → Status paid + Vollzahlungsdatum; partial → Status partial. Anzahlungsdatum nur wenn leer.",
        },
    ],
    "connections": {
        "Odoo Invoice Webhook": {
            "main": [[{"node": "Not Draft Invoice", "type": "main", "index": 0}]]
        },
        "Not Draft Invoice": {
            "main": [[{"node": "Config", "type": "main", "index": 0}]]
        },
        "Config": {
            "main": [[{"node": "Update Close Opportunity", "type": "main", "index": 0}]]
        },
    },
    "active": False,
    "settings": {"executionOrder": "v1"},
    "pinData": {},
    "meta": {"templateCredsSetupCompleted": False},
}

out = ROOT / "Odoo_Close_Invoice_Status.json"
out.write_text(json.dumps(workflow, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(f"Wrote {out}")
