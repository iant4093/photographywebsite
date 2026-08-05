"""Focused source-level checks for the responsive-preview V2 stack."""

from __future__ import annotations

import json
from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parents[2]
TEMPLATE = (ROOT / "backend" / "template.yaml").read_text(encoding="utf-8")
MAKEFILE = (ROOT / "backend" / "Makefile").read_text(encoding="utf-8")
RUNBOOK = (ROOT / "ops" / "README.md").read_text(encoding="utf-8")


def resource_block(logical_id: str) -> str:
    match = re.search(
        rf"(?ms)^  {re.escape(logical_id)}:\n(?P<body>.*?)(?=^  [A-Za-z][A-Za-z0-9]+:\n|^Outputs:)",
        TEMPLATE,
    )
    if not match:
        raise AssertionError(f"Missing resource {logical_id}")
    return match.group("body")


class PreviewDataProtectionTests(unittest.TestCase):
    def test_metadata_table_is_external_recoverable_and_customer_key_encrypted(self) -> None:
        key = resource_block("PreviewDataKey")
        table = resource_block("PreviewMetadataTable")
        for expected in (
            "DeletionPolicy: Retain",
            "UpdateReplacePolicy: Retain",
            "EnableKeyRotation: true",
            "PendingWindowInDays: 30",
        ):
            self.assertIn(expected, key)
        for expected in (
            "DeletionPolicy: Retain",
            "UpdateReplacePolicy: Retain",
            "DeletionProtectionEnabled: true",
            "PointInTimeRecoveryEnabled: true",
            "SSEType: KMS",
            "KMSMasterKeyId: !GetAtt PreviewDataKey.Arn",
            "AttributeName: albumId",
            "AttributeName: mediaId",
        ):
            self.assertIn(expected, table)

    def test_queue_and_dlq_are_kms_encrypted_and_bounded(self) -> None:
        queue = resource_block("PreviewQueue")
        dlq = resource_block("PreviewDeadLetterQueue")
        for block in (queue, dlq):
            self.assertIn("KmsMasterKeyId: !GetAtt PreviewDataKey.Arn", block)
            self.assertIn("MessageRetentionPeriod: 1209600", block)
        self.assertIn("VisibilityTimeout: 1080", queue)
        self.assertIn("deadLetterTargetArn: !GetAtt PreviewDeadLetterQueue.Arn", queue)
        self.assertIn("maxReceiveCount: 5", queue)


class PreviewWorkerTests(unittest.TestCase):
    def test_worker_is_reproducibly_packaged_and_concurrency_bounded(self) -> None:
        worker = resource_block("PreviewWorkerFunction")
        for expected in (
            "BuildMethod: makefile",
            "Runtime: nodejs22.x",
            "Handler: index.handler",
            "ReservedConcurrentExecutions: 2",
            "FunctionResponseTypes:",
            "- ReportBatchItemFailures",
            "MaximumConcurrency: 2",
            "PREVIEW_METADATA_TABLE: !Ref PreviewMetadataTable",
        ):
            self.assertIn(expected, worker)
        self.assertIn("build-PreviewWorkerFunction:", MAKEFILE)
        self.assertIn("--os=linux", MAKEFILE)
        self.assertIn("--cpu=x64", MAKEFILE)
        self.assertIn("--libc=glibc", MAKEFILE)
        self.assertIn("--no-bin-links", MAKEFILE)
        self.assertIn("npm ci", MAKEFILE.replace('"$(NPM)"', "npm"))

        package = json.loads((ROOT / "backend" / "preview_worker" / "package.json").read_text(encoding="utf-8"))
        lock = json.loads((ROOT / "backend" / "preview_worker" / "package-lock.json").read_text(encoding="utf-8"))
        self.assertEqual(package["engines"]["node"], ">=22 <25")
        self.assertEqual(package["dependencies"]["sharp"], "0.35.3")
        for dependency in (
            "@aws-sdk/client-dynamodb",
            "@aws-sdk/client-s3",
            "@aws-sdk/lib-dynamodb",
        ):
            self.assertEqual(package["dependencies"][dependency], "3.1091.0")
        self.assertEqual(lock["packages"][""]["dependencies"], package["dependencies"])

    def test_worker_cannot_delete_album_media_and_confines_hero_cleanup(self) -> None:
        worker = resource_block("PreviewWorkerFunction")
        self.assertIn("s3:GetObjectVersion", worker)
        self.assertIn("s3:PutObjectTagging", worker)
        self.assertIn("/albums/*/preview/v2/*", worker)
        album_permissions = worker.split("Resource: !Sub '${ImagesBucket.Arn}/albums/*'", 1)[0]
        self.assertNotIn("s3:DeleteObject", album_permissions)
        self.assertIn("${ImagesBucket.Arn}/site/hero/versions/v1/*", worker)
        self.assertIn("s3:DeleteObject", worker)
        hero_statement = worker.split(
            "- !Sub '${ImagesBucket.Arn}/site/hero/versions/v1/*'",
            1,
        )[0].rsplit("- Effect: Allow", 1)[-1]
        self.assertIn("s3:PutObjectTagging", hero_statement)
        self.assertNotIn("dynamodb:DeleteItem", worker)

    def test_exact_api_functions_receive_external_metadata_permissions(self) -> None:
        for logical_id in (
            "GetPublicAlbumFunction",
            "GetAlbumFunction",
            "GetSharedAlbumFunction",
            "CreateAlbumFunction",
            "UpdateAlbumFunction",
            "DeleteAlbumFunction",
            "AddImagesFunction",
            "DeleteImagesFunction",
        ):
            block = resource_block(logical_id)
            self.assertIn("PREVIEW_METADATA_TABLE: !Ref PreviewMetadataTable", block)
            self.assertIn("dynamodb:BatchGetItem", block)
        for logical_id in ("CreateAlbumFunction", "AddImagesFunction"):
            block = resource_block(logical_id)
            self.assertIn("PREVIEW_QUEUE_URL: !Ref PreviewQueue", block)
            self.assertIn("sqs:SendMessage", block)
            self.assertIn("kms:GenerateDataKey", block)
        for logical_id in ("DeleteAlbumFunction", "DeleteImagesFunction"):
            self.assertIn("dynamodb:BatchWriteItem", resource_block(logical_id))

    def test_every_preview_metadata_consumer_can_decrypt_the_exact_table_key(self) -> None:
        expected_consumers = {
            "GetPublicAlbumFunction",
            "GetAlbumFunction",
            "GetSharedAlbumFunction",
            "CreateAlbumFunction",
            "UpdateAlbumFunction",
            "DeleteAlbumFunction",
            "AddImagesFunction",
            "PreviewWorkerFunction",
            "DeleteImagesFunction",
        }
        actual_consumers = {
            logical_id
            for logical_id in re.findall(r"(?m)^  ([A-Za-z][A-Za-z0-9]+Function):$", TEMPLATE)
            if "PREVIEW_METADATA_TABLE: !Ref PreviewMetadataTable"
            in resource_block(logical_id)
        }
        self.assertEqual(expected_consumers, actual_consumers)

        exact_key_decrypt = re.compile(
            r"(?ms)Action:(?P<actions>.*?)"
            r"^\s+Resource: !GetAtt PreviewDataKey\.Arn$"
        )
        for logical_id in sorted(expected_consumers):
            with self.subTest(function=logical_id):
                key_statements = exact_key_decrypt.findall(resource_block(logical_id))
                self.assertTrue(
                    any("kms:Decrypt" in actions for actions in key_statements),
                    f"{logical_id} must decrypt PreviewDataKey",
                )


class PreviewDeliveryAndOperationsTests(unittest.TestCase):
    def test_public_preview_delivery_always_rechecks_visibility_at_origin(self) -> None:
        policy = resource_block("ImagesBucketPolicy")
        cache = resource_block("PreviewMediaCachePolicy")
        distribution = resource_block("ImagesCloudFront")
        self.assertIn("DenyCloudFrontNonPublicPreviewV2", policy)
        self.assertIn("s3:ExistingObjectTag/visibility: public", policy)
        self.assertIn("/albums/*/preview/v2/*", policy)
        for expected in ("DefaultTTL: 0", "MaxTTL: 0", "MinTTL: 0"):
            self.assertIn(expected, cache)
        self.assertIn("EnableAcceptEncodingBrotli: false", cache)
        self.assertIn("EnableAcceptEncodingGzip: false", cache)
        self.assertIn("PathPattern: 'albums/*/preview/v2/*'", distribution)
        self.assertIn("CachePolicyId: !Ref PreviewMediaCachePolicy", distribution)

    def test_media_origin_access_logs_use_scoped_existing_audit_bucket_policy(self) -> None:
        source = resource_block("ImagesBucket")
        target = resource_block("MediaAccessLogsBucket")
        policy = resource_block("MediaAccessLogsBucketPolicy")
        self.assertIn("DestinationBucketName: !Ref MediaAccessLogsBucket", source)
        self.assertIn("LogFilePrefix: s3-media/", source)
        self.assertIn("AccessControl: LogDeliveryWrite", target)
        self.assertIn("Service: logging.s3.amazonaws.com", policy)
        self.assertIn("Resource: !Sub '${MediaAccessLogsBucket.Arn}/s3-media/*'", policy)
        self.assertIn("aws:SourceAccount: !Ref AWS::AccountId", policy)
        self.assertIn("aws:SourceArn: !GetAtt ImagesBucket.Arn", policy)
        self.assertIn("ObjectOwnership: ObjectWriter", target)

    def test_failures_are_metricized_and_alarmable(self) -> None:
        self.assertIn("preview_job_failed", resource_block("PreviewJobFailureMetricFilter"))
        self.assertIn("hero_derivatives_failed", resource_block("PreviewJobFailureMetricFilter"))
        for logical_id in (
            "PreviewDeadLetterQueueAlarm",
            "PreviewQueueAgeAlarm",
            "PreviewMetadataSystemErrorsAlarm",
        ):
            block = resource_block(logical_id)
            self.assertIn("ian-photography-security-${Stage}", block)
            self.assertIn("TreatMissingData: notBreaching", block)
        for logical_id in (
            "PreviewQueueDepthAlarm",
            "PreviewWorkerFailureAlarm",
            "PreviewWorkerErrorsAlarm",
            "PreviewWorkerDurationAlarm",
            "PreviewWorkerThrottleAlarm",
            "PreviewMetadataThrottleAlarm",
        ):
            block = resource_block(logical_id)
            self.assertNotIn("AlarmActions:", block)
            self.assertIn("TreatMissingData: notBreaching", block)

    def test_backfill_uses_guarded_direct_queue_dispatch(self) -> None:
        self.assertNotIn("AWS::StepFunctions::StateMachine", TEMPLATE)
        self.assertNotIn("PreviewBackfillOperationsBucket:", TEMPLATE)
        self.assertIn("dry-run by default", RUNBOOK)
        self.assertIn("SendMessageBatch", RUNBOOK)
        self.assertIn("--expected-plan-digest", RUNBOOK)
        self.assertIn("--confirm backfill-preview-v2", RUNBOOK)


if __name__ == "__main__":
    unittest.main()
