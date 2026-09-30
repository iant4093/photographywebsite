# Private media through the frontend CDN

Protected album media (private, unlisted, and shared-album photos, responsive
previews, and HLS video) can be delivered same-origin from
`https://iantruongphotography.com/private-media/albums/<albumId>/...` instead of
per-object presigned S3 URLs. CloudFront authorizes each request with
album-scoped signed cookies; S3 stays private behind origin access control.
Public albums keep their existing media CDN URLs and are unaffected.

## Current security contract

- Album handlers that already authorize a viewer also issue three CloudFront
  signed cookies (`CloudFront-Policy`, `CloudFront-Signature`,
  `CloudFront-Key-Pair-Id`). They are first-party, `Secure`, `HttpOnly`,
  `SameSite=Lax`, and scoped by `Path=/private-media/albums/<albumId>` (plus
  the album's approved legacy prefix, if it has one), so a cookie for one album
  is never sent for another. The signed policy's resource is limited to the
  same album prefix.
- The cookie lifetime equals `MEDIA_URL_TTL_SECONDS` (default 600 s, clamped
  to 60–3,600 s), the same bound presigned URLs had. The existing
  `expiresAt` metadata still drives browser refresh, which re-issues cookies.
- The frontend distribution's `private-media/*` behavior trusts only the SAM
  `PrivateMediaKeyGroup`. CloudFront validates the cookie on every request,
  outside the cache key, so a cached object is never served without a valid
  cookie. The behavior is HTTPS-only, read-only (`GET`/`HEAD`; `OPTIONS` is
  allowed but rejected by the function), uncompressed, and has **no** origin
  request policy: viewer cookies and headers never reach S3.
- Its only viewer-request function is `PrivateMediaRewriteFunction`. It
  rejects anything outside one album's object namespace (encoded separators,
  dot segments, empty segments, other methods) with `404` and strips the
  `/private-media` prefix so the origin key is `albums/<albumId>/...`. The
  frontend `www` redirect is deliberately **not** attached to this behavior.
- The origin is the media bucket's regional REST endpoint
  (`<bucket>.s3.<region>.amazonaws.com`) with origin ID
  `ian-photography-private-media-v1` and the dedicated
  `PrivateMediaOriginAccessControl` (SigV4, always sign). The bucket policy
  grants the frontend distribution `s3:GetObject` on `albums/*` only; zips,
  hero media, and public previews stay unreachable through this path.
- Responses carry `Cache-Control: private, max-age=86400` and hardening
  headers from `PrivateMediaResponseHeadersPolicy`. Shared caches never store
  them; the service worker leaves `/private-media/` to the network.
- The RSA private key lives only in the SSM SecureString
  `/ian-website/prod/private-media-signing-key`. It never belongs in source,
  command arguments, logs, output, fixtures, or release artifacts. The
  distribution helper reads identifiers only, never the key.

## SAM resources

`backend/template.yaml` owns every edge dependency. The frontend distribution
itself is outside CloudFormation, so `ops/cloudfront_frontend.py` binds them.

| Logical ID | Type | Role |
|---|---|---|
| `PrivateMediaPublicKey` | `AWS::CloudFront::PublicKey` | Public half of the signing key; its ID is the cookie `Key-Pair-Id` |
| `PrivateMediaKeyGroup` | `AWS::CloudFront::KeyGroup` | Trusted signers for `private-media/*` |
| `PrivateMediaOriginAccessControl` | `AWS::CloudFront::OriginAccessControl` | S3 SigV4 signing for the frontend distribution's media origin |
| `PrivateMediaCachePolicy` | `AWS::CloudFront::CachePolicy` | Long edge caching keyed on the path only |
| `PrivateMediaResponseHeadersPolicy` | `AWS::CloudFront::ResponseHeadersPolicy` | Private browser caching and hardening headers |
| `PrivateMediaRewriteFunction` | `AWS::CloudFront::Function` | Strict path validation and prefix rewrite |

The stack also exports `PrivateMediaRewriteFunctionArn`, which the helper
prefers when resolving the function association. `PRIVATE_MEDIA_DELIVERY`
(a literal in each album handler's environment, default `'false'`) selects
presigned URLs or signed cookies at runtime.

## Frontend distribution behavior

`cloudfront_frontend.py --include-private-media` adds the origin and behavior
above. The flag is opt-in: without it the helper behaves exactly as before and
leaves any existing `private-media/*` behavior and origin untouched. With it:

- the private-media origin is upserted by its fixed ID and refused if that ID
  is already bound to another domain;
- `private-media/*` becomes a managed behavior ordered after the API and social
  document behaviors and before `print.html`, `assets/*`, and static paths;
- the dry-run summary prints a `privateMedia` section (`enabled`,
  `originDomain`, `keyGroupIdPresent`, `missing`) with identifiers only;
- `--apply` refuses unless the key group, cache policy, response headers
  policy, origin access control, function ARN, and origin domain were all
  discovered and the origin access control's origin type is `s3`.

**Once applied, pass `--include-private-media` on every later run.** A run with
`--include-www` or `--include-api-front-door` but without this flag treats the
rewrite function as an unmanaged viewer-request association and refuses, rather
than replacing it with the `www` redirect.

## Rollout

1. **SAM first, delivery off.** Release the backend template with
   `PRIVATE_MEDIA_DELIVERY: 'false'`. Confirm the stack contains every resource
   above and that the SSM parameter exists as a `SecureString`
   (`aws ssm describe-parameters`; do not read its value). Albums keep
   presigned URLs.
2. **Dry-run the edge change.** Use the same reviewed arguments as the existing
   [front-door workflow](API_FRONT_DOOR.md#validate-and-update), plus the new
   flag. Populate the shell variables from reviewed current metadata and keep
   every feature flag that is live today:

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

   Review the account, ETag, `privateMedia.originDomain`, and an empty
   `privateMedia.missing` list. The same run also reports
   `apiFrontDoor.policies.privateOrigin: update`: the existing
   `IanTruong-API-Private-Origin-v1` origin request policy is updated in place
   to allowlist the `CloudFront-Key-Pair-Id` cookie. CloudFront strips
   `Set-Cookie` from origin responses when a behavior forwards no cookies, so
   without this change the signed cookies the API issues never reach the
   browser. The cookie is path-scoped to `/private-media/albums/<id>`, so the
   API still receives no viewer cookie, and `/api/*` stays CachingDisabled.
3. **Apply the unchanged plan** and wait for deployment:

   ```bash
   python3 ops/cloudfront_frontend.py "${private_media_edge_args[@]}" --apply
   aws cloudfront wait distribution-deployed --id EIOCCNR8XGQ1B
   ```

   A stale ETag or any changed guard requires a fresh dry-run.
4. **Verify with a locally signed cookie** (see below) while the flag is still
   `'false'`. Nothing user-facing depends on the behavior yet.
5. **Regenerate the edge contract** (see below) and commit it.
6. **Flip delivery on.** Change `PRIVATE_MEDIA_DELIVERY` to `'true'` through
   the normal backend release. Verify a private album, an unlisted album, a
   shared album, and a video album end to end in a fresh browser session:
   images, responsive previews, HLS playback, and a refresh after the TTL.

## Verification

Anonymous and malformed requests must fail:

```bash
media="https://iantruongphotography.com/private-media/albums/<albumId>/<object key below the album>"
curl -sS -o /dev/null -w '%{http_code}\n' -I "$media"                       # 403
curl -sS -o /dev/null -w '%{http_code}\n' -I "https://iantruongphotography.com/private-media/albums/<albumId>/../x"  # 404
```

Sign a short-lived cookie locally for one album. Run this in a protected
operator shell whose history is disabled, and remove the key afterwards:

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

Also confirm that the same cookie returns `403` for a different album's object,
that responses carry `Cache-Control: private, max-age=86400`, and that a second
request reports `X-Cache: Hit from cloudfront` while still requiring the cookie.
Record only status codes and header names, never cookie values.

## Regenerate the edge contract

`ops/ci/frontend_edge_contract.json` hashes the complete frontend distribution,
so the scheduled audit fails closed after this change until the contract is
updated. After the distribution reports `Deployed`:

```bash
workspace="$(mktemp -d)"
aws cloudfront get-distribution --id EIOCCNR8XGQ1B --output json > "$workspace/distribution.json"
python3 -c 'import json, sys; sys.path.insert(0, "ops/ci"); import frontend_edge_posture as p; print(p._digest(p.sanitized_distribution(json.load(open(sys.argv[1])))))' "$workspace/distribution.json"
```

Replace only `distributionSha256` with the printed value, then run
`RUNNER_TEMP="$workspace" bash ops/ci/audit_frontend_edge.sh` and require
`IN_SYNC` before committing.

## Signing-key rotation

1. In a protected operator shell, generate a new 2048-bit RSA key pair
   (`openssl genrsa -out new.pem 2048`, then
   `openssl rsa -pubout -in new.pem -out new.pub.pem`).
2. Add a second `AWS::CloudFront::PublicKey` with the new public key and a new
   `CallerReference`/`Name`, and add it to `PrivateMediaKeyGroup` **alongside**
   the current key. Deploy; both keys are now trusted.
3. In a quiet period, overwrite `/ian-website/prod/private-media-signing-key`
   with the new private key
   (`aws ssm put-parameter --type SecureString --overwrite --value file://new.pem`)
   and immediately release the change that re-points `PRIVATE_MEDIA_KEY_PAIR_ID`
   to the new public key. The environment change replaces every execution
   environment, so key and key ID move together afterwards. In the short gap
   between the two steps, a handler that loads the key fresh can sign with the
   new key under the old key ID; CloudFront rejects those cookies and the
   viewer recovers on the next metadata refresh.
4. Wait at least one cookie TTL (`MEDIA_URL_TTL_SECONDS`) plus margin so every
   cookie signed by the old key has expired, then remove the old key from the
   key group and the template and deploy again.
5. Securely delete the local key files. Record only the key IDs and dates.

The key group ID does not change, so the distribution needs no update and the
edge contract stays valid.

## Revocation bounds

Revoking album access (visibility change, share disabled, account removed)
stops new cookies immediately. Cookies already issued remain valid until they
expire, at most `MEDIA_URL_TTL_SECONDS` (600 s by default); bytes a viewer
already downloaded may stay in that viewer's private browser cache for up to a
day. This matches the presigned-URL bound. For an emergency cutoff of every
cookie, remove the compromised public key from the key group and deploy; that
invalidates all cookies signed with it at once.

## Rollback

- Change `PRIVATE_MEDIA_DELIVERY` back to `'false'` and release. The next API
  responses return presigned URLs, and the frontend accepts both forms, so no
  frontend change or distribution update is needed. Outstanding cookies simply
  expire.
- The `private-media/*` behavior and origin can stay in place; without valid
  cookies they serve only `403`/`404`. The helper never deletes them; removal
  is a separately reviewed distribution change followed by an edge-contract
  update.
- Never disable the key-group requirement, attach an origin request policy, or
  widen the bucket grant beyond `albums/*` as a rollback shortcut.
