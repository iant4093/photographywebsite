"""Namespace-safe deletion helpers for versioned S3 album media."""

import os

import boto3

from media_access import bucket_name, canonical_album_prefix, normalize_object_key


s3 = boto3.client("s3")


class DeletionTooLargeError(Exception):
    pass


def sync_delete_limit():
    try:
        value = int(os.environ.get("MAX_SYNC_DELETE_VERSIONS", "5000"))
    except ValueError:
        value = 5000
    return max(1, min(value, 50000))


def _delete_batch(objects):
    if not objects:
        return 0
    response = s3.delete_objects(
        Bucket=bucket_name(),
        Delete={"Objects": objects, "Quiet": True},
    )
    if response.get("Errors"):
        raise RuntimeError("S3 did not delete every requested object version")
    return len(objects)


def delete_object_versions(objects):
    deleted = 0
    for offset in range(0, len(objects), 1000):
        deleted += _delete_batch(objects[offset : offset + 1000])
    return deleted


def _versions_under_prefix(prefix):
    prefix = normalize_object_key(prefix).rstrip("/") + "/"
    paginator = s3.get_paginator("list_object_versions")
    for page in paginator.paginate(Bucket=bucket_name(), Prefix=prefix):
        for item in page.get("Versions", []):
            if item.get("Key") and item.get("VersionId"):
                yield {"Key": item["Key"], "VersionId": item["VersionId"]}
        for item in page.get("DeleteMarkers", []):
            if item.get("Key") and item.get("VersionId"):
                yield {"Key": item["Key"], "VersionId": item["VersionId"]}


def _versions_for_exact_keys(keys):
    paginator = s3.get_paginator("list_object_versions")
    for key in sorted({normalize_object_key(key) for key in keys if key}):
        for page in paginator.paginate(Bucket=bucket_name(), Prefix=key):
            for collection in ("Versions", "DeleteMarkers"):
                for item in page.get(collection, []):
                    if item.get("Key") == key and item.get("VersionId"):
                        yield {"Key": key, "VersionId": item["VersionId"]}


def preflight_deletion(*, prefixes=(), keys=(), max_versions=None, max_prefixes=500, max_keys=500):
    """Bound synchronous destructive work before the first mutation."""
    normalized_prefixes = tuple(
        dict.fromkeys(normalize_object_key(prefix).rstrip("/") + "/" for prefix in prefixes if prefix)
    )
    normalized_keys = tuple(dict.fromkeys(normalize_object_key(key) for key in keys if key))
    if len(normalized_prefixes) > max_prefixes or len(normalized_keys) > max_keys:
        raise DeletionTooLargeError("Deletion request has too many targets")
    limit = sync_delete_limit() if max_versions is None else max(1, int(max_versions))
    seen = set()
    for iterator in (
        *(_versions_under_prefix(prefix) for prefix in normalized_prefixes),
        _versions_for_exact_keys(normalized_keys),
    ):
        for item in iterator:
            identity = (item["Key"], item["VersionId"])
            if identity in seen:
                continue
            seen.add(identity)
            if len(seen) > limit:
                raise DeletionTooLargeError("Deletion exceeds the synchronous safety limit")
    return len(seen)


def delete_prefix_all_versions(prefix):
    """Permanently remove every version and delete marker under a prefix."""
    deleted = 0
    batch = []
    for item in _versions_under_prefix(prefix):
        batch.append(item)
        if len(batch) == 1000:
            deleted += _delete_batch(batch)
            batch = []
    return deleted + _delete_batch(batch)


def delete_keys_all_versions(keys):
    """Permanently remove only exact keys, never prefix matches."""
    normalized = {normalize_object_key(key) for key in keys if key}
    if not normalized:
        return 0
    objects = list(_versions_for_exact_keys(normalized))
    return delete_object_versions(objects)
