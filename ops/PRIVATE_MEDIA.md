# Private media through the frontend CDN

Protected album media (photos, responsive previews and HLS video in private,
unlisted and shared albums) is served from the site's own origin at
`https://iantruongphotography.com/private-media/albums/<albumId>/...`. It used
to be per-object presigned S3 URLs. Delivery has been on since 2026-09-30.
CloudFront checks album-scoped signed cookies on each request, and S3 stays
private behind origin access control. Public albums keep their existing media
CDN URLs and aren't affected.

## How it's locked down

- Album handlers that already authorize a viewer also set three CloudFront
  signed cookies (`CloudFront-Policy`, `CloudFront-Signature`,
  `CloudFront-Key-Pair-Id`). They're first-party, `Secure`, `HttpOnly` and
  `SameSite=Lax`, and they're scoped with
  `Path=/private-media/albums/<albumId>` (plus the album's approved legacy
  prefix, if it has one). A cookie for one album is never sent for another. The
  signed policy's resource is limited to the same album prefix.
- The cookie lifetime is `MEDIA_URL_TTL_SECONDS` (600 s by default, clamped to
  60–3,600 s), the same limit presigned URLs had. The existing `expiresAt`
  metadata still drives the browser refresh, which sets fresh cookies.
- The frontend distribution's `private-media/*` behavior only trusts the SAM
  `PrivateMediaKeyGroup`. CloudFront checks the cookie on every request, and the
  cookie isn't part of the cache key, so a cached object is never served
  without a valid cookie. The behavior is HTTPS-only and read-only
  (`GET`/`HEAD`; `OPTIONS` is allowed through but the function rejects it),
  isn't compressed, and has **no** origin request policy. Viewer cookies and
  headers never reach S3.
- Its only viewer-request function is `PrivateMediaRewriteFunction`. It returns
  `404` for anything outside one album's object namespace (encoded separators,
  dot segments, empty segments, other methods) and strips the `/private-media`
  prefix so the origin key is `albums/<albumId>/...`. I left the frontend `www`
  redirect off this behavior on purpose.
- The origin is the media bucket's regional REST endpoint
  (`<bucket>.s3.<region>.amazonaws.com`) with origin ID
  `ian-photography-private-media-v1` and its own
  `PrivateMediaOriginAccessControl` (SigV4, always sign). The bucket policy
  gives the frontend distribution `s3:GetObject` on `albums/*` only. Zips, hero
  media and public previews can't be reached through this path.
- Responses carry `Cache-Control: private, max-age=600, must-revalidate` and
  hardening headers from `PrivateMediaResponseHeadersPolicy`. Shared caches
  never store them, and the service worker leaves `/private-media/` to the
  network.
- The RSA private key only lives in the SSM SecureString
  `/ian-website/prod/private-media-signing-key`. Keep it out of source, command
  arguments, logs, output, fixtures and release artifacts. The distribution
  helper only reads identifiers, never the key.

## SAM resources

`backend/template.yaml` owns every edge dependency. The frontend distribution
itself isn't in CloudFormation, so `ops/cloudfront_frontend.py` wires them up.

| Logical ID | Type | Role |
|---|---|---|
| `PrivateMediaPublicKey` | `AWS::CloudFront::PublicKey` | Public half of the signing key; its ID is the cookie `Key-Pair-Id` |
| `PrivateMediaKeyGroup` | `AWS::CloudFront::KeyGroup` | Trusted signers for `private-media/*` |
| `PrivateMediaOriginAccessControl` | `AWS::CloudFront::OriginAccessControl` | S3 SigV4 signing for the frontend distribution's media origin |
| `PrivateMediaCachePolicy` | `AWS::CloudFront::CachePolicy` | Long edge caching keyed on the path only |
| `PrivateMediaResponseHeadersPolicy` | `AWS::CloudFront::ResponseHeadersPolicy` | Private browser caching and hardening headers |
| `PrivateMediaRewriteFunction` | `AWS::CloudFront::Function` | Strict path validation and prefix rewrite |

Stack outputs expose each ID (`PrivateMediaPublicKeyId`,
`PrivateMediaKeyGroupId`, `PrivateMediaOriginAccessControlId`,
`PrivateMediaCachePolicyId`, `PrivateMediaResponseHeadersPolicyId`,
`PrivateMediaRewriteFunctionArn`). The helper uses the function ARN output when
it resolves the association.

`PRIVATE_MEDIA_DELIVERY` is a literal in each album handler's environment. It
picks signed cookies (`'true'`, the current setting) or presigned URLs (any
other value, or unset) at runtime. Handlers also get `PRIVATE_MEDIA_BASE_URL`,
`PRIVATE_MEDIA_KEY_PAIR_ID` and `PRIVATE_MEDIA_SIGNING_KEY_PARAMETER`.

## Frontend distribution behavior

`cloudfront_frontend.py --include-private-media` adds the origin and behavior
described above. It's opt-in. Without the flag the helper behaves the way it
always did and leaves any existing `private-media/*` behavior and origin alone.
With it:

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

**Once this is applied, pass `--include-private-media` on every later run.** If
you run with `--include-www` or `--include-api-front-door` but leave this flag
off, the helper sees the rewrite function as an unmanaged viewer-request
association and refuses. It won't swap it out for the `www` redirect.

## Rollout

I finished this rollout on 2026-09-30. I'm keeping the steps for the next time
the behavior has to be bound again, say on a replacement distribution. For
routine edge runs, just keep passing `--include-private-media`.

1. **SAM first, with delivery off.** Release the backend template with
   `PRIVATE_MEDIA_DELIVERY: 'false'`. Check that the stack has every resource
   above and that the SSM parameter exists as a `SecureString`
   (`aws ssm describe-parameters`; don't read its value). Albums keep using
   presigned URLs.
2. **Dry-run the edge change.** Use the same arguments as the existing
   [front-door workflow](API_FRONT_DOOR.md#validate-and-update), plus the new
   flag. Fill in the shell variables from current metadata you've checked, and
   keep every feature flag that's live today:

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

   Look at the account, the ETag, `privateMedia.originDomain`, and check that
   `privateMedia.missing` is empty. The same run also reports
   `apiFrontDoor.policies.privateOrigin: update`. That's the existing
   `IanTruong-API-Private-Origin-v1` origin request policy being updated in
   place to allowlist the `ian-photography-set-cookie-passthrough` cookie.

   Here's why that's needed. CloudFront strips `Set-Cookie` from origin
   responses when a behavior forwards no cookies, so without this change the
   signed cookies the API sets would never reach the browser. The site never
   sets a cookie with that name (the `CloudFront-*` names are reserved for
   signature checks), so the API still gets no viewer cookie, and `/api/*`
   stays CachingDisabled.
3. **Apply the same plan** and wait for the deploy:

   ```bash
   python3 ops/cloudfront_frontend.py "${private_media_edge_args[@]}" --apply
   aws cloudfront wait distribution-deployed --id EIOCCNR8XGQ1B
   ```

   If the ETag went stale or any guard changed, do a fresh dry run.
4. **Verify with a cookie you sign locally** ([below](#verification)) while the
   flag is still `'false'`. Nothing user-facing depends on the behavior yet.
5. **Regenerate the edge contract** ([below](#regenerate-the-edge-contract))
   and commit it.
6. **Turn delivery on.** Change `PRIVATE_MEDIA_DELIVERY` to `'true'` through
   the normal backend release. In a fresh browser session, check a private
   album, an unlisted album, a shared album and a video album end to end:
   images, responsive previews, HLS playback, and a refresh after the TTL runs
   out.

## Verification

Anonymous and malformed requests should fail:

```bash
media="https://iantruongphotography.com/private-media/albums/<albumId>/<object key below the album>"
curl -sS -o /dev/null -w '%{http_code}\n' -I "$media"                       # 403
curl -sS -o /dev/null -w '%{http_code}\n' -I "https://iantruongphotography.com/private-media/albums/<albumId>/../x"  # 404
```

Then sign a short-lived cookie locally for one album. Do this in a protected
shell with history turned off, and delete the key when you're done:

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
that a second request shows `X-Cache: Hit from cloudfront` and still needs the
cookie. Write down only status codes and header names, never cookie values.

## Regenerate the edge contract

`ops/ci/frontend_edge_contract.json` holds a hash of the whole frontend
distribution, so the scheduled audit fails after a change like this until the
contract is updated. Once the distribution reports `Deployed`:

```bash
workspace="$(mktemp -d)"
aws cloudfront get-distribution --id EIOCCNR8XGQ1B --output json > "$workspace/distribution.json"
python3 -c 'import json, sys; sys.path.insert(0, "ops/ci"); import frontend_edge_posture as p; print(p._digest(p.sanitized_distribution(json.load(open(sys.argv[1])))))' "$workspace/distribution.json"
```

Replace only `distributionSha256` with the printed value. Then run
`RUNNER_TEMP="$workspace" bash ops/ci/audit_frontend_edge.sh` and don't commit
until it says `IN_SYNC`.

## Rotating the signing key

1. In a protected shell, generate a new 2048-bit RSA key pair
   (`openssl genrsa -out new.pem 2048`, then
   `openssl rsa -pubout -in new.pem -out new.pub.pem`).
2. Add a second `AWS::CloudFront::PublicKey` with the new public key and a new
   `CallerReference`/`Name`, and add it to `PrivateMediaKeyGroup` **next to**
   the current key. Deploy. Both keys are now trusted.
3. At a quiet time, overwrite `/ian-website/prod/private-media-signing-key`
   with the new private key
   (`aws ssm put-parameter --type SecureString --overwrite --value file://new.pem`)
   and right away release the change that points `PRIVATE_MEDIA_KEY_PAIR_ID`
   at the new public key. Changing the environment replaces every execution
   environment, so after that the key and key ID move together. In the short
   gap between those two steps, a handler that loads the key fresh can sign
   with the new key under the old key ID. CloudFront rejects those cookies, and
   the viewer recovers on the next metadata refresh.
4. Wait at least one cookie TTL (`MEDIA_URL_TTL_SECONDS`) plus some margin so
   every cookie signed with the old key has expired. Then remove the old key
   from the key group and the template, and deploy again.
5. Securely delete the local key files. Record only the key IDs and dates.

The key group ID doesn't change, so the distribution doesn't need an update and
the edge contract stays valid.

## How long revocation takes

Revoking album access (visibility change, share turned off, account removed)
stops new cookies right away. Cookies already handed out keep working until
they expire, which is at most `MEDIA_URL_TTL_SECONDS` (600 s by default). Bytes
a viewer already downloaded can be reused from their private browser cache for
up to 600 s (`max-age=600, must-revalidate`) before revalidating. That's the
same window presigned URLs had. To cut off every cookie in an emergency, remove
the compromised public key from the key group and deploy. That invalidates
every cookie signed with it at once.

## Rollback

- Change `PRIVATE_MEDIA_DELIVERY` back to `'false'` and release. The next API
  responses return presigned URLs, and the frontend handles both, so there's
  no frontend change or distribution update. Cookies already out there just
  expire.
- The `private-media/*` behavior and origin can stay put. Without valid
  cookies they only return `403`/`404`. The helper never deletes them. Removing
  them is its own distribution change, followed by an edge-contract update.
- Never drop the key-group requirement, attach an origin request policy, or
  widen the bucket grant past `albums/*` as a shortcut to roll back.
