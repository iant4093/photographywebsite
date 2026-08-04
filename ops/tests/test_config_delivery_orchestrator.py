"""Behavior tests for the exact inline Config delivery custom resource code."""

from __future__ import annotations

import hashlib
import os
from pathlib import Path
import sys
import types
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[2]
TEMPLATE = (ROOT / "ops" / "security_managed_services_template.yaml").read_text(
    encoding="utf-8"
)
ACCOUNT = "123456789012"
REGION = "us-west-2"
CHANNEL = "ian-photography-prod"
BUCKET = "config-history-example-bucket"
ROLE = f"arn:aws:iam::{ACCOUNT}:role/config-recorder-role"
MARKER = f"/ian-photography/config-delivery/{CHANNEL}/owner"
STACK_ID = (
    f"arn:aws:cloudformation:{REGION}:{ACCOUNT}:"
    "stack/ian-photography-security-managed/00000000-0000-4000-8000-000000000000"
)
TOKEN = "v1:" + hashlib.sha256(STACK_ID.encode("utf-8")).hexdigest()
OWNED_ID = f"config-delivery-channel:{ACCOUNT}:{REGION}:{CHANNEL}:owned"
def inline_handler_source() -> str:
    """Extract deployed ZipFile code so the behavior tests cannot drift from IaC."""

    lines = TEMPLATE.splitlines()
    marker = lines.index("        ZipFile: |")
    source: list[str] = []
    for line in lines[marker + 1 :]:
        if not line:
            source.append("")
        elif line.startswith("          "):
            source.append(line[10:])
        else:
            break
    if not source:
        raise AssertionError("missing inline Config delivery handler")
    return "\n".join(source) + "\n"


def load_handler() -> types.ModuleType:
    module = types.ModuleType("config_delivery_inline_handler")
    fake_boto3 = types.SimpleNamespace(client=lambda _service: None)
    with mock.patch.dict(sys.modules, {"boto3": fake_boto3}):
        exec(
            compile(inline_handler_source(), "<config-delivery-handler>", "exec"),
            module.__dict__,
        )
    return module


class Context:
    invoked_function_arn = (
        f"arn:aws:lambda:{REGION}:{ACCOUNT}:function:config-delivery"
    )
    log_stream_name = "safe-log-stream"

    def __init__(self, remaining_ms: int = 600_000) -> None:
        self.remaining_ms = remaining_ms

    def get_remaining_time_in_millis(self) -> int:
        return self.remaining_ms


def properties(**overrides) -> dict:
    result = {
        "ChannelName": CHANNEL,
        "BucketName": BUCKET,
        "DeliveryFrequency": "TwentyFour_Hours",
        "ExpectedAccountId": ACCOUNT,
        "ExpectedRegion": REGION,
        "ExpectedRecorderRoleArn": ROLE,
        "ExpectedAllSupported": True,
        "ExpectedIncludeGlobalResourceTypes": False,
        "OwnershipParameterName": MARKER,
    }
    result.update(overrides)
    return result


def legacy_properties(**overrides) -> dict:
    result = properties()
    result.pop("ExpectedAllSupported")
    result.pop("ExpectedIncludeGlobalResourceTypes")
    result["ExpectedResourceTypes"] = [
        "AWS::S3::Bucket",
        "AWS::DynamoDB::Table",
        "AWS::Lambda::Function",
    ]
    result.update(overrides)
    return result


def desired(props: dict | None = None) -> dict:
    props = props or properties()
    return {
        "name": props["ChannelName"],
        "s3BucketName": props["BucketName"],
        "configSnapshotDeliveryProperties": {
            "deliveryFrequency": props["DeliveryFrequency"]
        },
    }


def recorder(**overrides) -> dict:
    result = {
        "name": CHANNEL,
        "roleARN": ROLE,
        "recordingGroup": {
            "allSupported": True,
            "includeGlobalResourceTypes": False,
        },
    }
    result.update(overrides)
    return result


class ApiError(Exception):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.response = {"Error": {"Code": code}}


class ConfigClient:
    def __init__(
        self,
        *,
        recorder_responses: list[list[dict]] | None = None,
        channels: list[dict] | None = None,
        recording: bool = False,
        fail_after_put: bool = False,
        concurrent_delete: bool = False,
        calls: list[str] | None = None,
    ) -> None:
        self.recorder_responses = recorder_responses or [[recorder()]]
        self.channels = list(channels or [])
        self.recording = recording
        self.fail_after_put = fail_after_put
        self.concurrent_delete = concurrent_delete
        self.calls = calls if calls is not None else []
        self.put_calls: list[dict] = []
        self.stop_calls: list[str] = []
        self.delete_calls: list[str] = []

    def describe_configuration_recorders(self) -> dict:
        if len(self.recorder_responses) > 1:
            current = self.recorder_responses.pop(0)
        else:
            current = self.recorder_responses[0]
        return {"ConfigurationRecorders": current}

    def describe_delivery_channels(self) -> dict:
        return {"DeliveryChannels": list(self.channels)}

    def put_delivery_channel(self, *, DeliveryChannel: dict) -> None:
        self.calls.append("config:put")
        self.put_calls.append(DeliveryChannel)
        self.channels = [DeliveryChannel]
        if self.fail_after_put:
            raise ApiError("InternalError")

    def describe_configuration_recorder_status(
        self, *, ConfigurationRecorderNames: list[str]
    ) -> dict:
        return {
            "ConfigurationRecordersStatus": [
                {
                    "name": ConfigurationRecorderNames[0],
                    "recording": self.recording,
                }
            ]
        }

    def stop_configuration_recorder(self, *, ConfigurationRecorderName: str) -> None:
        self.calls.append("config:stop")
        self.stop_calls.append(ConfigurationRecorderName)
        self.recording = False

    def delete_delivery_channel(self, *, DeliveryChannelName: str) -> None:
        self.calls.append("config:delete")
        self.delete_calls.append(DeliveryChannelName)
        self.channels = [
            item for item in self.channels if item.get("name") != DeliveryChannelName
        ]
        if self.concurrent_delete:
            raise ApiError("NoSuchDeliveryChannelException")


class MarkerClient:
    def __init__(
        self,
        value: str | None = None,
        *,
        calls: list[str] | None = None,
    ) -> None:
        self.parameters = {} if value is None else {MARKER: value}
        self.calls = calls if calls is not None else []
        self.put_calls = 0
        self.delete_calls = 0

    def get_parameter(self, *, Name: str, WithDecryption: bool) -> dict:
        if Name not in self.parameters:
            raise ApiError("ParameterNotFound")
        return {"Parameter": {"Name": Name, "Value": self.parameters[Name]}}

    def put_parameter(self, **kwargs) -> dict:
        name = kwargs["Name"]
        if name in self.parameters and not kwargs.get("Overwrite", False):
            raise ApiError("ParameterAlreadyExists")
        self.calls.append("marker:put")
        self.put_calls += 1
        self.parameters[name] = kwargs["Value"]
        return {"Version": 1}

    def delete_parameter(self, *, Name: str) -> None:
        self.calls.append("marker:delete")
        self.delete_calls += 1
        self.parameters.pop(Name, None)


class ConfigDeliveryOrchestratorTests(unittest.TestCase):
    def setUp(self) -> None:
        self.module = load_handler()
        self.environment = mock.patch.dict(
            os.environ,
            {"AWS_REGION": REGION, "RECORDER_WAIT_SECONDS": "420"},
        )
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def reconcile(
        self,
        config: ConfigClient,
        marker: MarkerClient,
        *,
        request_type: str = "Create",
        props: dict | None = None,
        old_props: dict | None = None,
        physical_id: str | None = None,
    ) -> tuple[str, str]:
        return self.module._reconcile(
            config,
            marker,
            request_type,
            props or properties(),
            old_props or {},
            physical_id,
            STACK_ID,
            1,
            Context(),
        )

    def delete(
        self,
        config: ConfigClient,
        marker: MarkerClient,
        *,
        props: dict | None = None,
        physical_id: str = OWNED_ID,
    ) -> str:
        return self.module._delete(
            config,
            marker,
            props or properties(),
            physical_id,
            STACK_ID,
            Context(),
        )

    def test_create_waits_claims_marker_before_put_and_returns_owned_id(self) -> None:
        calls: list[str] = []
        config = ConfigClient(
            recorder_responses=[[], [recorder()]],
            calls=calls,
        )
        marker = MarkerClient(calls=calls)
        with mock.patch.object(self.module.time, "sleep"):
            physical_id, outcome = self.reconcile(config, marker)
        self.assertEqual(physical_id, OWNED_ID)
        self.assertEqual(outcome, "reconciled-marker-claimed")
        self.assertEqual(calls, ["marker:put", "config:put"])
        self.assertEqual(marker.parameters[MARKER], TOKEN)
        self.assertEqual(config.put_calls, [desired()])

    def test_post_put_failure_can_be_safely_cleaned_up_on_rollback(self) -> None:
        config = ConfigClient(recording=True, fail_after_put=True)
        marker = MarkerClient()
        event = {
            "RequestType": "Create",
            "ResourceProperties": properties(),
            "StackId": STACK_ID,
            "RequestId": "request-id",
            "LogicalResourceId": "ConfigDeliveryChannel",
            "ResponseURL": "https://example.invalid/presigned",
        }
        clients = {"config": config, "ssm": marker}
        with (
            mock.patch.object(
                self.module.boto3, "client", side_effect=lambda service: clients[service]
            ),
            mock.patch.object(self.module, "_send") as sender,
        ):
            self.module.handler(event, Context())
        self.assertEqual(sender.call_args.args[2], "FAILED")
        self.assertEqual(sender.call_args.args[3], OWNED_ID)
        self.assertEqual(config.channels, [desired()])
        self.assertEqual(marker.parameters[MARKER], TOKEN)

        config.fail_after_put = False
        outcome = self.delete(config, marker)
        self.assertEqual(outcome, "deleted-initial-rollback")
        self.assertEqual(config.stop_calls, [CHANNEL])
        self.assertEqual(config.delete_calls, [CHANNEL])
        self.assertNotIn(MARKER, marker.parameters)

    def test_retry_recovers_marker_and_exact_post_put_channel(self) -> None:
        config = ConfigClient(fail_after_put=True)
        marker = MarkerClient()
        with self.assertRaises(ApiError):
            self.reconcile(config, marker)
        config.fail_after_put = False

        physical_id, outcome = self.reconcile(config, marker)
        self.assertEqual(physical_id, OWNED_ID)
        self.assertEqual(outcome, "already-current")
        self.assertEqual(marker.put_calls, 1)
        self.assertEqual(len(config.put_calls), 1)

    def test_preexisting_exact_channel_without_marker_fails_and_is_never_deleted(self) -> None:
        config = ConfigClient(channels=[desired()], recording=True)
        marker = MarkerClient()
        with self.assertRaisesRegex(PermissionError, "lacks ownership marker"):
            self.reconcile(config, marker)
        self.assertEqual(marker.put_calls, 0)
        self.assertEqual(config.put_calls, [])

        outcome = self.delete(config, marker)
        self.assertEqual(outcome, "retained-marker-absent")
        self.assertEqual(config.stop_calls, [])
        self.assertEqual(config.delete_calls, [])

    def test_marker_mismatch_blocks_create_update_and_delete(self) -> None:
        config = ConfigClient(channels=[desired()], recording=True)
        marker = MarkerClient("v1:" + "f" * 64)
        with self.assertRaisesRegex(PermissionError, "marker mismatch"):
            self.reconcile(config, marker)
        outcome = self.delete(config, marker)
        self.assertEqual(outcome, "retained-marker-mismatch")
        self.assertEqual(config.stop_calls, [])
        self.assertEqual(config.delete_calls, [])
        self.assertEqual(marker.delete_calls, 0)

    def test_recorder_drift_blocks_create_and_rollback_stop(self) -> None:
        drifted = recorder(roleARN=f"arn:aws:iam::{ACCOUNT}:role/other-role")
        create_config = ConfigClient(recorder_responses=[[drifted]])
        with self.assertRaisesRegex(RuntimeError, "unexpected configuration recorder"):
            self.reconcile(create_config, MarkerClient())

        delete_config = ConfigClient(
            recorder_responses=[[drifted]],
            channels=[desired()],
            recording=True,
        )
        marker = MarkerClient(TOKEN)
        outcome = self.delete(delete_config, marker)
        self.assertEqual(outcome, "retained-recorder-drift")
        self.assertEqual(delete_config.stop_calls, [])
        self.assertEqual(delete_config.delete_calls, [])
        self.assertEqual(marker.parameters[MARKER], TOKEN)

    def test_recording_scope_drift_also_blocks_rollback(self) -> None:
        group = recorder()["recordingGroup"] | {
            "allSupported": False,
            "resourceTypes": ["AWS::S3::Bucket"],
        }
        config = ConfigClient(
            recorder_responses=[[recorder(recordingGroup=group)]],
            channels=[desired()],
            recording=True,
        )
        marker = MarkerClient(TOKEN)
        self.assertEqual(self.delete(config, marker), "retained-recorder-drift")
        self.assertEqual(config.stop_calls, [])

    def test_update_requires_marker_physical_id_and_undrifted_old_state(self) -> None:
        old = legacy_properties(DeliveryFrequency="Twelve_Hours")
        config = ConfigClient(channels=[desired(old)])
        marker = MarkerClient(TOKEN)
        physical_id, outcome = self.reconcile(
            config,
            marker,
            request_type="Update",
            old_props=old,
            physical_id=OWNED_ID,
        )
        self.assertEqual(physical_id, OWNED_ID)
        self.assertEqual(outcome, "reconciled-marker-recovered")
        self.assertEqual(config.put_calls, [desired()])

        missing_marker = MarkerClient()
        with self.assertRaisesRegex(PermissionError, "marker is missing"):
            self.reconcile(
                ConfigClient(channels=[desired(old)]),
                missing_marker,
                request_type="Update",
                old_props=old,
                physical_id=OWNED_ID,
            )

    def test_channel_absent_delete_cleans_only_matching_marker(self) -> None:
        marker = MarkerClient(TOKEN)
        outcome = self.delete(ConfigClient(), marker)
        self.assertEqual(outcome, "cleaned-marker-channel-absent")
        self.assertEqual(marker.delete_calls, 1)
        self.assertNotIn(MARKER, marker.parameters)

    def test_concurrent_channel_delete_still_cleans_matching_marker(self) -> None:
        config = ConfigClient(
            channels=[desired()],
            concurrent_delete=True,
        )
        marker = MarkerClient(TOKEN)
        outcome = self.delete(config, marker)
        self.assertEqual(outcome, "deleted-initial-rollback")
        self.assertEqual(config.channels, [])
        self.assertEqual(marker.delete_calls, 1)
        self.assertNotIn(MARKER, marker.parameters)

    def test_scope_stack_and_value_guards_fail_closed(self) -> None:
        bad_values = (
            properties(ExpectedAccountId="999999999999"),
            properties(ExpectedRegion="us-east-1"),
            properties(ChannelName="bad/channel"),
            properties(BucketName="INVALID_BUCKET"),
            properties(DeliveryFrequency="EveryMinute"),
            properties(ExpectedRecorderRoleArn="arn:aws:iam::999999999999:role/x"),
            properties(ExpectedAllSupported=False),
            properties(ExpectedIncludeGlobalResourceTypes="false"),
            legacy_properties(ExpectedResourceTypes=[]),
            properties(OwnershipParameterName="/unrelated/marker"),
        )
        for bad in bad_values:
            with self.subTest(bad=bad):
                with self.assertRaises((PermissionError, ValueError)):
                    self.module._scope(bad, Context())
        scope = self.module._scope(properties(), Context())
        legacy_scope = self.module._scope(
            legacy_properties(), Context(), allow_legacy_recording=True
        )
        self.assertFalse(legacy_scope["all_supported"])
        with self.assertRaisesRegex(ValueError, "all-supported"):
            self.module._scope(legacy_properties(), Context())
        with self.assertRaisesRegex(PermissionError, "stack scope mismatch"):
            self.module._ownership_token("not-a-stack-arn", scope)

    def test_handler_create_failure_uses_deterministic_owned_physical_id(self) -> None:
        event = {
            "RequestType": "Create",
            "ResourceProperties": properties(),
            "StackId": "not-a-stack-arn",
            "RequestId": "request-id",
            "LogicalResourceId": "ConfigDeliveryChannel",
            "ResponseURL": "https://example.invalid/presigned",
        }
        clients = {"config": ConfigClient(), "ssm": MarkerClient()}
        with (
            mock.patch.object(
                self.module.boto3, "client", side_effect=lambda service: clients[service]
            ),
            mock.patch.object(self.module, "_send") as sender,
        ):
            self.module.handler(event, Context())
        args = sender.call_args.args
        self.assertEqual(args[2], "FAILED")
        self.assertEqual(args[3], OWNED_ID)
        self.assertEqual(args[4], "PermissionError; see the orchestrator log group")
        self.assertEqual(args[5], {})

    def test_callback_retries_and_timing_leave_bounded_headroom(self) -> None:
        event = {
            "StackId": STACK_ID,
            "RequestId": "request-id",
            "LogicalResourceId": "ConfigDeliveryChannel",
            "ResponseURL": "https://example.invalid/presigned",
        }
        response = mock.MagicMock()
        response.__enter__.return_value = response
        with (
            mock.patch.object(
                self.module.urllib.request,
                "urlopen",
                side_effect=[OSError(), OSError(), response],
            ) as opener,
            mock.patch.object(self.module.time, "sleep") as sleeper,
        ):
            self.module._send(event, Context(), "SUCCESS", OWNED_ID, "Completed", {})
        self.assertEqual(opener.call_count, 3)
        self.assertEqual([call.args[0] for call in sleeper.call_args_list], [1, 2])
        self.assertEqual(self.module._reconcile_wait_seconds(Context()), 420)
        self.assertEqual(self.module._reconcile_wait_seconds(Context(120_000)), 30)
        self.assertIn("Timeout: 600", TEMPLATE)
        self.assertIn("RECORDER_WAIT_SECONDS: '420'", TEMPLATE)
        self.assertIn("ServiceTimeout: 660", TEMPLATE)


if __name__ == "__main__":
    unittest.main()
