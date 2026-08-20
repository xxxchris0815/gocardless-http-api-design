#!/usr/bin/env python3
"""Embed whatsapp_to_close.js into an importable n8n workflow JSON."""

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CLOSE_JS = (ROOT / "whatsapp_to_close.js").read_text(encoding="utf-8")
CONVERT_JS = (ROOT / "voice_convert.js").read_text(encoding="utf-8")
PRESIGN_JS = (ROOT / "minio_presign.js").read_text(encoding="utf-8")

WEBHOOK_ID = "b81c12d3-4e56-4789-9abc-0def12345601"
UNWRAP_ID = "fa5a5617-8290-4123-d0e0-412345678905"
FILTER_ID = "c92d23e4-5f67-4890-abcd-1ef012345602"
SET_ID = "da3e34f5-6078-4901-bcde-2f0123456703"
CONVERT_ID = "fc5a5618-8291-4124-d0e1-412345678906"
IF_ID = "0d6b6729-93a2-4235-e1f2-523456789017"
PRESIGN_ID = "2f8d894b-b5c4-4457-a314-745678901239"
HTTP_ID = "1e7c783a-a4b3-4346-f203-634567890128"
CODE_ID = "eb4f4506-7189-4012-cdef-301234567804"

ASSIGNMENTS = [
    ("close_api_key", ""),
    ("my_whatsapp_number", ""),
    ("create_task", "true"),
    ("excluded_phone_number", "16416666880"),
    ("excluded_user_id", "user_JLZiYec3UhCAKchqWJLr3AMa3MeYlQeX2J0c0Ule6e0"),
    ("field_id_responsible_user", "cf_XNUTqdtJkSXJIt2XdfS61YyinahAvTWplVfvI8qMZkK"),
    ("evolution_base_url", ""),
    ("evolution_api_key", ""),
    ("upload_media", "true"),
    ("s3_endpoint", ""),
    ("s3_bucket", ""),
    ("s3_access_key", ""),
    ("s3_secret_key", ""),
    ("s3_region", "us-east-1"),
]

UNWRAP_JS = """function collect(raw, depth) {
  depth = depth || 0;
  if (depth > 8 || raw === undefined || raw === null) return [];
  if (typeof raw === 'string') {
    try { return collect(JSON.parse(raw), depth + 1); } catch (e) { return []; }
  }
  if (Array.isArray(raw)) {
    const found = [];
    for (const item of raw) found.push.apply(found, collect(item, depth + 1));
    return found;
  }
  if (typeof raw !== 'object') return [];
  if (typeof raw.event === 'string' && raw.data) return [raw];
  const found = [];
  if (raw.json) found.push.apply(found, collect(raw.json, depth + 1));
  if (raw.body) found.push.apply(found, collect(raw.body, depth + 1));
  return found;
}

const out = [];
for (const item of $input.all()) {
  const payloads = collect(item.json);
  for (const p of payloads) {
    const body = Object.assign({}, p);
    const evoKey = body.apikey;
    const serverUrl = body.server_url;
    const sender = body.sender;
    delete body.apikey;
    out.push({
      json: {
        body: body,
        event: body.event,
        instance: body.instance,
        data: body.data,
        server_url: serverUrl,
        sender: sender,
        _evo_apikey: evoKey || "",
      },
    });
  }
}
return out;
"""


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
            "notes": "Nimmt n8n-Webhook-Items entgegen (headers + body) und nackte Evolution-Bodies.",
        },
        {
            "parameters": {
                "mode": "runOnceForAllItems",
                "language": "javaScript",
                "jsCode": UNWRAP_JS,
            },
            "id": UNWRAP_ID,
            "name": "Unwrap Evolution Body",
            "type": "n8n-nodes-base.code",
            "typeVersion": 2,
            "position": [440, 300],
            "notes": "Holt event/data aus n8n-Wrapper-Arrays [{ headers, body }].",
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
            "position": [680, 300],
            "notes": "Nur send.message und messages.upsert.",
        },
        {
            "parameters": {
                "keepOnlySet": False,
                "values": {
                    "string": [
                        {"name": name, "value": value} for name, value in ASSIGNMENTS
                    ]
                },
                "options": {},
            },
            "id": SET_ID,
            "name": "Config",
            "type": "n8n-nodes-base.set",
            "typeVersion": 2,
            "position": [920, 300],
            "notes": "Nur zusätzliche Felder setzen, Webhook-Body behalten (keepOnlySet=false). close_api_key = Klartext-Key (api_…). s3_access_key / s3_secret_key = MinIO wie Evolution. Endpoint/Bucket können aus mediaUrl kommen.",
        },
        {
            "parameters": {
                "mode": "runOnceForAllItems",
                "language": "javaScript",
                "jsCode": CONVERT_JS,
            },
            "id": CONVERT_ID,
            "name": "Convert Voice to MP3",
            "type": "n8n-nodes-base.code",
            "typeVersion": 2,
            "position": [1160, 300],
            "notes": "Nur ffmpeg: Voice-OGA laden, MP3 als Binary data ausgeben. JSON durchreichen. Kein MinIO, kein Close.",
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
                        {
                            "id": "need-minio",
                            "leftValue": "={{ $json.needs_minio_upload }}",
                            "rightValue": True,
                            "operator": {
                                "type": "boolean",
                                "operation": "true",
                                "singleValue": True,
                            },
                        }
                    ],
                    "combinator": "and",
                },
                "options": {},
            },
            "id": IF_ID,
            "name": "Voice MP3?",
            "type": "n8n-nodes-base.if",
            "typeVersion": 2.2,
            "position": [1400, 300],
            "notes": "Nur Voice mit fertiger MP3 geht in Presign + MinIO-PUT.",
        },
        {
            "parameters": {
                "mode": "runOnceForAllItems",
                "language": "javaScript",
                "jsCode": PRESIGN_JS,
            },
            "id": PRESIGN_ID,
            "name": "Prepare MinIO Upload",
            "type": "n8n-nodes-base.code",
            "typeVersion": 2,
            "position": [1640, 180],
            "notes": "Presigned PUT/GET für die MP3. Binary durchreichen.",
        },
        {
            "parameters": {
                "method": "PUT",
                "url": "={{ $json.s3_put_url }}",
                "sendHeaders": True,
                "headerParameters": {
                    "parameters": [{"name": "Content-Type", "value": "audio/mpeg"}]
                },
                "sendBody": True,
                "contentType": "binaryData",
                "inputDataFieldName": "data",
                "options": {
                    "timeout": 60000,
                    "response": {
                        "response": {
                            "fullResponse": True,
                            "neverError": True,
                            "responseFormat": "text",
                        }
                    },
                },
            },
            "id": HTTP_ID,
            "name": "Upload MP3 MinIO",
            "type": "n8n-nodes-base.httpRequest",
            "typeVersion": 4.2,
            "position": [1880, 180],
            "onError": "continueRegularOutput",
            "notes": "PUT der MP3 nach MinIO über die presigned URL aus Prepare MinIO Upload.",
        },
        {
            "parameters": {
                "mode": "runOnceForAllItems",
                "language": "javaScript",
                "jsCode": CLOSE_JS,
            },
            "id": CODE_ID,
            "name": "Create Close WhatsApp Activity",
            "type": "n8n-nodes-base.code",
            "typeVersion": 2,
            "position": [2120, 300],
            "notes": "Liest Webhook aus Convert Voice to MP3, recording_url aus Prepare MinIO Upload. Lead suchen, WhatsApp-Hinweis, Call.",
        },
    ],
    "connections": {
        "WhatsApp Webhook": {
            "main": [[{"node": "Unwrap Evolution Body", "type": "main", "index": 0}]]
        },
        "Unwrap Evolution Body": {
            "main": [[{"node": "Message Events Only", "type": "main", "index": 0}]]
        },
        "Message Events Only": {
            "main": [[{"node": "Config", "type": "main", "index": 0}]]
        },
        "Config": {
            "main": [[{"node": "Convert Voice to MP3", "type": "main", "index": 0}]]
        },
        "Convert Voice to MP3": {
            "main": [[{"node": "Voice MP3?", "type": "main", "index": 0}]]
        },
        "Voice MP3?": {
            "main": [
                [{"node": "Prepare MinIO Upload", "type": "main", "index": 0}],
                [{"node": "Create Close WhatsApp Activity", "type": "main", "index": 0}],
            ]
        },
        "Prepare MinIO Upload": {
            "main": [[{"node": "Upload MP3 MinIO", "type": "main", "index": 0}]]
        },
        "Upload MP3 MinIO": {
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
