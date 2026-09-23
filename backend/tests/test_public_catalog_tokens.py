"""Local public pagination authenticity, compatibility, rotation and work bounds."""
import base64,json,os,unittest
from urllib.parse import parse_qs, urlsplit
from unittest.mock import patch
import test_support
import public_catalog_cursor as codec
import get_public_albums,get_albums
from cursor_helpers import encode_cursor
from validation_helpers import ValidationError

KEY={'albumId':'11111111-1111-4111-8111-111111111111','visibility':'public','createdAt':'2026-01-01T00:00:00Z'}
SCOPE='public:photo'

class PublicCatalogTokenTests(unittest.TestCase):
    def setUp(self):
        self.keys=self.enterContext(patch.object(codec,'_keys',return_value=[b'test-cursor-key']))
        self.clock=self.enterContext(patch.object(codec.time,'time',return_value=1000))
        self.enterContext(patch.object(get_public_albums,'verify_front_door_request',return_value=None))
        self.fetch=self.enterContext(patch.object(get_public_albums,'_fetch_page',return_value=([],None)))
        self.enterContext(patch.object(get_public_albums,'load_gallery_settings',return_value={}))

    def request(self,**params):
        return get_public_albums.handler({'queryStringParameters':params},None)

    def test_cache_stability_authentic_round_trip_and_key_rotation(self):
        token=codec.encode_public_cursor(KEY,SCOPE)
        self.clock.return_value=1001
        self.assertEqual(codec.encode_public_cursor(KEY,SCOPE),token)
        self.assertEqual(codec.decode_public_cursor(token,SCOPE),KEY)
        self.keys.return_value=[b'new-test-key',b'test-cursor-key']
        self.assertEqual(codec.decode_public_cursor(token,SCOPE),KEY)
        self.keys.return_value=[b'new-test-key']
        with self.assertRaises(codec.RestartCatalog):codec.decode_public_cursor(token,SCOPE)

    def test_tampering_wrong_scope_and_alternate_encodings_never_query(self):
        token=codec.encode_public_cursor(KEY,SCOPE)
        encoded,signature=token.split('.')
        payload=json.loads(base64.urlsafe_b64decode(encoded+'='*(-len(encoded)%4)))
        payload['key']['createdAt']='2099-01-01T00:00:00Z'
        changed=codec._encode(codec._payload(payload))+'.'+signature
        for invalid in (token+'=',encoded+'=.'+signature,token+'.extra','bad', 'x'*4097):
            with self.subTest(cursor=invalid[:20]):
                self.assertEqual(self.request(type='photo',cursor=invalid)['statusCode'],400)
        # A forged continuation has no more authority than a first-page visit.
        changed_response = self.request(type='photo', cursor=changed)
        self.assertEqual(changed_response['statusCode'],307)
        restart = parse_qs(urlsplit(changed_response['headers']['Location']).query)['cursor'][0]
        self.assertIsNone(codec.decode_public_cursor(restart,SCOPE))
        self.assertEqual(self.request(type='video',cursor=token)['statusCode'],400)
        self.fetch.assert_not_called()

    def test_unsigned_and_authentically_expired_tokens_redirect_without_database_work(self):
        legacy=encode_cursor(KEY,SCOPE)
        signed=codec.encode_public_cursor(KEY,SCOPE)
        self.clock.return_value=108001
        for token in (legacy,signed):
            result=self.request(type='photo',limit='1',cursor=token)
            self.assertEqual(result['statusCode'],307)
            redirect=parse_qs(urlsplit(result['headers']['Location']).query)
            self.assertEqual(redirect['type'],['photo']);self.assertEqual(redirect['limit'],['1'])
            self.assertIsNone(codec.decode_public_cursor(redirect['cursor'][0],SCOPE))
            self.assertEqual(result['headers']['Cache-Control'],'no-store')
        self.fetch.assert_not_called()

    def test_migration_uses_a_shared_fresh_first_page_instead_of_cached_unsigned_pages(self):
        legacy=encode_cursor(KEY,SCOPE)
        other=encode_cursor({**KEY,'createdAt':'2099-01-01T00:00:00Z'},SCOPE)
        locations=[]
        for token in (legacy,other):
            response=self.request(type='photo',limit='1',cursor=token)
            locations.append(response['headers']['Location'])
        self.assertEqual(locations[0],locations[1])
        self.fetch.assert_not_called()
        query={k:v[0] for k,v in parse_qs(urlsplit(locations[0]).query).items()}
        self.fetch.return_value=([],KEY)
        response=self.request(**query)
        self.assertEqual(response['statusCode'],200)
        self.fetch.assert_called_once_with(album_type='photo',limit=1,start_key=None)
        next_cursor=json.loads(response['body'])['nextCursor']
        self.assertNotEqual(next_cursor,legacy)
        self.assertNotEqual(next_cursor,query['cursor'])
        self.assertEqual(codec.decode_public_cursor(next_cursor,SCOPE),KEY)

    def test_valid_signed_token_reaches_only_its_scoped_start_key(self):
        token=codec.encode_public_cursor(KEY,SCOPE)
        self.assertEqual(self.request(type='photo',limit='1',cursor=token)['statusCode'],200)
        self.fetch.assert_called_once_with(album_type='photo',limit=1,start_key=KEY)

    def test_noncanonical_queries_redirect_without_database_work(self):
        for limit in ('01','0001','+1',' 1'):
            response=self.request(type='photo',limit=limit)
            self.assertEqual(response['statusCode'],307)
            self.assertEqual(response['headers']['Location'],'/api/public/albums?type=photo&limit=1')
        for raw in ('limit=1&type=photo','type=photo&limit=%31','type=photo&limit=1&cursor='):
            response=get_public_albums.handler({'queryStringParameters':{'type':'photo','limit':'1'},'rawQueryString':raw},None)
            self.assertEqual(response['statusCode'],307)
        self.fetch.assert_not_called()
        response=get_public_albums.handler({'queryStringParameters':{'type':'photo','limit':'1'},'rawQueryString':'type=photo&limit=1'},None)
        self.assertEqual(response['statusCode'],200)

    def test_legacy_api_preserves_signed_cursor_and_checks_auth_first(self):
        token=codec.encode_public_cursor(KEY,SCOPE)
        with patch.object(get_albums,'get_verified_claims',return_value=None),patch.object(get_albums,'verify_front_door_request',return_value=None),patch.object(get_albums,'_fetch_page') as fetch:
            response=get_albums.handler({'queryStringParameters':{'type':'photo','limit':'1','cursor':token}},None)
        self.assertEqual(response['statusCode'],307)
        self.assertIn('cursor='+token,response['headers']['Location'])
        fetch.assert_not_called()

    def test_missing_key_material_fails_closed_and_keys_are_purpose_separated(self):
        # Exercise the real provider outside the patched codec via its saved function.
        with patch.dict(os.environ,{'FRONT_DOOR_CONFIG_PARAMETER':''}):
            with self.assertRaises(RuntimeError):ORIGINAL_KEYS()
        with patch.dict(os.environ,{'FRONT_DOOR_CONFIG_PARAMETER':'synthetic-parameter'}),patch.object(codec,'_secret_values',return_value=('test-current-value','test-previous-value')):
            keys=ORIGINAL_KEYS()
        self.assertEqual(len(keys),2);self.assertTrue(all(len(key)==32 for key in keys))
        self.assertNotEqual(keys[0],b'test-current-value')

ORIGINAL_KEYS=codec._keys
