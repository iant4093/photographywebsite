"""Untrusted bodies are bounded before decoding and keep normal browser JSON working."""

import base64
import json
import unittest
from unittest.mock import patch

import test_support  # noqa: F401
import validation_helpers as validation


class RequestJsonHardeningTests(unittest.TestCase):
    def parse(self, raw, **kwargs):
        return validation.parse_json_body({"body": raw}, **kwargs)

    def test_browser_payloads_keep_unicode_numbers_arrays_and_escaped_text(self):
        body = {
            "title": "夏 — café 📷",
            "images": [{"id": "media", "adjustments": {"exposure": -0.75}}],
            "enabled": True, "empty": None, "count": 4,
            "caption": 'Quotes: " \\" and \\\\ plus ' + "[{" * 200,
        }
        for ensure_ascii in (True, False):
            raw = json.dumps(body, ensure_ascii=ensure_ascii)
            self.assertEqual(self.parse(raw), body)
            self.assertEqual(validation.parse_json_body({
                "body": base64.b64encode(raw.encode()).decode(), "isBase64Encoded": True,
            }), body)

    def test_duplicate_keys_are_rejected_at_every_depth_including_unicode_aliases(self):
        for raw in ('{"x":1,"x":2}', '{"items":[{"x":1,"x":2}]}', '{"a":1,"\\u0061":2}'):
            with self.subTest(raw=raw), self.assertRaises(validation.ValidationError):
                self.parse(raw)
        self.assertEqual(self.parse('{"a":{"x":1},"b":{"x":2}}'), {"a": {"x": 1}, "b": {"x": 2}})

    def test_nonfinite_constants_and_overflowing_floats_are_rejected(self):
        for value in ("NaN", "Infinity", "-Infinity", "1e9999", "-1e9999"):
            with self.subTest(value=value), self.assertRaises(validation.ValidationError):
                self.parse('{"x":[' + value + ']}')
        self.assertEqual(self.parse('{"x":[1e-300,1e300,-2.5,0]}')["x"], [1e-300, 1e300, -2.5, 0])

    def test_nesting_boundary_and_extreme_depth_rejected_before_json_decode(self):
        depth = validation.MAX_JSON_DEPTH
        raw = '{"x":' + '[' * (depth - 1) + '0' + ']' * (depth - 1) + '}'
        self.assertIn("x", self.parse(raw))
        for nested in (depth, 2200):
            raw = '{"x":' + '[' * nested + '0' + ']' * nested + '}'
            with patch.object(validation.json, "loads") as decoder, self.assertRaises(validation.ValidationError):
                self.parse(raw)
            decoder.assert_not_called()

    def test_base64_size_rejection_precedes_allocation(self):
        with patch.object(validation.base64, "b64decode") as decode, self.assertRaises(validation.ValidationError):
            validation.parse_json_body({"body": "A" * 128, "isBase64Encoded": True}, max_bytes=8)
        decode.assert_not_called()

    def test_decoded_size_still_checked_when_base64_padding_hides_extra_byte(self):
        raw = b'{"x":12}'
        self.assertEqual(len(raw), 8)
        with self.assertRaises(validation.ValidationError):
            validation.parse_json_body({
                "body": base64.b64encode(raw).decode(), "isBase64Encoded": True,
            }, max_bytes=7)

    def test_exact_utf8_byte_limit_for_plain_and_base64_bodies(self):
        for value in ("abc", "é📷"):
            raw = json.dumps({"x": value}, ensure_ascii=False)
            size = len(raw.encode())
            for encoded in (False, True):
                event = {"body": base64.b64encode(raw.encode()).decode() if encoded else raw,
                         "isBase64Encoded": encoded}
                self.assertEqual(validation.parse_json_body(event, max_bytes=size), {"x": value})
                with self.assertRaises(validation.ValidationError):
                    validation.parse_json_body(event, max_bytes=size - 1)

    def test_invalid_unicode_base64_and_decoder_recursion_fail_as_validation_errors(self):
        with self.assertRaises(validation.ValidationError):
            self.parse('{"x":"\ud800"}')
        for raw in ("not-base64!", "é", base64.b64encode(b'\xff').decode()):
            with self.subTest(raw=raw), self.assertRaises(validation.ValidationError):
                validation.parse_json_body({"body": raw, "isBase64Encoded": True})
        with patch.object(validation.json, "loads", side_effect=RecursionError), self.assertRaises(validation.ValidationError):
            self.parse('{}')

    def test_large_plain_body_is_rejected_before_parser(self):
        with patch.object(validation.json, "loads") as decoder, self.assertRaises(validation.ValidationError):
            self.parse('{"x":"' + 'a' * 100 + '"}', max_bytes=16)
        decoder.assert_not_called()
