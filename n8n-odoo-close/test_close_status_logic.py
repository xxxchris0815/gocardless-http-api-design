#!/usr/bin/env python3
"""Close status rules — paid / partial / deposit write-once / draft filter."""

import unittest
from pathlib import Path

from close_status_logic import (
    close_custom_key,
    decide_close_payload,
    is_draft_invoice,
    is_fully_paid,
    read_custom_field,
)

RESIDUAL = "cf_residualTEST"
PAID = "stat_paidTEST"
PARTIAL = "stat_partialTEST"
DEPOSIT = "cf_depositTEST"
FULL = "cf_fullpayTEST"
TODAY = "2026-08-18"


def payload(**kwargs):
    defaults = dict(
        payment_state="not_paid",
        amount_residual=100.0,
        current_deposit_date=None,
        field_id_residual=RESIDUAL,
        status_id_paid=PAID,
        status_id_partial=PARTIAL,
        field_id_deposit=DEPOSIT,
        field_id_full_pay=FULL,
        today=TODAY,
    )
    defaults.update(kwargs)
    return decide_close_payload(**defaults)


class CustomKeyTests(unittest.TestCase):
    def test_strips_duplicate_custom_prefix(self):
        self.assertEqual(close_custom_key("custom.cf_abc"), "custom.cf_abc")
        self.assertEqual(close_custom_key("cf_abc"), "custom.cf_abc")

    def test_zapier_residual_input_does_not_become_custom_custom(self):
        zapier_residual = "custom.cf_q6Ho0eoB1QNrxnVRpZMg4AVQGSSYVyoijjHGlEG9Ipf"
        p = payload(field_id_residual=zapier_residual, payment_state="paid", amount_residual=0.0)
        self.assertIn("custom.cf_q6Ho0eoB1QNrxnVRpZMg4AVQGSSYVyoijjHGlEG9Ipf", p)
        self.assertNotIn("custom.custom.cf_q6Ho0eoB1QNrxnVRpZMg4AVQGSSYVyoijjHGlEG9Ipf", p)


class DraftFilterTests(unittest.TestCase):
    def test_skips_draft_invoice_name(self):
        self.assertTrue(is_draft_invoice("Draft Invoice"))
        self.assertTrue(is_draft_invoice("Draft Invoice / Partner"))
        self.assertFalse(is_draft_invoice("INV/2026/00113"))


class PaidTests(unittest.TestCase):
    def test_paid_sets_status_residual_and_both_dates_when_deposit_empty(self):
        p = payload(payment_state="paid", amount_residual=0.0)
        self.assertEqual(p["status_id"], PAID)
        self.assertEqual(p[close_custom_key(RESIDUAL)], 0.0)
        self.assertEqual(p[close_custom_key(FULL)], TODAY)
        self.assertEqual(p[close_custom_key(DEPOSIT)], TODAY)

    def test_paid_does_not_overwrite_existing_deposit_date(self):
        p = payload(
            payment_state="paid",
            amount_residual=0.0,
            current_deposit_date="2026-01-15",
        )
        self.assertEqual(p[close_custom_key(FULL)], TODAY)
        self.assertNotIn(close_custom_key(DEPOSIT), p)

    def test_in_payment_counts_as_paid(self):
        p = payload(payment_state="in_payment", amount_residual=10.0)
        self.assertEqual(p["status_id"], PAID)
        self.assertIn(close_custom_key(FULL), p)

    def test_tiny_residual_counts_as_paid(self):
        self.assertTrue(is_fully_paid("not_paid", 0.0))
        self.assertTrue(is_fully_paid("partial", 0.009))
        p = payload(payment_state="not_paid", amount_residual=0.0)
        self.assertEqual(p["status_id"], PAID)


class PartialTests(unittest.TestCase):
    def test_partial_sets_status_and_deposit_once(self):
        p = payload(payment_state="partial", amount_residual=1200.5)
        self.assertEqual(p["status_id"], PARTIAL)
        self.assertEqual(p[close_custom_key(RESIDUAL)], 1200.5)
        self.assertEqual(p[close_custom_key(DEPOSIT)], TODAY)
        self.assertNotIn(close_custom_key(FULL), p)

    def test_partial_keeps_existing_deposit(self):
        p = payload(
            payment_state="partial",
            amount_residual=50.0,
            current_deposit_date="2026-03-01",
        )
        self.assertNotIn(close_custom_key(DEPOSIT), p)
        self.assertEqual(p["status_id"], PARTIAL)


class UnpaidTests(unittest.TestCase):
    def test_not_paid_only_updates_residual(self):
        p = payload(payment_state="not_paid", amount_residual=4500.0)
        self.assertNotIn("status_id", p)
        self.assertEqual(p[close_custom_key(RESIDUAL)], 4500.0)
        self.assertNotIn(close_custom_key(DEPOSIT), p)
        self.assertNotIn(close_custom_key(FULL), p)


class CloseReadTests(unittest.TestCase):
    def test_nested_and_flat_custom_fields(self):
        nested = {"custom": {DEPOSIT: "2026-02-02"}}
        flat = {f"custom.{DEPOSIT}": "2026-02-02"}
        self.assertEqual(read_custom_field(nested, DEPOSIT), "2026-02-02")
        self.assertEqual(read_custom_field(flat, f"custom.{DEPOSIT}"), "2026-02-02")
        self.assertIsNone(read_custom_field({}, DEPOSIT))


class SampleWebhookTests(unittest.TestCase):
    def test_odoo_paid_invoice_sample(self):
        webhook = {
            "display_name": "INV/2026/00113",
            "payment_state": "paid",
            "amount_residual": 0.0,
            "x_studio_close_opp_id": "oppo_6ZSVu8hRSc29obEyKLTi8SaV0mtFE0WkxEQTxfekF81",
        }
        self.assertFalse(is_draft_invoice(webhook["display_name"]))
        p = payload(
            payment_state=webhook["payment_state"],
            amount_residual=webhook["amount_residual"],
        )
        self.assertEqual(p["status_id"], PAID)
        self.assertEqual(p[close_custom_key(FULL)], TODAY)


class JsSmokeTests(unittest.TestCase):
    def test_n8n_script_has_filter_and_write_once_deposit(self):
        js = Path(__file__).with_name("odoo_to_close.js").read_text(encoding="utf-8")
        self.assertIn("Draft Invoice", js)
        self.assertIn("in_payment", js)
        self.assertIn("closeCustomKey", js)
        self.assertIn("/opportunity/", js)


if __name__ == "__main__":
    unittest.main()
