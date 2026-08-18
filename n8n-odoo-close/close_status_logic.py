"""Odoo invoice webhook → Close opportunity status (pure rules).

Keep in sync with ``odoo_to_close.js``.
"""

from __future__ import annotations

from typing import Any, Optional


PAID_STATES = frozenset({"paid", "in_payment"})
PARTIAL_STATE = "partial"
RESIDUAL_PAID_THRESHOLD = 0.01
DRAFT_INVOICE_NEEDLE = "draft invoice"


def close_custom_key(field_id: str) -> str:
    """Close PUT keys must be ``custom.cf_…`` exactly once."""
    fid = (field_id or "").strip()
    if fid.startswith("custom."):
        fid = fid[len("custom.") :]
    return f"custom.{fid}"


def strip_custom_prefix(field_id: str) -> str:
    fid = (field_id or "").strip()
    if fid.startswith("custom."):
        return fid[len("custom.") :]
    return fid


def is_draft_invoice(display_name: Optional[str]) -> bool:
    return DRAFT_INVOICE_NEEDLE in (display_name or "").lower()


def is_fully_paid(payment_state: str, amount_residual: float) -> bool:
    state = (payment_state or "").lower().strip()
    return state in PAID_STATES or amount_residual <= RESIDUAL_PAID_THRESHOLD


def read_custom_field(opportunity: dict, field_id: str) -> Any:
    """Close GET may nest custom fields or return flat ``custom.cf_…`` keys."""
    fid = strip_custom_prefix(field_id)
    nested = (opportunity.get("custom") or {}).get(fid)
    if nested not in (None, ""):
        return nested
    flat = opportunity.get(f"custom.{fid}")
    if flat not in (None, ""):
        return flat
    return None


def decide_close_payload(
    *,
    payment_state: str,
    amount_residual: float,
    current_deposit_date: Any,
    field_id_residual: str,
    status_id_paid: str,
    status_id_partial: str,
    field_id_deposit: str,
    field_id_full_pay: str,
    today: str,
) -> dict:
    """Build the Close PUT body. Deposit date is write-once; full-pay date always moves on paid."""
    payload: dict = {}
    if field_id_residual:
        payload[close_custom_key(field_id_residual)] = amount_residual

    state = (payment_state or "").lower().strip()

    if is_fully_paid(state, amount_residual):
        if status_id_paid:
            payload["status_id"] = status_id_paid
        if field_id_full_pay:
            payload[close_custom_key(field_id_full_pay)] = today
        if field_id_deposit and not current_deposit_date:
            payload[close_custom_key(field_id_deposit)] = today
    elif state == PARTIAL_STATE:
        if status_id_partial:
            payload["status_id"] = status_id_partial
        if field_id_deposit and not current_deposit_date:
            payload[close_custom_key(field_id_deposit)] = today

    return payload
