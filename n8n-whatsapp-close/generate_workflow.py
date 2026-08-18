#!/usr/bin/env python3
"""Embed whatsapp_to_close.js into an importable n8n workflow JSON."""

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
JS = (ROOT / "whatsapp_to_close.js").read_text(encoding="utf-8")

WEBHOOK_ID = "b81c12d3-4e56-4789-9abc-0def12345601"
FILTER_ID = "c92d23e4-5f67-4890-abcd-1ef012345602"
SET_ID = "da3e34f5-6078-4901-bcde-2f0123456703"
CODE_ID = "eb4f4506-7189-4012-cdef-301234567804"

ASSIGNMENTS = [
    ("close_api_key", ""),
    ("my_whatsapp_number", "491758925279"),
    ("create_task", "true"),
    ("excluded_phone_number", "16416666880"),
    ("excluded_user_id", "user_JLZiYec3UhCAKchqWJLr3AMa3MeYlQeX2J0c0Ule6e0"),
    ("field_id_responsible_user", "cf_XNUTqdtJkSXJIt2XdfS61YyinahAvTWplVfvI8qMZkK"),
    ("instance_phone_map", '{"WA-B1":"491758925279"}'),
]


def assignment(name: str, value: str, index: int) -> dict:
    return {
        "id": f"wa-cfg-{index}",
        "name": name,
        "value": value,
        "type": "string",
    }


def event_equals(condition_id: str, value: str) -> dict:
    return {
        "id": condition_id,
        "leftValue": "={{ $json.body.event || $json.event || '' }}",
        "rightValue": value,
        "operator": {"type": "string", "operation": "equals"},
    }


workflow = {
    "name": "WhatsApp → Close Activity",
    "nodes": [
        {
            "parameters": {
                "httpMethod": "POST",
                "path": "whatsapp-close",
                "responseMode": "onReceived",
                "options": {},
            },
            "id": WEBHOOK_ID,
            "name": "WhatsApp Webhook",
            "type": "n8n-nodes-base.webhook",
            "typeVersion": 2,
            "position": [200, 300],
            "webhookId": "whatsapp-close",
            "notes": "Evolution-API Webhook hierhin (send.message / messages.upsert). Antwort sofort.",
        },
        {
            "parameters": {
                "conditions": {
                    "options": {
                        "caseSensitive": True,
                        "leftValue": "",
                        "typeValidation": "loose",
                        "version": 2,
                    },
                    "conditions": [
                        event_equals("ev-send", "send.message"),
                        event_equals("ev-upsert", "messages.upsert"),
                    ],
                    "combinator": "or",
                },
                "options": {},
            },
            "id": FILTER_ID,
            "name": "Message Events Only",
            "type": "n8n-nodes-base.filter",
            "typeVersion": 2.2,
            "position": [460, 300],
            "notes": "Nur send.message und messages.upsert. Connection/Receipt-Events werden verworfen.",
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
            "notes": "close_api_key eintragen. instance_phone_map mappt Evolution-Instanz auf die lokale WA-Nummer.",
        },
        {
            "parameters": {
                "mode": "runOnceForAllItems",
                "language": "javaScript",
                "jsCode": JS,
            },
            "id": CODE_ID,
            "name": "Create Close WhatsApp Activity",
            "type": "n8n-nodes-base.code",
            "typeVersion": 2,
            "position": [980, 300],
            "notes": "Lead per Telefon suchen, Activity anlegen, bei Incoming Task 'WhatsApp beantworten'. Bilder als Markdown-Link.",
        },
    ],
    "connections": {
        "WhatsApp Webhook": {
            "main": [[{"node": "Message Events Only", "type": "main", "index": 0}]]
        },
        "Message Events Only": {
            "main": [[{"node": "Config", "type": "main", "index": 0}]]
        },
        "Config": {
            "main": [[{"node": "Create Close WhatsApp Activity", "type": "main", "index": 0}]]
        },
    },
    "active": False,
    "settings": {"executionOrder": "v1"},
    "pinData": {},
    "meta": {"templateCredsSetupCompleted": False},
}

out = ROOT / "WhatsApp_Close_Activity.json"
out.write_text(json.dumps(workflow, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(f"Wrote {out}")
