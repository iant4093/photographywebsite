"""CloudFront signed cookies for protected album media on the site origin.

Protected media can be served by the frontend distribution's
``private-media/*`` behavior, which trusts only the stack's private-media key
group. A cookie triple is scoped to one album media prefix, so an authorized
viewer of one album never receives access to another. The policy expiry equals
the presigned URL lifetime, which keeps revocation bounds and the frontend's
``expiresAt``-driven refresh unchanged.

This module never imports ``media_access`` at import time: ``media_access``
is bundled into many functions that do not sign cookies, and the build
allowlist copies every transitive import into each artifact.
"""

import base64
import json
import logging
import os
import time
import urllib.parse
from typing import NamedTuple

from secret_helpers import resolve_secret


COOKIE_POLICY = "CloudFront-Policy"
COOKIE_SIGNATURE = "CloudFront-Signature"
COOKIE_KEY_PAIR_ID = "CloudFront-Key-Pair-Id"
PROTECTED_ALBUM_VISIBILITIES = frozenset({"private", "unlisted"})
_SAFE_B64 = str.maketrans({"+": "-", "=": "_", "/": "~"})

logger = logging.getLogger("photography_api.media_signing")
# (PEM text, loaded key). The PEM is cached by secret_helpers; parsing it on
# every request would cost more than the signature itself.
_loaded_key = None


class PrivateMediaDelivery(NamedTuple):
    """Per-response delivery decision: CDN base URL plus its Set-Cookie values.

    ``base_url`` is None whenever protected media must keep presigned URLs.
    """

    base_url: str | None
    cookies: tuple


DISABLED = PrivateMediaDelivery(None, ())


def private_media_enabled():
    return os.environ.get("PRIVATE_MEDIA_DELIVERY", "false").strip().lower() == "true"


def private_media_base_url():
    base = os.environ.get("PRIVATE_MEDIA_BASE_URL", "").strip().rstrip("/")
    parsed = urllib.parse.urlsplit(base)
    if parsed.scheme != "https" or not parsed.netloc or parsed.query or parsed.fragment or not parsed.path:
        raise RuntimeError("Private media CDN is not configured")
    return base


def private_media_url(key):
    from media_access import private_cdn_url

    return private_cdn_url(key, private_media_base_url())


def cloudfront_safe_b64(data):
    """CloudFront's URL-safe base64 variant (``+``/``=``/``/`` -> ``-``/``_``/``~``)."""
    return base64.b64encode(data).decode("ascii").translate(_SAFE_B64)


def build_policy(resource, expires_epoch):
    """Return the compact custom policy bytes that are signed and sent verbatim."""
    policy = {
        "Statement": [
            {
                "Resource": resource,
                "Condition": {"DateLessThan": {"AWS:EpochTime": int(expires_epoch)}},
            }
        ]
    }
    return json.dumps(policy, separators=(",", ":")).encode("utf-8")


def _private_key():
    global _loaded_key
    pem = resolve_secret(
        direct_env="PRIVATE_MEDIA_SIGNING_KEY",
        parameter_env="PRIVATE_MEDIA_SIGNING_KEY_PARAMETER",
    )
    if _loaded_key is None or _loaded_key[0] != pem:
        from cryptography.hazmat.primitives.serialization import load_pem_private_key

        _loaded_key = (pem, load_pem_private_key(pem.encode("utf-8"), password=None))
    return _loaded_key[1]


def sign_policy(policy):
    """Sign with RSA PKCS#1 v1.5 over SHA-1, the only scheme CloudFront accepts."""
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import padding

    signature = _private_key().sign(policy, padding.PKCS1v15(), hashes.SHA1())
    return cloudfront_safe_b64(signature)


def _key_pair_id():
    value = os.environ.get("PRIVATE_MEDIA_KEY_PAIR_ID", "").strip()
    if not value or not value.isalnum():
        raise RuntimeError("Private media key pair is not configured")
    return value


def signed_cookies_for_prefixes(prefixes, *, ttl_seconds, now=None):
    """Return three Set-Cookie values per album prefix (e.g. ``albums/<id>/``)."""
    base = private_media_base_url()
    base_path = urllib.parse.urlsplit(base).path.rstrip("/")
    key_pair_id = _key_pair_id()
    ttl = int(ttl_seconds)
    expires = int(time.time() if now is None else now) + ttl
    cookies = []
    for prefix in prefixes:
        encoded = urllib.parse.quote(str(prefix), safe="/~")
        if not encoded.startswith("albums/") or not encoded.endswith("/") or ".." in encoded.split("/"):
            raise ValueError("Private media prefix is outside the album namespace")
        policy = build_policy(f"{base}/{encoded}*", expires)
        # Scoping the path to the album keeps each album's cookies separate
        # and avoids sending them with unrelated site requests.
        attributes = f"Path={base_path}/{encoded.rstrip('/')}; Max-Age={ttl}; Secure; HttpOnly; SameSite=Lax"
        cookies.extend((
            f"{COOKIE_POLICY}={cloudfront_safe_b64(policy)}; {attributes}",
            f"{COOKIE_SIGNATURE}={sign_policy(policy)}; {attributes}",
            f"{COOKIE_KEY_PAIR_ID}={key_pair_id}; {attributes}",
        ))
    return cookies


def signed_cookies_for_album(album, *, ttl_seconds=None, now=None):
    from media_access import _ttl_seconds, album_media_prefixes

    return signed_cookies_for_prefixes(
        album_media_prefixes(album),
        ttl_seconds=_ttl_seconds() if ttl_seconds is None else ttl_seconds,
        now=now,
    )


def private_media_delivery(album, *, operation):
    """Decide how one authorized response delivers protected album media.

    Cookies are issued only after the caller has authorized the album. Any
    signing failure (missing key, SSM outage, bad configuration) degrades this
    response to presigned URLs instead of failing the request.
    """
    if not private_media_enabled() or not isinstance(album, dict):
        return DISABLED
    if album.get("visibility") not in PROTECTED_ALBUM_VISIBILITIES:
        return DISABLED
    try:
        cookies = signed_cookies_for_album(album)
        return PrivateMediaDelivery(private_media_base_url(), tuple(cookies))
    except Exception as error:
        # The exception text is never logged: key-loading errors can quote
        # configuration, and nothing here is needed to diagnose the fallback.
        logger.warning(
            "private_media_signing_failed operation=%s error_type=%s",
            operation, type(error).__name__,
        )
        return DISABLED
