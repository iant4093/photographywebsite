"""Anonymous compatibility must avoid DB work without weakening auth or cursors."""
import json
import os
import unittest
from unittest.mock import Mock, patch
from urllib.parse import parse_qs, urlsplit
import test_support
import get_albums
from auth_helpers import AuthError
from cursor_helpers import encode_cursor


class LegacyCatalogAdapterTests(unittest.TestCase):
    def setUp(self):
        self.enterContext(patch.object(get_albums, 'verify_front_door_request', return_value=None))
        self.auth = self.enterContext(patch.object(get_albums, 'get_verified_claims', return_value=None))
        self.fetch = self.enterContext(patch.object(get_albums, '_fetch_page', return_value=([], None)))
        self.enterContext(patch.object(get_albums, 'load_gallery_settings', return_value={}))
        self.enterContext(patch.dict(os.environ, {'FRONTEND_URL':'https://portfolio.example.test'}))
        self.connection = self.enterContext(patch.object(get_albums.http.client, 'HTTPSConnection')).return_value
        self.response = self.connection.getresponse.return_value
        self.response.status = 200
        self.response.read.return_value = b'{"items": [{"albumId":"public-summary"}], "nextCursor":"next"}'

    def request(self, **params):
        return get_albums.handler({'queryStringParameters':params}, None)

    def test_paginated_anonymous_reads_redirect_with_same_validated_cursor_and_page_size(self):
        cursor = encode_cursor({'albumId':'11111111-1111-4111-8111-111111111111'}, 'public:photo')
        result = self.request(type='photo', limit='3', cursor=cursor, visibility='private', ignored='old-client')
        self.assertEqual(result['statusCode'], 307)
        location = urlsplit(result['headers']['Location'])
        self.assertEqual(location.path, '/api/public/albums')
        self.assertEqual(parse_qs(location.query), {'type':['photo'], 'limit':['3'], 'cursor':[cursor]})
        self.fetch.assert_not_called(); self.connection.request.assert_not_called()

    def test_legacy_array_uses_cached_origin_without_auth_headers_or_database(self):
        for params in ({}, {'visibility':'public'}, {'oldClient':'yes'}):
            result = self.request(**params)
            self.assertEqual(result['statusCode'], 200)
            self.assertEqual(json.loads(result['body']), [{'albumId':'public-summary'}])
        self.fetch.assert_not_called()
        request = self.connection.request.call_args
        self.assertEqual(request.args, ('GET', '/api/public/albums?limit=20'))
        self.assertNotIn('Authorization', request.kwargs['headers'])
        self.assertEqual(self.response.read.call_args.args, (1024 * 1024 + 1,))
        self.assertEqual(self.connection.close.call_count, 3)

    def test_invalid_parameters_and_credentials_never_redirect_or_read_upstream(self):
        for params in ({'limit':'101'}, {'type':'bogus'}, {'cursor':'bad'}, {'ownerEmail':'someone@example.test'}):
            self.assertIn(self.request(**params)['statusCode'], (400,403))
        self.auth.side_effect = AuthError('Invalid token', 401)
        self.assertEqual(self.request(limit='1')['statusCode'], 401)
        self.fetch.assert_not_called(); self.connection.request.assert_not_called()

    def test_authenticated_catalog_stays_authorized_and_uncached(self):
        self.auth.return_value = {'sub':'owner', 'email':'owner@example.test'}
        result = self.request(visibility='private')
        self.assertEqual(result['statusCode'], 200)
        self.assertEqual(result['headers']['Cache-Control'], 'no-store')
        self.assertEqual(self.fetch.call_args.kwargs['owner_sub'], 'owner')
        self.connection.request.assert_not_called()
        self.auth.return_value = {'sub':'owner', 'email':'owner@example.test'}
        self.assertEqual(self.request()['headers']['Cache-Control'], 'no-store')

    def test_upstream_failures_are_bounded_and_do_not_trigger_database_fallback(self):
        for data in (b'{', b'[]', b'{"items":{}}', b'x'*(1024*1024+1), json.dumps({'items':[{}]*21}).encode()):
            self.response.read.return_value = data
            self.assertEqual(self.request()['statusCode'], 500)
        self.response.status = 307
        self.assertEqual(self.request()['statusCode'], 500)
        self.response.status = 200
        self.connection.getresponse.side_effect = TimeoutError()
        self.assertEqual(self.request()['statusCode'], 500)
        self.fetch.assert_not_called()
        self.assertEqual(self.connection.close.call_count, 7)

    def test_only_configured_https_origin_is_accepted(self):
        for origin in ('http://portfolio.test', 'https://name:password@portfolio.test', 'https://portfolio.test:80',
                       'https://portfolio.test/redirect', 'https://portfolio.test?url=other', 'https://portfolio.test#fragment'):
            with patch.dict(os.environ, {'FRONTEND_URL':origin}):
                self.assertEqual(self.request()['statusCode'], 500)
        self.connection.request.assert_not_called(); self.fetch.assert_not_called()
