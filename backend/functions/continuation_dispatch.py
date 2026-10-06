"""Internal continuation adapters; API handlers receive only their trusted envelope."""
import json
import os
import re

import boto3
from botocore.config import Config
from validation_helpers import validate_uuid


WORKERS = {"user-email-update": "USER_EMAIL_WORKER_FUNCTION_NAME", "album-visibility": "VISIBILITY_WORKER_FUNCTION_NAME",
           "user-deletion": "USER_DELETION_WORKER_FUNCTION_NAME",
           "album-upload-followup": "UPLOAD_WORKER_FUNCTION_NAME",
           "album-media-sync": "UPLOAD_WORKER_FUNCTION_NAME",
           "album-video-jobs": "UPLOAD_WORKER_FUNCTION_NAME",
           "album-thumbnail-cleanup": "THUMBNAIL_WORKER_FUNCTION_NAME",
           "album-object-tagging": "TAGGING_WORKER_FUNCTION_NAME",
           "album-media-deletion": "MEDIA_DELETION_WORKER_FUNCTION_NAME",
           "album-deletion": "DELETION_WORKER_FUNCTION_NAME",
           "album-drive-backup": "DRIVE_WORKER_FUNCTION_NAME"}


def continue_album_work(body):
    function = os.environ.get(WORKERS[body["kind"]], "").strip()
    if not function:
        raise RuntimeError("Album continuation worker is not configured")
    client = boto3.session.Session().client("lambda", config=Config(connect_timeout=2, read_timeout=20,
                                                retries={"mode": "standard", "total_max_attempts": 1}))
    if body["kind"] == "album-drive-backup":
        entry = body.get("jobEntry", "")
        if not isinstance(entry, str) or not re.fullmatch(r"job#[a-f0-9]{32}", entry):
            raise ValueError("Invalid backup job")
        response = client.invoke(FunctionName=function, InvocationType="Event", Payload=json.dumps({
            "source": "album-drive-backup", "albumId": validate_uuid(body["albumId"]), "jobEntry": entry}))
        payload = response.get("Payload")
        if payload is not None:
            payload.close()
        if response.get("StatusCode") != 202:
            raise RuntimeError("Backup continuation was not accepted")
        return
    envelope = {"source": body["kind"], "albumId": validate_uuid(body["albumId"])}
    if body["kind"] in {"user-deletion", "user-email-update"}:
        envelope["subject"] = envelope.pop("albumId")
    if body["kind"] == "album-object-tagging":
        if not isinstance(body.get("key"), str) or len(body["key"]) > 1024:
            raise ValueError("Invalid tagging key")
        envelope.update(key=body["key"], firstAttemptAt=int(body["firstAttemptAt"]), attempt=int(body["attempt"]))
    response = client.invoke(FunctionName=function, InvocationType="RequestResponse", Payload=json.dumps(envelope))
    payload = response["Payload"]
    try:
        raw = payload.read(65537)
        if len(raw) > 65536:
            raise RuntimeError("Invalid continuation response size")
        result = json.loads(raw)
    finally:
        payload.close()
    if response.get("FunctionError") or result.get("statusCode") not in {200, 202}:
        raise RuntimeError("Album continuation did not complete")
