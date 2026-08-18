"""Parse Evolution API WhatsApp webhooks for Close."""

from __future__ import annotations

import re
import json
from datetime import datetime, timezone
from typing import Any, Optional
from urllib.parse import urlparse


RELEVANT_EVENTS = frozenset({"send.message", "messages.upsert"})
SKIP_JID_MARKERS = ("@g.us", "@broadcast", "@newsletter")
WHATSAPP_CDN = ("mmg.whatsapp.net", "media.whatsapp.com", "pps.whatsapp.net")

WRAPPER_KEYS = (
    "ephemeralMessage",
    "viewOnceMessage",
    "viewOnceMessageV2",
    "viewOnceMessageV2Extension",
    "documentWithCaptionMessage",
)

TYPE_MAP = {
    "conversation": "text",
    "extendedTextMessage": "text",
    "imageMessage": "image",
    "videoMessage": "video",
    "audioMessage": "audio",
    "documentMessage": "document",
    "stickerMessage": "sticker",
    "reactionMessage": "reaction",
    "contactMessage": "contact",
    "locationMessage": "location",
}


def clean_phone(phone: Optional[str]) -> str:
    if not phone:
        return ""
    return re.sub(r"\D", "", str(phone))


def phone_search_variants(remote_phone: str) -> list[str]:
    digits = clean_phone(remote_phone)
    if not digits:
        return []
    variants = [digits, f"+{digits}"]
    if len(digits) > 2:
        rest = digits[2:]
        variants.extend([rest, f"0{rest}"])
    seen: set[str] = set()
    out: list[str] = []
    for item in variants:
        if item and item not in seen:
            seen.add(item)
            out.append(item)
    return out


def is_group_or_broadcast(jid: str) -> bool:
    jid_l = (jid or "").lower()
    return any(marker in jid_l for marker in SKIP_JID_MARKERS)


def is_relevant_event(event: Optional[str]) -> bool:
    return (event or "") in RELEVANT_EVENTS


def public_media_url(url: Optional[str]) -> Optional[str]:
    if not url or not str(url).startswith("http"):
        return None
    host = (urlparse(url).hostname or "").lower()
    if any(cdn in host for cdn in WHATSAPP_CDN):
        return None
    return str(url)


def unwrap_message(message: Any) -> dict:
    if not isinstance(message, dict):
        return {}
    for wrapper in WRAPPER_KEYS:
        if wrapper in message and isinstance(message[wrapper], dict):
            inner = message[wrapper].get("message") or message[wrapper]
            return unwrap_message(inner)
    return message


def iso_from_timestamp(ts: Any, fallback_iso: Optional[str] = None) -> str:
    if ts in (None, ""):
        return fallback_iso or datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    try:
        n = float(ts)
        if n > 1e12:
            n = n / 1000.0
        return datetime.fromtimestamp(n, tz=timezone.utc).isoformat().replace("+00:00", "Z")
    except (TypeError, ValueError, OSError):
        return fallback_iso or datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _create_media_link(url: Optional[str], icon: str, label: str) -> str:
    public = public_media_url(url)
    if not public:
        return ""
    return f"\n\n[{icon} {label}]({public})"


def message_text_from_parts(kind: str, caption: str, link: Optional[str], extra: str = "") -> str:
    if kind == "text":
        return caption or extra
    if kind == "image":
        body = caption or "📷 Foto empfangen"
        return f"{body}{_create_media_link(link, '🖼️', 'Bild ansehen')}"
    if kind == "video":
        body = caption or "🎥 Video empfangen"
        return f"{body}{_create_media_link(link, '▶️', 'Video ansehen')}"
    if kind in ("audio", "voice"):
        return f"🎤 Sprachnachricht empfangen{_create_media_link(link, '▶️', 'Abspielen')}"
    if kind == "document":
        body = caption or "📄 Dokument empfangen"
        filename = extra or "Dokument"
        return f"{body}{_create_media_link(link, '⬇️', filename)}"
    if kind == "reaction":
        emoji = caption.strip()
        return f"{emoji} (Reaktion)" if emoji else ""
    if kind == "sticker":
        return f"🎨 Sticker empfangen{_create_media_link(link, '🖼️', 'Sticker ansehen')}"
    if kind == "location":
        return caption or "📍 Standort empfangen"
    if kind == "contact":
        return caption or "👤 Kontakt empfangen"
    text = caption or extra
    return text if text else f"[Nachrichtentyp: {kind}]"


def parse_evolution_message(payload: dict, default_local_phone: str) -> Optional[dict]:
    """Normalize an Evolution API webhook body into a Close-ready message dict."""
    event = payload.get("event")
    if not is_relevant_event(event):
        return None

    data = payload.get("data") or payload
    if isinstance(data, list):
        data = data[0] if data else {}
    if not isinstance(data, dict):
        return None

    key = data.get("key") or {}
    remote_jid = key.get("remoteJid") or data.get("remoteJid") or ""
    if is_group_or_broadcast(remote_jid):
        return None

    from_me = bool(key.get("fromMe", data.get("fromMe", False)))
    msg_id = key.get("id") or data.get("id")
    if not msg_id:
        return None

    inner = unwrap_message(data.get("message") or {})
    message_type = data.get("messageType") or ""
    kind, caption, link, extra = _evolution_content(inner, message_type)
    text = message_text_from_parts(kind, caption, link, extra)
    if not (text or "").strip():
        if kind == "reaction":
            return {"skip": True, "reason": "Reaction removed", "id": msg_id}
        text = f"[Mediennachricht: {kind or message_type or 'unknown'}]"

    remote_phone = clean_phone(remote_jid.split("@")[0] if "@" in remote_jid else remote_jid)
    local_phone = clean_phone(default_local_phone)
    ts = data.get("messageTimestamp") or data.get("messageTimestamp")
    return {
        "id": msg_id,
        "is_incoming": not from_me,
        "remote_phone": remote_phone,
        "local_phone": local_phone,
        "type": kind,
        "text": text,
        "media_url": public_media_url(link),
        "timestamp": ts,
        "instance": payload.get("instance"),
        "event": event,
    }


def _evolution_content(inner: dict, message_type: str) -> tuple[str, str, Optional[str], str]:
    if "conversation" in inner and inner.get("conversation"):
        return "text", str(inner.get("conversation") or ""), None, ""
    if "extendedTextMessage" in inner:
        ext = inner["extendedTextMessage"] or {}
        return "text", str(ext.get("text") or ""), None, ""
    if "imageMessage" in inner:
        img = inner["imageMessage"] or {}
        return "image", str(img.get("caption") or ""), img.get("url") or img.get("mediaUrl"), ""
    if "videoMessage" in inner:
        vid = inner["videoMessage"] or {}
        return "video", str(vid.get("caption") or ""), vid.get("url") or vid.get("mediaUrl"), ""
    if "audioMessage" in inner:
        aud = inner["audioMessage"] or {}
        kind = "voice" if aud.get("ptt") else "audio"
        return kind, "", aud.get("url") or aud.get("mediaUrl"), ""
    if "documentMessage" in inner:
        doc = inner["documentMessage"] or {}
        return (
            "document",
            str(doc.get("caption") or ""),
            doc.get("url") or doc.get("mediaUrl"),
            str(doc.get("fileName") or doc.get("filename") or "Dokument"),
        )
    if "stickerMessage" in inner:
        st = inner["stickerMessage"] or {}
        return "sticker", "", st.get("url") or st.get("mediaUrl"), ""
    if "reactionMessage" in inner:
        rx = inner["reactionMessage"] or {}
        return "reaction", str(rx.get("text") or ""), None, ""
    if "locationMessage" in inner:
        loc = inner["locationMessage"] or {}
        name = loc.get("name") or loc.get("address") or ""
        return "location", str(name), None, ""
    if "contactMessage" in inner:
        c = inner["contactMessage"] or {}
        return "contact", str(c.get("displayName") or ""), None, ""

    mapped = TYPE_MAP.get(message_type, message_type or "unknown")
    if message_type == "conversation":
        return "text", "", None, ""
    return mapped, "", None, ""


def looks_like_evolution(obj: Any) -> bool:
    return (
        isinstance(obj, dict)
        and isinstance(obj.get("event"), str)
        and isinstance(obj.get("data"), (dict, list))
    )


def collect_evolution_payloads(raw: Any, depth: int = 0) -> list[dict]:
    """Find Evolution bodies inside n8n webhook items, arrays, or nested json/body."""
    if depth > 8 or raw is None:
        return []
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except json.JSONDecodeError:
            return []
        return collect_evolution_payloads(raw, depth + 1)
    if isinstance(raw, list):
        found: list[dict] = []
        for item in raw:
            found.extend(collect_evolution_payloads(item, depth + 1))
        return found
    if not isinstance(raw, dict):
        return []
    if looks_like_evolution(raw):
        return [raw]
    found = []
    if "json" in raw:
        found.extend(collect_evolution_payloads(raw["json"], depth + 1))
    if "body" in raw:
        found.extend(collect_evolution_payloads(raw["body"], depth + 1))
    return found


def parse_webhook(payload: dict, default_local_phone: str = "") -> Optional[dict]:
    bodies = collect_evolution_payloads(payload)
    if not bodies:
        return parse_evolution_message(payload, default_local_phone)
    return parse_evolution_message(bodies[0], default_local_phone)
