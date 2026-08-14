import importlib.util
import pathlib
import sys
import unittest
from unittest.mock import Mock, patch

from botocore.exceptions import ClientError


OPS = pathlib.Path(__file__).resolve().parents[1]
if str(OPS) not in sys.path:
    sys.path.insert(0, str(OPS))
MODULE_PATH = OPS / "backfill_album_qr_codes.py"
SPEC = importlib.util.spec_from_file_location("backfill_album_qr_codes", MODULE_PATH)
module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)


ALBUM_ID = "11111111-1111-4111-8111-111111111111"


def album(**overrides):
    value = {
        "albumId": ALBUM_ID,
        "type": "photo",
        "status": "active",
        "visibility": "public",
    }
    value.update(overrides)
    return value


class AlbumQrBackfillTests(unittest.TestCase):
    def test_eligibility_excludes_private_revoked_inactive_and_malformed(self):
        eligible, counts = module.eligible_albums([
            album(),
            album(albumId="22222222-2222-4222-8222-222222222222", visibility="unlisted", isShared=True, shareCode="valid-share-code"),
            album(albumId="33333333-3333-4333-8333-333333333333", visibility="private"),
            album(albumId="44444444-4444-4444-8444-444444444444", visibility="unlisted", isShared=False),
            album(albumId="55555555-5555-4555-8555-555555555555", status="pending"),
            album(albumId="bad"),
        ], module.DEFAULT_FRONTEND_ORIGIN)
        self.assertEqual(len(eligible), 2)
        self.assertEqual(counts["eligiblePublicCount"], 1)
        self.assertEqual(counts["eligibleLinkOnlyCount"], 1)
        self.assertEqual(counts["privateSkippedCount"], 1)
        self.assertEqual(counts["revokedLinkSkippedCount"], 1)
        self.assertEqual(counts["inactiveSkippedCount"], 1)
        self.assertEqual(counts["malformedSkippedCount"], 1)

    def test_plan_is_deterministic_and_only_repairs_mismatches(self):
        candidates, _ = module.eligible_albums([album()], module.DEFAULT_FRONTEND_ORIGIN)
        key = candidates[0]["key"]
        s3 = Mock()
        s3.get_object_tagging.return_value = {"TagSet": [{"Key": "visibility", "Value": "public"}]}
        candidates[0]["album"]["qrCodeKey"] = key
        plan, counts = module.build_plan(candidates, s3, "bucket")
        self.assertEqual(plan, [])
        self.assertEqual(counts["alreadyCompleteCount"], 1)

        s3.get_object_tagging.return_value = {"TagSet": [{"Key": "visibility", "Value": "pending"}]}
        plan, counts = module.build_plan(candidates, s3, "bucket")
        self.assertEqual(len(plan), 1)
        self.assertEqual(counts["visibilityTagRepairCount"], 1)
        self.assertEqual(module.plan_digest(plan), module.plan_digest(list(plan)))

    def test_missing_objects_are_planned_without_exposing_identifiers(self):
        candidates, _ = module.eligible_albums([album()], module.DEFAULT_FRONTEND_ORIGIN)
        missing = ClientError({"Error": {"Code": "NoSuchKey"}}, "GetObjectTagging")
        s3 = Mock()
        s3.get_object_tagging.side_effect = missing
        plan, counts = module.build_plan(candidates, s3, "bucket")
        self.assertEqual(len(plan), 1)
        self.assertEqual(counts["missingObjectCount"], 1)

    def test_apply_writes_pending_then_conditionally_commits_and_tags(self):
        candidates, _ = module.eligible_albums([album()], module.DEFAULT_FRONTEND_ORIGIN)
        table = Mock()
        s3 = Mock()
        with patch.object(module, "write_album_qr", return_value=candidates[0]["key"]) as write:
            updated, conflicts = module.apply_plan(candidates, table, s3, "bucket", module.DEFAULT_FRONTEND_ORIGIN)
        self.assertEqual((updated, conflicts), (1, 0))
        write.assert_called_once()
        self.assertIn("#visibility = :visibility", table.update_item.call_args.kwargs["ConditionExpression"])
        self.assertEqual(s3.put_object_tagging.call_args.kwargs["Tagging"]["TagSet"][0]["Value"], "public")

        table.update_item.side_effect = ClientError({"Error": {"Code": "ConditionalCheckFailedException"}}, "UpdateItem")
        with patch.object(module, "write_album_qr", return_value=candidates[0]["key"]):
            self.assertEqual(module.apply_plan(candidates, table, s3, "bucket", module.DEFAULT_FRONTEND_ORIGIN), (0, 1))

    def test_scan_paginates_and_rejects_repeated_tokens(self):
        table = Mock()
        table.scan.side_effect = [
            {"Items": [{"albumId": "one"}], "LastEvaluatedKey": {"albumId": "one"}},
            {"Items": [{"albumId": "two"}]},
        ]
        self.assertEqual(len(module.scan_albums(table)), 2)
        table.scan.side_effect = [
            {"Items": [], "LastEvaluatedKey": {"albumId": "one"}},
            {"Items": [], "LastEvaluatedKey": {"albumId": "one"}},
        ]
        with self.assertRaises(RuntimeError):
            module.scan_albums(table)


if __name__ == "__main__":
    unittest.main()
