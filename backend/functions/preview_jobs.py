"""Best-effort dispatch for idempotent responsive-preview work."""

import json
import os

import boto3

from media_access import PREVIEW_VERSION, normalize_object_key
from validation_helpers import validate_uuid


_sqs = None


def get_sqs_client():
    global _sqs
    if _sqs is None:
        _sqs = boto3.client("sqs")
    return _sqs


def enqueue_preview_jobs(album_id, images):
    """Queue photo preview work when the optional queue is configured.

    Duplicates are expected and safe: output keys and worker manifest updates
    are deterministic and conditional. The worker re-reads the album and does
    not trust visibility or ownership data from this message.
    """
    queue_url = os.environ.get("PREVIEW_QUEUE_URL", "").strip()
    if not queue_url:
        return 0
    album_id = validate_uuid(album_id)
    jobs = []
    for image in images or []:
        if not isinstance(image, dict):
            continue
        raw_key = normalize_object_key(image.get("rawKey") or image.get("key"))
        jobs.append({"albumId": album_id, "rawKey": raw_key, "previewVersion": PREVIEW_VERSION})

    sent = 0
    client = get_sqs_client()
    for offset in range(0, len(jobs), 10):
        batch = jobs[offset:offset + 10]
        response = client.send_message_batch(
            QueueUrl=queue_url,
            Entries=[
                {"Id": str(index), "MessageBody": json.dumps(job, separators=(",", ":"), sort_keys=True)}
                for index, job in enumerate(batch)
            ],
        )
        failed = response.get("Failed", [])
        if failed:
            raise RuntimeError(f"Preview queue rejected {len(failed)} message(s)")
        sent += len(response.get("Successful", []))
    return sent
