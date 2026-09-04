"""Narrow first-deploy parameter addition without relaxing preservation gates."""

from __future__ import annotations

import contextlib
import copy
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from ops.ci import release_guard  # noqa: E402


SHA = "a" * 40
ADDITION = {"OriginalComparisonsEnabled": "true"}
DOCUMENT = {"version": 1, "additions": ADDITION}


def stack(flag=None):
    parameters = [
        {"ParameterKey": "Stage", "ParameterValue": "prod"},
        {"ParameterKey": "ProtectedParameter", "ParameterValue": "masked-private-value"},
        {"ParameterKey": "ReleaseSha", "ParameterValue": "b" * 40},
    ]
    if flag is not None:
        parameters.append({"ParameterKey": "OriginalComparisonsEnabled", "ParameterValue": flag})
    return {"Parameters": parameters}


def request(flag="true", *, existing=False):
    values = [
        {"ParameterKey": "Stage", "UsePreviousValue": True},
        {"ParameterKey": "ProtectedParameter", "UsePreviousValue": True},
        {"ParameterKey": "ReleaseSha", "ParameterValue": SHA},
    ]
    if flag is not None:
        values.append({"ParameterKey": "OriginalComparisonsEnabled", **({"UsePreviousValue": True} if existing else {"ParameterValue": flag})})
    return values


def resolved(flag="true"):
    values = copy.deepcopy(stack()["Parameters"])
    values[2]["ParameterValue"] = SHA
    if flag is not None:
        values.append({"ParameterKey": "OriginalComparisonsEnabled", "ParameterValue": flag})
    return values


class ParameterAdditionPolicyTests(unittest.TestCase):
    def test_only_exact_reviewed_document_loads(self):
        self.assertEqual(release_guard.load_parameter_additions(copy.deepcopy(DOCUMENT)), ADDITION)
        invalid = (
            None, [], {}, {"version": 1}, {"additions": ADDITION},
            {"version": True, "additions": ADDITION}, {"version": 1.0, "additions": ADDITION},
            {"version": "1", "additions": ADDITION}, {"version": 2, "additions": ADDITION},
            {"version": 1, "additions": {}, "extra": "not-approved"},
            {"version": 1, "additions": {}},
            {"version": 1, "additions": {"OriginalComparisonsEnabled": "false"}},
            {"version": 1, "additions": {"OriginalComparisonsEnabled": True}},
            {"version": 1, "additions": {"OriginalComparisonsEnabled": "true", "Stage": "dev"}},
            {"version": 1, "additions": {"ArbitrarySetting": "true"}},
        )
        for document in invalid:
            with self.subTest(document=document), self.assertRaises(release_guard.GateError):
                release_guard.load_parameter_additions(document)

    def test_functions_defensively_reject_unapproved_direct_maps(self):
        for additions in (
            {"Other": "true"}, {"OriginalComparisonsEnabled": "false"},
            {"OriginalComparisonsEnabled": True}, {**ADDITION, "Stage": "dev"},
            {"OriginalComparisonsEnabled": "true "}, [ADDITION], "not-a-map",
        ):
            with self.subTest(additions=additions):
                with self.assertRaises(release_guard.GateError):
                    release_guard.previous_parameter_payload(stack(), release_sha=SHA, parameter_additions=additions)
                with self.assertRaises(release_guard.GateError):
                    release_guard.require_preserved_parameters(stack(), request(), release_sha=SHA, parameter_additions=additions)


class ParameterAdditionPreservationTests(unittest.TestCase):
    def test_first_deploy_explicitly_adds_flag_and_preserves_every_existing_value(self):
        existing = stack()
        before = copy.deepcopy(existing)
        generated = release_guard.previous_parameter_payload(existing, release_sha=SHA, parameter_additions=ADDITION)
        self.assertEqual(generated, request())
        self.assertEqual(existing, before)
        self.assertNotIn("masked-private-value", json.dumps(generated))
        release_guard.require_preserved_parameters(existing, generated, release_sha=SHA, parameter_additions=ADDITION)
        release_guard.require_preserved_parameters(existing, resolved(), release_sha=SHA, resolved_values=True, parameter_additions=ADDITION)

    def test_existing_flag_always_uses_previous_value_even_when_disabled(self):
        for value in ("false", "true"):
            with self.subTest(value=value):
                generated = release_guard.previous_parameter_payload(stack(value), release_sha=SHA, parameter_additions=ADDITION)
                self.assertEqual(generated, request(existing=True))
                release_guard.require_preserved_parameters(stack(value), generated, release_sha=SHA, parameter_additions=ADDITION)
                release_guard.require_preserved_parameters(stack(value), resolved(value), release_sha=SHA, resolved_values=True, parameter_additions=ADDITION)
                with self.assertRaises(release_guard.GateError):
                    release_guard.require_preserved_parameters(stack(value), request(value), release_sha=SHA, parameter_additions=ADDITION)
        with self.assertRaises(release_guard.GateError):
            release_guard.require_preserved_parameters(stack("false"), resolved("true"), release_sha=SHA, resolved_values=True, parameter_additions=ADDITION)

    def test_missing_policy_keeps_original_no_new_keys_contract(self):
        for additions in (None, {}):
            with self.subTest(additions=additions):
                generated = release_guard.previous_parameter_payload(stack(), release_sha=SHA, parameter_additions=additions)
                self.assertEqual(generated, request(None))
                release_guard.require_preserved_parameters(stack(), generated, release_sha=SHA, parameter_additions=additions)
                release_guard.require_preserved_parameters(stack(), resolved(None), release_sha=SHA, resolved_values=True, parameter_additions=additions)
                with self.assertRaises(release_guard.GateError):
                    release_guard.require_preserved_parameters(stack(), request(), release_sha=SHA, parameter_additions=additions)

    def test_new_flag_requires_exact_value_and_cannot_claim_a_previous_value(self):
        invalid_entries = (
            {"ParameterKey": "OriginalComparisonsEnabled", "UsePreviousValue": True},
            {"ParameterKey": "OriginalComparisonsEnabled", "ParameterValue": "true", "UsePreviousValue": True},
            {"ParameterKey": "OriginalComparisonsEnabled", "ParameterValue": "true", "UsePreviousValue": "false"},
            {"ParameterKey": "OriginalComparisonsEnabled", "ParameterValue": "true", "UsePreviousValue": 0},
            {"ParameterKey": "OriginalComparisonsEnabled", "ParameterValue": "false"},
            {"ParameterKey": "OriginalComparisonsEnabled", "ParameterValue": True},
            {"ParameterKey": "OriginalComparisonsEnabled"},
        )
        for entry in invalid_entries:
            for resolved_mode in (False, True):
                planned = (resolved(None) if resolved_mode else request(None)) + [entry]
                with self.subTest(entry=entry, resolved_mode=resolved_mode), self.assertRaises(release_guard.GateError):
                    release_guard.require_preserved_parameters(stack(), planned, release_sha=SHA, resolved_values=resolved_mode, parameter_additions=ADDITION)
        for resolved_mode in (False, True):
            explicit_false = resolved() if resolved_mode else request()
            explicit_false[-1]["UsePreviousValue"] = False
            release_guard.require_preserved_parameters(stack(), explicit_false, release_sha=SHA, resolved_values=resolved_mode, parameter_additions=ADDITION)
            with self.subTest(missing=True, resolved_mode=resolved_mode), self.assertRaises(release_guard.GateError):
                release_guard.require_preserved_parameters(stack(), resolved(None) if resolved_mode else request(None), release_sha=SHA, resolved_values=resolved_mode, parameter_additions=ADDITION)

    def test_addition_does_not_permit_missing_extra_or_modified_existing_parameters(self):
        for resolved_mode in (False, True):
            valid = resolved() if resolved_mode else request()
            changed = copy.deepcopy(valid)
            changed[0] = {"ParameterKey": "Stage", "ParameterValue": "dev"}
            wrong_sha = copy.deepcopy(valid)
            wrong_sha[2] = {"ParameterKey": "ReleaseSha", "ParameterValue": "c" * 40}
            invalid = (
                valid[1:],
                valid + [{"ParameterKey": "UnreviewedNewFlag", "ParameterValue": "true"}],
                valid + [valid[-1]],
                changed,
                wrong_sha,
            )
            for planned in invalid:
                with self.subTest(planned=planned, resolved_mode=resolved_mode), self.assertRaises(release_guard.GateError):
                    release_guard.require_preserved_parameters(stack(), planned, release_sha=SHA, resolved_values=resolved_mode, parameter_additions=ADDITION)


class ParameterAdditionCliTests(unittest.TestCase):
    def test_policy_file_roundtrip_for_request_and_resolved_modes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            stack_path, policy_path = root / "stack.json", root / "policy.json"
            request_path, resolved_path = root / "request.json", root / "resolved.json"
            stack_path.write_text(json.dumps(stack()), encoding="utf-8")
            policy_path.write_text(json.dumps(DOCUMENT), encoding="utf-8")
            resolved_path.write_text(json.dumps(resolved()), encoding="utf-8")
            arguments = ["--release-sha", SHA, "--parameter-additions", str(policy_path)]
            self.assertEqual(release_guard.main(["previous-parameters", str(stack_path), str(request_path), *arguments]), 0)
            self.assertEqual(json.loads(request_path.read_text(encoding="utf-8")), request())
            self.assertEqual(release_guard.main(["preserved-parameters", str(stack_path), str(request_path), *arguments]), 0)
            self.assertEqual(release_guard.main(["preserved-parameters", str(stack_path), str(resolved_path), *arguments, "--resolved-values"]), 0)
            request_path.write_text(json.dumps(request("false")), encoding="utf-8")
            with contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(release_guard.main(["preserved-parameters", str(stack_path), str(request_path), *arguments]), 2)

    def test_invalid_policy_file_cannot_generate_a_request(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            stack_path, policy_path, output = root / "stack.json", root / "policy.json", root / "request.json"
            stack_path.write_text(json.dumps(stack()), encoding="utf-8")
            policy_path.write_text(json.dumps({"version": 1, "additions": {"Stage": "dev"}}), encoding="utf-8")
            with contextlib.redirect_stderr(io.StringIO()):
                result = release_guard.main(["previous-parameters", str(stack_path), str(output), "--release-sha", SHA, "--parameter-additions", str(policy_path)])
            self.assertEqual(result, 2)
            self.assertFalse(output.exists())


if __name__ == "__main__":
    unittest.main()
