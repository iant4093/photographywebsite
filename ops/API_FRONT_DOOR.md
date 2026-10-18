# Single CloudFront API front door

The browser only talks to one origin, `https://iantruongphotography.com`. Static
files and `/api/*` go through the same frontend CloudFront distribution and its
CloudFront-scope WAF. The regional HTTP API is still where the application and
authentication checks happen. The WAF is an extra layer in front of it.

## How a request gets in

- The browser's API base is `/api`.
- `/api/public/*` caches only anonymous `GET`/`HEAD` responses. The cache key
  varies only on the `cursor`, `limit`, `mode`, `seed`, `type`, and `value`
  query keys, plus compression.
- `/api/public/stats` has its own behavior, listed ahead of that wildcard, so
  the materialized daily report can stay at the edge for a day. Every other
  public API response follows the origin's `s-maxage`, capped at one hour. So
  do the `/album/*` and `/video/*` social documents, which share the same cache
  policy.
- The rest of `/api/*` has caching off. It forwards only the allowed methods,
  query strings, and API/auth/CORS headers. Its origin request policy
  allowlists one cookie, `ian-photography-set-cookie-passthrough`, which the
  site never sets. It's there because CloudFront only passes the API's
  private-media `Set-Cookie` headers through when some cookie is allowlisted
  (see [`PRIVATE_MEDIA.md`](PRIVATE_MEDIA.md)).
- CloudFront connects to the TLS 1.2 regional custom domain
  (`origin-api.iantruongphotography.com`) through the fixed `api` mapping and
  adds the secret `X-Origin-Verify` header. Every application route checks that
  value before it does authentication, validation, or any real work.
- The value lives in the encrypted SSM parameter
  `/ian-website/<stage>/front-door-config`. It's retained, and the stack never
  writes it. It holds a `current` value and an optional `previous` one, so a
  rotation can safely overlap Lambda caching (`FrontDoorSecretCacheTtlSeconds`,
  default 300 seconds) and CloudFront propagation. The secret never goes in
  source, arguments, output, logs, fixtures, or release artifacts.
- The default execute-api endpoint is disabled. A request sent straight to the
  custom domain doesn't carry the CloudFront-only header, so it gets the fixed,
  no-store denial.
- The WAF has its own stack, `ian-photography-front-door-waf`, in CloudFront's
  `us-east-1` Region. Sampling is off, sensitive fields are redacted, and every
  rule is in BLOCK mode. The managed rules block known-bad inputs and sources on
  the IP reputation list. A per-IP `/api/` rate rule stops floods from a single
  source; static pages aren't covered by it. Explore gets its own lower per-IP
  limit so one caller can't use arbitrary filter values to run up heavy
  DynamoDB usage.
- Distributed traffic to the origin is capped by the API Gateway throttles
  below. Those throttles sit under the old constant-key WAF circuit breakers
  (15,000 and 5,000 per five minutes), so the breakers could never kick in
  first. I removed both rules on 2026-10-16.

## Rate limits that cost nothing extra

The API Gateway stage default is still 25 requests/second with a burst of 50.
The route overrides below apply to all callers combined, not to each visitor:

| Routes | Requests/second | Burst |
|---|---:|---:|
| Login, login challenge, contact, album/shared print, print session | 2 | 10 |
| Album/shared ZIP status, download URL, and original comparison | 5 | 20 |
| Analytics event ingestion | 10 | 25 |
| Public Explore | 5 | 15 |

Every other route keeps the stage default, including gallery lists/details and
uploads. Detailed route metrics stay off. The browser's retry delays and ZIP
polling already respect cooldowns, and none of these overrides adds a paid
resource.

There are five WAF rules: two managed groups and three per-IP rate rules. The
same ACL is attached to the frontend distribution and the media CDN
(`ImagesCloudFront` names it as its `WebACLId`), so I don't pay for a second
ACL. The per-IP limits, per 300-second window, are:

| Scope | Requests per IP per 5 minutes |
|---|---:|
| API (`/api/`) | 3,000 |
| Explore | 600 |
| Media CDN (matched on the media `Host` header) | 4,000 |

The media limit leaves about 2x headroom over the busiest real viewer in the
2026-09-16 to 2026-10-16 access logs. These numbers are the parameter defaults
in `ops/waf_front_door_template.yaml`. They're also `WAF_RATE_LIMIT_CONTRACT` in
`ops/cloudfront_frontend.py`, which refuses to run if the live ACL doesn't
match, and a test keeps the two in sync. The rules keep BLOCK actions and
privacy-safe logging. Treat the numbers as approximate rate targets, not hard
ceilings. Several people behind one shared IP can also trip a limit together.

The download and original-comparison handlers check the request body (which has
a size limit) and the media identifier before any database or identity lookup.
Valid requests still go through every album authorization and media membership
check. Once the application rate limiter confirms a denial, each Lambda process
caches it until the database's original window expires. The cache holds at
most 1,024 hashed entries. It never caches permission to proceed or a database
failure, and it goes back to DynamoDB on a miss, expiry, eviction, or policy
change. It saves trips to the shared limiter. It doesn't replace it.

### Changing the WAF limits

The normal release deploys API stage and handler changes. CI never deploys the
WAF stack. To tune a WAF limit, create a CloudFormation UPDATE change set for
the existing WAF stack. Set only the changed `ApiPerIpRequestLimit`,
`ExplorePerIpRequestLimit`, or `MediaPerIpRequestLimit` values, and use previous
values for every other parameter. Update the template defaults and
`WAF_RATE_LIMIT_CONTRACT` in the same change.

Before executing it, check that only the existing web ACL's rules change, with
no ACL replacement and no new resource. CloudFormation may also report that it's
reevaluating the `ResourceArn` reference on the unchanged logging
configuration. That's fine as long as the definition is identical and the ACL's
physical ARN stays the same. Changing the template defaults alone doesn't update
the live parameter values. Rate-rule updates can briefly reset counting, so do
one controlled update and verify it.

To roll back, restore the previous WAF parameter values with another change set,
and use the previous attested backend release to restore the stage and handlers.
Keep origin verification on. None of this adds alarms, budgets, paid bot
controls, or an automatic cutoff, and none of it caps bandwidth charges.

## Hardening inside the API

I verify Cognito JWTs in my own code with PyJWT 2.15.0, a ten-minute JWKS cache,
and a 30-second cooldown on refreshes for unknown keys. Unsupported algorithms
and missing or oversized key IDs are rejected before any key fetch. PyJWT's
unlimited per-key cache is turned off, so a retired key stops being trusted
after the next set refresh. If the client has just refreshed, a newly published
key can take up to 30 seconds to show up. Keys already known to be valid keep
working during that cooldown, and during a failed refresh while their cached set
is still valid.

Login, login challenges, contact, and shared-album viewing check for a confirmed
IP block before Turnstile runs. That check uses no quota, doesn't extend a
block, doesn't look at username blocks before the CAPTCHA, and doesn't cache an
allowance. If there's no block, the request still has to pass Turnstile and then
the existing authoritative limiter.

JSON bodies keep their per-endpoint byte limits. On top of that they reject
duplicate object keys, non-finite numbers (including exponent overflow), and
nesting deeper than 32 containers. Encoded bodies are size-checked before base64
decoding. Normal Unicode text, arrays, numbers, and escaped strings are still
accepted.

For shared-album viewing, the share index is only used to find the album ID. The
handler then does a consistent read of the base table and checks the current
share code, enabled state, visibility, and status before it serializes any
media. If that read fails, it never falls back to the stale index record. It
costs one extra metered read per uniquely matched share. It doesn't revoke URLs
that were already issued; those still last until their normal expiry. Deploy
the handler and its narrow `dynamodb:GetItem` permission on `AlbumsTable`
together through the backend template. No new AWS resources are needed.

## Validate and update

Normal `main` releases keep the deployed front-door parameters as they are.
Changing the front door is its own operation, which I do by hand:

1. Run the full repository tests and infrastructure validation.
2. Run `ops/front_door_preflight.py` with the stack, account, certificate, SSM
   parameter name, and WAF guards. It only reads metadata and never decrypts the
   parameter.
3. Run `ops/cloudfront_frontend.py --include-api-front-door` without `--apply`.
   Pass the current resource guards, then read through the proposed
   distribution changes and note the current ETag.
4. Apply that same dry-run plan, unchanged, with the ETag, account, resource
   guards, and confirmation phrase. Wait for CloudFront to reach `Deployed`.
5. Through the canonical host, check public list/detail pagination, protected
   identity behavior, CORS, cache headers, origin verification, that
   execute-api is still disabled, and WAF redaction/count behavior.
6. Run the credential-free public-posture smoke and the scheduled edge/drift
   audit. Keep only aggregate evidence, with secrets redacted.

The helper's `--help` output is the source of truth for required arguments.
Apply is blocked by a stale ETag, a changed origin, a certificate/secret/WAF
resource that doesn't match, a re-enabled direct endpoint, or a viewer-request
association nobody can explain.

## Rotating the origin secret without downtime

1. In a protected operator process, generate a new random value and update the
   SSM parameter: `previous` becomes the old `current`, and `current` becomes
   the new value.
2. Leave CloudFront on the old value for longer than the Lambda cache TTL
   (`FrontDoorSecretCacheTtlSeconds`) plus some margin. Keep the canonical
   canaries running while it drains.
3. Apply the CloudFront plan so its origin header uses the new `current`. Wait
   for `Deployed`, then run positive and negative canaries.
4. Keep both values for another propagation and rollback window. Then clear
   `previous`, wait one more cache TTL, and run the canaries again.
5. Record only redacted version/timestamp and change evidence. Never record
   either secret value.

If rotation fails before CloudFront switches, put back the previous two-value
JSON. If it fails after, keep accepting both values while you fix the
distribution. Don't turn off origin verification as a quick way to roll back.

## Rolling back

- For a WAF false positive, switch only the affected rule to COUNT. Don't add a
  broad allow rule.
- For an origin or behavior regression, restore a known-good earlier CloudFront
  configuration using the current ETag.
- Re-enabling execute-api or turning off origin enforcement reopens the bypass.
  Treat that as an emergency backend change with a time limit and its own
  review.
- Never delete the retained certificate, custom domain, mapping, DNS record,
  origin-verification parameter, WAF ACL, or security logs as part of a
  rollback.

Before promoting a rule, look at its WAF metrics over representative traffic.
Write down every exclusion with an owner, reason, evidence, expiry, test, and
rollback. IP addresses, paths, user agents, and request identifiers are
restricted security data, so handle them that way.
