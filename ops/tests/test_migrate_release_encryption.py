"""In-place rewrapping must preserve pinned versions and protect locked data."""

import copy
import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import migrate_release_encryption as migration


class Storage:
    def __init__(self, **changes):
        self.head = {"VersionId": "pinned-version", "ETag": '"checksum"', "ContentLength": 123,
                     "ServerSideEncryption": "aws:kms", "SSEKMSKeyId": "old-key",
                     "LastModified": "original-time", "Metadata": {"sha256": "original"}, **changes}
        self.updates = []

    def head_object(self, **kw):
        assert kw["VersionId"] == "pinned-version"
        assert kw["ExpectedBucketOwner"] == "123456789012"
        return copy.deepcopy(self.head)

    def update_object_encryption(self, **kw):
        self.updates.append(kw)
        self.head["SSEKMSKeyId"] = kw["ObjectEncryption"]["SSEKMS"]["KMSKeyArn"]
        self.head["BucketKeyEnabled"] = True


class ReleaseEncryptionMigrationTests(unittest.TestCase):
    def migrate(self, storage, apply=True):
        return migration.migrate_version(storage, bucket="release-bucket",
            row={"Key": "releases/test/package", "VersionId": "pinned-version", "ETag": '"checksum"', "Size": 123},
            account="123456789012", source_key="old-key", target_key="managed-key", apply=apply)

    def test_changes_only_the_key_and_preserves_the_exact_version(self):
        storage = Storage()
        self.assertEqual(self.migrate(storage), "migrated")
        self.assertEqual(storage.updates[0]["VersionId"], "pinned-version")
        self.assertEqual(storage.head["Metadata"], {"sha256": "original"})
        self.assertEqual(self.migrate(storage), "already-managed")
        self.assertEqual(len(storage.updates), 1)

    def test_dry_run_never_mutates(self):
        storage = Storage()
        self.assertEqual(self.migrate(storage, apply=False), "eligible")
        self.assertFalse(storage.updates)

    def test_never_bypasses_retention_or_legal_holds(self):
        for changes in [{"ObjectLockMode": "GOVERNANCE"}, {"ObjectLockMode": "COMPLIANCE"}, {"ObjectLockLegalHoldStatus": "ON"}]:
            storage = Storage(**changes)
            with self.assertRaisesRegex(ValueError, "locked"):
                self.migrate(storage)
            self.assertFalse(storage.updates)

    def test_rejects_changed_content_or_unexpected_keys(self):
        for changes in [{"ETag": '"changed"'}, {"ContentLength": 124}, {"SSEKMSKeyId": "unrelated-key"}]:
            storage = Storage(**changes)
            with self.assertRaises(ValueError):
                self.migrate(storage)
            self.assertFalse(storage.updates)

    def test_detects_a_provider_change_to_immutable_metadata(self):
        storage = Storage()
        original = storage.update_object_encryption
        def update(**kw):
            original(**kw)
            storage.head["LastModified"] = "unexpected-change"
        storage.update_object_encryption = update
        with self.assertRaisesRegex(RuntimeError, "metadata changed"):
            self.migrate(storage)


if __name__ == "__main__":
    unittest.main()
