# Private media through the frontend CDN

Protected album media (photos, responsive previews and HLS video in private and
unlisted albums, including shared albums) is served from the site's own origin
at `https://iantruongphotography.com/private-media/albums/<albumId>/...`
instead of per-object presigned S3 URLs. Signed-cookie delivery was enabled on
2026-09-30 (commit `45e33fc`). CloudFront checks album-scoped signed cookies on
each request, and S3 stays private behind origin access control. Public albums
keep their media CDN URLs.

## Access controls

- Album handlers that have authorized a viewer also set three CloudFront
  signed cookies (`CloudFront-Policy`, `CloudFront-Signature`,
  `CloudFront-Key-Pair-Id`). They are first-party, `Secure`, `HttpOnly` and
  `SameSite=Lax`, and scoped with `Path=/private-media/albums/<albumId>` (plus
  the album's approved legacy prefix, if it has one). A cookie for one album is
  not sent for another. The signed policy's resource is limited to the same
  album prefix.
- The cookie lifetime is `MEDIA_URL_TTL_SECONDS` (600 s by default, clamped to
  60 to 3,600 s), the same limit presigned URLs use. The existing `expiresAt`
  metadata drives the browser refresh, which sets fresh cookies.
- If signing fails (missing key, SSM error, bad configuration), the handler
  logs `private_media_signing_failed` and returns presigned URLs for that
  response.
- The frontend distribution's `private-media/*` behavior trusts only the SAM
  `PrivateMediaKeyGroup`. CloudFront checks the cookie on every request, and
  the cookie is not part of the cache key, so a cached object is never served
  without a valid cookie. The behavior is HTTPS-only and read-only (`GET` and
  `HEAD`; `OPTIONS` is allowed by CloudFront but the function rejects it), has
  compression off, and has no origin request policy. Viewer cookies and headers
  are not forwarded to S3.
- Its only viewer-request function is `PrivateMediaRewriteFunction`. It returns
  `404` for anything outside one album's object namespace (encoded separators,
  dot segments, empty segments, other methods) and strips the `/private-media`
  prefix so the origin key is `albums/<albumId>/...`. The frontend `www`
  redirect function is not attached to this behavior.
- The origin is the media bucket's regional REST endpoint
  (`<bucket>.s3.<region>.amazonaws.com`) with origin ID
  `ian-photography-private-media-v1` and its own
  `PrivateMediaOriginAccessControl` (SigV4, always sign). The bucket policy
  statement `AllowFrontendDistributionPrivateMediaReads` gives the frontend
  distribution `s3:GetObject` on `albums/*` only. ZIPs, hero media and public
  previews can't be reached through this path.
- Responses carry `Cache-Control: private, max-age=600, must-revalidate` and
  hardening headers from `PrivateMediaResponseHeadersPolicy`, so downstream
  shared caches must not store them. The service worker leaves
  `/private-media/` requests to the network.
- The RSA private key is stored only in the SSM SecureString
  `/ian-website/prod/private-media-signing-key`. Keep it out of source, command
  arguments, logs, output, fixtures and release artifacts. The distribution
  helper reads only identifiers, never the key.

## SAM resources

`backend/template.yaml` defines every edge dependency. The frontend
distribution itself isn't in CloudFormation, so `ops/cloudfront_frontend.py`
attaches them.

| Logical ID | Type | Role |
|---|---|---|
| `PrivateMediaPublicKey` | `AWS::CloudFront::PublicKey` | Public half of the signing key; its ID is the cookie `Key-Pair-Id` |
| `PrivateMediaKeyGroup` | `AWS::CloudFront::KeyGroup` | Trusted signers for `private-media/*` |
| `PrivateMediaOriginAccessControl` | `AWS::CloudFront::OriginAccessControl` | S3 SigV4 signing for the frontend distribution's media origin |
| `PrivateMediaCachePolicy` | `AWS::CloudFront::CachePolicy` | Edge caching (1-day default TTL) keyed on the path only |
| `PrivateMediaResponseHeadersPolicy` | `AWS::CloudFront::ResponseHeadersPolicy` | Private browser caching and hardening headers |
| `PrivateMediaRewriteFunction` | `AWS::CloudFront::Function` | Path validation and prefix rewrite |

Stack outputs expose each ID (`PrivateMediaPublicKeyId`,
`PrivateMediaKeyGroupId`, `PrivateMediaOriginAccessControlId`,
`PrivateMediaCachePolicyId`, `PrivateMediaResponseHeadersPolicyId`,
`PrivateMediaRewriteFunctionArn`). The helper uses the function ARN output to
build the association.

`PRIVATE_MEDIA_DELIVERY` is a literal in the environment of each of the five
cookie-issuing handlers (`GetAlbumFunction`, `GetSharedAlbumFunction`,
`GetAdminAlbumMediaFunction`, `AddImagesFunction`, `UpdateImageFunction`). It
selects signed cookies (`'true'`, the current setting) or presigned URLs (any
other value, or unset) at runtime. Those handlers also get
`PRIVATE_MEDIA_BASE_URL`, `PRIVATE_MEDIA_KEY_PAIR_ID` and
`PRIVATE_MEDIA_SIGNING_KEY_PARAMETER`. `PrivateMediaEdgeTests` in
`ops/tests/test_infrastructure.py` asserts this wiring, the single key in the
key group and the `'true'` literal, so any change to them needs a matching test
change.

## Frontend distribution behavior

`cloudfront_frontend.py --include-private-media` adds the origin and behavior
described above. The flag is opt-in. Without it, the helper leaves any existing
`private-media/*` behavior and origin unchanged. With it:

- the private-media origin is created or updated by its fixed ID, and the
  helper refuses if that ID already points at another domain;
- `private-media/*` becomes a managed behavior, ordered after the API and
  social document behaviors and before `print.html`, `assets/*` and static
  paths;
- the dry-run summary prints a `privateMedia` section (`enabled`,
  `originDomain`, `keyGroupIdPresent`, `missing`) with identifiers only;
- `--apply` refuses unless it found the key group, cache policy, response
  headers policy, origin access control, function ARN and origin domain, and
  the origin access control's origin type is `s3`.

Once the behavior exists, pass `--include-private-media` on every later run.
A run with `--include-www` or `--include-api-front-door` but without this flag
sees the rewrite function as an unmanaged viewer-request association and
refuses, instead of replacing it with the `www` redirect.

## Rollout

The rollout was completed on 2026-09-30 (commits `2200385`, `82e929d`,
`45e33fc`). The steps below apply when the behavior has to be bound again, for
example on a replacement distribution. For routine edge runs, keep passing
`--include-private-media`.

On a replacement distribution, first update the literal distribution ID
`EIOCCNR8XGQ1B` in `backend/template.yaml` (the
`AllowFrontendDistributionPrivateMediaReads` bucket policy statement and the
cache-invalidation worker's `cloudfront:CreateInvalidation` resource) and the
`DEFAULT_FRONTEND_DISTRIBUTION_ID` constants in
`backend/functions/cache_invalidation.py`, `ops/backfill_explore_index.py` and
`ops/backfill_album_qr_codes.py`, and the tests that assert them.

1. Release the backend template with `PRIVATE_MEDIA_DELIVERY: 'false'`. Check
   that the stack has every resource above and that the SSM parameter exists as
   a `SecureString` (`aws ssm describe-parameters`; don't read its value).
   Albums keep using presigned URLs.
2. Dry-run the edge change with the same arguments as the
   [front-door workflow](API_FRONT_DOOR.md#validate-and-update), plus the new
   flag. Fill in the shell variables from current, reviewed metadata, and keep
   every feature flag that is live:

   ```bash
   private_media_edge_args=(
     --stack-name ian-website
     --region us-west-2
     --include-www
     --include-fotomoto-print
     --include-api-front-door
     --api-certificate-arn "$api_certificate_arn"
     --origin-parameter-name "$origin_parameter_name"
     --web-acl-arn "$web_acl_arn"
     --expected-etag "$distribution_etag"
     --expected-account-id "$account_id"
     --expected-frontend-origin-id "$frontend_origin_id"
     --expected-frontend-origin-domain "$frontend_origin_domain"
     --expected-api-origin-domain "$api_origin_domain"
     --expected-api-certificate-arn "$api_certificate_arn"
     --expected-origin-parameter-name "$origin_parameter_name"
     --expected-web-acl-arn "$web_acl_arn"
     --confirm-front-door ADD-SINGLE-API-FRONT-DOOR
     --include-private-media
   )

   python3 ops/cloudfront_frontend.py "${private_media_edge_args[@]}"
   ```

   Check the account, the ETag and `privateMedia.originDomain`, and confirm
   that `privateMedia.missing` is empty. If the existing
   `IanTruong-API-Private-Origin-v1` origin request policy doesn't yet
   allowlist the `ian-photography-set-cookie-passthrough` cookie, the same run
   reports `apiFrontDoor.policies.privateOrigin: update`.

   CloudFront strips `Set-Cookie` from origin responses when a behavior
   forwards no cookies, so without that allowlisted cookie the signed cookies
   set by the API would not reach the browser. The site never sets a cookie
   with that name (the `CloudFront-*` names are reserved for signature checks),
   so the API still receives no viewer cookie, and `/api/*` stays
   CachingDisabled.
3. Apply the same plan and wait for the deploy:

   ```bash
   python3 ops/cloudfront_frontend.py "${private_media_edge_args[@]}" --apply
   aws cloudfront wait distribution-deployed --id EIOCCNR8XGQ1B
   ```

   If the ETag is stale or any guard changed, run a fresh dry run.
4. Verify with a locally signed cookie ([below](#verification)) while the flag
   is still `'false'`. Nothing user-facing depends on the behavior yet.
5. [Regenerate the edge contract](#regenerate-the-edge-contract) and commit it.
6. Change `PRIVATE_MEDIA_DELIVERY` to `'true'` through the normal backend
   release. In a fresh browser session, check a private album, an unlisted
   album, a shared album and a video album end to end: images, responsive
   previews, HLS playback, and a refresh after the TTL expires.

## Verification

Anonymous requests, including path traversal attempts, return `403` (recorded
in commit `82e929d`):

```bash
media="https://iantruongphotography.com/private-media/albums/<albumId>/<object key below the album>"
curl -sS -o /dev/null -w '%{http_code}\n' -I "$media"                       # 403
curl -sS -o /dev/null -w '%{http_code}\n' -I "https://iantruongphotography.com/private-media/albums/<albumId>/../x"  # 403
```

Then sign a short-lived cookie locally for one album. Do this in a protected
shell with history turned off, and delete the key file afterward:

```bash
umask 077
key_file="$(mktemp)"
aws ssm get-parameter --name /ian-website/prod/private-media-signing-key \
  --with-decryption --query Parameter.Value --output text > "$key_file"
key_pair_id="$(aws cloudformation describe-stacks --stack-name ian-website \
  --query "Stacks[0].Outputs[?OutputKey=='PrivateMediaPublicKeyId'].OutputValue" --output text)"
expires=$(( $(date +%s) + 300 ))
policy="{\"Statement\":[{\"Resource\":\"https://iantruongphotography.com/private-media/albums/<albumId>/*\",\"Condition\":{\"DateLessThan\":{\"AWS:EpochTime\":$expires}}}]}"
cf_b64() { openssl base64 -A | tr '+=/' '-_~'; }
cookie="CloudFront-Policy=$(printf %s "$policy" | cf_b64); CloudFront-Signature=$(printf %s "$policy" | openssl dgst -sha1 -sign "$key_file" | cf_b64); CloudFront-Key-Pair-Id=$key_pair_id"
rm -P "$key_file" 2>/dev/null || rm -f "$key_file"

curl -sS -o /dev/null -w '%{http_code}\n' -I -H "Cookie: $cookie" "$media"   # 200
```

Also check that the same cookie gets `403` on another album's object, that
responses carry `Cache-Control: private, max-age=600, must-revalidate`, and
that a second request shows `X-Cache: Hit from cloudfront` and still requires
the cookie. Record only status codes and header names, never cookie values.

## Regenerate the edge contract

`ops/ci/frontend_edge_contract.json` holds a SHA-256 of the frontend
distribution configuration (custom origin header values redacted), so the
scheduled audit fails after a change like this until the contract is updated.
Once the distribution reports `Deployed`:

```bash
workspace="$(mktemp -d)"
aws cloudfront get-distribution --id EIOCCNR8XGQ1B --output json > "$workspace/distribution.json"
python3 -c 'import json, sys; sys.path.insert(0, "ops/ci"); import frontend_edge_posture as p; print(p._digest(p.sanitized_distribution(json.load(open(sys.argv[1])))))' "$workspace/distribution.json"
```

Replace only `distributionSha256` with the printed value. Then run
`RUNNER_TEMP="$workspace" bash ops/ci/audit_frontend_edge.sh` and don't commit
until it reports `IN_SYNC`.

## Rotating the signing key

1. In a protected shell, generate a new 2048-bit RSA key pair
   (`openssl genrsa -out new.pem 2048`, then
   `openssl rsa -pubout -in new.pem -out new.pub.pem`).
2. Add a second `AWS::CloudFront::PublicKey` with the new public key and a new
   `CallerReference` and `Name`, and add it to `PrivateMediaKeyGroup` next to
   the current key. Update `PrivateMediaEdgeTests` to match. Deploy. Both keys
   are now trusted.
3. At a quiet time, overwrite the private key:

   ```bash
   aws ssm put-parameter --name /ian-website/prod/private-media-signing-key \
     --type SecureString --overwrite --value file://new.pem
   ```

   Then release the change that points `PRIVATE_MEDIA_KEY_PAIR_ID` at the new
   public key. Changing the environment replaces every execution environment,
   so after that release the key and key ID change together. Between the two
   steps, a handler that loads the key fresh can sign with the new key under
   the old key ID. CloudFront rejects those cookies, and the viewer recovers on
   the next metadata refresh.
4. Wait at least one cookie TTL (`MEDIA_URL_TTL_SECONDS`) plus a margin so
   every cookie signed with the old key has expired. Then remove the old key
   from the key group and the template, and deploy again.
5. Securely delete the local key files. Record only the key IDs and dates.

The key group ID doesn't change, so the distribution needs no update and the
edge contract stays valid.

## Revocation timing

Revoking album access (visibility change, share turned off, account removed)
stops new cookies immediately. Cookies already issued keep working until they
expire, at most `MEDIA_URL_TTL_SECONDS` (600 s by default). Bytes a viewer
already downloaded can be reused from their private browser cache for up to
600 s (`max-age=600, must-revalidate`) before revalidating. Presigned URLs had
the same window. To invalidate every cookie in an emergency, remove the
compromised public key from the key group and deploy.

## Rollback

- Change `PRIVATE_MEDIA_DELIVERY` back to `'false'` on the five handlers,
  update the matching assertion in `ops/tests/test_infrastructure.py`, and
  release. The next API responses return presigned URLs. The frontend accepts
  both, so no frontend change or distribution update is needed. Issued cookies
  expire on their own.
- The `private-media/*` behavior and origin can stay. Without valid cookies
  they return only `403` or `404`. The helper never deletes them. Removing them
  is a separate distribution change, followed by an edge-contract update.
- Never remove the key-group requirement, attach an origin request policy, or
  widen the bucket grant beyond `albums/*` as a rollback shortcut.
