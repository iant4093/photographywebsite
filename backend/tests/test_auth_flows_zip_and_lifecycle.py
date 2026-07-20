import json
import unittest
from unittest.mock import Mock, patch

from botocore.exceptions import ClientError

from test_support import claims, response_body

import complete_challenge
import create_album
import create_user
import create_zip
import login
import tag_media_object
import worker_zip
import zip_helpers
import album_mutation_helpers


ALBUM_ID = "11111111-1111-4111-8111-111111111111"


class UserAuthenticationFlowTests(unittest.TestCase):
    def test_invitation_uses_cognito_generated_temporary_credential(self):
        event = {"body": json.dumps({"email": "NEW@Example.com", "password": "client-chosen"})}
        with patch.object(create_user, "require_admin", return_value=None), patch.object(
            create_user.cognito, "admin_create_user"
        ) as create:
            response = create_user.handler(event, None)
        self.assertEqual(response["statusCode"], 201)
        arguments = create.call_args.kwargs
        self.assertEqual(arguments["Username"], "new@example.com")
        self.assertNotIn("TemporaryPassword", arguments)
        self.assertEqual(arguments["DesiredDeliveryMediums"], ["EMAIL"])

    def test_login_requires_captcha_before_cognito(self):
        event = {
            "body": json.dumps(
                {"email": "user@example.com", "password": "Password123!", "turnstileToken": "bad"}
            )
        }
        with patch.object(login, "verify_turnstile", return_value=False), patch.object(
            login.cognito, "admin_initiate_auth"
        ) as auth:
            response = login.handler(event, None)
        self.assertEqual(response["statusCode"], 403)
        auth.assert_not_called()

    def test_login_preserves_new_password_challenge_without_exposing_password(self):
        event = {
            "body": json.dumps(
                {"email": "user@example.com", "password": "Password123!", "turnstileToken": "ok"}
            )
        }
        with patch.object(login, "verify_turnstile", return_value=True), patch.object(
            login, "check_rate_limit", return_value=True
        ), patch.object(
            login.cognito,
            "admin_initiate_auth",
            return_value={"ChallengeName": "NEW_PASSWORD_REQUIRED", "Session": "opaque-session"},
        ) as initiate:
            response = login.handler(event, None)
        body = response_body(response)
        self.assertEqual(body, {"ChallengeName": "NEW_PASSWORD_REQUIRED", "Session": "opaque-session"})
        self.assertNotIn("Password123", response["body"])
        self.assertEqual(initiate.call_args.kwargs["AuthFlow"], "ADMIN_USER_PASSWORD_AUTH")

    def test_new_password_policy_is_enforced_locally(self):
        with self.assertRaises(Exception):
            complete_challenge._validate_new_password("alllowercase123")
        self.assertEqual(complete_challenge._validate_new_password("StrongPassword123!"), "StrongPassword123!")

    def test_challenge_completion_is_captcha_and_rate_limited(self):
        event = {
            "body": json.dumps(
                {
                    "email": "user@example.com",
                    "challengeName": "NEW_PASSWORD_REQUIRED",
                    "newPassword": "StrongPassword123!",
                    "session": "opaque-session-value",
                    "turnstileToken": "ok",
                }
            )
        }
        result = {"AuthenticationResult": {"IdToken": "id", "RefreshToken": "refresh"}}
        with patch.object(complete_challenge, "verify_turnstile", return_value=True), patch.object(
            complete_challenge, "check_rate_limit", return_value=True
        ), patch.object(
            complete_challenge.cognito, "admin_respond_to_auth_challenge", return_value=result
        ) as respond:
            response = complete_challenge.handler(event, None)
        self.assertEqual(response["statusCode"], 200)
        self.assertEqual(respond.call_args.kwargs["ChallengeName"], "NEW_PASSWORD_REQUIRED")
        self.assertEqual(respond.call_args.kwargs["ChallengeResponses"]["USERNAME"], "user@example.com")

    def test_totp_challenge_requires_exact_six_digits_and_uses_cognito_mfa_response(self):
        event = {
            "body": json.dumps(
                {
                    "email": "user@example.com",
                    "challengeName": "SOFTWARE_TOKEN_MFA",
                    "code": "012345",
                    "session": "opaque-session-value",
                    "turnstileToken": "ok",
                }
            )
        }
        result = {"AuthenticationResult": {"IdToken": "id", "RefreshToken": "refresh"}}
        with patch.object(complete_challenge, "verify_turnstile", return_value=True), patch.object(
            complete_challenge, "check_rate_limit", return_value=True
        ), patch.object(
            complete_challenge.cognito, "admin_respond_to_auth_challenge", return_value=result
        ) as respond:
            response = complete_challenge.handler(event, None)
        self.assertEqual(response["statusCode"], 200)
        self.assertEqual(respond.call_args.kwargs["ChallengeName"], "SOFTWARE_TOKEN_MFA")
        self.assertEqual(respond.call_args.kwargs["ChallengeResponses"]["SOFTWARE_TOKEN_MFA_CODE"], "012345")

        event["body"] = json.dumps(
            {
                "email": "user@example.com",
                "challengeName": "SOFTWARE_TOKEN_MFA",
                "code": "12345x",
                "session": "opaque-session-value",
                "turnstileToken": "ok",
            }
        )
        self.assertEqual(complete_challenge.handler(event, None)["statusCode"], 400)

    def test_video_manifest_matches_mediaconvert_name_modifier(self):
        raw_key = f"albums/{ALBUM_ID}/original/movie.mp4"
        normalized = create_album._normalize_images([{"rawKey": raw_key}], ALBUM_ID, "video")
        self.assertEqual(
            normalized[0]["hlsUrl"],
            f"albums/{ALBUM_ID}/original/movie_hls/movie_1080p5m.m3u8",
        )


class AlbumLifecycleTests(unittest.TestCase):
    def test_image_normalization_rejects_cross_album_key(self):
        images = [{"rawKey": "albums/22222222-2222-4222-8222-222222222222/original/photo.jpg"}]
        with self.assertRaises(Exception):
            create_album._normalize_images(images, ALBUM_ID, "photo")

    def test_owner_resolution_uses_sub_attribute_not_cognito_username(self):
        body = {"ownerEmail": "owner@example.com"}
        response = {
            "Users": [
                {
                    "Username": "opaque-cognito-username",
                    "Attributes": [{"Name": "sub", "Value": ALBUM_ID}],
                }
            ]
        }
        with patch.object(album_mutation_helpers.cognito, "list_users", return_value=response):
            email, subject = create_album._resolve_owner(body)
        self.assertEqual(email, "owner@example.com")
        self.assertEqual(subject, ALBUM_ID)

    def test_restrictive_album_stays_pending_when_tagging_fails(self):
        raw_key = f"albums/{ALBUM_ID}/original/photo.jpg"
        event = {
            "body": json.dumps(
                {
                    "albumId": ALBUM_ID,
                    "type": "photo",
                    "visibility": "private",
                    "title": "Private album",
                    "description": "",
                    "category": "Portraits",
                    "createdAt": "2026-01-01T00:00:00Z",
                    "images": [{"rawKey": raw_key}],
                    "ownerEmail": "owner@example.com",
                    "backupToGoogleDrive": False,
                }
            )
        }
        with patch.object(create_album, "require_admin", return_value=None), patch.object(
            create_album, "get_caller_claims", return_value=claims(groups=["Admins"])
        ), patch.object(create_album, "_resolve_owner", return_value=("owner@example.com", ALBUM_ID)), patch.object(
            create_album, "_extract_exif"
        ), patch.object(create_album.table, "put_item") as put, patch.object(
            create_album.table, "update_item"
        ) as update, patch.object(
            create_album, "tag_album_visibility", side_effect=RuntimeError("S3 unavailable")
        ):
            response = create_album.handler(event, None)
        self.assertEqual(response["statusCode"], 500)
        self.assertEqual(put.call_args.kwargs["Item"]["status"], "pending")
        update.assert_not_called()

    def test_s3_event_tags_orphan_upload_pending(self):
        event = {
            "Records": [
                {
                    "s3": {
                        "bucket": {"name": "images-test"},
                        "object": {"key": f"albums/{ALBUM_ID}/original/photo.jpg"},
                    }
                }
            ]
        }
        with patch.object(tag_media_object.table, "get_item", return_value={}), patch.object(
            tag_media_object, "tag_keys_visibility", return_value=1
        ) as tag:
            response = tag_media_object.handler(event, None)
        self.assertEqual(response["tagged"], 1)
        self.assertEqual(tag.call_args.args[1], "pending")

    def test_s3_event_propagates_only_active_valid_visibility(self):
        event = {
            "Records": [
                {
                    "s3": {
                        "bucket": {"name": "images-test"},
                        "object": {"key": f"albums/{ALBUM_ID}/video_hls/segment.ts"},
                    }
                }
            ]
        }
        with patch.object(
            tag_media_object.table,
            "get_item",
            return_value={"Item": {"albumId": ALBUM_ID, "status": "active", "visibility": "private"}},
        ), patch.object(tag_media_object, "tag_keys_visibility", return_value=1) as tag:
            tag_media_object.handler(event, None)
        self.assertEqual(tag.call_args.args[1], "private")


class ZipTests(unittest.TestCase):
    def test_zip_version_changes_with_content_or_visibility(self):
        base = {
            "albumId": ALBUM_ID,
            "visibility": "private",
            "images": [{"rawKey": f"albums/{ALBUM_ID}/original/one.jpg"}],
        }
        self.assertNotEqual(zip_helpers.zip_version(base), zip_helpers.zip_version({**base, "visibility": "public"}))
        changed = {**base, "images": [*base["images"], {"rawKey": f"albums/{ALBUM_ID}/original/two.jpg"}]}
        self.assertNotEqual(zip_helpers.zip_version(base), zip_helpers.zip_version(changed))

    def test_private_zip_requires_authentication(self):
        album = {
            "albumId": ALBUM_ID,
            "status": "active",
            "visibility": "private",
            "ownerSub": "owner",
            "type": "photo",
            "images": [{"rawKey": f"albums/{ALBUM_ID}/original/one.jpg"}],
        }
        event = {"pathParameters": {"albumId": ALBUM_ID}}
        with patch.object(create_zip, "get_album_record", return_value=album), patch.object(
            create_zip, "get_verified_claims", return_value=None
        ):
            response = create_zip.handler(event, None)
        self.assertEqual(response["statusCode"], 401)

    def test_worker_rejects_pending_album_even_for_internal_event(self):
        with patch.object(
            worker_zip, "get_album_record", return_value={"albumId": ALBUM_ID, "status": "pending", "visibility": "public"}
        ):
            with self.assertRaises(Exception):
                worker_zip._validated_album({"albumId": ALBUM_ID})

    def test_processing_response_advertises_retry_after(self):
        album = {
            "albumId": ALBUM_ID,
            "status": "active",
            "visibility": "public",
            "type": "photo",
            "images": [{"rawKey": f"albums/{ALBUM_ID}/original/one.jpg"}],
        }
        missing = ClientError({"Error": {"Code": "404"}}, "HeadObject")
        with patch.object(create_zip, "get_album_record", return_value=album), patch.object(
            create_zip, "get_verified_claims", return_value=None
        ), patch.object(create_zip, "check_rate_limit", return_value=True), patch.object(
            create_zip.s3, "head_object", side_effect=[missing, missing]
        ), patch.object(create_zip.s3, "put_object"), patch.object(create_zip.lambda_client, "invoke"):
            response = create_zip.handler({"pathParameters": {"albumId": ALBUM_ID}}, None)
        self.assertEqual(response["statusCode"], 202)
        self.assertEqual(response["headers"]["Retry-After"], "3")
        self.assertEqual(response_body(response)["retryAfterSeconds"], 3)


if __name__ == "__main__":
    unittest.main()
