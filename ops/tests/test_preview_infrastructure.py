"""Focused source-level checks for the responsive-preview V3 stack."""

from __future__ import annotations

import json
from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parents[2]
TEMPLATE = (ROOT / "backend" / "template.yaml").read_text(encoding="utf-8")
MAKEFILE = (ROOT / "backend" / "Makefile").read_text(encoding="utf-8")
RUNBOOK = (ROOT / "ops" / "README.md").read_text(encoding="utf-8")
WORKER_SOURCE = (ROOT / "backend" / "preview_worker" / "index.mjs").read_text(encoding="utf-8")


def resource_block(logical_id: str) -> str:
    match = re.search(
        rf"(?ms)^  {re.escape(logical_id)}:\n(?P<body>.*?)(?=^  [A-Za-z][A-Za-z0-9]+:\n|^Outputs:)",
        TEMPLATE,
    )
    if not match:
        raise AssertionError(f"Missing resource {logical_id}")
    return match.group("body")


class PreviewDataProtectionTests(unittest.TestCase):
    def test_metadata_table_is_external_recoverable_and_aws_owned_key_encrypted(self) -> None:
        table = resource_block("PreviewMetadataTable")
        for expected in (
            "DeletionPolicy: Retain",
            "UpdateReplacePolicy: Retain",
            "DeletionProtectionEnabled: true",
            "PointInTimeRecoveryEnabled: true",
            "SSEEnabled: true",
            "AttributeName: albumId",
            "AttributeName: mediaId",
        ):
            self.assertIn(expected, table)
        self.assertNotIn("KMSMasterKeyId", table)
        self.assertNotIn("PreviewDataKey", TEMPLATE)

    def test_queue_and_dlq_use_sqs_managed_encryption_and_are_bounded(self) -> None:
        queue = resource_block("PreviewQueue")
        dlq = resource_block("PreviewDeadLetterQueue")
        for block in (queue, dlq):
            self.assertIn("SqsManagedSseEnabled: true", block)
            self.assertNotIn("KmsMasterKeyId", block)
            self.assertIn("MessageRetentionPeriod: 1209600", block)
        self.assertIn("VisibilityTimeout: 1080", queue)
        self.assertIn("deadLetterTargetArn: !GetAtt PreviewDeadLetterQueue.Arn", queue)
        self.assertIn("maxReceiveCount: 5", queue)


class PreviewWorkerTests(unittest.TestCase):
    def test_responsive_hero_invalidations_have_a_migration_safe_namespace(self) -> None:
        self.assertIn("CallerReference: `responsive-${job.heroType}-hero-v2-${job.version}`", WORKER_SOURCE)
        self.assertNotIn("CallerReference: `hero-${job.version}`", WORKER_SOURCE)

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
        self.assertIn("/albums/*/preview/v3/*", worker)
        album_permissions = worker.split("Resource: !Sub '${ImagesBucket.Arn}/albums/*'", 1)[0]
        self.assertNotIn("s3:DeleteObject", album_permissions)
        self.assertIn("${ImagesBucket.Arn}/site/hero/versions/v1/*", worker)
        self.assertIn("${ImagesBucket.Arn}/site/hero/current/*", worker)
        self.assertIn("${ImagesBucket.Arn}/site/hero/versions/video/v1/*", worker)
        self.assertIn("${ImagesBucket.Arn}/site/hero/video/current/*", worker)
        self.assertIn("- site/hero/manifest.json", worker)
        self.assertIn("- site/hero/current/*", worker)
        self.assertIn("- site/hero/video/manifest.json", worker)
        self.assertIn("- site/hero/video/current/*", worker)
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
            self.assertNotIn("kms:GenerateDataKey", block)
        for logical_id in ("DeleteAlbumFunction", "DeleteImagesFunction"):
            self.assertIn("dynamodb:BatchWriteItem", resource_block(logical_id))

    def test_every_preview_metadata_consumer_uses_no_customer_key_permissions(self) -> None:
        expected_consumers = {
            "GetPublicAlbumFunction",
            "GetAlbumFunction",
            "GetSharedAlbumFunction",
            "CreateAlbumFunction",
            "UpdateAlbumFunction",
            "DeleteAlbumFunction",
            "AddImagesFunction",
            "PreviewWorkerFunction",
            "RandomPhotoPoolBuilderFunction",
            "HoverPreviewManifestBuilderFunction",
            "DeleteImagesFunction",
            "GetAdminAlbumMediaFunction",
        }
        actual_consumers = {
            logical_id
            for logical_id in re.findall(r"(?m)^  ([A-Za-z][A-Za-z0-9]+Function):$", TEMPLATE)
            if "PREVIEW_METADATA_TABLE: !Ref PreviewMetadataTable"
            in resource_block(logical_id)
        }
        self.assertEqual(expected_consumers, actual_consumers)

        for logical_id in sorted(expected_consumers):
            with self.subTest(function=logical_id):
                self.assertNotIn("PreviewDataKey", resource_block(logical_id))

    def test_random_photo_pools_use_targeted_refreshes_and_keep_a_disabled_rollback_mapping(self) -> None:
        albums = resource_block("AlbumsTable")
        builder = resource_block("RandomPhotoPoolBuilderFunction")
        self.assertIn("StreamViewType: KEYS_ONLY", albums)
        for expected in (
            "Handler: random_photo_pool_builder.handler",
            "ReservedConcurrentExecutions: 1",
            "Timeout: 120",
            "MemorySize: 512",
            "PREVIEW_METADATA_TABLE: !Ref PreviewMetadataTable",
            "Stream: !GetAtt AlbumsTable.StreamArn",
            "Enabled: false",
            "Queue: !GetAtt RandomPhotoRefreshQueue.Arn",
            "Schedule: rate(1 hour)",
            "MaximumBatchingWindowInSeconds: 10",
            "MaximumRetryAttempts: 3",
            "BisectBatchOnFunctionError: true",
            "Destination: !GetAtt AsyncFailureQueue.Arn",
            "dynamodb:BatchWriteItem",
            "dynamodb:GetRecords",
            "s3:ListBucket",
        ):
            self.assertIn(expected, builder)
        self.assertIn("SOURCES_RandomPhotoPoolBuilderFunction", MAKEFILE)

    def test_hover_previews_use_bounded_immutable_materialization(self) -> None:
        metadata = resource_block("PreviewMetadataTable")
        queue = resource_block("HoverPreviewRefreshQueue")
        builder = resource_block("HoverPreviewManifestBuilderFunction")
        update_album = resource_block("UpdateAlbumFunction")
        rewrite = resource_block("PublicPreviewRewriteFunction")

        self.assertIn("StreamViewType: KEYS_ONLY", metadata)
        for expected in (
            "Handler: hover_preview_manifest_builder.handler",
            "ReservedConcurrentExecutions: 2",
            "Timeout: 120",
            "MemorySize: 512",
            "Stream: !GetAtt PreviewMetadataTable.StreamArn",
            "Queue: !GetAtt HoverPreviewRefreshQueue.Arn",
            "Schedule: rate(15 minutes)",
            "MaximumRetryAttempts: 3",
            "BisectBatchOnFunctionError: true",
            "- ReportBatchItemFailures",
            "${ImagesBucket.Arn}/albums/*/preview/v3/hover-*.json",
            "s3:GetObjectTagging",
            "CACHE_INVALIDATION_QUEUE_URL: !Ref CacheInvalidationQueue",
        ):
            self.assertIn(expected, builder)
        self.assertIn("VisibilityTimeout: 900", queue)
        self.assertIn("deadLetterTargetArn: !GetAtt AsyncFailureQueue.Arn", queue)
        self.assertIn("HOVER_PREVIEW_REFRESH_QUEUE_URL: !Ref HoverPreviewRefreshQueue", update_album)
        self.assertIn("manifestPattern = /^hover-", rewrite)
        self.assertIn("SOURCES_HoverPreviewManifestBuilderFunction", MAKEFILE)
        self.assertIn("hover_preview_refresh.py", MAKEFILE)

        for logical_id in (
            "HoverPreviewRefreshQueueAgeAlarm",
            "HoverPreviewManifestBuilderErrorsAlarm",
            "HoverPreviewManifestFailureAlarm",
        ):
            alarm = resource_block(logical_id)
            self.assertIn("TreatMissingData: notBreaching", alarm)
            self.assertIn("ian-photography-security-${Stage}", alarm)

        self.assertIn("Album hover-preview manifests", RUNBOOK)
        self.assertIn("HOVER_PREVIEW_MANIFESTS.md", RUNBOOK)


class PreviewDeliveryAndOperationsTests(unittest.TestCase):
    def test_protected_preview_delivery_rechecks_visibility_while_public_aliases_are_cached(self) -> None:
        policy = resource_block("ImagesBucketPolicy")
        protected_cache = resource_block("PreviewMediaCachePolicy")
        public_cache = resource_block("PublicPreviewCachePolicy")
        public_headers = resource_block("PublicPreviewResponseHeadersPolicy")
        rewrite = resource_block("PublicPreviewRewriteFunction")
        distribution = resource_block("ImagesCloudFront")
        self.assertIn("DenyCloudFrontNonPublicResponsivePreviews", policy)
        self.assertIn("s3:ExistingObjectTag/visibility: public", policy)
        self.assertIn("/albums/*/preview/v2/*", policy)
        self.assertIn("/albums/*/preview/v3/*", policy)
        for expected in ("DefaultTTL: 0", "MaxTTL: 0", "MinTTL: 0"):
            self.assertIn(expected, protected_cache)
        for expected in ("DefaultTTL: 86400", "MaxTTL: 86400", "MinTTL: 1"):
            self.assertIn(expected, public_cache)
        self.assertIn("EnableAcceptEncodingBrotli: false", protected_cache)
        self.assertIn("EnableAcceptEncodingGzip: false", protected_cache)
        self.assertIn("parts[1] !== 'public-previews'", rewrite)
        self.assertIn("request.uri = '/albums/'", rewrite)
        self.assertIn("statusCode: 404", rewrite)
        self.assertIn("private, no-store", rewrite)
        self.assertNotIn("Cache-Control", public_headers)
        self.assertIn("CustomErrorResponses:", distribution)
        self.assertIn("ErrorCode: 403", distribution)
        self.assertIn("ErrorCode: 404", distribution)
        self.assertGreaterEqual(distribution.count("ErrorCachingMinTTL: 0"), 2)
        self.assertIn("PathPattern: 'public-previews/*'", distribution)
        self.assertIn("CachePolicyId: !Ref PublicPreviewCachePolicy", distribution)
        self.assertIn("ResponseHeadersPolicyId: !Ref PublicPreviewResponseHeadersPolicy", distribution)
        self.assertIn("FunctionARN: !GetAtt PublicPreviewRewriteFunction.FunctionMetadata.FunctionARN", distribution)
        self.assertNotIn("EventType: viewer-response", distribution)
        self.assertIn("PathPattern: 'albums/*/preview/v2/*'", distribution)
        self.assertIn("PathPattern: 'albums/*/preview/v3/*'", distribution)
        self.assertIn("CachePolicyId: !Ref PreviewMediaCachePolicy", distribution)

    def test_public_mutations_have_least_privilege_invalidation_permissions(self) -> None:
        frontend_only = (
            "CreateAlbumFunction",
            "AddImagesFunction",
            "UpdateGalleryOrderFunction",
            "UpdateImageFunction",
        )
        for logical_id in frontend_only:
            block = resource_block(logical_id)
            self.assertIn("CACHE_INVALIDATION_QUEUE_URL: !Ref CacheInvalidationQueue", block)
            self.assertIn("sqs:SendMessage", block)
            self.assertNotIn("distribution/EIOCCNR8XGQ1B", block)
        worker = resource_block("CacheInvalidationWorkerFunction")
        self.assertIn("cloudfront:CreateInvalidation", worker)
        self.assertIn("distribution/EIOCCNR8XGQ1B", worker)
        for logical_id in ("UpdateAlbumFunction", "DeleteAlbumFunction", "DeleteImagesFunction"):
            block = resource_block(logical_id)
            self.assertIn("IMAGES_DISTRIBUTION_ID: !Ref ImagesCloudFront", block)
            self.assertIn("cloudfront:CreateInvalidation", block)
            self.assertIn("distribution/${ImagesCloudFront}", block)
            self.assertNotIn("Resource: '*'", block)

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
        self.assertIn("--confirm backfill-preview-v3", RUNBOOK)


if __name__ == "__main__":
    unittest.main()
