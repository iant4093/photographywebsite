import io
import json
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from botocore.exceptions import ClientError

from test_support import response_body

import hero_cover


JPEG_PREFIX = b"\xff\xd8\xff" + (b"x" * 29)
VALID_ETAG = "0123456789abcdef0123456789abcdef"


def event(operation, body):
    return {
        "pathParameters": {"operation": operation},
        "body": json.dumps(body),
        "requestContext": {
            "requestId": "request-hero",
            "authorizer": {"jwt": {"claims": {"cognito:groups": ["Admins"]}}},
        },
    }


class HeroUploadValidationTests(unittest.TestCase):
    def test_upload_intent_allows_browser_formats_and_rejects_mismatch_or_bad_size(self):
        formats = (
            ("cover.jpg", "image/jpeg"),
            ("cover.jpeg", "image/jpeg"),
            ("cover.png", "image/png"),
            ("cover.webp", "image/webp"),
            ("cover.avif", "image/avif"),
        )
        for filename, content_type in formats:
            with self.subTest(content_type=content_type):
                self.assertEqual(
                    hero_cover._validate_upload_intent({
                        "filename": filename,
                        "contentType": content_type,
                        "size": 4096,
                    }),
                    (content_type, 4096),
                )

        for mutation in (
            {"filename": "cover.svg", "contentType": "image/svg+xml", "size": 4096},
            {"filename": "cover.png", "contentType": "image/jpeg", "size": 4096},
            {"filename": "cover.jpg", "contentType": "image/jpeg", "size": 100},
            {"filename": "cover.jpg", "contentType": "image/jpeg", "size": 51 * 1024 * 1024},
            {"filename": "cover.jpg", "contentType": "image/jpeg", "size": "not-a-number"},
        ):
            with self.subTest(mutation=mutation), self.assertRaises(Exception):
                hero_cover._validate_upload_intent(mutation)

    def test_magic_byte_checks_match_the_declared_browser_format(self):
        self.assertTrue(hero_cover._matches_content_type("image/jpeg", JPEG_PREFIX))
        self.assertTrue(hero_cover._matches_content_type("image/png", b"\x89PNG\r\n\x1a\n" + b"x" * 24))
        self.assertTrue(hero_cover._matches_content_type("image/webp", b"RIFF1234WEBP" + b"x" * 20))
        self.assertTrue(hero_cover._matches_content_type("image/avif", b"1234ftypavif" + b"x" * 20))
        self.assertFalse(hero_cover._matches_content_type("image/jpeg", b"<html>" + b"x" * 26))
        self.assertFalse(hero_cover._matches_content_type("text/html", JPEG_PREFIX))

    def test_upload_authorization_uses_only_the_fixed_pending_key_and_signed_headers(self):
        request = event("upload-url", {
            "filename": "../../camera-original.jpg",
            "contentType": "image/jpeg",
            "size": 4096,
        })
        with patch.object(hero_cover, "verify_front_door_request", return_value=None), patch.object(
            hero_cover, "require_admin", return_value=None
        ), patch.object(
            hero_cover.s3, "generate_presigned_url", return_value="https://upload.example"
        ) as generate, patch.object(hero_cover, "emit_audit_event") as audit:
            response = hero_cover.handler(request, SimpleNamespace(aws_request_id="lambda-hero"))

        self.assertEqual(response["statusCode"], 200)
        body = response_body(response)
        self.assertNotIn("key", body)
        self.assertEqual(body["requiredHeaders"], {
            "Content-Type": "image/jpeg",
            "x-amz-tagging": "visibility=pending",
        })
        params = generate.call_args.kwargs["Params"]
        self.assertEqual(params["Key"], hero_cover.PENDING_KEY)
        self.assertEqual(params["ContentLength"], 4096)
        self.assertNotIn("camera-original", json.dumps(params))
        self.assertEqual(audit.call_args.kwargs["event_name"], "admin.hero_upload_authorized")
        self.assertEqual(audit.call_args.kwargs["outcome"], "success")

    def test_front_door_and_admin_denials_happen_before_s3(self):
        denied = {"statusCode": 403, "body": "denied"}
        with patch.object(hero_cover, "verify_front_door_request", return_value=denied), patch.object(
            hero_cover, "require_admin"
        ) as require_admin, patch.object(hero_cover.s3, "generate_presigned_url") as generate:
            self.assertIs(hero_cover.handler({}, None), denied)
        require_admin.assert_not_called()
        generate.assert_not_called()

        with patch.object(hero_cover, "verify_front_door_request", return_value=None), patch.object(
            hero_cover, "require_admin", return_value=denied
        ), patch.object(hero_cover.s3, "generate_presigned_url") as generate:
            self.assertIs(hero_cover.handler({}, None), denied)
        generate.assert_not_called()


class HeroActivationTests(unittest.TestCase):
    def _arrange_valid_pending(self):
        hero_cover.s3.head_object.return_value = {
            "ETag": f'"{VALID_ETAG}"',
            "ContentType": "image/jpeg",
            "ContentLength": 4096,
        }
        hero_cover.s3.get_object_tagging.return_value = {
            "TagSet": [{"Key": "visibility", "Value": "pending"}],
        }
        hero_cover.s3.get_object.return_value = {"Body": io.BytesIO(JPEG_PREFIX)}

    def setUp(self):
        self.s3_patcher = patch.object(hero_cover, "s3", Mock())
        self.cloudfront_patcher = patch.object(hero_cover, "cloudfront", Mock())
        self.s3_patcher.start()
        self.cloudfront_patcher.start()
        self.request = event("complete", {"etag": f'"{VALID_ETAG}"'})

    def tearDown(self):
        self.cloudfront_patcher.stop()
        self.s3_patcher.stop()

    def test_completion_validates_then_copies_original_bytes_and_invalidates_only_the_hero(self):
        self._arrange_valid_pending()
        with patch.object(hero_cover, "verify_front_door_request", return_value=None), patch.object(
            hero_cover, "require_admin", return_value=None
        ), patch.dict(
            "os.environ",
            {
                "IMAGES_BUCKET": "images-test",
                "IMAGES_DISTRIBUTION_ID": "DISTRIBUTION",
                "CLOUDFRONT_DOMAIN": "media.example.test",
            },
            clear=False,
        ), patch.object(hero_cover, "emit_audit_event") as audit:
            response = hero_cover.handler(self.request, None)

        self.assertEqual(response["statusCode"], 200)
        self.assertEqual(
            response_body(response)["heroUrl"],
            f"https://media.example.test/{hero_cover.HERO_KEY}",
        )
        hero_cover.s3.copy_object.assert_called_once_with(
            Bucket="images-test",
            Key=hero_cover.HERO_KEY,
            CopySource={"Bucket": "images-test", "Key": hero_cover.PENDING_KEY},
            ContentType="image/jpeg",
            CacheControl=hero_cover.HERO_CACHE_CONTROL,
            MetadataDirective="REPLACE",
            Tagging="visibility=public",
            TaggingDirective="REPLACE",
        )
        hero_cover.s3.delete_object.assert_called_once_with(
            Bucket="images-test", Key=hero_cover.PENDING_KEY
        )
        invalidation = hero_cover.cloudfront.create_invalidation.call_args.kwargs
        self.assertEqual(invalidation["DistributionId"], "DISTRIBUTION")
        self.assertEqual(
            invalidation["InvalidationBatch"]["Paths"]["Items"],
            [f"/{hero_cover.HERO_KEY}"],
        )
        self.assertEqual(audit.call_args.kwargs["event_name"], "admin.hero_cover_updated")
        self.assertEqual(audit.call_args.kwargs["outcome"], "success")

    def test_bad_receipt_or_content_never_replaces_the_live_hero(self):
        self._arrange_valid_pending()
        requests = (
            event("complete", {"etag": "bad"}),
            event("complete", {"etag": "f" * 32}),
        )
        for index, request in enumerate(requests):
            with self.subTest(index=index), patch.object(
                hero_cover, "verify_front_door_request", return_value=None
            ), patch.object(hero_cover, "require_admin", return_value=None):
                response = hero_cover.handler(request, None)
            self.assertIn(response["statusCode"], {400, 409})
        hero_cover.s3.copy_object.assert_not_called()
        hero_cover.cloudfront.create_invalidation.assert_not_called()

        self._arrange_valid_pending()
        hero_cover.s3.get_object.return_value = {"Body": io.BytesIO(b"<html>" + b"x" * 26)}
        with patch.object(hero_cover, "verify_front_door_request", return_value=None), patch.object(
            hero_cover, "require_admin", return_value=None
        ):
            response = hero_cover.handler(self.request, None)
        self.assertEqual(response["statusCode"], 400)
        hero_cover.s3.copy_object.assert_not_called()

    def test_cdn_failure_keeps_the_verified_pending_upload_available_for_retry(self):
        self._arrange_valid_pending()
        hero_cover.cloudfront.create_invalidation.side_effect = RuntimeError("temporary failure")
        with patch.object(hero_cover, "verify_front_door_request", return_value=None), patch.object(
            hero_cover, "require_admin", return_value=None
        ), patch.dict(
            "os.environ",
            {
                "IMAGES_BUCKET": "images-test",
                "IMAGES_DISTRIBUTION_ID": "DISTRIBUTION",
                "CLOUDFRONT_DOMAIN": "media.example.test",
            },
            clear=False,
        ), self.assertLogs("photography_api", level="ERROR"):
            response = hero_cover.handler(self.request, None)

        self.assertEqual(response["statusCode"], 500)
        hero_cover.s3.copy_object.assert_called_once()
        hero_cover.s3.delete_object.assert_not_called()

    def test_missing_pending_upload_is_a_retryable_conflict_and_provider_errors_are_redacted(self):
        missing = ClientError({"Error": {"Code": "NoSuchKey", "Message": "private detail"}}, "HeadObject")
        hero_cover.s3.head_object.side_effect = missing
        with patch.object(hero_cover, "verify_front_door_request", return_value=None), patch.object(
            hero_cover, "require_admin", return_value=None
        ):
            response = hero_cover.handler(self.request, None)
        self.assertEqual(response["statusCode"], 409)
        self.assertNotIn("private detail", response["body"])

        hero_cover.s3.head_object.side_effect = RuntimeError("provider secret detail")
        with patch.object(hero_cover, "verify_front_door_request", return_value=None), patch.object(
            hero_cover, "require_admin", return_value=None
        ), self.assertLogs("photography_api", level="ERROR") as captured:
            response = hero_cover.handler(self.request, SimpleNamespace(aws_request_id="request-safe"))
        self.assertEqual(response["statusCode"], 500)
        self.assertNotIn("provider secret detail", response["body"] + "\n".join(captured.output))


if __name__ == "__main__":
    unittest.main()
