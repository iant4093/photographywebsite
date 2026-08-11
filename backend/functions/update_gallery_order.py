"""Admin-only updates to public photo gallery album and category ordering."""

from datetime import datetime, timezone
import logging
import os

import boto3
from botocore.exceptions import ClientError

from audit_helpers import actor_context, emit_audit_event
from auth_helpers import require_admin
from front_door import verify_front_door_request
from gallery_order import SETTING_ID
from response_helpers import error_response, internal_error, json_response
from validation_helpers import (
    ValidationError,
    parse_json_body,
    require_string,
    validate_list,
    validate_uuid,
)


logger = logging.getLogger("photography_api.gallery_order")
dynamodb = boto3.resource("dynamodb")
albums_table = dynamodb.Table(os.environ["ALBUMS_TABLE"])
settings_table = dynamodb.Table(os.environ["GALLERY_SETTINGS_TABLE"])


def _audit(event, context, outcome, reason_code, *, album_count=None):
    actor_type, auth_method = actor_context(event)
    details = {"album_count": album_count} if album_count is not None else None
    emit_audit_event(
        event_name="admin.gallery_order_updated",
        outcome=outcome,
        action="album.gallery_order_update",
        resource_type="album",
        reason_code=reason_code,
        event=event,
        context=context,
        actor_type=actor_type,
        auth_method=auth_method,
        details=details,
    )


def _validated_album_ids(body):
    raw_ids = validate_list(body.get("albumIds"), "albumIds", maximum=500)
    album_ids = [validate_uuid(value, f"albumIds[{index}]") for index, value in enumerate(raw_ids)]
    if len(album_ids) != len(set(album_ids)):
        raise ValidationError("albumIds must not contain duplicates")
    return album_ids


def _validated_category_names(body):
    raw_names = validate_list(body.get("categoryNames"), "categoryNames", maximum=200)
    names = [
        require_string(value, f"categoryNames[{index}]", maximum=100)
        for index, value in enumerate(raw_names)
    ]
    if len(names) != len(set(names)):
        raise ValidationError("categoryNames must not contain duplicates")
    return names


def _load_albums(album_ids):
    if not album_ids:
        return []

    table_name = albums_table.name
    records = []
    for start in range(0, len(album_ids), 100):
        request_items = {
            table_name: {
                "Keys": [{"albumId": album_id} for album_id in album_ids[start:start + 100]],
                "ConsistentRead": True,
                "ProjectionExpression": "albumId, #status, visibility, #type",
                "ExpressionAttributeNames": {"#status": "status", "#type": "type"},
            }
        }
        for _attempt in range(4):
            response = dynamodb.batch_get_item(RequestItems=request_items)
            records.extend(response.get("Responses", {}).get(table_name, []))
            request_items = response.get("UnprocessedKeys", {})
            if not request_items:
                break
        if request_items:
            raise RuntimeError("Album validation could not be completed")
    return records


def _verify_public_photo_albums(album_ids):
    records = _load_albums(album_ids)
    valid_ids = {
        record.get("albumId")
        for record in records
        if record.get("status", "active") == "active"
        and record.get("visibility") == "public"
        and record.get("type", "photo") == "photo"
    }
    if valid_ids != set(album_ids):
        raise ValidationError("albumIds must contain only active main-gallery photo albums")


def handler(event, context):
    front_door_denied = verify_front_door_request(event, context)
    if front_door_denied:
        return front_door_denied
    denied = require_admin(event)
    if denied:
        return denied

    try:
        body = parse_json_body(event)
        allowed_fields = {"albumIds", "categoryNames"}
        if not body or not set(body).issubset(allowed_fields):
            raise ValidationError("Request must contain albumIds or categoryNames only")

        album_ids = _validated_album_ids(body) if "albumIds" in body else None
        category_names = _validated_category_names(body) if "categoryNames" in body else None
        if album_ids is not None:
            _verify_public_photo_albums(album_ids)

        assignments = ["updatedAt = :updated_at"]
        values = {":updated_at": datetime.now(timezone.utc).isoformat(timespec="seconds")}
        if album_ids is not None:
            assignments.append("albumIds = :album_ids")
            values[":album_ids"] = album_ids
        if category_names is not None:
            assignments.append("categoryNames = :category_names")
            values[":category_names"] = category_names
        settings_table.update_item(
            Key={"settingId": SETTING_ID},
            UpdateExpression="SET " + ", ".join(assignments),
            ExpressionAttributeValues=values,
        )
        _audit(
            event,
            context,
            "success",
            "gallery_order_updated",
            album_count=len(album_ids) if album_ids is not None else None,
        )
        response = {}
        if album_ids is not None:
            response["albumIds"] = album_ids
        if category_names is not None:
            response["categoryNames"] = category_names
        return json_response(200, response, cache_control="no-store")
    except ValidationError as error:
        _audit(event, context, "denied", "invalid_gallery_order")
        return error_response(400, str(error), code="invalid_gallery_order")
    except ClientError as error:
        _audit(event, context, "failure", "provider_error")
        return internal_error(context, error, "update_gallery_order")
    except Exception as error:
        _audit(event, context, "failure", "unexpected_error")
        return internal_error(context, error, "update_gallery_order")
