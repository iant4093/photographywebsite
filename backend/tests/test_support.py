import json
import os
import pathlib
import sys


FUNCTIONS_DIR = pathlib.Path(__file__).resolve().parents[1] / "functions"
if str(FUNCTIONS_DIR) not in sys.path:
    sys.path.insert(0, str(FUNCTIONS_DIR))

DEFAULT_ENV = {
    "AWS_ACCESS_KEY_ID": "testing",
    "AWS_SECRET_ACCESS_KEY": "testing",
    "AWS_SESSION_TOKEN": "testing",
    "AWS_EC2_METADATA_DISABLED": "true",
    "AWS_DEFAULT_REGION": "us-west-2",
    "AWS_REGION": "us-west-2",
    "ALBUMS_TABLE": "albums-test",
    "GALLERY_SETTINGS_TABLE": "gallery-settings-test",
    "RATE_LIMIT_TABLE": "rate-test",
    "COST_REPORT_CACHE_TABLE": "cost-report-test",
    "ANALYTICS_TABLE": "analytics-test",
    "ANALYTICS_TIMEZONE": "America/Los_Angeles",
    "FRONTEND_URL": "https://iantruongphotography.com",
    "DRIVE_USAGE_CACHE_TABLE": "drive-usage-test",
    "GITHUB_ANALYTICS_CACHE_TABLE": "github-analytics-test",
    "GOOGLE_DRIVE_FOLDER_ID": "drive-root-test",
    "GOOGLE_OAUTH_PARAMETER": "/ian-website/prod/google-drive-credentials",
    "RATE_LIMIT_HASH_SECRET": "unit-test-rate-hash-secret",
    "IMAGES_BUCKET": "images-test",
    "CLOUDFRONT_DOMAIN": "media.example.test",
    "COGNITO_USER_POOL_ID": "us-west-2_testpool",
    "COGNITO_CLIENT_ID": "test-client-id",
    "SHARE_CODE_INDEX": "ShareCodeIndex",
    "WORKER_FUNCTION_NAME": "zip-worker-test",
}
for key, value in DEFAULT_ENV.items():
    os.environ.setdefault(key, value)


def response_body(response):
    return json.loads(response["body"])


def claims(*, subject="user-sub", email="user@example.com", groups=None, expires=4_102_444_800):
    result = {
        "iss": "https://cognito-idp.us-west-2.amazonaws.com/us-west-2_testpool",
        "aud": "test-client-id",
        "token_use": "id",
        "exp": expires,
        "sub": subject,
        "email": email,
    }
    if groups is not None:
        result["cognito:groups"] = groups
    return result


def gateway_event(token_claims, **extra):
    event = {
        "requestContext": {
            "authorizer": {"jwt": {"claims": token_claims}},
            "http": {"sourceIp": "192.0.2.8"},
        }
    }
    event.update(extra)
    return event
