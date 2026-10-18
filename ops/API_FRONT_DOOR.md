# Single CloudFront API front door

The browser uses one origin, `https://iantruongphotography.com`. Static files
and `/api/*` go through the same frontend CloudFront distribution and its
CloudFront-scope WAF. The regional HTTP API still performs the application and
authentication checks. The WAF is an additional layer in front of it.

## Request path

- The browser's API base is `/api` (`VITE_API_BASE_URL`).
- `/api/public/*` allows `GET`, `HEAD`, and `OPTIONS`, and caches `GET` and
  `HEAD`. Its cache policy forwards no cookies and no headers, and the cache key
  includes only the `cursor`, `limit`, `mode`, `seed`, `type`, and `value` query
  strings plus compression.
- `/api/public/stats` has its own behavior, ordered before that wildcard, with a
  one-day TTL for the daily materialized report. Other public API responses
  follow the origin's `s-maxage`, capped at one hour. The `/album/*` and
  `/video/*` social documents use the same capped policy.
- The rest of `/api/*` has caching disabled. It forwards all query strings and
  only the `Authorization`, `CloudFront-Viewer-Country`, `Content-Type`,
  `Origin`, `X-Turnstile-Token`, and CORS preflight headers. Its origin request
  policy allowlists one cookie, `ian-photography-set-cookie-passthrough`, which
  the site never sets. CloudFront removes `Set-Cookie` from responses when no
  cookie is allowlisted, and the API sets the private-media cookies (see
  [`PRIVATE_MEDIA.md`](PRIVATE_MEDIA.md)).
- CloudFront connects to the regional custom domain
  `origin-api.iantruongphotography.com` (TLS 1.2 security policy) through the
  `api` mapping and adds the secret `X-Origin-Verify` header. Each application
  handler checks that header before authentication, validation, or other work.
- The value is stored in the encrypted SSM parameter
  `/ian-website/<stage>/front-door-config`. The stack does not write it. It
  holds a `current` value and an optional `previous` value, so a rotation can
  overlap the Lambda cache (`FrontDoorSecretCacheTtlSeconds`, default 300
  seconds) and CloudFront propagation. The secret must not appear in source,
  arguments, output, logs, fixtures, or release artifacts.
- The default execute-api endpoint is disabled. A request sent directly to the
  custom domain lacks the CloudFront-only header and gets a 403 `private,
  no-store` denial.
- The WAF is in its own stack, `ian-photography-front-door-waf`, in `us-east-1`.
  Request sampling is off. The WAF log redacts the `authorization`, `cookie`,
  and `x-origin-verify` headers and the query string, and keeps only BLOCK
  actions. The managed rule groups block known-bad inputs and sources on the
  Amazon IP reputation list. A per-IP rate rule covers paths starting with
  `/api/`; static pages are not covered. `/api/public/explore` has its own
  lower per-IP limit.
- Aggregate traffic to the origin is limited by the API Gateway throttles below.
  The WAF has no account-wide (constant-key) rate rules.

## Rate limits

The API Gateway stage default is 25 requests per second with a burst of 50. The
route overrides below apply to all callers combined, not to each visitor:

| Routes | Requests/second | Burst |
|---|---:|---:|
| Login, login challenge, contact, album/shared print, print session | 2 | 10 |
| Album/shared ZIP, download URL, and original comparison | 5 | 20 |
| Analytics event ingestion | 10 | 25 |
| Public Explore | 5 | 15 |

Every other route uses the stage default, including gallery lists, details, and
uploads. Detailed route metrics are off.

The web ACL has five rules: two AWS managed rule groups and three per-IP rate
rules. The same ACL is attached to the frontend distribution and the media CDN
(`ImagesCloudFront` sets it as its `WebACLId`). The per-IP limits, per
300-second window, are:

| Scope | Requests per IP per 5 minutes |
|---|---:|
| API (URI path starts with `/api/`) | 3,000 |
| Explore (URI path `/api/public/explore`) | 600 |
| Media CDN (`Host` header `d1twwtwfz1yeo4.cloudfront.net`) | 4,000 |

The busiest real media viewer in the 2026-09-16 to 2026-10-16 access logs
peaked near 1,800 requests per window. These numbers are the parameter defaults
in `ops/waf_front_door_template.yaml`. They are also `WAF_RATE_LIMIT_CONTRACT`
in `ops/cloudfront_frontend.py`, which refuses to run if the live ACL does not
match, and a test keeps the two in sync. All rules use BLOCK actions. Several
viewers behind one shared IP count toward the same limit.

The download and original-comparison handler validates the request body (8 KiB
limit) and the media identifier before any album or identity lookup. Valid
requests still go through album authorization and media membership checks.
Once the rate limiter confirms a denial, each Lambda process caches it until
the limiter's window ends. The cache holds at most 1,024 entries keyed by a
hashed identifier. It never caches an allowance or a database failure, and a
miss, expiry, or eviction falls back to DynamoDB.

### Changing the WAF limits

The normal release deploys API stage and handler changes. CI does not deploy the
WAF stack. To change a WAF limit, create a CloudFormation UPDATE change set for
the existing WAF stack. Set only the changed `ApiPerIpRequestLimit`,
`ExplorePerIpRequestLimit`, or `MediaPerIpRequestLimit` values, and use previous
values for every other parameter. Update the template defaults and
`WAF_RATE_LIMIT_CONTRACT` in the same commit.

Before executing, check that only the existing web ACL's rules change, with no
ACL replacement and no new resource. If the change set also lists
`WafLoggingConfiguration` because of its `ResourceArn` reference, confirm that
its definition is unchanged and the ACL's physical ARN stays the same. Changing
the template defaults alone does not update the live parameter values.

To roll back, restore the previous WAF parameter values with another change set,
and use the previous attested backend release to restore the stage and handlers.
Keep origin verification on.

## Checks inside the API

Cognito JWTs are verified in application code with PyJWT 2.15.0
(`backend/functions/auth_helpers.py`). The JWKS client caches the key set for
ten minutes, waits 30 seconds between refreshes for unknown keys, and has its
per-key cache turned off, so a retired key stops being trusted after the next
set refresh. Tokens whose header algorithm is not `RS256`, or whose key ID is
missing or longer than 256 characters, are rejected before any key fetch.

Login, login challenge, contact, and shared-album viewing apply the per-IP rate
limit before Turnstile verification. Login and login challenge then apply a
per-user limit after Turnstile.

ZIP status, download URL, original comparison, and print requests that name an
album ID first check the local cache of confirmed denials
(`is_rate_limit_denied`). That check uses no quota and
makes no DynamoDB call. A cache miss does not grant access; the request still
goes through the authoritative limiter.

JSON bodies have per-endpoint byte limits. They also reject duplicate object
keys, non-finite numbers, and nesting deeper than 32 levels
(`backend/functions/validation_helpers.py`). Base64-encoded bodies are
size-checked before decoding.

For shared-album viewing, the share-code index is used only to find the album
ID. The handler then reads the album with a consistent read and checks the
current share code and shared state, then runs album authorization before it
returns any media. It does not revoke URLs that were already issued; those last
until their normal expiry.

## Validate and update

Normal `main` releases keep the deployed front-door parameters unchanged.
Changes to the front door are a separate manual operation:

1. Run the full repository tests and infrastructure validation.
2. Run `ops/front_door_preflight.py` with the stack, account, certificate, SSM
   parameter name, and web ACL arguments. It reads metadata only and does not
   decrypt the parameter.
3. Run `ops/cloudfront_frontend.py --include-api-front-door` without `--apply`.
   Pass the current resource guards, review the proposed distribution changes,
   and note the current ETag.
4. Apply the same plan with `--apply`, `--expected-etag`,
   `--expected-account-id`, the resource guards, and
   `--confirm-front-door ADD-SINGLE-API-FRONT-DOOR`. Wait for CloudFront to
   reach `Deployed`.
5. Through the canonical host, check public list/detail pagination, protected
   identity behavior, CORS, cache headers, origin verification, that
   execute-api is still disabled, and WAF log redaction.
6. Run the credential-free public smoke test (`ops/ci/public_smoke.sh`) and
   the scheduled drift audit. Keep only aggregate evidence, with secrets
   redacted.

Run each helper with `--help` for its required arguments. Apply refuses a stale
ETag, a changed origin, a certificate, parameter, or WAF resource that does not
match, a re-enabled default endpoint, or an unmanaged viewer-request function
association.

## Rotating the origin secret

1. From a protected operator session, generate a new random value and update
   the SSM parameter: `previous` becomes the old `current`, and `current`
   becomes the new value.
2. Leave CloudFront on the old value for longer than the Lambda cache TTL
   (`FrontDoorSecretCacheTtlSeconds`) plus a margin. Keep running canary
   requests through the canonical host during this time.
3. Apply the CloudFront plan so the origin header uses the new `current`. Wait
   for `Deployed`, then run positive and negative canaries.
4. Keep both values for another propagation and rollback window. Then clear
   `previous`, wait one more cache TTL, and run the canaries again.
5. Record only redacted version, timestamp, and change evidence. Never record
   either secret value.

If rotation fails before CloudFront switches, restore the previous two-value
JSON. If it fails after, keep accepting both values while fixing the
distribution. Do not disable origin verification as a rollback.

## Rolling back

- For a WAF false positive, switch only the affected rule to COUNT. Do not add a
  broad allow rule.
- For an origin or behavior regression, restore a known-good earlier CloudFront
  configuration using the current ETag.
- Re-enabling execute-api or disabling origin enforcement reopens the bypass.
  Treat that as an emergency backend change with a time limit and its own
  review.
- Do not delete the retained certificate, custom domain, mapping, DNS record,
  origin-verification parameter, WAF ACL, or security logs as part of a
  rollback.

Before changing a rule, review its WAF metrics over representative traffic.
Record each exclusion with an owner, reason, evidence, expiry, test, and
rollback. IP addresses, paths, user agents, and request identifiers are
restricted security data.
