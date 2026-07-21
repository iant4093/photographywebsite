from __future__ import annotations

import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import tarfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from ops.ci import (  # noqa: E402
    coverage_gate,
    credential_artifact_scan,
    release_guard,
    workflow_policy,
)


def private_key_marker(label: str = "", *, ending: bool = False) -> str:
    kind = f"{label} " if label else ""
    return "-----" + ("END" if ending else "BEGIN") + f" {kind}PRIVATE KEY-----"


def access_key_id(prefix: str, suffix: str) -> str:
    return prefix + suffix


def iam_credentials_discovery_document() -> dict[str, str]:
    return {
        "discoveryVersion": "v1",
        "id": "iamcredentials:v1",
        "name": "iamcredentials",
        "rootUrl": "https://iamcredentials.googleapis.com/",
        "version": "v1",
    }


def change(
    action="Modify",
    logical_id="OrdinaryFunction",
    replacement="False",
    recreation="Never",
    resource_type="AWS::Lambda::Function",
):
    return {
        "ResourceChange": {
            "Action": action,
            "LogicalResourceId": logical_id,
            "ResourceType": resource_type,
            "Replacement": replacement,
            "Details": [{"Target": {"RequiresRecreation": recreation}}],
        }
    }


class ChangeSetGateTests(unittest.TestCase):
    def test_accepts_all_pages_and_returns_safe_aggregate_counts(self):
        pages = [
            {"Changes": [change()]},
            {"Changes": [change(action="Add", logical_id="NewFunction", replacement=None)]},
        ]
        self.assertEqual(
            release_guard.gate_change_set(pages),
            {"Add": 1, "Modify": 1, "Total": 2},
        )

    def test_accepts_empty_change_set(self):
        self.assertEqual(
            release_guard.gate_change_set([{"Changes": []}]),
            {"Add": 0, "Modify": 0, "Total": 0},
        )

    def test_rejects_removal_unknown_action_and_protected_resources(self):
        cases = [
            change(action="Remove"),
            change(action="Import"),
            change(logical_id="AlbumsTable"),
            change(logical_id="GeneratedRole", resource_type="AWS::IAM::Role"),
        ]
        for item in cases:
            with self.subTest(item=item), self.assertRaises(release_guard.GateError):
                release_guard.gate_change_set([{"Changes": [item]}])

    def test_rejects_true_conditional_and_unknown_replacement(self):
        for replacement in ("True", "Conditional", "Maybe"):
            with self.subTest(replacement=replacement), self.assertRaises(release_guard.GateError):
                release_guard.gate_change_set([{"Changes": [change(replacement=replacement)]}])

    def test_rejects_recreation_and_unknown_recreation(self):
        for recreation in ("Always", "Conditionally", "Unknown"):
            with self.subTest(recreation=recreation), self.assertRaises(release_guard.GateError):
                release_guard.gate_change_set([{"Changes": [change(recreation=recreation)]}])

    def test_rejects_malformed_pages_entries_details_and_targets(self):
        malformed = [
            {},
            {"Changes": None},
            {"Changes": [None]},
            {"Changes": [{}]},
            {"Changes": [{"ResourceChange": {}}]},
            {"Changes": [change() | {"ResourceChange": change()["ResourceChange"] | {"Details": None}}]},
            {"Changes": [change() | {"ResourceChange": change()["ResourceChange"] | {"Details": [None]}}]},
            {"Changes": [change() | {"ResourceChange": change()["ResourceChange"] | {"Details": [{"Target": None}]}}]},
        ]
        for page in malformed:
            with self.subTest(page=page), self.assertRaises(release_guard.GateError):
                release_guard.gate_change_set([page])


class StackGuardTests(unittest.TestCase):
    def test_previous_parameters_contains_keys_only(self):
        stack = {
            "Parameters": [
                {"ParameterKey": "SecretArn", "ParameterValue": "never-copy-this"},
                {"ParameterKey": "Stage", "ParameterValue": "prod"},
            ]
        }
        self.assertEqual(
            release_guard.previous_parameter_payload(stack),
            [
                {"ParameterKey": "SecretArn", "UsePreviousValue": True},
                {"ParameterKey": "Stage", "UsePreviousValue": True},
            ],
        )

    def test_release_sha_is_exact_and_new_parameter_is_added(self):
        sha = "a" * 40
        existing = release_guard.previous_parameter_payload(
            {"Parameters": [{"ParameterKey": "Stage"}, {"ParameterKey": "ReleaseSha"}]},
            release_sha=sha,
        )
        self.assertEqual(existing[-1], {"ParameterKey": "ReleaseSha", "ParameterValue": sha})
        new = release_guard.previous_parameter_payload(
            {"Parameters": [{"ParameterKey": "Stage"}]}, release_sha=sha
        )
        self.assertEqual(new[-1], {"ParameterKey": "ReleaseSha", "ParameterValue": sha})
        for invalid in ("", "abc1234", "A" * 40, "g" * 40):
            with self.subTest(invalid=invalid), self.assertRaises(release_guard.GateError):
                release_guard.previous_parameter_payload(
                    {"Parameters": []}, release_sha=invalid
                )

    def test_previous_parameters_rejects_missing_invalid_and_duplicate_keys(self):
        for stack in (
            {},
            {"Parameters": None},
            {"Parameters": [None]},
            {"Parameters": [{"ParameterKey": ""}]},
            {"Parameters": [{"ParameterKey": "A"}, {"ParameterKey": "A"}]},
        ):
            with self.subTest(stack=stack), self.assertRaises(release_guard.GateError):
                release_guard.previous_parameter_payload(stack)

    def test_stack_invariants_accept_stable_expected_outputs(self):
        release_guard.require_stack_invariants(
            {
                "StackStatus": "UPDATE_COMPLETE",
                "EnableTerminationProtection": True,
                "Outputs": [
                    {"OutputKey": "AlbumIndexDeploymentPhase", "OutputValue": "both"},
                    {"OutputKey": "PrivateMediaCloudFrontDenyEnforced", "OutputValue": "true"},
                ],
            }
        )

    def test_stack_invariants_fail_closed(self):
        base = {
            "StackStatus": "UPDATE_COMPLETE",
            "EnableTerminationProtection": True,
            "Outputs": [
                {"OutputKey": "AlbumIndexDeploymentPhase", "OutputValue": "both"},
                {"OutputKey": "PrivateMediaCloudFrontDenyEnforced", "OutputValue": "true"},
            ],
        }
        cases = [
            base | {"StackStatus": "UPDATE_IN_PROGRESS"},
            base | {"EnableTerminationProtection": False},
            base | {"Outputs": []},
            base | {"Outputs": [base["Outputs"][1]]},
            base | {"Outputs": [base["Outputs"][0], {"OutputKey": "PrivateMediaCloudFrontDenyEnforced", "OutputValue": "false"}]},
        ]
        for stack in cases:
            with self.subTest(stack=stack), self.assertRaises(release_guard.GateError):
                release_guard.require_stack_invariants(stack)


class ArtifactTests(unittest.TestCase):
    def test_sha_manifest_and_upload_plan(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "assets").mkdir()
            (root / "assets" / "app-abc.js").write_text("asset", encoding="utf-8")
            (root / "robots.txt").write_text("robots", encoding="utf-8")
            (root / "index.html").write_text("index", encoding="utf-8")
            files = []
            for relative in ("assets/app-abc.js", "robots.txt", "index.html"):
                digest = hashlib.sha256((root / relative).read_bytes()).hexdigest()
                files.append({"path": relative, "sha256": digest})
            self.assertEqual(release_guard.validate_manifest(root, {"files": files}), 3)
            generated = release_guard.build_manifest(root)
            self.assertEqual(release_guard.validate_manifest(root, generated), 3)
            plan = release_guard.frontend_upload_plan(root)
            self.assertEqual(plan[-1]["path"], "index.html")
            self.assertIn("immutable", plan[0]["cache_control"])
            self.assertIn("max-age=300", plan[1]["cache_control"])
            self.assertIn("no-cache", plan[-1]["cache_control"])
            self.assertNotIn("delete", json.dumps(plan).lower())

    def test_manifest_rejects_missing_mismatch_traversal_absolute_duplicate_and_bad_shape(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "index.html").write_text("index", encoding="utf-8")
            digest = release_guard.sha256_file(root / "index.html")
            manifests = [
                {},
                {"files": []},
                {"files": [None]},
                {"files": [{"path": "missing", "sha256": digest}]},
                {"files": [{"path": "index.html", "sha256": "0" * 64}]},
                {"files": [{"path": "../index.html", "sha256": digest}]},
                {"files": [{"path": "/index.html", "sha256": digest}]},
                {"files": [{"path": "index.html", "sha256": digest}] * 2},
            ]
            for manifest in manifests:
                with self.subTest(manifest=manifest), self.assertRaises(release_guard.GateError):
                    release_guard.validate_manifest(root, manifest)
            (root / "extra.txt").write_text("extra", encoding="utf-8")
            with self.assertRaises(release_guard.GateError):
                release_guard.validate_manifest(
                    root, {"files": [{"path": "index.html", "sha256": digest}]}
                )

    def test_frontend_plan_requires_directory_and_index(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaises(release_guard.GateError):
                release_guard.frontend_upload_plan(root)
            with self.assertRaises(release_guard.GateError):
                release_guard.frontend_upload_plan(root / "missing")
            with self.assertRaises(release_guard.GateError):
                release_guard.build_manifest(root)
            with self.assertRaises(release_guard.GateError):
                release_guard.build_manifest(root / "missing")

    def test_tar_validation_accepts_files_and_rejects_traversal_links_and_limits(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            payload = root / "payload.txt"
            payload.write_text("safe", encoding="utf-8")
            archive = root / "safe.tar.gz"
            with tarfile.open(archive, "w:gz") as handle:
                handle.add(payload, arcname="build/payload.txt")
            self.assertEqual(release_guard.validate_tar(archive), 1)
            with self.assertRaises(release_guard.GateError):
                release_guard.validate_tar(archive, max_members=0)
            with self.assertRaises(release_guard.GateError):
                release_guard.validate_tar(archive, max_bytes=1)

            traversal = root / "traversal.tar.gz"
            with tarfile.open(traversal, "w:gz") as handle:
                handle.addfile(tarfile.TarInfo("../outside"))
            with self.assertRaises(release_guard.GateError):
                release_guard.validate_tar(traversal)

            linked = root / "linked.tar.gz"
            with tarfile.open(linked, "w:gz") as handle:
                info = tarfile.TarInfo("link")
                info.type = tarfile.SYMTYPE
                info.linkname = "/tmp/target"
                handle.addfile(info)
            with self.assertRaises(release_guard.GateError):
                release_guard.validate_tar(linked)

    def test_manifest_generation_refuses_symlink(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / "target"
            target.write_text("safe", encoding="utf-8")
            (root / "link").symlink_to(target)
            with self.assertRaises(release_guard.GateError):
                release_guard.build_manifest(root)


class CoverageGateTests(unittest.TestCase):
    def test_percentage_and_metrics(self):
        self.assertEqual(coverage_gate.percentage(0, 0), 100.0)
        self.assertEqual(coverage_gate.percentage(8, 10), 80.0)
        self.assertEqual(
            coverage_gate.metrics(
                {"totals": {"covered_lines": 8, "num_statements": 10, "covered_branches": 4, "num_branches": 5}}
            ),
            (80.0, 80.0),
        )

    def test_cli_passes_and_fails_independent_thresholds(self):
        report = {"totals": {"covered_lines": 9, "num_statements": 10, "covered_branches": 4, "num_branches": 5}}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "coverage.json"
            path.write_text(json.dumps(report), encoding="utf-8")
            self.assertEqual(coverage_gate.main([str(path)]), 0)
            self.assertEqual(coverage_gate.main([str(path), "--minimum-branches", "81"]), 1)
            self.assertEqual(coverage_gate.main([str(path), "--minimum-lines", "91"]), 1)


class CredentialArtifactScanTests(unittest.TestCase):
    def test_workflow_keeps_strict_source_scan_and_uses_artifact_scanner(self):
        workflow = (ROOT / ".github/workflows/_quality.yml").read_text(encoding="utf-8")
        self.assertIn(
            "python3 ops/ci/credential_artifact_scan.py backend/.aws-sam/build",
            workflow,
        )
        self.assertIn("if git grep -I -l -E -- 'BEGIN", workflow)
        source_pattern = (
            "BEGIN "
            + "([A-Z0-9]+ )*"
            + "PRIVATE KEY|"
            + "A(KI|SI)A"
            + "[0-9A-Z]{16}"
        )
        self.assertIn(source_pattern, workflow)

        with tempfile.TemporaryDirectory() as directory:
            fixture_root = Path(directory)
            fixtures = {
                "generic.pem": private_key_marker(),
                "encrypted.pem": private_key_marker("ENCRYPTED"),
                "dsa.pem": private_key_marker("DSA"),
                "long-term.txt": access_key_id("AKIA", "1234567890ABCDEF"),
                "temporary.txt": access_key_id("ASIA", "1234567890ABCDEF"),
            }
            for name, value in fixtures.items():
                (fixture_root / name).write_text(value, encoding="utf-8")
            fixture_scan = subprocess.run(
                ["grep", "-E", "-l", "--", source_pattern, *sorted(fixtures)],
                cwd=fixture_root,
                check=False,
                capture_output=True,
                text=True,
            )
            self.assertEqual(fixture_scan.returncode, 0, fixture_scan.stderr)
            self.assertEqual(
                set(fixture_scan.stdout.splitlines()),
                set(fixtures),
            )

        completed = subprocess.run(
            [
                "git",
                "grep",
                "-I",
                "-l",
                "-E",
                "--",
                source_pattern,
                ":!package-lock.json",
            ],
            cwd=ROOT,
            check=False,
            capture_output=True,
            text=True,
        )
        self.assertEqual(completed.returncode, 1, completed.stdout)
        self.assertEqual(completed.stdout, "")

    def test_observed_dependency_vocabulary_is_not_credential_material(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            openssh_begin = private_key_marker("OPENSSH")
            openssh_end = private_key_marker("OPENSSH", ending=True)
            rsa_begin = private_key_marker("RSA")
            rsa_end = private_key_marker("RSA", ending=True)
            ec_begin = private_key_marker("EC")
            ec_end = private_key_marker("EC", ending=True)
            documentation_id = access_key_id("AKIA", "IOSFODNN7EXAMPLE")
            fixtures = {
                "cryptography/hazmat/primitives/serialization/ssh.py": (
                    f'_START = b"{openssh_begin}"\n'
                    f'_END = b"{openssh_end}"\n'
                ),
                "google/auth/crypt/_python_rsa.py": (
                    f'markers = ("{rsa_begin}", "{rsa_end}")\n'
                ),
                "google/oauth2/gdch_credentials.py": (
                    f'example = "{ec_begin}\\n<key bytes>\\n{ec_end}\\n"\n'
                ),
                "googleapiclient/discovery_cache/documents/appengine.v1.json": (
                    json.dumps({"description": f"{rsa_begin} {rsa_end}"})
                ),
                "GoogleDriveBackupFunction/googleapiclient/discovery_cache/documents/iamcredentials.v1.json": (
                    json.dumps(iam_credentials_discovery_document())
                ),
                "node_modules/@aws-sdk/sts/AssumeRoleCommand.d.ts": (
                    f'example: "{documentation_id}"\n'
                ),
            }
            for relative, source in fixtures.items():
                path = root / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(source, encoding="utf-8")

            report = credential_artifact_scan.scan(root)
            self.assertEqual(report.files_scanned, len(fixtures))
            self.assertEqual(report.findings, ())
            self.assertEqual(credential_artifact_scan.main([str(root)]), 0)

    def test_real_material_and_forbidden_filename_fail_without_echoing_secrets(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            key_begin = private_key_marker()
            key_end = private_key_marker(ending=True)
            key = root / "leaked.pem"
            key.write_text(
                f"{key_begin}\n"
                "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n"
                f"{key_end}\n",
                encoding="utf-8",
            )
            long_term_id = access_key_id("AKIA", "1234567890ABCDEF")
            temporary_id = access_key_id("ASIA", "1234567890ABCDEF")
            access_key = root / "handler.py"
            access_key.write_text(
                f'value = "{long_term_id}"\n'
                f'temporary = "{temporary_id}"\n',
                encoding="utf-8",
            )
            forbidden = root / "service-account-prod.json"
            forbidden.write_text("{}", encoding="utf-8")
            (root / "service_account_prod.json").write_text("{}", encoding="utf-8")
            (root / "cached_credentials.json").write_text("{}", encoding="utf-8")

            report = credential_artifact_scan.scan(root)
            self.assertEqual(
                {finding.kind for finding in report.findings},
                {
                    "aws_access_key_id",
                    "forbidden_credential_filename",
                    "private_key_block",
                },
            )
            with patch("sys.stdout") as stdout:
                self.assertEqual(credential_artifact_scan.main([str(root)]), 1)
            rendered = "".join(str(call) for call in stdout.write.call_args_list)
            self.assertNotIn(long_term_id, rendered)
            self.assertNotIn(temporary_id, rendered)
            self.assertNotIn("MIIEvQIBADANBgkqhkiG9w0BAQEFAASC", rendered)

    def test_legacy_encrypted_pem_with_metadata_is_rejected(self):
        begin = private_key_marker("RSA")
        end = private_key_marker("RSA", ending=True)
        payload = (
            f"{begin}\n"
            "Proc-Type: 4,ENCRYPTED\n"
            "DEK-Info: AES-256-CBC,0123456789ABCDEF\n\n"
            "MIIE6TAbBgkqhkiG9w0BBQMwDgQIZmFrZVNhbHQCAggA\n"
            f"{end}\n"
        ).encode()
        self.assertTrue(credential_artifact_scan._contains_private_key_block(payload))

    def test_iam_credentials_exception_requires_exact_path_and_schema_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            valid_document = json.dumps(iam_credentials_discovery_document())
            wrong_path = root / "other" / "iamcredentials.v1.json"
            wrong_path.parent.mkdir(parents=True)
            wrong_path.write_text(valid_document, encoding="utf-8")
            wrong_document = (
                root
                / "GoogleDriveBackupFunction"
                / "googleapiclient"
                / "discovery_cache"
                / "documents"
                / "iamcredentials.v1.json"
            )
            wrong_document.parent.mkdir(parents=True)
            wrong_document.write_text("{}", encoding="utf-8")
            report = credential_artifact_scan.scan(root)
            self.assertEqual(
                [finding.kind for finding in report.findings],
                ["forbidden_credential_filename", "forbidden_credential_filename"],
            )

    def test_directory_enumeration_error_fails_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            blocked = root / "blocked"
            blocked.mkdir()
            (root / "safe.txt").write_text("safe", encoding="utf-8")
            real_scandir = credential_artifact_scan.os.scandir

            def guarded_scandir(path):
                if Path(path) == blocked:
                    raise PermissionError("blocked")
                return real_scandir(path)

            with patch.object(
                credential_artifact_scan.os, "scandir", side_effect=guarded_scandir
            ), self.assertRaises(credential_artifact_scan.ScanError):
                credential_artifact_scan.scan(root)

    def test_empty_or_unsafe_artifact_roots_fail_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaises(credential_artifact_scan.ScanError):
                credential_artifact_scan.scan(root)
            with patch("sys.stderr") as stderr:
                self.assertEqual(credential_artifact_scan.main([str(root)]), 2)
            self.assertNotIn(str(root), "".join(str(call) for call in stderr.write.call_args_list))


class CliTests(unittest.TestCase):
    def test_release_guard_subcommands_and_redacted_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            stack = root / "stack.json"
            output = root / "parameters.json"
            stack.write_text(json.dumps({"Parameters": [{"ParameterKey": "Stage"}]}), encoding="utf-8")
            self.assertEqual(release_guard.main(["previous-parameters", str(stack), str(output)]), 0)
            self.assertEqual(json.loads(output.read_text()), [{"ParameterKey": "Stage", "UsePreviousValue": True}])

            pages = root / "pages.json"
            pages.write_text(json.dumps([{"Changes": [change()]}]), encoding="utf-8")
            self.assertEqual(release_guard.main(["gate-change-set", str(pages)]), 0)

            invalid = root / "invalid.json"
            invalid.write_text("not-json", encoding="utf-8")
            with patch("sys.stderr") as stderr:
                self.assertEqual(release_guard.main(["stack-invariants", str(invalid)]), 2)
                self.assertTrue(stderr.write.called)


class WorkflowPolicyTests(unittest.TestCase):
    def test_accepts_full_sha_and_local_reusable_workflow(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "workflow.yml"
            path.write_text(
                "steps:\n  - uses: actions/checkout@" + "a" * 40 + "\n  - uses: ./.github/workflows/_quality.yml\n",
                encoding="utf-8",
            )
            self.assertEqual(workflow_policy.violations(path), [])
            self.assertEqual(workflow_policy.main([str(path)]), 0)

    def test_rejects_mutable_actions_privileged_trigger_permissions_and_checkout(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "workflow.yml"
            path.write_text(
                "on:\n  pull_request_target:\npermissions: write-all\nsteps:\n"
                "  - uses: actions/checkout@v4\n    with:\n      persist-credentials: true\n",
                encoding="utf-8",
            )
            problems = workflow_policy.violations(path)
            self.assertEqual(len(problems), 4)
            self.assertEqual(workflow_policy.main([str(path)]), 1)

    def test_deploy_helpers_preserve_release_safety_contract(self):
        helper_paths = [
            ROOT / "ops" / "ci" / name
            for name in (
                "backend_plan.sh",
                "backend_execute.sh",
                "collect_change_set.sh",
                "frontend_deploy.sh",
                "public_smoke.sh",
                "wait_for_drift.sh",
            )
        ]
        for path in helper_paths:
            self.assertTrue(path.stat().st_mode & 0o111, f"{path.name} must be executable")

        plan = helper_paths[0].read_text(encoding="utf-8")
        execute = helper_paths[1].read_text(encoding="utf-8")
        collect = helper_paths[2].read_text(encoding="utf-8")
        frontend = helper_paths[3].read_text(encoding="utf-8")
        smoke = helper_paths[4].read_text(encoding="utf-8")
        drift = helper_paths[5].read_text(encoding="utf-8")
        self.assertIn("detect-stack-drift", plan)
        self.assertNotIn("wait stack-drift-detection-complete", plan)
        self.assertIn("DETECTION_IN_PROGRESS", drift)
        self.assertIn("DETECTION_FAILED", drift)
        self.assertIn("timed out", drift)
        self.assertIn("CREATE_COMPLETE", collect)
        self.assertIn("AVAILABLE", collect)
        self.assertIn("ReleaseSha", collect)
        self.assertIn("gate-change-set", collect)
        self.assertIn("previous-parameters", plan)
        self.assertIn("--release-sha", plan)
        self.assertIn("ARTIFACT_KMS_KEY_ARN", plan)
        self.assertIn("--kms-key-id", plan)
        self.assertIn("packaged_template_key", plan)
        self.assertIn("--template-url", plan)
        self.assertNotIn('--template-body "file://$workspace/packaged.yaml"', plan)
        self.assertIn("collect_change_set.sh", plan)
        self.assertIn("CAPABILITY_NAMED_IAM", plan)
        self.assertIn("stack-update-complete", execute)
        self.assertIn("EXPECTED_RELEASE_SHA", execute)
        self.assertIn("collect_change_set.sh", execute)
        self.assertNotIn("sync", frontend)
        self.assertNotIn("delete", frontend)
        self.assertIn("get-public-access-block", frontend)
        self.assertIn("OriginAccessControlId", frontend)
        self.assertLess(frontend.index('"$root/index.html"'), frontend.index("create-invalidation"))
        self.assertNotIn("--paths '/*'", frontend)
        self.assertIn("'/index.html'", frontend)
        self.assertIn("'/images/heroes/*'", frontend)
        self.assertIn('if [[ "$api" == "/api" ]]', smoke)
        self.assertIn('api="${site}${api}"', smoke)
        self.assertIn('elif [[ "$api" != https://* ]]', smoke)


if __name__ == "__main__":
    unittest.main()
