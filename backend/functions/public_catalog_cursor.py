"""Authenticated, cache-stable public catalog continuations using existing key material."""
import base64
import hmac
import json
import os
import time
from cursor_helpers import decode_cursor, validate_catalog_cursor
from front_door import _secret_values
from validation_helpers import ValidationError, parse_json_body

BUCKET_SECONDS = 6 * 3600
LIFETIME_SECONDS = 24 * 3600
PURPOSE = b'ian-photography/public-catalog-cursor/v2'


class RestartCatalog(Exception):
    """Old/expired continuations restart through the cached first-page URL."""


def _keys():
    parameter = os.environ.get('FRONT_DOOR_CONFIG_PARAMETER', '').strip()
    if not parameter:
        raise RuntimeError('Public cursor signing is unavailable')
    return [hmac.digest(secret.encode('ascii'), PURPOSE, 'sha256')
            for secret in _secret_values(parameter) if secret]


def _encode(raw):
    return base64.urlsafe_b64encode(raw).rstrip(b'=').decode('ascii')


def _payload(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode('utf-8')


def encode_public_cursor(key, scope, *, restart=False):
    if not key and not restart:
        return None
    validate_catalog_cursor(key, visibility='public')
    # All readers of the same page share a token during this six-hour bucket.
    until = (int(time.time()) // BUCKET_SECONDS + 1) * BUCKET_SECONDS + LIFETIME_SECONDS
    raw = _payload({'v':2, 'scope':scope, 'key':key, 'until':until})
    return _encode(raw) + '.' + _encode(hmac.digest(_keys()[0], raw, 'sha256'))


def decode_public_cursor(cursor, scope):
    if not cursor:
        return None
    if not isinstance(cursor, str) or len(cursor) > 4096:
        raise ValidationError('Invalid cursor')
    if '.' not in cursor:
        # Never sign or query an arbitrary unsigned key. Old open tabs can
        # follow the redirect and automatically merge the fresh pagination.
        validate_catalog_cursor(decode_cursor(cursor, scope), visibility='public')
        raise RestartCatalog()
    try:
        encoded, signature = cursor.split('.')
        raw = base64.b64decode(encoded + '=' * (-len(encoded) % 4), altchars=b'-_', validate=True)
        value = parse_json_body({'body':raw.decode('utf-8')}, max_bytes=3072)
        if (_encode(raw) != encoded or _payload(value) != raw or set(value) != {'v','scope','key','until'}
                or type(value['v']) is not int or value['v'] != 2 or value['scope'] != scope
                or type(value['until']) is not int):
            raise ValueError()
        validate_catalog_cursor(value['key'], visibility='public')
        if (len(signature) != 43 or not signature.isascii()
                or _encode(base64.b64decode(signature + '=', altchars=b'-_', validate=True)) != signature):
            raise ValueError()
        if not any(hmac.compare_digest(signature, _encode(hmac.digest(key, raw, 'sha256'))) for key in _keys()):
            # A retired signing key cannot authorize continuation. Restart at
            # the same public first page as unsigned clients; never use its key.
            raise RestartCatalog()
        now = int(time.time())
        if value['until'] > now + LIFETIME_SECONDS + BUCKET_SECONDS + 60:
            raise ValueError()
        if value['until'] <= now:
            raise RestartCatalog()
        return value['key']
    except (ValueError, UnicodeError, ValidationError):
        raise ValidationError('Invalid cursor') from None
