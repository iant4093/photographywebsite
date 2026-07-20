# Production infrastructure runbook

The files in this directory implement the security, privacy, reliability, and
performance baseline for `iantruongphotography.com`. All mutating helper scripts
are **dry-run by default** and require multiple exact production guards to apply.

## What is source controlled

- `backend/template.yaml` owns the API, Lambda functions, Cognito, DynamoDB,
  private media bucket, media CloudFront distribution, logs, dead-letter queue,
  and alarms.
- `backend/Makefile` creates allow-listed Lambda artifacts from Python source
  only and installs exact top-level runtime dependency versions. Local OAuth or
  service-account JSON cannot be copied by the build.
- `frontend_cloudfront_baseline.json` and `cloudfront_frontend.py` harden the
  existing frontend distribution without silently changing its origin,
  certificate, DNS, or logging destination.
- `dns_hardening.py` manages CAA and `www` alias records after CloudFront is
  ready for `www`.
- `dnssec-key-template.yaml` is a deliberately separate, explicit DNSSEC stack.
- Migration helpers cover existing album ownership, GSIs, media visibility
  tags, media-cache invalidation, and Lambda log retention.

The scripts discover physical table, bucket, user-pool, API, distribution, and
hosted-zone IDs from a caller-supplied CloudFormation stack name or canonical
domain. Account IDs and current ETags are deliberately runtime guard values and
are never committed. `us-west-2` is the application-region default; the DNSSEC
KMS stack must be deployed in `us-east-1`.

## Preflight and recovery point

Run all local validation first:

```bash
./ops/validate_infrastructure.sh --build
npm test
npm run lint
npm run build
```

Then verify the active account and capture current state before any mutation:

```bash
aws sts get-caller-identity
aws cloudformation describe-stacks --stack-name STACK_NAME --region us-west-2
python3 ops/check_album_indexes.py --stack-name STACK_NAME
python3 ops/cloudfront_frontend.py --stack-name STACK_NAME
python3 ops/dns_hardening.py
python3 ops/set_lambda_log_retention.py --stack-name STACK_NAME
python3 ops/tag_existing_media.py --stack-name STACK_NAME
python3 ops/backfill_legacy_media_prefix.py --stack-name STACK_NAME
python3 ops/backfill_album_owner_sub.py --stack-name STACK_NAME
python3 ops/invalidate_media_cache.py --stack-name STACK_NAME
```

Before the first hardened stack deployment, create an on-demand DynamoDB backup
and verify it becomes `AVAILABLE`. Versioning and point-in-time recovery protect
future changes; they cannot recreate history from before they were enabled.
Also retain the current CloudFormation template and both CloudFront distribution
configs as rollback evidence. Never print or save table items in deployment logs.

## Mandatory legacy media-prefix approval before code cutover

Run this migration against the existing production table **before deploying the
hardened backend code**. The old backend ignores `legacyS3Prefix`, so it is safe
to backfill first. The hardened backend intentionally ignores the mutable
historic `s3Prefix` for authorization and deletion; cutting over first would make
legacy albums unavailable until the approval is present.

```bash
python3 ops/backfill_legacy_media_prefix.py --stack-name STACK_NAME
python3 ops/backfill_legacy_media_prefix.py \
  --stack-name STACK_NAME \
  --apply \
  --expected-account-id EXPECTED_ACCOUNT_ID \
  --expected-record-count EXPECTED_COUNT \
  --expected-plan-digest DRY_RUN_PLAN_DIGEST \
  --confirm-stack-name STACK_NAME \
  --confirm backfill-legacy-media-prefix
```

The script scans every page, reports a SHA-256 digest of the sorted safe
`(albumId,prefix)` plan without disclosing it, and requires that exact digest on
apply. It refuses the whole apply for malformed UUIDs,
non-normalized or duplicate single-segment prefixes, conflicting prior
approvals, absolute/traversing keys, or any image, thumbnail, HLS manifest, or
cover outside its record's exact historic prefix. It reports aggregate counts
only. Re-run the dry-run after apply and require zero unsafe counts before the
backend cutover.

## Secrets migration

Production uses Secrets Manager ARNs. The legacy raw `ResendApiKey` and
`TurnstileSecretKey` parameters remain only as `NoEcho` transition inputs and
should be passed as empty strings after the ARN migration.

Accepted secret payloads are:

- Resend: a raw API-key string or `{"apiKey":"..."}`.
- Turnstile: a raw secret string or `{"secretKey":"..."}`.
- Google Drive: `{"oauth":{...}}`, `{"service_account":{...}}`, or the
  corresponding authorized-user/service-account object directly.
- Rate-limit HMAC: generated and retained automatically as
  `RateLimitHashSecret`; no operator-supplied value is needed. Code also accepts
  a raw string or `{"secret":"..."}` for compatible external configurations.

Create/update secrets using `--secret-string file://...` from a permission-0600
temporary file so values do not enter shell history. Do not store that file in
the repository. Record only the resulting ARNs. If a customer-managed KMS key is
used for the three external secrets, pass its exact ARN as
`ApplicationSecretsKmsKeyArn`; Lambda permissions are scoped to that key.

Deploy initially with `AlbumIndexDeploymentPhase=none` and the private-media
deny switch off. The example uses placeholders only:

```bash
cd backend
sam deploy \
  --parameter-overrides \
    Stage=prod \
    FrontendUrl=https://iantruongphotography.com \
    FrontendHostname=iantruongphotography.com \
    ResendApiKey= \
    TurnstileSecretKey= \
    ResendApiKeySecretArn=RESEND_SECRET_ARN \
    TurnstileSecretArn=TURNSTILE_SECRET_ARN \
    GoogleOAuthSecretArn=GOOGLE_SECRET_ARN \
    ApplicationSecretsKmsKeyArn=OPTIONAL_KMS_KEY_ARN \
    GoogleDriveFolderId=DRIVE_FOLDER_ID \
    AlbumIndexDeploymentPhase=none \
    EnforcePrivateMediaCloudFrontDeny=false
```

Review the CloudFormation changeset before confirming it. After cutover, verify
contact/login/Google backup behavior. Provider-side rotation is a separate owner
decision: if requested, rotate Resend, Turnstile, and Google values at their
issuers, update the Secrets Manager copies, prove each with a live invocation,
then remove obsolete local credential files. Do not rotate or revoke credentials
as an implicit side effect of a deployment.

## DynamoDB GSI and owner migration

DynamoDB permits only one GSI creation per table update. Preserve this order:

1. Deploy `AlbumIndexDeploymentPhase=none`. This ships code with safe scan
   fallbacks and all non-index hardening.
2. Dry-run legacy owner migration:

   ```bash
   python3 ops/backfill_album_owner_sub.py --stack-name STACK_NAME
   ```

   The script touches only private, active (or legacy status-less) albums with a
   missing/empty `ownerSub`, a valid UUID album ID, and exactly one matching
   Cognito email whose `sub` is a valid UUID. It never prints identifiers.
3. Apply only if all aggregate counts are understood:

   ```bash
   python3 ops/backfill_album_owner_sub.py \
     --stack-name STACK_NAME \
     --apply \
     --expected-account-id EXPECTED_ACCOUNT_ID \
     --expected-record-count EXPECTED_COUNT \
     --confirm-stack-name STACK_NAME \
     --confirm backfill-album-owner-sub
   ```

4. Deploy with `AlbumIndexDeploymentPhase=visibility`. Wait for
   `VisibilityCreatedAtIndex` to be `ACTIVE` and `Backfilling=false`:

   ```bash
   python3 ops/check_album_indexes.py --stack-name STACK_NAME
   ```

5. Exercise public album listing and compare results/order against the predeploy
   snapshot. Then deploy with `AlbumIndexDeploymentPhase=both`.
6. Wait for `OwnerSubCreatedAtIndex` to be ready. Exercise admin/user album
   lists, user edits, user deletion preflight, and private album authorization.

Every `sam deploy --parameter-overrides` invocation must include the production
values from the secrets step, plus the new phase. Do not rely on shell history to
reconstruct them. Use a protected deployment system or a local permission-0600
parameter file outside the repository.

## Media privacy migration and deny switch

The bucket policy can deny CloudFront reads when an existing object tag
`visibility` is `private`, `unlisted`, or `pending`. Keep
`EnforcePrivateMediaCloudFrontDeny=false` until all steps below pass. The deny is
deliberately gated because old cached objects can outlive origin policy changes,
and private HLS segment delivery needs end-to-end regression testing.

1. Confirm the legacy-prefix approval above completed, then deploy the frontend
   and backend code with the deny disabled. New uploads are
   tagged `pending`; album mutation flows and the S3 tag worker synchronize
   visibility. Confirm direct S3 access is denied and public CDN media still
   loads.
2. Dry-run the existing-object migration:

   ```bash
   python3 ops/tag_existing_media.py --stack-name STACK_NAME
   ```

   The script derives assignments from album records and album prefixes without
   printing object keys or album/user data. It refuses invalid visibility values
   and cross-album key conflicts. It also inventories the complete paginated
   `albums/` keyspace and tags every unassigned orphan `quarantined`; this value
   is denied by the CDN fail-closed policy but is not matched by the lifecycle
   rule that expires abandoned `pending` uploads.
3. Apply with all current aggregate guards:

   ```bash
   python3 ops/tag_existing_media.py \
     --stack-name STACK_NAME \
     --apply \
     --expected-account-id EXPECTED_ACCOUNT_ID \
     --expected-record-count EXPECTED_COUNT \
     --expected-bucket-object-count EXPECTED_OBJECT_COUNT \
     --expected-plan-digest EXPECTED_PLAN_DIGEST \
     --confirm tag-existing-media
   ```

   Re-run the dry-run and separately audit tag counts before continuing.
4. Submit one full media invalidation after tag completion:

   ```bash
   python3 ops/invalidate_media_cache.py \
     --stack-name STACK_NAME \
     --apply \
     --expected-account-id EXPECTED_ACCOUNT_ID \
     --confirm-distribution-id DISCOVERED_MEDIA_DISTRIBUTION_ID
   ```

   Wait until the invalidation and distribution are complete. A wildcard is one
   invalidation path, but CloudFront invalidation pricing/quota still applies.
5. Audit that every media object has exactly `visibility=public`, `private`, or
   `unlisted`; missing and unknown tags must be zero. Then deploy
   `EnforcePrivateMediaCloudFrontDeny=true`. The guarded policy denies CloudFront
   reads for every object whose visibility tag is not exactly `public`, including
   missing/unknown tags. In a fresh browser and with
   caches disabled, test public images/video/HLS, owner-authorized private media,
   admin private media, unlisted share access, original downloads, ZIP creation,
   expired URLs, cross-album keys, and anonymous CDN guesses.

Rollback the deny immediately by redeploying the parameter as `false`; do not
delete tags. If old private objects were previously public through CloudFront,
perform another invalidation after rollback analysis rather than assuming cached
behavior.

## Frontend CloudFront and `www`

The frontend updater guards the current S3 website origin. Its default behavior
uses the managed caching-disabled policy for HTML, HTTPS redirect, compression,
HTTP/2+3, CSP, HSTS, frame denial, MIME sniff protection, referrer policy, and a
permissions policy. `assets/*` uses the managed optimized-cache policy and a
one-year immutable response header. The CSP renders the exact media CloudFront,
API, Cognito, and media-bucket global/regional S3 origins discovered from the
stack; direct private presigned GETs therefore work without an S3 wildcard.

Dry-run and capture the displayed current ETag. Apply only with that exact ETag:

```bash
python3 ops/cloudfront_frontend.py --stack-name STACK_NAME
python3 ops/cloudfront_frontend.py \
  --stack-name STACK_NAME \
  --apply \
  --expected-account-id EXPECTED_ACCOUNT_ID \
  --expected-etag CURRENT_ETAG
```

Wait for `Deployed`, then test HTTP-to-HTTPS, all response headers, SPA deep
links, login/Turnstile, Google Fonts, API/Cognito calls, media, and asset cache
headers. A stale ETag blocks the update.

The S3 website endpoint cannot use Origin Access Control. Migrate it separately,
after the header/cache update is stable. First run the discovery-only plan:

```bash
python3 ops/migrate_frontend_origin.py
```

It discovers the frontend distribution by canonical alias and the bucket from
its current origin, reports the live ETag/public policy count, and plans a staged
OAC conversion. Apply using only values printed by that dry-run, and place the
rollback snapshot outside the repository on encrypted storage:

```bash
python3 ops/migrate_frontend_origin.py \
  --apply \
  --expected-account-id EXPECTED_ACCOUNT_ID \
  --expected-etag CURRENT_ETAG \
  --expected-bucket DISCOVERED_FRONTEND_BUCKET \
  --expected-public-allow-count EXPECTED_PUBLIC_ALLOW_COUNT \
  --confirm-domain iantruongphotography.com \
  --rollback-file /SECURE/OUTSIDE/REPOSITORY/frontend-origin-rollback.json
```

The tool writes the rollback snapshot before mutation, creates/reuses a named
SigV4 OAC, adds an account/distribution-conditioned read grant, switches to the
regional S3 REST origin, configures 403/404 SPA fallback to `/index.html`, waits
for `Deployed`, and smoke-tests `/` plus a deep link. Only then does it remove
public `GetObject` statements and enable all four S3 public-access-block flags.
Any discovery drift, stale ETag, changed bucket, changed public-policy count, or
failed smoke check stops the migration. Retain the snapshot until at least one
normal traffic cycle and test direct S3 website/REST URLs return access denied.

For `www`, first ensure the ACM certificate attached to CloudFront covers
`www.iantruongphotography.com`. `--include-www` verifies the issued certificate
at apply time, creates/publishes a small viewer-request CloudFront Function, and
associates it with every behavior so `www` returns a path/query-preserving 301 to
the apex. It refuses to overwrite an unmanaged viewer-request association. Add
the alias using a fresh ETag, wait for deployment, and only then apply DNS:

```bash
python3 ops/dns_hardening.py
python3 ops/dns_hardening.py \
  --apply \
  --expected-account-id EXPECTED_ACCOUNT_ID \
  --confirm-domain iantruongphotography.com
```

The DNS helper refuses to create the `www` A/AAAA aliases until CloudFront lists
the alternate domain. It also adds a CAA record authorizing Amazon certificate
issuance. Verify canonical redirect behavior at the application/CDN layer; DNS
aliases alone do not redirect browsers.

## DNSSEC is a separate ceremony

DNSSEC creates a billable customer-managed KMS key and introduces a registrar
dependency. Do not deploy it as part of the routine application release.

1. Confirm the registrar supports DS records and document an on-call rollback.
2. Lower relevant TTLs in advance and configure DNSSEC health/validation alarms.
3. Validate and deploy `ops/dnssec-key-template.yaml` in **us-east-1**, passing
   the hosted zone ID. Review the KMS monthly/request cost first.
4. Wait for Route 53 signing and the KSK to be healthy/`INSYNC`.
5. Retrieve the DS record from `aws route53 get-dnssec` and add that exact value
   at the registrar.
6. Validate through multiple independent DNSSEC resolvers for at least one TTL
   window before considering the ceremony complete.

If validation fails, remove the registrar DS record first, wait for caches, then
disable Route 53 signing. Never delete the retained KMS/KSK resources during an
active chain of trust.

## Logs, alarms, and routine operations

The SAM stack creates privacy-minimized API access logs, media CloudFront logs,
an encrypted async-failure queue, and alarms for API 5xx, API p95 latency, DLQ
depth, and login throttling. No request/response bodies, tokens, email addresses,
album IDs, share codes, or query strings should be added to log formats.

SAM-created Lambda log groups already in production need an explicit retention
update because Lambda created them outside CloudFormation. Preview, then apply:

```bash
python3 ops/set_lambda_log_retention.py --stack-name STACK_NAME
python3 ops/set_lambda_log_retention.py \
  --stack-name STACK_NAME \
  --apply \
  --expected-account-id EXPECTED_ACCOUNT_ID \
  --confirm-stack-name STACK_NAME
```

Subscribe a monitored endpoint to the SNS alarm topic after deployment. Alarm
delivery is not useful until the subscription is confirmed. Periodically test
DLQ replay procedures with synthetic, non-sensitive payloads; never blindly
redrive old messages into production. Review log and media-log retention against
traffic, privacy, and cost after 30 days.

## Paid and deliberately deferred controls

- Route 53 DNSSEC is prepared but deferred until the registrar ceremony is
  scheduled. Its required customer-managed KMS key has ongoing key/request cost.
- AWS WAF managed rules are deferred for the initial release. Turnstile, strict
  input validation, API/Lambda throttles, reserved concurrency, and atomic
  per-action rate limits provide the first abuse boundary without a fixed WAF
  monthly/rule/request charge. Revisit WAF if telemetry shows sustained hostile
  traffic or the site becomes materially business-critical.
- CloudTrail S3/Lambda data events, GuardDuty S3 protection, Security Hub, and
  centralized multi-account log archival are useful paid controls but are not
  enabled by this single-site stack. Reassess them alongside traffic, data
  sensitivity, incident-response staffing, and budget.
- CloudFront standard logs, CloudWatch logs/metrics/alarms, Secrets Manager,
  DynamoDB PITR, S3 version storage, invalidations above the free allowance, and
  retained backup/log objects all have usage or storage costs. Budgets and cost
  anomaly alerts should be configured at the AWS account level.

## Post-release checks

- `curl -I` HTTP and HTTPS apex/`www`, several SPA routes, and a fingerprinted
  asset; assert redirect, CSP/HSTS/nosniff/frame/referrer/permissions headers and
  correct HTML-versus-asset cache control.
- Test API preflights from the canonical origin and assert a hostile Origin does
  not receive CORS authorization.
- Test login, forced-password challenge, enumeration-resistant failures,
  Turnstile, rate limiting, logout/token revocation, and Cognito recovery.
- Test public/private/unlisted album boundaries with anonymous, owner, other
  user, and admin identities, including download and ZIP paths.
- Confirm DynamoDB PITR, deletion protection, S3 versioning, public-access block,
  TLS-only bucket policy, CloudFront OAC, media logs, API logs, DLQ, and alarms.
- Review CloudWatch error rate, latency, Lambda throttles/concurrency, DynamoDB
  throttles, S3/CloudFront 4xx/5xx, cache hit ratio, and cost for at least one
  normal traffic cycle.

Do not treat a successful infrastructure deployment as proof of privacy. The
authorization matrix and live CDN cache tests are required release gates.
