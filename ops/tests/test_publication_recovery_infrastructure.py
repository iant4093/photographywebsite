"""Keep recovery paths deployable under their actual, scoped IAM contracts."""
from pathlib import Path
import unittest

from cfnlint.decode import decode


ROOT = Path(__file__).resolve().parents[2]


def sequence(value):
    return value if isinstance(value, list) else [value]


class PublicationRecoveryInfrastructureTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        template, errors = decode(str(ROOT / "backend/template.yaml"))
        if errors:
            raise AssertionError(errors)
        cls.resources = template["Resources"]

    def allowed(self, function, resource):
        actions = set()
        for policy in self.resources[function]["Properties"]["Policies"]:
            for statement in policy.get("Statement", []) if isinstance(policy, dict) else []:
                if statement.get("Effect") == "Allow" and resource in sequence(statement.get("Resource")):
                    actions.update(sequence(statement["Action"]))
        return actions

    def test_every_media_lease_writer_can_read_and_conditionally_update_existing_albums(self):
        for function in ("TagMediaObjectFunction", "PreviewWorkerFunction", "HoverPreviewManifestBuilderFunction",
                         "CreateAlbumFunction", "UpdateAlbumFunction", "AddImagesFunction",
                         "UpdateImageFunction", "DeleteImagesFunction", "EditUserFunction"):
            with self.subTest(function=function):
                self.assertTrue({"dynamodb:GetItem", "dynamodb:UpdateItem"} <= self.allowed(
                    function, {"Fn::GetAtt": ["AlbumsTable", "Arn"]}))

    def test_manifest_repair_has_bounded_query_and_batch_write_access(self):
        # Repair enumerates obsolete rows before replacing them. BatchWrite alone
        # can handle fresh appends but strands an interrupted upload in fallback.
        self.assertEqual(self.allowed("AddImagesFunction", {"Fn::GetAtt": ["AlbumMediaTable", "Arn"]}),
                         {"dynamodb:Query", "dynamodb:BatchWriteItem"})

    def test_existing_continuation_queue_can_call_each_recovery_handler(self):
        worker = self.resources["CacheInvalidationWorkerFunction"]["Properties"]
        for function in ("UpdateAlbumFunction", "AddImagesFunction", "UpdateImageFunction"):
            with self.subTest(function=function):
                self.assertEqual(self.allowed("CacheInvalidationWorkerFunction", {"Fn::GetAtt": [function, "Arn"]}),
                                 {"lambda:InvokeFunction"})
                self.assertIn("sqs:SendMessage", self.allowed(function, {"Fn::GetAtt": ["CacheInvalidationQueue", "Arn"]}))
        self.assertEqual(worker["Events"]["CacheInvalidationRequests"]["Properties"]["FunctionResponseTypes"],
                         ["ReportBatchItemFailures"])

    def test_thumbnail_cleanup_can_revoke_existing_distribution_cache(self):
        self.assertEqual(self.allowed("UpdateImageFunction", {"Fn::Sub": "arn:${AWS::Partition}:cloudfront::${AWS::AccountId}:distribution/${ImagesCloudFront}"}),
                         {"cloudfront:CreateInvalidation"})

    def test_visibility_completion_can_only_read_its_existing_distribution_purge(self):
        self.assertEqual(self.allowed("UpdateAlbumFunction", {"Fn::Sub": "arn:${AWS::Partition}:cloudfront::${AWS::AccountId}:distribution/${ImagesCloudFront}"}),
                         {"cloudfront:CreateInvalidation", "cloudfront:GetInvalidation"})

    def test_video_reconciliation_only_searches_the_existing_default_queue(self):
        resource = {"Fn::Sub": "arn:${AWS::Partition}:mediaconvert:${AWS::Region}:${AWS::AccountId}:queues/Default"}
        for function in ("CreateAlbumFunction", "AddImagesFunction"):
            self.assertEqual(self.allowed(function, resource), {"mediaconvert:SearchJobs"})
            self.assertNotIn("mediaconvert:SearchJobs", self.allowed(function, "*"))

    def test_backup_deferral_reuses_existing_queue_and_worker_with_exact_wiring(self):
        self.assertEqual(self.allowed("CacheInvalidationWorkerFunction", {"Fn::GetAtt": ["GoogleDriveBackupFunction", "Arn"]}), {"lambda:InvokeFunction"})
        self.assertEqual(self.resources["CacheInvalidationWorkerFunction"]["Properties"]["Environment"]["Variables"]["DRIVE_WORKER_FUNCTION_NAME"], {"Ref": "GoogleDriveBackupFunction"})
        self.assertEqual(self.allowed("GoogleDriveBackupFunction", {"Fn::GetAtt": ["CacheInvalidationQueue", "Arn"]}), {"sqs:SendMessage"})
        self.assertEqual(self.resources["GoogleDriveBackupFunction"]["Properties"]["Environment"]["Variables"]["CACHE_INVALIDATION_QUEUE_URL"], {"Ref": "CacheInvalidationQueue"})
