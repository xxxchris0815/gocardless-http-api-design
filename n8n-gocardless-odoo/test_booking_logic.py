#!/usr/bin/env python3
"""Booking-rule tests — especially the retry case that skipped Odoo lines."""

import unittest

from booking_logic import (
    Decision,
    count_payment_lines,
    decide_payment_booking,
    is_payout_event,
    is_payout_failed,
    payout_reversal_unique_id,
    should_book_payout_reversal,
    unique_id_for,
)


PM = "PM0001TESTPAY1"
EV1 = "EV0001CONFIRM1"
EV2 = "EV0002FAILED01"
EV3 = "EV0003RETRY001"
EV4 = "EV0004FAILED02"
PO = "PO0001PAYOUT01"


class CountLinesTests(unittest.TestCase):
    def test_legacy_and_event_scoped_ids(self):
        uids = [
            f"{PM}_CONFIRMED",  # Zapier legacy
            f"{PM}_FAILED_{EV2}",
            f"{PM}_CONFIRMED_{EV3}",
            f"{PM}_FAILED_payout_{PO}_chargeback",
            "PMOTHER_CONFIRMED_EVX",
        ]
        self.assertEqual(count_payment_lines(PM, uids), (2, 2))


class ConfirmedTests(unittest.TestCase):
    def test_first_confirmation_is_booked(self):
        d = decide_payment_booking(
            action="confirmed",
            will_attempt_retry=False,
            event_id=EV1,
            payment_id=PM,
            existing_uids=[],
        )
        self.assertEqual(d.kind, "book")
        self.assertEqual(d.amount_sign, 1)
        self.assertEqual(d.retry_index, 0)
        self.assertEqual(d.unique_import_id, unique_id_for(PM, "CONFIRMED", EV1))

    def test_duplicate_event_is_skipped(self):
        uid = unique_id_for(PM, "CONFIRMED", EV1)
        d = decide_payment_booking(
            action="confirmed",
            will_attempt_retry=False,
            event_id=EV1,
            payment_id=PM,
            existing_uids=[uid],
        )
        self.assertEqual(d.kind, "skip")
        self.assertIn("already booked", d.reason)

    def test_duplicate_webhook_without_event_id_in_payload_still_skips_if_open(self):
        """Same payment, second confirmed event while first is unmatched → skip."""
        d = decide_payment_booking(
            action="confirmed",
            will_attempt_retry=False,
            event_id="EVDUPLICATE",
            payment_id=PM,
            existing_uids=[f"{PM}_CONFIRMED"],
        )
        self.assertEqual(d.kind, "skip")
        self.assertIn("unmatched confirmation", d.reason)


class FailedTests(unittest.TestCase):
    def test_will_attempt_retry_does_nothing(self):
        d = decide_payment_booking(
            action="failed",
            will_attempt_retry=True,
            event_id=EV2,
            payment_id=PM,
            existing_uids=[unique_id_for(PM, "CONFIRMED", EV1)],
        )
        self.assertEqual(d.kind, "skip")
        self.assertIn("will_attempt_retry", d.reason)

    def test_failed_without_confirmation_does_not_book_negative(self):
        d = decide_payment_booking(
            action="failed",
            will_attempt_retry=False,
            event_id=EV2,
            payment_id=PM,
            existing_uids=[],
        )
        self.assertEqual(d.kind, "skip")
        self.assertIn("nothing to reverse", d.reason)

    def test_late_failure_reverses_confirmation(self):
        d = decide_payment_booking(
            action="failed",
            will_attempt_retry=False,
            event_id=EV2,
            payment_id=PM,
            existing_uids=[f"{PM}_CONFIRMED"],
        )
        self.assertEqual(d.kind, "book")
        self.assertEqual(d.amount_sign, -1)
        self.assertEqual(d.suffix, "FAILED")
        self.assertEqual(d.unique_import_id, unique_id_for(PM, "FAILED", EV2))

    def test_charged_back_reverses_like_failed(self):
        d = decide_payment_booking(
            action="charged_back",
            will_attempt_retry=False,
            event_id=EV2,
            payment_id=PM,
            existing_uids=[unique_id_for(PM, "CONFIRMED", EV1)],
        )
        self.assertEqual(d.kind, "book")
        self.assertEqual(d.suffix, "CHARGEDBACK")
        self.assertEqual(d.amount_sign, -1)


class RetryAfterFailureTests(unittest.TestCase):
    """The original Zapier bug: retry succeeds, no new Odoo line.

    Zapier used unique_import_id = ``{payment_id}_CONFIRMED``. After a late
    failure the confirmation id still exists, so the retry was skipped.
    """

    def test_retry_after_late_failure_books_new_confirmed_line(self):
        existing = [
            f"{PM}_CONFIRMED",  # first successful collection (legacy Zapier id)
            unique_id_for(PM, "FAILED", EV2),
        ]
        d = decide_payment_booking(
            action="confirmed",
            will_attempt_retry=False,
            event_id=EV3,
            payment_id=PM,
            existing_uids=existing,
        )
        self.assertEqual(d.kind, "book", d.reason)
        self.assertEqual(d.amount_sign, 1)
        self.assertEqual(d.retry_index, 1)
        self.assertEqual(d.unique_import_id, unique_id_for(PM, "CONFIRMED", EV3))
        self.assertNotEqual(d.unique_import_id, f"{PM}_CONFIRMED")

    def test_retry_after_first_fail_without_reversal_still_books(self):
        """Intelligent retry: failed with will_attempt_retry, then confirmed."""
        d = decide_payment_booking(
            action="confirmed",
            will_attempt_retry=False,
            event_id=EV3,
            payment_id=PM,
            existing_uids=[],
        )
        self.assertEqual(d.kind, "book")
        self.assertEqual(d.retry_index, 0)

    def test_second_failure_after_retry_reverses_again(self):
        existing = [
            f"{PM}_CONFIRMED",
            unique_id_for(PM, "FAILED", EV2),
            unique_id_for(PM, "CONFIRMED", EV3),
        ]
        d = decide_payment_booking(
            action="failed",
            will_attempt_retry=False,
            event_id=EV4,
            payment_id=PM,
            existing_uids=existing,
        )
        self.assertEqual(d.kind, "book")
        self.assertEqual(d.amount_sign, -1)
        self.assertEqual(d.unique_import_id, unique_id_for(PM, "FAILED", EV4))

    def test_full_lifecycle_net_counts(self):
        uids: list[str] = []

        first = decide_payment_booking(
            action="confirmed",
            will_attempt_retry=False,
            event_id=EV1,
            payment_id=PM,
            existing_uids=uids,
        )
        self.assertEqual(first.kind, "book")
        uids.append(first.unique_import_id)  # type: ignore[arg-type]

        fail = decide_payment_booking(
            action="failed",
            will_attempt_retry=False,
            event_id=EV2,
            payment_id=PM,
            existing_uids=uids,
        )
        self.assertEqual(fail.kind, "book")
        uids.append(fail.unique_import_id)  # type: ignore[arg-type]

        retry = decide_payment_booking(
            action="confirmed",
            will_attempt_retry=False,
            event_id=EV3,
            payment_id=PM,
            existing_uids=uids,
        )
        self.assertEqual(retry.kind, "book")
        self.assertEqual(retry.retry_index, 1)
        uids.append(retry.unique_import_id)  # type: ignore[arg-type]

        self.assertEqual(count_payment_lines(PM, uids), (2, 1))


class PayoutReversalDedupTests(unittest.TestCase):
    def test_skip_chargeback_when_payment_failed_already_booked(self):
        existing = [
            unique_id_for(PM, "CONFIRMED", EV1),
            unique_id_for(PM, "FAILED", EV2),
        ]
        uid = payout_reversal_unique_id(PM, PO, "chargeback")
        d = should_book_payout_reversal(PM, existing, uid)
        self.assertEqual(d.kind, "skip")
        self.assertIn("already reversed", d.reason)

    def test_book_chargeback_when_failed_webhook_was_missed(self):
        existing = [unique_id_for(PM, "CONFIRMED", EV1)]
        uid = payout_reversal_unique_id(PM, PO, "chargeback")
        d = should_book_payout_reversal(PM, existing, uid)
        self.assertEqual(d.kind, "book")

    def test_payout_event_detection(self):
        self.assertTrue(is_payout_event("payouts", "paid"))
        self.assertTrue(is_payout_event("payments", "paid_out"))
        self.assertTrue(is_payout_event("payments", "late_failure_settled"))
        self.assertTrue(is_payout_event("payments", "surcharge_fee_debited"))
        self.assertFalse(is_payout_event("payouts", "failed"))
        self.assertTrue(is_payout_failed("payouts", "failed"))
        self.assertFalse(is_payout_event("payments", "confirmed"))


class JsScriptSmokeTests(unittest.TestCase):
    def test_n8n_script_uses_event_scoped_confirmed_id(self):
        from pathlib import Path

        js = Path(__file__).with_name("gocardless_to_odoo.js").read_text(encoding="utf-8")
        self.assertIn("uniqueIdFor(paymentId, \"CONFIRMED\", eventId)", js)
        self.assertIn("ERNEUTER EINZUG", js)
        self.assertIn("will_attempt_retry", js)
        self.assertNotIn("${payment_id}_CONFIRMED`", js)


class DecisionShapeTests(unittest.TestCase):
    def test_skip_irrelevant_action(self):
        d = decide_payment_booking(
            action="submitted",
            will_attempt_retry=False,
            event_id=EV1,
            payment_id=PM,
            existing_uids=[],
        )
        self.assertIsInstance(d, Decision)
        self.assertEqual(d.kind, "skip")


if __name__ == "__main__":
    unittest.main()
