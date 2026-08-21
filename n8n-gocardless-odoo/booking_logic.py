"""Pure booking rules for GoCardless webhooks → Odoo bank statement lines.

These rules are shared conceptually with ``gocardless_to_odoo.js`` (n8n Code node).
Keep both in sync when changing retry / unique_import_id behaviour.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Literal, Optional


PaymentAction = Literal["confirmed", "failed", "charged_back", "cancelled"]
DecisionKind = Literal["book", "skip"]
LineKind = Literal["confirmed", "failed"]


FAILED_LIKE_PREFIXES = ("FAILED", "CHARGEDBACK", "CANCELLED")


@dataclass(frozen=True)
class Decision:
    kind: DecisionKind
    reason: str
    unique_import_id: Optional[str] = None
    amount_sign: int = 0  # +1 book credit, -1 book debit/reversal
    suffix: Optional[str] = None
    retry_index: int = 0  # 0 = first confirmation, 1+ = erneuter Einzug


def line_kind(unique_import_id: str, payment_id: str) -> Optional[LineKind]:
    """Classify an Odoo unique_import_id that belongs to this payment."""
    prefix = f"{payment_id}_"
    if not unique_import_id.startswith(prefix):
        return None
    rest = unique_import_id[len(prefix) :]
    if rest == "CONFIRMED" or rest.startswith("CONFIRMED_"):
        return "confirmed"
    if rest.startswith(FAILED_LIKE_PREFIXES):
        return "failed"
    return None


def count_payment_lines(payment_id: str, existing_uids: Iterable[str]) -> tuple[int, int]:
    confirmed = 0
    failed = 0
    for uid in existing_uids:
        kind = line_kind(uid, payment_id)
        if kind == "confirmed":
            confirmed += 1
        elif kind == "failed":
            failed += 1
    return confirmed, failed


def unique_id_for(payment_id: str, suffix: str, event_id: str) -> str:
    """Event-scoped id so a retry can book a second CONFIRMED line."""
    return f"{payment_id}_{suffix}_{event_id}"


def payout_reversal_unique_id(payment_id: str, payout_id: str, item_type: str) -> str:
    """Reversal booked from a payout item; still counts as a failed-like line."""
    return f"{payment_id}_FAILED_payout_{payout_id}_{item_type}"


def decide_payment_booking(
    *,
    action: str,
    will_attempt_retry: bool,
    event_id: str,
    payment_id: str,
    existing_uids: Iterable[str],
) -> Decision:
    """Decide whether a payments.* webhook should create an Odoo statement line.

    Key invariant for retries (same GoCardless payment id):
    - First ``confirmed`` books ``{payment_id}_CONFIRMED_{event_id}``.
    - Final ``failed`` / ``charged_back`` (no automatic retry) reverses only if
      there is still an unmatched confirmation.
    - After a reversal, a later ``confirmed`` (manual/auto retry) MUST book a
      new line. The old Zapier id ``{payment_id}_CONFIRMED`` cannot be reused.
    """
    existing = list(existing_uids)
    confirmed_n, failed_n = count_payment_lines(payment_id, existing)

    if action == "confirmed":
        uid = unique_id_for(payment_id, "CONFIRMED", event_id)
        if uid in existing:
            return Decision("skip", "event already booked", uid)
        if confirmed_n > failed_n:
            return Decision(
                "skip",
                "unmatched confirmation already exists (duplicate webhook)",
                uid,
            )
        retry_index = failed_n  # number of prior reversals = which retry this is
        return Decision("book", "confirmed", uid, 1, "CONFIRMED", retry_index)

    suffix_by_action = {
        "failed": "FAILED",
        "charged_back": "CHARGEDBACK",
        "cancelled": "CANCELLED",
    }
    if action not in suffix_by_action:
        return Decision("skip", f"irrelevant payment action: {action}")

    if action == "failed" and will_attempt_retry:
        return Decision("skip", "GoCardless will_attempt_retry — wait for next attempt")

    suffix = suffix_by_action[action]
    uid = unique_id_for(payment_id, suffix, event_id)
    if uid in existing:
        return Decision("skip", "event already booked", uid)
    if confirmed_n <= failed_n:
        return Decision(
            "skip",
            "nothing to reverse (never confirmed or already reversed)",
            uid,
        )
    return Decision("book", f"reverse after {action}", uid, -1, suffix, 0)


def should_book_payout_reversal(
    payment_id: str,
    existing_uids: Iterable[str],
    reversal_uid: str,
) -> Decision:
    """Skip payout chargeback/refund items when payment.failed already reversed."""
    existing = list(existing_uids)
    if reversal_uid in existing:
        return Decision("skip", "payout reversal already booked", reversal_uid)
    confirmed_n, failed_n = count_payment_lines(payment_id, existing)
    if confirmed_n <= failed_n:
        return Decision(
            "skip",
            "payment already reversed — skip payout chargeback to avoid double count",
            reversal_uid,
        )
    return Decision("book", "payout reversal", reversal_uid, -1, "FAILED", 0)


PAYOUT_FEE_TYPES = frozenset({"gocardless_fee", "app_fee", "surcharge_fee"})
PAYOUT_REVERSAL_TYPES = frozenset(
    {
        "payment_refunded",
        "refund",
        "chargeback",
        "failure_fee",
        "late_failure_settled",
    }
)
PAYOUT_TRIGGER_PAYMENT_ACTIONS = frozenset(
    {"paid_out", "surcharge_fee_debited", "late_failure_settled"}
)


def is_payout_event(resource_type: str, action: str) -> bool:
    if resource_type == "payouts" and action == "paid":
        return True
    if resource_type == "payments" and action in PAYOUT_TRIGGER_PAYMENT_ACTIONS:
        return True
    return False


def is_payout_failed(resource_type: str, action: str) -> bool:
    return resource_type == "payouts" and action == "failed"
