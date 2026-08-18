#!/usr/bin/env python3
"""WhatsApp webhook parsing tests (Evolution + legacy Zapier format)."""

import unittest
from pathlib import Path

from message_parse import (
    is_group_or_broadcast,
    is_relevant_event,
    parse_webhook,
    phone_search_variants,
    public_media_url,
)


SAMPLE_SEND = {
    "event": "send.message",
    "instance": "WA-B1",
    "data": {
        "key": {
            "fromMe": True,
            "id": "wamid.HBgMNDkxNjAxODY1NDIxFQIAERgSNjM4QURDMDNFRTQyMDFBMkMxAA==",
            "remoteJid": "491601865421@s.whatsapp.net",
        },
        "message": {"conversation": "was genau findest du toll"},
        "messageType": "conversation",
        "messageTimestamp": 1787049466,
        "status": "PENDING",
    },
    "date_time": "2026-08-18T07:37:46.499Z",
}


class EvolutionSampleTests(unittest.TestCase):
    def test_outgoing_conversation(self):
        parsed = parse_webhook(SAMPLE_SEND, "491758925279")
        self.assertIsNotNone(parsed)
        self.assertFalse(parsed["is_incoming"])
        self.assertEqual(parsed["remote_phone"], "491601865421")
        self.assertEqual(parsed["local_phone"], "491758925279")
        self.assertEqual(parsed["type"], "text")
        self.assertEqual(parsed["text"], "was genau findest du toll")
        self.assertEqual(parsed["id"], SAMPLE_SEND["data"]["key"]["id"])

    def test_incoming_image_with_public_link(self):
        payload = {
            "event": "messages.upsert",
            "data": {
                "key": {
                    "fromMe": False,
                    "id": "ABCD",
                    "remoteJid": "491701112223@s.whatsapp.net",
                },
                "message": {
                    "imageMessage": {
                        "caption": "hier das foto",
                        "url": "https://cdn.example.com/pic.jpg",
                    }
                },
                "messageType": "imageMessage",
                "messageTimestamp": 1787049466,
            },
        }
        parsed = parse_webhook(payload, "491758925279")
        self.assertTrue(parsed["is_incoming"])
        self.assertIn("hier das foto", parsed["text"])
        self.assertIn("Bild ansehen", parsed["text"])
        self.assertEqual(parsed["media_url"], "https://cdn.example.com/pic.jpg")

    def test_whatsapp_cdn_url_is_not_used_as_link(self):
        payload = {
            "event": "messages.upsert",
            "data": {
                "key": {"fromMe": False, "id": "X", "remoteJid": "49170@s.whatsapp.net"},
                "message": {
                    "imageMessage": {
                        "url": "https://mmg.whatsapp.net/v/t62.encrypted",
                    }
                },
                "messageType": "imageMessage",
            },
        }
        parsed = parse_webhook(payload, "49")
        self.assertIn("Foto empfangen", parsed["text"])
        self.assertNotIn("mmg.whatsapp.net", parsed["text"])
        self.assertIsNone(parsed["media_url"])

    def test_skips_groups_and_status_events(self):
        group = {
            "event": "messages.upsert",
            "data": {
                "key": {"fromMe": False, "id": "G", "remoteJid": "120363@g.us"},
                "message": {"conversation": "hallo gruppe"},
            },
        }
        self.assertIsNone(parse_webhook(group, "49"))
        self.assertFalse(is_relevant_event("connection.update"))
        self.assertTrue(is_relevant_event("send.message"))
        self.assertTrue(is_group_or_broadcast("status@broadcast"))


class LegacyZapierTests(unittest.TestCase):
    def test_incoming_text(self):
        payload = {
            "messages": [
                {
                    "id": "wamid.legacy",
                    "from_me": False,
                    "from": "491601865421@c.us",
                    "chat_id": "491601865421@c.us",
                    "type": "text",
                    "text": {"body": "hallo"},
                    "timestamp": 1787049466,
                }
            ]
        }
        parsed = parse_webhook(payload, "+49 175 8925279")
        self.assertTrue(parsed["is_incoming"])
        self.assertEqual(parsed["text"], "hallo")
        self.assertEqual(parsed["local_phone"], "491758925279")

    def test_reaction_removed_skips(self):
        payload = {
            "messages": [
                {
                    "id": "rx1",
                    "from_me": False,
                    "from": "49160@c.us",
                    "type": "action",
                    "action": {"type": "reaction"},
                    "timestamp": 1,
                }
            ]
        }
        parsed = parse_webhook(payload, "49")
        self.assertTrue(parsed["skip"])
        self.assertEqual(parsed["reason"], "Reaction removed")


class PhoneVariantTests(unittest.TestCase):
    def test_german_mobile_variants(self):
        variants = phone_search_variants("491601865421")
        self.assertIn("491601865421", variants)
        self.assertIn("+491601865421", variants)
        self.assertIn("1601865421", variants)
        self.assertIn("01601865421", variants)


class MediaUrlTests(unittest.TestCase):
    def test_public_vs_cdn(self):
        self.assertIsNone(public_media_url("https://mmg.whatsapp.net/x"))
        self.assertEqual(public_media_url("https://files.example.com/a.jpg"), "https://files.example.com/a.jpg")


class JsSmokeTests(unittest.TestCase):
    def test_n8n_script_handles_evolution_and_close_activity(self):
        js = Path(__file__).with_name("whatsapp_to_close.js").read_text(encoding="utf-8")
        self.assertIn("send.message", js)
        self.assertIn("messages.upsert", js)
        self.assertIn("whatsapp_message", js)
        self.assertIn("external_whatsapp_message_id", js)
        self.assertIn("fromMe", js)


if __name__ == "__main__":
    unittest.main()
