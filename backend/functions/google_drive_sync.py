"""Asynchronous, idempotent S3-to-Google-Drive backup worker."""

import base64
import json
import os
import posixpath
import tempfile

import boto3
from google.oauth2 import service_account
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload

from media_access import validate_album_media_key
from validation_helpers import ValidationError, require_string, validate_album_type, validate_list, validate_uuid


s3 = boto3.client("s3")
table = boto3.resource("dynamodb").Table(os.environ["ALBUMS_TABLE"])
secrets_client = boto3.client("secretsmanager")
DRIVE_SCOPE = ["https://www.googleapis.com/auth/drive.file"]
_credentials_cache = None


def _credential_payload():
    global _credentials_cache
    if _credentials_cache is not None:
        return _credentials_cache
    secret_arn = os.environ.get("GOOGLE_OAUTH_SECRET_ARN", "").strip()
    if secret_arn:
        response = secrets_client.get_secret_value(SecretId=secret_arn)
        if "SecretString" in response:
            raw = response["SecretString"]
        else:
            binary = response["SecretBinary"]
            raw = binary.decode("utf-8") if isinstance(binary, bytes) else base64.b64decode(binary).decode("utf-8")
        payload = json.loads(raw)
        if not isinstance(payload, dict):
            raise RuntimeError("Google credential secret must be a JSON object")
        _credentials_cache = payload
        return payload

    # Explicit opt-in is only for local migration/testing. Production fails
    # closed rather than silently loading a credential from the code package.
    if os.environ.get("ALLOW_LEGACY_GOOGLE_CREDENTIAL_FILE") == "true":
        with open("google_oauth_token.json", "r", encoding="utf-8") as handle:
            return json.load(handle)
    raise RuntimeError("Google credential secret is not configured")


def get_drive_service():
    payload = _credential_payload()
    oauth_info = payload.get("oauth") if isinstance(payload.get("oauth"), dict) else None
    service_info = payload.get("service_account") if isinstance(payload.get("service_account"), dict) else None
    if oauth_info:
        credentials = Credentials.from_authorized_user_info(oauth_info, scopes=DRIVE_SCOPE)
    elif service_info:
        credentials = service_account.Credentials.from_service_account_info(service_info, scopes=DRIVE_SCOPE)
    elif payload.get("type") == "service_account":
        credentials = service_account.Credentials.from_service_account_info(payload, scopes=DRIVE_SCOPE)
    elif payload.get("refresh_token"):
        credentials = Credentials.from_authorized_user_info(payload, scopes=DRIVE_SCOPE)
    else:
        raise RuntimeError("Google credential secret has no supported credential payload")
    return build("drive", "v3", credentials=credentials, cache_discovery=False)


def _drive_literal(value):
    return str(value).replace("\\", "\\\\").replace("'", "\\'")


def find_or_create_folder(service, folder_name, parent_id=None):
    query = f"mimeType='application/vnd.google-apps.folder' and name='{_drive_literal(folder_name)}' and trashed=false"
    if parent_id:
        query += f" and '{_drive_literal(parent_id)}' in parents"
    results = service.files().list(q=query, spaces="drive", fields="files(id,name)", pageSize=2).execute()
    items = results.get("files", [])
    if items:
        return items[0]["id"]
    metadata = {"name": folder_name, "mimeType": "application/vnd.google-apps.folder"}
    if parent_id:
        metadata["parents"] = [parent_id]
    return service.files().create(body=metadata, fields="id").execute()["id"]


def _existing_file_id(service, filename, parent_id):
    query = (
        f"name='{_drive_literal(filename)}' and '{_drive_literal(parent_id)}' in parents "
        "and trashed=false"
    )
    files = service.files().list(q=query, spaces="drive", fields="files(id)", pageSize=2).execute().get("files", [])
    return files[0]["id"] if files else None


def handler(event, context):
    root_folder_id = os.environ.get("GOOGLE_DRIVE_FOLDER_ID", "").strip()
    if not root_folder_id:
        raise RuntimeError("Google Drive destination is not configured")

    album_type = validate_album_type((event or {}).get("albumType"))
    album_id = validate_uuid((event or {}).get("albumId"))
    album_descriptor = table.get_item(Key={"albumId": album_id}, ConsistentRead=True).get("Item")
    if (
        not album_descriptor
        or album_descriptor.get("status", "active") != "active"
        or album_descriptor.get("backupToGoogleDrive") is not True
    ):
        raise ValidationError("Album is not eligible for Google Drive backup")
    album_title = require_string((event or {}).get("albumTitle"), "albumTitle", maximum=200)
    bucket = require_string((event or {}).get("bucket"), "bucket", maximum=255)
    if bucket != os.environ.get("IMAGES_BUCKET"):
        raise ValidationError("Unexpected source bucket")
    keys = validate_list((event or {}).get("keys"), "keys", maximum=500, required=True)

    service = get_drive_service()
    type_folder = find_or_create_folder(service, "Photos" if album_type == "photo" else "Videos", root_folder_id)
    album_folder = find_or_create_folder(service, album_title, type_folder)
    uploaded = 0

    for raw_key in keys:
        key = validate_album_media_key(raw_key, album=album_descriptor)
        filename = posixpath.basename(key)
        temporary_path = None
        try:
            head = s3.head_object(Bucket=bucket, Key=key)
            with tempfile.NamedTemporaryFile(prefix="drive-", suffix=posixpath.splitext(filename)[1], delete=False) as handle:
                temporary_path = handle.name
            s3.download_file(bucket, key, temporary_path)
            media = MediaFileUpload(
                temporary_path,
                mimetype=head.get("ContentType", "application/octet-stream"),
                chunksize=5 * 1024 * 1024,
                resumable=True,
            )
            existing_id = _existing_file_id(service, filename, album_folder)
            if existing_id:
                request = service.files().update(fileId=existing_id, media_body=media, fields="id")
            else:
                request = service.files().create(
                    body={"name": filename, "parents": [album_folder]},
                    media_body=media,
                    fields="id",
                )
            response = None
            while response is None:
                _, response = request.next_chunk()
            uploaded += 1
        finally:
            if temporary_path and os.path.exists(temporary_path):
                os.remove(temporary_path)
    return {"status": "success", "uploadedCount": uploaded}
