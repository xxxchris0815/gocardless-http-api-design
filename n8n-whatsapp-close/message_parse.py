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

MEDIA_UPLOAD_KINDS = frozenset({"image", "video", "gif", "audio", "voice", "document", "sticker"})
MAX_MEDIA_BYTES = 20 * 1024 * 1024

MIME_EXT = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
        "image/gif": "gif",
        "audio/ogg": "ogg",
    "audio/opus": "ogg",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "audio/aac": "aac",
    "video/mp4": "mp4",
    "video/3gpp": "3gp",
    "application/pdf": "pdf",
}


def clean_phone(phone: Optional[str]) -> str:
    if not phone:
        return ""
    return re.sub(r"\D", "", str(phone))


def jid_to_phone(jid: Optional[str]) -> str:
    local = str(jid or "").split("@")[0]
    local = local.split(":")[0]
    return clean_phone(local)


def phone_from_instance_info(data: Any, instance_name: str = "") -> str:
    """Extract the connected WhatsApp number from Evolution fetchInstances."""
    want = (instance_name or "").lower()
    if isinstance(data, list):
        rows = data
    elif isinstance(data, dict):
        rows = data["instance"] if isinstance(data.get("instance"), list) else [data]
    else:
        rows = []
    fallback = ""
    for row in rows:
        inst = row.get("instance") if isinstance(row, dict) and isinstance(row.get("instance"), dict) else row
        if not isinstance(inst, dict):
            continue
        name = str(inst.get("instanceName") or inst.get("name") or "").lower()
        owner = inst.get("owner") or inst.get("ownerJid") or inst.get("wuid") or inst.get("wid") or inst.get("number") or ""
        phone = jid_to_phone(owner) or clean_phone(inst.get("number"))
        if not phone:
            continue
        if want and name and name != want:
            continue
        if want and name == want:
            return phone
        if not fallback:
            fallback = phone
    return fallback


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


def is_close_app_file_url(url: Optional[str]) -> bool:
    raw = str(url or "")
    if not raw:
        return False
    host = (urlparse(raw).hostname or "").lower()
    if host in {"app.close.com", "api.close.com"} or host.endswith(".close.com"):
        return True
    return "close.com/go/file" in raw.lower()


def recording_public_url(webhook_url: str, token: str) -> str:
    """Turn the incoming n8n webhook URL into the public Close recording GET URL."""
    if not webhook_url or not token:
        return ""
    parsed = urlparse(webhook_url)
    path = (parsed.path or "").replace("/webhook-test/", "/webhook/")
    parts = path.rstrip("/").split("/")
    if parts:
        parts[-1] = "whatsapp-close-recording"
    new_path = "/".join(parts)
    if not new_path.startswith("/"):
        new_path = "/" + new_path
    return f"{parsed.scheme}://{parsed.netloc}{new_path}?t={token}"


def needs_media_upload(kind: str) -> bool:
    return kind in MEDIA_UPLOAD_KINDS


def strip_mime(mime: Optional[str]) -> str:
    return (mime or "").split(";")[0].strip().lower()


def filename_for_media(kind: str, mime: str = "", given: str = "") -> str:
    given_name = (given or "").strip()
    if given_name:
        return re.sub(r"[^\w.\-]+", "_", given_name)
    clean = strip_mime(mime)
    ext = MIME_EXT.get(clean)
    if not ext and "/" in clean:
        ext = re.sub(r"[^a-z0-9]", "", clean.split("/", 1)[1]) or "bin"
    if not ext:
        ext = "bin"
    prefix = {
        "image": "photo",
        "video": "video",
        "gif": "gif",
        "audio": "audio",
        "voice": "voice",
        "document": "document",
        "sticker": "sticker",
    }.get(kind, "media")
    return f"{prefix}.{ext}"


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
    if kind == "gif":
        body = caption or "🎞️ GIF empfangen"
        return f"{body}{_create_media_link(link, '▶️', 'GIF ansehen')}"
    if kind in ("audio", "voice"):
        dur = f" ({extra})" if extra else ""
        return f"🎤 Sprachnachricht empfangen{dur}{_create_media_link(link, '▶️', 'Abspielen')}"
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

    remote_phone = jid_to_phone(remote_jid)
    sender_phone = jid_to_phone(payload.get("sender") or "")
    local_phone = sender_phone or clean_phone(default_local_phone)
    ts = data.get("messageTimestamp") or data.get("messageTimestamp")
    duration = 0
    if kind in ("voice", "audio"):
        aud = inner.get("audioMessage") or {}
        try:
            duration = int(float(aud.get("seconds") or 0))
        except (TypeError, ValueError):
            duration = 0
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
        "server_url": payload.get("server_url") or "",
        "from_name": data.get("pushName") or "",
        "duration_seconds": duration,
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
        is_gif = bool(vid.get("gifPlayback"))
        kind = "gif" if is_gif else "video"
        caption = str(vid.get("caption") or vid.get("accessibilityLabel") or "")
        return kind, caption, vid.get("url") or vid.get("mediaUrl"), ""
    if "audioMessage" in inner:
        aud = inner["audioMessage"] or {}
        kind = "voice" if aud.get("ptt") else "audio"
        try:
            secs = int(float(aud.get("seconds") or 0))
        except (TypeError, ValueError):
            secs = 0
        extra = f"{secs}s" if secs > 0 else ""
        return kind, "", aud.get("url") or aud.get("mediaUrl"), extra
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


def pick_responsible_user(
    custom_field_user: Optional[str],
    excluded_user_id: str,
    history_user: Optional[str],
) -> tuple[Optional[str], Optional[str]]:
    """Custom Field wins when set (and not excluded); otherwise WA/call history."""
    cf = (custom_field_user or "").strip() or None
    excluded = (excluded_user_id or "").strip()
    if cf and cf != excluded:
        return cf, "custom_field"
    if history_user:
        return history_user, "history"
    return None, None


def parse_webhook(payload: dict, default_local_phone: str = "") -> Optional[dict]:
    bodies = collect_evolution_payloads(payload)
    if not bodies:
        return parse_evolution_message(payload, default_local_phone)
    return parse_evolution_message(bodies[0], default_local_phone)
