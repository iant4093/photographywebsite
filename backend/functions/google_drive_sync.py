"""Asynchronous, idempotent S3-to-Google-Drive backup worker."""

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
from validation_helpers import (
    ValidationError,
    optional_string,
    require_string,
    validate_album_type,
    validate_list,
    validate_uuid,
)


s3 = boto3.client("s3")
table = boto3.resource("dynamodb").Table(os.environ["ALBUMS_TABLE"])
ssm_client = boto3.client("ssm")
DRIVE_SCOPE = ["https://www.googleapis.com/auth/drive.file"]
FOLDER_MIME_TYPE = "application/vnd.google-apps.folder"
APP_KIND_KEY = "ianPhotographyKind"
APP_ALBUM_ID_KEY = "ianPhotographyAlbumId"
_credentials_cache = None


def _credential_payload():
    global _credentials_cache
    if _credentials_cache is not None:
        return _credentials_cache
    parameter_name = os.environ.get("GOOGLE_OAUTH_PARAMETER", "").strip()
    if parameter_name:
        response = ssm_client.get_parameter(Name=parameter_name, WithDecryption=True)
        raw = response.get("Parameter", {}).get("Value")
        payload = json.loads(raw)
        if not isinstance(payload, dict):
            raise RuntimeError("Google credential parameter must be a JSON object")
        _credentials_cache = payload
        return payload

    # Explicit opt-in is only for local migration/testing. Production fails
    # closed rather than silently loading a credential from the code package.
    if os.environ.get("ALLOW_LEGACY_GOOGLE_CREDENTIAL_FILE") == "true":
        with open("google_oauth_token.json", "r", encoding="utf-8") as handle:
            return json.load(handle)
    raise RuntimeError("Google credential parameter is not configured")


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
        raise RuntimeError("Google credential parameter has no supported credential payload")
    return build("drive", "v3", credentials=credentials, cache_discovery=False)


def _drive_literal(value):
    return str(value).replace("\\", "\\\\").replace("'", "\\'")


def find_or_create_folder(service, folder_name, parent_id=None, app_properties=None):
    query = f"mimeType='{FOLDER_MIME_TYPE}' and name='{_drive_literal(folder_name)}' and trashed=false"
    if parent_id:
        query += f" and '{_drive_literal(parent_id)}' in parents"
    for key, value in sorted((app_properties or {}).items()):
        query += (
            " and appProperties has "
            f"{{ key='{_drive_literal(key)}' and value='{_drive_literal(value)}' }}"
        )
    results = service.files().list(
        q=query,
        spaces="drive",
        fields="files(id,name,parents,appProperties)",
        pageSize=2,
    ).execute()
    items = results.get("files", [])
    if items:
        return items[0]["id"]
    metadata = {"name": folder_name, "mimeType": FOLDER_MIME_TYPE}
    if parent_id:
        metadata["parents"] = [parent_id]
    if app_properties:
        metadata["appProperties"] = dict(app_properties)
    return service.files().create(body=metadata, fields="id").execute()["id"]


def _folder_query(service, query, *, page_size=10):
    response = service.files().list(
        q=f"mimeType='{FOLDER_MIME_TYPE}' and trashed=false and {query}",
        spaces="drive",
        fields="files(id,name,parents,appProperties)",
        pageSize=page_size,
    ).execute()
    files = response.get("files", [])
    return files if isinstance(files, list) else []


def _album_folder_by_id(service, album_id):
    matches = _folder_query(
        service,
        "appProperties has "
        f"{{ key='{APP_ALBUM_ID_KEY}' and value='{_drive_literal(album_id)}' }}",
        page_size=2,
    )
    if len(matches) > 1:
        raise RuntimeError("Google Drive contains duplicate album folder identities")
    return matches[0] if matches else None


def _legacy_album_folder(service, album_title, type_folder_id, category_folder_id):
    candidates = []
    seen = set()
    for parent_id in (category_folder_id, type_folder_id):
        matches = _folder_query(
            service,
            f"name='{_drive_literal(album_title)}' and '{_drive_literal(parent_id)}' in parents",
        )
        for match in matches:
            app_properties = match.get("appProperties") or {}
            if app_properties.get(APP_KIND_KEY) == "category" or match.get("id") in seen:
                continue
            seen.add(match.get("id"))
            candidates.append(match)
    if len(candidates) > 1:
        raise RuntimeError("Google Drive contains ambiguous legacy album folders")
    return candidates[0] if candidates else None


def find_or_create_album_folder(
    service,
    album_id,
    album_title,
    type_folder_id,
    category_folder_id,
):
    folder = _album_folder_by_id(service, album_id)
    if folder is None:
        folder = _legacy_album_folder(
            service,
            album_title,
            type_folder_id,
            category_folder_id,
        )
    properties = {
        APP_KIND_KEY: "album",
        APP_ALBUM_ID_KEY: album_id,
    }
    if folder is None:
        return find_or_create_folder(
            service,
            album_title,
            category_folder_id,
            app_properties=properties,
        )

    folder_id = folder["id"]
    current_parents = [parent for parent in folder.get("parents", []) if isinstance(parent, str)]
    update = {
        "fileId": folder_id,
        "body": {"name": album_title, "appProperties": properties},
        "fields": "id,parents",
        "supportsAllDrives": True,
    }
    if category_folder_id not in current_parents:
        update["addParents"] = category_folder_id
        if current_parents:
            update["removeParents"] = ",".join(current_parents)
    service.files().update(**update).execute()
    return folder_id


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

    requested_album_type = validate_album_type((event or {}).get("albumType"))
    album_id = validate_uuid((event or {}).get("albumId"))
    album_descriptor = table.get_item(Key={"albumId": album_id}, ConsistentRead=True).get("Item")
    if not album_descriptor or album_descriptor.get("status", "active") != "active":
        raise ValidationError("Album is not eligible for Google Drive backup")
    album_type = validate_album_type(album_descriptor.get("type", requested_album_type))
    if album_type != requested_album_type:
        raise ValidationError("Album type does not match the stored album")
    album_title = require_string(album_descriptor.get("title"), "albumTitle", maximum=200)
    album_category = (
        optional_string(
            album_descriptor.get("category"),
            "albumCategory",
            maximum=100,
            default="Uncategorized",
        )
        or "Uncategorized"
    )
    bucket = require_string((event or {}).get("bucket"), "bucket", maximum=255)
    if bucket != os.environ.get("IMAGES_BUCKET"):
        raise ValidationError("Unexpected source bucket")
    keys = validate_list((event or {}).get("keys"), "keys", maximum=500)
    backup_enabled = album_descriptor.get("backupToGoogleDrive") is True
    if keys and not backup_enabled:
        raise ValidationError("Album is not eligible for Google Drive backup")

    service = get_drive_service()
    # Metadata-only reconciliation is also used for historical backups whose
    # ongoing backup toggle is now off. Only a folder tagged by the migration's
    # stable album ID is eligible; never create a backup for an opted-out album.
    if not backup_enabled and _album_folder_by_id(service, album_id) is None:
        return {"status": "success", "uploadedCount": 0, "folderReconciled": False}
    type_folder = find_or_create_folder(service, "Photos" if album_type == "photo" else "Videos", root_folder_id)
    category_folder = find_or_create_folder(
        service,
        album_category,
        type_folder,
        app_properties={APP_KIND_KEY: "category"},
    )
    album_folder = find_or_create_album_folder(
        service,
        album_id,
        album_title,
        type_folder,
        category_folder,
    )
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
