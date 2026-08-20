#!/usr/bin/env python3
"""Evolution API WhatsApp webhook parsing tests."""

import json
import unittest
from pathlib import Path

from message_parse import (
    collect_evolution_payloads,
    filename_for_media,
    is_close_app_file_url,
    is_group_or_broadcast,
    is_relevant_event,
    jid_to_phone,
    needs_media_upload,
    parse_webhook,
    phone_from_instance_info,
    phone_search_variants,
    pick_responsible_user,
    public_media_url,
    force_https,
    is_public_recording_url,
    needs_mp3_for_close_recording,
    parse_s3_media_url,
    mp3_key_from_source,
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

    def test_empty_reaction_is_skipped(self):
        payload = {
            "event": "messages.upsert",
            "data": {
                "key": {"fromMe": False, "id": "rx1", "remoteJid": "49160@s.whatsapp.net"},
                "message": {"reactionMessage": {"text": ""}},
                "messageType": "reactionMessage",
            },
        }
        parsed = parse_webhook(payload, "49")
        self.assertTrue(parsed["skip"])
        self.assertEqual(parsed["reason"], "Reaction removed")

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

    def test_incoming_voice_note_n8n_wrapper(self):
        wrapped = [
            {
                "headers": {"host": "automation.orgasmic.live"},
                "params": {},
                "query": {},
                "body": {
                    "event": "messages.upsert",
                    "instance": "WA-Business_Alexandra",
                    "data": {
                        "key": {
                            "remoteJid": "491601865421@s.whatsapp.net",
                            "fromMe": False,
                            "id": "3EB0555C13E55CF32997DB",
                        },
                        "message": {
                            "audioMessage": {
                                "url": "https://mmg.whatsapp.net/v/t62.encrypted",
                                "mimetype": "audio/ogg; codecs=opus",
                                "seconds": 8,
                                "ptt": True,
                                "mediaKey": {"0": 74, "1": 50, "2": 13},
                            }
                        },
                        "messageType": "audioMessage",
                        "messageTimestamp": 1787071507,
                        "pushName": "Christian",
                    },
                    "server_url": "https://wa.orgasmic.live",
                    "sender": "14087093943@s.whatsapp.net",
                    "apikey": "REDACTED",
                },
            }
        ]
        found = collect_evolution_payloads(wrapped)
        self.assertEqual(len(found), 1)
        parsed = parse_webhook(found[0], "491758925279")
        self.assertTrue(parsed["is_incoming"])
        self.assertEqual(parsed["type"], "voice")
        self.assertEqual(parsed["remote_phone"], "491601865421")
        self.assertEqual(parsed["local_phone"], "14087093943")
        self.assertEqual(parsed["instance"], "WA-Business_Alexandra")
        self.assertEqual(parsed["server_url"], "https://wa.orgasmic.live")
        self.assertIn("Sprachnachricht empfangen", parsed["text"])
        self.assertIn("8s", parsed["text"])
        self.assertNotIn("mmg.whatsapp.net", parsed["text"])
        self.assertTrue(needs_media_upload(parsed["type"]))
        self.assertIsNone(parsed["media_url"])
        self.assertEqual(parsed["duration_seconds"], 8)
        self.assertEqual(parsed["from_name"], "Christian")

    def test_incoming_voice_prefers_s3_media_url(self):
        s3 = (
            "https://s3.example.com/evolution/audioMessage/voice.oga"
            "?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=test"
            "&X-Amz-Signature=abc123"
        )
        wrapped = [
            {
                "headers": {},
                "body": {
                    "event": "messages.upsert",
                    "instance": "WA-Business_Alexandra",
                    "data": {
                        "key": {
                            "remoteJid": "491601865421@s.whatsapp.net",
                            "fromMe": False,
                            "id": "ACB97A4776A99ECFD45F3069BC54B212",
                        },
                        "pushName": "Christian",
                        "message": {
                            "audioMessage": {
                                "url": "https://mmg.whatsapp.net/v/t62.encrypted",
                                "mimetype": "audio/ogg; codecs=opus",
                                "seconds": 4,
                                "ptt": True,
                            },
                            "mediaUrl": s3,
                        },
                        "messageType": "audioMessage",
                        "messageTimestamp": 1787165155,
                    },
                    "sender": "14087093943@s.whatsapp.net",
                    "server_url": "https://wa.example.com",
                    "apikey": "REDACTED",
                },
            }
        ]
        parsed = parse_webhook(wrapped, "491758925279")
        self.assertEqual(parsed["type"], "voice")
        self.assertEqual(parsed["media_url"], s3)
        self.assertIn("Abspielen", parsed["text"])
        self.assertIn("s3.example.com", parsed["text"])
        self.assertNotIn("mmg.whatsapp.net", parsed["text"])
        self.assertEqual(parsed["duration_seconds"], 4)
        self.assertTrue(is_public_recording_url(parsed["media_url"]))
        self.assertTrue(
            needs_mp3_for_close_recording(parsed["media_url"], "audio/ogg; codecs=opus")
        )

    def test_image_prefers_s3_media_url_over_cdn(self):
        s3 = "https://s3.example.com/evolution/photo.jpg?X-Amz-Signature=abc"
        payload = {
            "event": "messages.upsert",
            "data": {
                "key": {"fromMe": False, "id": "IMG1", "remoteJid": "49160@s.whatsapp.net"},
                "message": {
                    "imageMessage": {
                        "caption": "hier das foto",
                        "url": "https://mmg.whatsapp.net/v/t62.encrypted",
                    },
                    "mediaUrl": s3,
                },
                "messageType": "imageMessage",
            },
        }
        parsed = parse_webhook(payload, "49")
        self.assertEqual(parsed["type"], "image")
        self.assertEqual(parsed["media_url"], s3)
        self.assertIn("Bild ansehen", parsed["text"])
        self.assertIn("s3.example.com", parsed["text"])
        self.assertNotIn("mmg.whatsapp.net", parsed["text"])

    def test_incoming_gif_video_message(self):
        payload = {
            "event": "messages.upsert",
            "instance": "WA-Business_Alexandra",
            "data": {
                "key": {
                    "remoteJid": "491601865421@s.whatsapp.net",
                    "fromMe": False,
                    "id": "3EB02B3ABADD9AB18F6B79",
                },
                "message": {
                    "videoMessage": {
                        "url": "https://mmg.whatsapp.net/o1/v/encrypted",
                        "mimetype": "video/mp4",
                        "seconds": 1,
                        "gifPlayback": True,
                        "accessibilityLabel": "TV gif. Timmy from Shaun the Sheep.",
                    }
                },
                "messageType": "videoMessage",
                "messageTimestamp": 1787071823,
            },
            "sender": "14087093943@s.whatsapp.net",
            "server_url": "https://wa.orgasmic.live",
        }
        parsed = parse_webhook(payload, "491758925279")
        self.assertEqual(parsed["type"], "gif")
        self.assertTrue(parsed["is_incoming"])
        self.assertIn("Timmy from Shaun the Sheep", parsed["text"])
        self.assertNotIn("mmg.whatsapp.net", parsed["text"])
        self.assertTrue(needs_media_upload(parsed["type"]))
        self.assertEqual(filename_for_media("gif", "video/mp4"), "gif.mp4")

    def test_n8n_webhook_wrapper_array(self):
        wrapped = [
            {
                "headers": {"host": "automation.example.com"},
                "params": {},
                "query": {},
                "body": SAMPLE_SEND,
                "webhookUrl": "https://automation.example.com/webhook/abc",
                "executionMode": "production",
            }
        ]
        bodies = collect_evolution_payloads(wrapped)
        self.assertEqual(len(bodies), 1)
        parsed = parse_webhook(wrapped, "491758925279")
        self.assertEqual(parsed["text"], "was genau findest du toll")
        self.assertEqual(parsed["remote_phone"], "491601865421")
        self.assertFalse(parsed["is_incoming"])

        doubled = wrapped + wrapped
        self.assertEqual(len(collect_evolution_payloads(doubled)), 2)

    def test_n8n_item_with_config_fields_still_finds_body(self):
        item = {
            "close_api_key": "secret",
            "headers": {},
            "body": SAMPLE_SEND,
        }
        parsed = parse_webhook(item, "491758925279")
        self.assertEqual(parsed["id"], SAMPLE_SEND["data"]["key"]["id"])

    def test_ignores_non_evolution_payloads(self):
        zapier = {
            "messages": [
                {
                    "id": "wamid.legacy",
                    "from_me": False,
                    "from": "491601865421@c.us",
                    "type": "text",
                    "text": {"body": "hallo"},
                }
            ]
        }
        self.assertIsNone(parse_webhook(zapier, "49"))
        self.assertIsNone(parse_webhook({"event": "connection.update", "data": {}}, "49"))


class PhoneVariantTests(unittest.TestCase):
    def test_german_mobile_variants(self):
        variants = phone_search_variants("491601865421")
        self.assertEqual(variants, ["491601865421", "+491601865421", "1601865421", "01601865421"])

    def test_jid_strips_device_suffix(self):
        self.assertEqual(jid_to_phone("14087093943:12@s.whatsapp.net"), "14087093943")
        self.assertEqual(jid_to_phone("491758925279@s.whatsapp.net"), "491758925279")


class EvolutionInstancePhoneTests(unittest.TestCase):
    def test_owner_jid_for_named_instance(self):
        payload = [
            {
                "instance": {
                    "instanceName": "WA-Business_Alexandra",
                    "owner": "14087093943@s.whatsapp.net",
                    "status": "open",
                }
            },
            {"instance": {"instanceName": "other", "owner": "491111111111@s.whatsapp.net"}},
        ]
        self.assertEqual(phone_from_instance_info(payload, "WA-Business_Alexandra"), "14087093943")

    def test_flat_v2_number_field(self):
        payload = [{"name": "WA-B1", "number": "491758925279", "ownerJid": "491758925279:1@s.whatsapp.net"}]
        self.assertEqual(phone_from_instance_info(payload, "WA-B1"), "491758925279")


class ResponsibleUserTests(unittest.TestCase):
    def test_custom_field_beats_history(self):
        user, source = pick_responsible_user("user_FROM_CF", "user_EXCLUDED", "user_FROM_HISTORY")
        self.assertEqual(user, "user_FROM_CF")
        self.assertEqual(source, "custom_field")

    def test_empty_custom_field_uses_history(self):
        user, source = pick_responsible_user("", "user_EXCLUDED", "user_FROM_HISTORY")
        self.assertEqual(user, "user_FROM_HISTORY")
        self.assertEqual(source, "history")

    def test_excluded_custom_field_falls_back_to_history(self):
        user, source = pick_responsible_user("user_EXCLUDED", "user_EXCLUDED", "user_FROM_HISTORY")
        self.assertEqual(user, "user_FROM_HISTORY")


class MediaUrlTests(unittest.TestCase):
    def test_public_vs_cdn(self):
        self.assertIsNone(public_media_url("https://mmg.whatsapp.net/x"))
        self.assertEqual(public_media_url("https://files.example.com/a.jpg"), "https://files.example.com/a.jpg")


class MediaUploadHelperTests(unittest.TestCase):
    def test_upload_kinds(self):
        self.assertTrue(needs_media_upload("image"))
        self.assertTrue(needs_media_upload("voice"))
        self.assertTrue(needs_media_upload("gif"))
        self.assertTrue(needs_media_upload("audio"))
        self.assertFalse(needs_media_upload("text"))
        self.assertFalse(needs_media_upload("reaction"))

    def test_filenames(self):
        self.assertEqual(filename_for_media("image", "image/jpeg"), "photo.jpg")
        self.assertEqual(filename_for_media("voice", "audio/ogg; codecs=opus"), "voice.ogg")
        self.assertEqual(filename_for_media("voice", "audio/mp4"), "voice.m4a")
        self.assertEqual(filename_for_media("gif", "video/mp4"), "gif.mp4")
        self.assertEqual(filename_for_media("document", "application/pdf", "Rechnung 1.pdf"), "Rechnung_1.pdf")


class RecordingUrlTests(unittest.TestCase):
    def test_close_file_urls_are_not_public(self):
        self.assertTrue(is_close_app_file_url("https://app.close.com/go/file/xyz/voice.ogg"))
        self.assertTrue(is_close_app_file_url("https://api.close.com/api/v1/files/download/?x=1"))
        self.assertFalse(is_public_recording_url("https://app.close.com/go/file/xyz/voice.m4a"))
        self.assertFalse(
            is_public_recording_url("https://automation.orgasmic.live/webhook/whatsapp-close-recording?t=1")
        )

    def test_signed_s3_url_is_public(self):
        url = (
            "https://close-attachments.s3.amazonaws.com/voice.m4a"
            "?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIA%2F20260819"
            "&X-Amz-Signature=abc123"
        )
        self.assertTrue(is_public_recording_url(url))
        self.assertFalse(is_public_recording_url("https://close-attachments.s3.amazonaws.com/voice.m4a"))
        self.assertTrue(
            is_public_recording_url(
                "https://s3.example.com/evolution/voice.oga?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=abc"
            )
        )
        self.assertEqual(
            force_https("http://s3.example.com/evolution/voice.mp3?X-Amz-Signature=abc"),
            "https://s3.example.com/evolution/voice.mp3?X-Amz-Signature=abc",
        )
        self.assertEqual(
            force_https("http://s3.example.com:9000/evolution/voice.mp3?X-Amz-Signature=abc"),
            "https://s3.example.com/evolution/voice.mp3?X-Amz-Signature=abc",
        )
        self.assertEqual(
            force_https("https://s3.example.com:9000/evolution/voice.mp3"),
            "https://s3.example.com/evolution/voice.mp3",
        )
        self.assertFalse(is_public_recording_url("http://s3.example.com/a.mp3?X-Amz-Signature=abc"))
        self.assertEqual(force_https("https://s3.example.com/a.mp3"), "https://s3.example.com/a.mp3")


class CloseMp3Tests(unittest.TestCase):
    def test_oga_needs_mp3(self):
        self.assertTrue(
            needs_mp3_for_close_recording(
                "https://s3.example.com/evolution/voice.oga?X-Amz-Signature=abc",
                "audio/ogg; codecs=opus",
            )
        )
        self.assertTrue(needs_mp3_for_close_recording("https://s3.example.com/a.ogg", "audio/ogg"))
        self.assertFalse(needs_mp3_for_close_recording("https://s3.example.com/a.mp3", "audio/mpeg"))
        self.assertFalse(needs_mp3_for_close_recording("https://cdn.example.com/rec.mp3"))


class MinioUrlTests(unittest.TestCase):
    def test_parse_path_style_media_url(self):
        url = (
            "https://s3.example.com/evolution/evolution-api/abc-id/"
            "170424369434729%40lid/audioMessage/123_MSG.oga?X-Amz-Signature=abc"
        )
        parsed = parse_s3_media_url(url)
        self.assertEqual(parsed["endpoint"], "https://s3.example.com")
        self.assertEqual(parsed["bucket"], "evolution")
        self.assertEqual(
            parsed["key"],
            "evolution-api/abc-id/170424369434729@lid/audioMessage/123_MSG.oga",
        )
        self.assertEqual(
            mp3_key_from_source(parsed["key"]),
            "evolution-api/abc-id/170424369434729@lid/audioMessage/123_MSG.mp3",
        )

    def test_mp3_key_fallback(self):
        self.assertEqual(mp3_key_from_source("", "wamid.1"), "evolution-api/close-mp3/wamid.1.mp3")


class JsSmokeTests(unittest.TestCase):
    def test_n8n_script_is_evolution_only(self):
        js = Path(__file__).with_name("whatsapp_to_close.js").read_text(encoding="utf-8")
        convert = Path(__file__).with_name("voice_convert.js").read_text(encoding="utf-8")
        presign = Path(__file__).with_name("minio_presign.js").read_text(encoding="utf-8")
        self.assertIn("send.message", js)
        self.assertIn("messages.upsert", js)
        self.assertIn("whatsapp_message", js)
        self.assertIn("external_whatsapp_message_id", js)
        self.assertIn("fromMe", js)
        self.assertNotIn("parseLegacy", js)
        self.assertNotIn("from_me", js)
        self.assertNotIn("Zapier-Format", js)
        self.assertIn("collectEvolutionPayloads", js)
        self.assertNotIn("instance_phone_map", js)
        self.assertNotIn("resolveLocalPhone", js)
        self.assertIn("qs", js)
        self.assertIn('phone:"', js)
        self.assertIn("getBase64FromMediaMessage", js)
        self.assertIn("files/upload", js)
        self.assertIn("attachments", js)
        self.assertIn("evolution_base_url", js)
        self.assertIn("server_url", js)
        self.assertIn("normalizeForEvolution", js)
        self.assertIn("gifPlayback", js)
        self.assertIn("jpegThumbnail", js)
        self.assertIn("activity/call", js)
        self.assertIn("WhatsApp Voice beantworten", js)
        self.assertIn("recording_url", js)
        self.assertIn("last_outbound_activity", js)
        self.assertIn("isPublicRecordingUrl", js)
        self.assertIn("resolvePublicRecordingUrl", js)
        self.assertIn("X-Amz-Signature", js)
        self.assertNotIn("whatsapp-close-recording", js)
        self.assertNotIn("$getWorkflowStaticData", js)
        self.assertIn('source: "External"', js)
        self.assertIn("created_by", js)
        self.assertIn("Sprachdatei abspielen", js)
        self.assertIn("hint_activity_id", js)
        self.assertIn("fetchInstances", js)
        self.assertIn("phoneFromInstanceInfo", js)
        self.assertIn("fetchEvolutionInstancePhone", js)
        self.assertIn("firstPublicMediaUrl", js)
        self.assertIn("mediaUrl", js)
        self.assertIn("Öffentliche S3-mediaUrl", js)
        self.assertIn("tryFfmpegToMp3", js)
        self.assertIn("needsMp3ForCloseRecording", js)
        self.assertIn("audio/mpeg", js)
        self.assertIn("ffmpegToMp3", convert)
        self.assertIn("libmp3lame", convert)
        self.assertIn("44100", convert)
        self.assertIn("64k", convert)
        self.assertNotIn('"16000"', convert)
        self.assertNotIn("|| !aud.ptt", convert)
        self.assertIn("keine audioMessage im Item", convert)
        self.assertIn("-analyzeduration", convert)
        self.assertIn("-f", convert)
        self.assertIn("ogg", convert)
        self.assertNotIn("closeAuthHeader", convert)
        self.assertNotIn("prepareMinioMp3Upload", convert)
        self.assertNotIn("activity/call", convert)
        self.assertIn("ffmpeg fehlt oder Konvertierung fehlgeschlagen", convert)
        self.assertIn("prepareMinioMp3Upload", js)
        self.assertIn("presignMinioPut", js)
        self.assertIn("forceHttps", presign)
        self.assertIn("presignedUrl", js)
        self.assertIn("inputItem.presignedUrl", js)
        self.assertIn("inputItem.url", js)
        self.assertIn("publicHttpsUrl", js)
        self.assertNotIn('jsonFromNamed("Convert Voice to MP3")', js)
        self.assertNotIn('jsonFromNamed("Prepare MinIO Upload")', js)
        self.assertNotIn('jsonFromNamed("Upload MP3 MinIO")', js)
        self.assertIn("parseS3MediaUrl", js)
        self.assertIn("$('Config').first().json", js)
        self.assertIn("close_api_key", js)
        self.assertIn("s3_access_key", js)
        self.assertNotIn("uploadMp3ToMinio", js)

    def test_generated_workflow_has_single_post_webhook(self):
        data = json.loads(Path(__file__).with_name("WhatsApp_Close_Activity.json").read_text(encoding="utf-8"))
        webhooks = [n for n in data["nodes"] if n["type"] == "n8n-nodes-base.webhook"]
        self.assertEqual(len(webhooks), 1)
        self.assertEqual(webhooks[0]["parameters"]["path"], "whatsapp-close")
        self.assertEqual(webhooks[0]["parameters"]["httpMethod"], "POST")
        names = [n["name"] for n in data["nodes"]]
        self.assertIn("Convert Voice to MP3", names)
        self.assertIn("Voice MP3?", names)
        self.assertIn("Prepare MinIO Upload", names)
        self.assertIn("Upload MP3 MinIO", names)
        self.assertIn("Create Close WhatsApp Activity", names)
        by_name = {n["name"]: n for n in data["nodes"]}
        convert_js = by_name["Convert Voice to MP3"]["parameters"]["jsCode"]
        presign_js = by_name["Prepare MinIO Upload"]["parameters"]["jsCode"]
        close_js = by_name["Create Close WhatsApp Activity"]["parameters"]["jsCode"]
        http = by_name["Upload MP3 MinIO"]
        self.assertIn("Convert: MP3 erzeugt", convert_js)
        self.assertIn("prepareBinaryData", convert_js)
        self.assertIn("ffmpegToMp3", convert_js)
        self.assertIn("44100", convert_js)
        self.assertIn("-analyzeduration", convert_js)
        self.assertIn("needs_minio_upload", convert_js)
        self.assertNotIn("activity/call", convert_js)
        self.assertNotIn("close_api_key", convert_js)
        self.assertNotIn("s3_put_url", convert_js)
        self.assertIn("s3_put_url", presign_js)
        self.assertIn("presignedUrl", presign_js)
        self.assertIn("forceHttps", presign_js)
        self.assertIn("getEndpoint", presign_js)
        self.assertIn("X-Amz-Signature", presign_js)
        self.assertIn("activity/call", close_js)
        self.assertIn("inputItem.presignedUrl", close_js)
        self.assertIn("inputItem.url", close_js)
        self.assertIn("publicHttpsUrl", close_js)
        self.assertIn("$('Config').first().json", close_js)
        self.assertNotIn('jsonFromNamed("Convert Voice to MP3")', close_js)
        self.assertEqual(http["parameters"]["method"], "PUT")
        self.assertEqual(http["parameters"]["contentType"], "binaryData")
        self.assertEqual(http["parameters"]["inputDataFieldName"], "data")
        self.assertIn("s3_put_url", http["parameters"]["url"])
        self.assertEqual(
            http["parameters"]["options"]["response"]["response"]["outputPropertyName"],
            "minio_put",
        )
        self.assertEqual(
            data["connections"]["Voice MP3?"]["main"][0][0]["node"],
            "Prepare MinIO Upload",
        )
        self.assertEqual(
            data["connections"]["Prepare MinIO Upload"]["main"][0][0]["node"],
            "Upload MP3 MinIO",
        )
        self.assertEqual(
            data["connections"]["Voice MP3?"]["main"][1][0]["node"],
            "Create Close WhatsApp Activity",
        )
        blob = json.dumps(data)
        self.assertNotIn("whatsapp-close-recording", blob)
        self.assertNotIn("$getWorkflowStaticData", blob)
        self.assertIn("resolvePublicRecordingUrl", blob)
        self.assertIn("firstPublicMediaUrl", blob)
        self.assertIn("tryFfmpegToMp3", blob)
        self.assertIn("prepareMinioMp3Upload", blob)
        self.assertNotIn("uploadMp3ToMinio", blob)


if __name__ == "__main__":
    unittest.main()
