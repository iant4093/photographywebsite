# Production infrastructure runbook

The tracked GitHub Actions release system and its one-time branch-bound OIDC
configuration are documented in [`ops/CI_CD.md`](CI_CD.md). The local procedures
below remain the recovery reference and must continue to match those guards.

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
- The staged account-security templates, singleton inventory, Inspector guard,
  restore gate, and retained audit dependency chain are documented in
  [`SECURITY_ACCOUNT_BASELINE.md`](SECURITY_ACCOUNT_BASELINE.md). The unsafe
  all-in-one security template was removed.
- `regional_security_rollout.py` inventories GuardDuty and Security Hub in
  every enabled Region and, only with exact account/Region/digest guards,
  prepares non-executing CloudFormation change sets for owner review.
- `ci/regional_security_posture.py` is the aggregate-only scheduled counterpart:
  it verifies the exact GuardDuty/Security Hub contract and protected
  two-resource satellite stack ownership in every enabled Region without
  printing provider identifiers or mutating the account.
- `security_budget_template.yaml`, `security_budget_preflight.py`, and
  [`COST_GOVERNANCE.md`](COST_GOVERNANCE.md) define a retained, alert-only
  account budget. No budget is created until an owner approves the amount and
  two human notification destinations are confirmed.
- Migration helpers cover existing album ownership, GSIs, media visibility
  tags, media-cache invalidation, and Lambda log retention.
- `SECURITY_OBSERVABILITY.md` defines the structured audit contract, centralized
  Lambda log group, alert ownership, privacy rules, triage, and rollback steps.
- [`ALARM_REGISTRY.md`](ALARM_REGISTRY.md) and `alarm_registry.json` map every
  declared application, WAF, observability, account-security, backup failure/
  freshness, and account-budget signal to a privacy-safe runbook and make
  missing human ownership explicit.
- `observability_template.yaml`, `observability_preflight.py`, and
  [`OBSERVABILITY.md`](OBSERVABILITY.md) define the retained, privacy-controlled
  paid CloudFront metrics, dashboard, and edge-alarm rollout.

The scripts discover physical table, bucket, user-pool, API, distribution, and
hosted-zone IDs from a caller-supplied CloudFormation stack name or canonical
domain. Account IDs and current ETags are deliberately runtime guard values and
are never committed. `us-west-2` is the application-region default; the DNSSEC
KMS stack must be deployed in `us-east-1`.

## Responsive preview V2 rollout

The exact canary, dispatch, reconciliation, monitoring, and rollback sequence is
documented in [`PREVIEW_V2.md`](PREVIEW_V2.md). Preserve its stable eligible
inventory digest across canary and full reconciliation; do not use a sorted
`--max-jobs` slice as the production canary.

`backend/template.yaml` owns the online path for versioned responsive previews:

- a retained, deletion-protected, point-in-time-recoverable
  `PreviewMetadataTable` encrypted with the dedicated rotating `PreviewDataKey`;
- a KMS-encrypted `PreviewQueue` and 14-day dead-letter queue;
- a Node.js 22 worker with reserved/event-source concurrency of two and partial
  SQS batch failure reporting; and
- a preview-only CloudFront behavior that rechecks the S3 visibility tag at the
  origin for every uncached browser request. The versioned WebP response remains
  immutable in the browser, while the edge cannot continue serving an object
  after a public-to-private transition without re-evaluating the bucket policy.

The worker is an independent locked Node package under
`backend/preview_worker/`. The SAM make build installs exact Linux x86_64 native
Sharp binaries into the ZIP artifact, even when a developer builds on macOS.
Building requires npm registry access; it does not modify the root frontend
package or lockfile. Run its dependency and contract checks explicitly:

```bash
cd backend/preview_worker
npm ci
npm test
cd ../..
sam build --template-file backend/template.yaml
```

The deployed table initially contains no derivative state. New photo album
creates/appends enqueue V2 work only after the existing JPEG fallback is
committed and tagged. An absent, delayed, or failed V2 never removes or modifies
the raw image or current 800px JPEG.

Existing media backfill is **dry-run by default**. The script resolves the
albums table, preview metadata table, media bucket, and PreviewQueue directly
from the named CloudFormation stack. Operators may run the aggregate-only
source/plan audit after the online stack is deployed:

```bash
python3 ops/backfill_preview_v2.py --stack-name STACK_NAME
```

Review the printed aggregate counts, pending plan digest, and stable eligible
inventory digest. First run the five-case representative dry run and follow the
digest-bound canary procedure in `PREVIEW_V2.md`. To dispatch a reviewed full
pending plan, rerun with every independent guard copied from its dry-run output:

```bash
python3 ops/backfill_preview_v2.py \
  --stack-name STACK_NAME \
  --expected-account-id AWS_ACCOUNT_ID \
  --expected-record-count ALBUM_RECORD_COUNT \
  --expected-preview-record-count PREVIEW_METADATA_RECORD_COUNT \
  --expected-job-count PLANNED_JOB_COUNT \
  --expected-plan-digest PLAN_DIGEST \
  --confirm-stack-name STACK_NAME \
  --confirm backfill-preview-v2 \
  --apply
```

Apply performs the same scans and source-object HEAD validation again before
checking the account, both record counts, final job count, digest, stack name,
confirmation phrase, metadata conflicts, and source validation failures. It
then sends the deterministic, duplicate-free in-memory plan directly to the
stack's KMS-encrypted PreviewQueue using `SendMessageBatch` requests of at most
10 entries. It creates no manifest and does not mutate album manifests, source
objects, or DynamoDB records. Any SQS failed entry or incomplete acknowledgement
stops the run immediately; some earlier batches may already be queued, so
inspect the queue/DLQ and worker alarms before deciding whether to rerun. The
worker's metadata contract makes already-ready jobs safe to receive again.
The AWS identity running apply must have `sqs:SendMessage` on that exact queue
and the KMS permissions required to produce messages for its customer-managed
key; the script does not broaden the deployed Lambda roles or key policy.

After the complete queue drains, run the read-only aggregate reconciler with
the original eligible inventory count and digest:

```bash
python3 ops/reconcile_preview_v2.py \
  --stack-name STACK_NAME \
  --expected-account-id AWS_ACCOUNT_ID \
  --expected-inventory-count ELIGIBLE_INVENTORY_COUNT \
  --expected-inventory-digest ELIGIBLE_INVENTORY_DIGEST
```

The reconciler checks metadata, actual WebP dimensions, checksum evidence,
object metadata/tags/cache/content type/encryption, bucket access controls, and
public-versus-protected CloudFront behavior. It prints only aggregate counts and
fixed failure categories. Canary review and full success are defined precisely
in `PREVIEW_V2.md`.

This bounded backfill does not require an operations bucket or Step Functions.
If future scale requires an orchestrated backfill, introduce and test that path
as a separate reviewed change rather than accepting ad-hoc bucket or state
machine ARNs in this script.

For rollback of the online path, disable the preview SQS event source and stop
producer dispatch first. Keep the retained metadata table, KMS key, queues, V2
objects, raw media, and V1 thumbnails intact for investigation. The API and
frontend automatically continue using the existing JPEG fallback whenever a
complete ready V2 record is unavailable.

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
python3 ops/observability_preflight.py \
  --deployment-mode create \
  --frontend-distribution-id FRONTEND_DISTRIBUTION_ID \
  --media-distribution-id MEDIA_DISTRIBUTION_ID \
  --expected-account-id AWS_ACCOUNT_ID
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
   snapshot. Deploy with `AlbumIndexDeploymentPhase=summary`, then wait for
   `VisibilityCreatedAtSummaryIndex` to be `ACTIVE` and `Backfilling=false`.
   Re-run the public catalog comparison; the response/count/order/cursors must
   match while the index projection excludes full media manifests and private
   owner/share fields.
6. Deploy with `AlbumIndexDeploymentPhase=both`, then wait for
   `OwnerSubCreatedAtIndex` to be ready. Exercise admin/user album
   lists, user edits, user deletion preflight, and private album authorization.

Every `sam deploy --parameter-overrides` invocation must include the production
values from the secrets step, plus the new phase. Do not rely on shell history to
reconstruct them. Use a protected deployment system or a local permission-0600
parameter file outside the repository.

Deployments must also pass `ReleaseSha` as the exact tested Git revision and
preserve the approved `ApplicationLogRetentionDays`. Use `ReleaseSha=unknown`
only for a documented legacy/manual release; never place credentials or user
input in either parameter. Follow `SECURITY_OBSERVABILITY.md` to test synthetic
audit delivery and alarm routing after the change set completes.

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
at apply time. The frontend baseline creates/publishes a small viewer-request
CloudFront Function and associates it with every behavior so `www` returns a
path/query-preserving 301 to the apex. The same function rewrites only
extensionless, non-API `GET`/`HEAD` navigation paths to `/index.html`; `/api` and
`/api/*` always pass through unchanged. When the API front door is enabled the
helper removes legacy distribution-wide 403/404 SPA substitutions so API errors
retain their status and JSON body. It refuses to overwrite an unmanaged
viewer-request association. Add the alias using a fresh ETag, wait for
deployment, and only then apply DNS:

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

The SAM stack creates privacy-minimized API access logs, media origin/CDN access
logs, an encrypted async-failure queue, and alarms for API 5xx, API p95 latency,
DLQ depth, and login throttling. The staged account-security and observability
stacks add retained audit logs and privacy-safe detection alarms. No request or
response bodies, tokens, email addresses, album IDs, share codes, object keys,
or query strings should be added to log or notification formats.

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

The alarm registry currently records notification delivery as blocked: the
primary owner, backup owner, and two confirmed human destinations are still
unassigned. Do not call the route operational until those owners confirm both
destinations and a controlled privacy-safe test alarm succeeds. Periodically
test DLQ replay procedures with synthetic, non-sensitive payloads; never blindly
redrive old messages into production. Review log and media-log retention against
traffic, privacy, and cost after 30 days.

## Paid and deliberately deferred controls

- Route 53 DNSSEC is prepared but deferred until the registrar ceremony is
  scheduled. Its required customer-managed KMS key has ongoing key/request cost.
- The retained CloudFront WAF rollout is source controlled in COUNT mode with
  request sampling disabled and sensitive fields redacted. Moving an individual
  rule to BLOCK remains deferred until representative traffic evidence and a
  documented rollback threshold are reviewed.
- Guarded CloudTrail, Config, GuardDuty, Security Hub, Access Analyzer, Inspector,
  and AWS Backup rollouts are source controlled separately from the application
  stack. They are paid operational decisions, not proof of live enablement. Use
  the complete singleton/Region inventory and reviewed change sets in
  `SECURITY_ACCOUNT_BASELINE.md`; centralized multi-account archival remains a
  future organization-level decision.
- CloudFront standard logs, CloudWatch logs/metrics/alarms, Secrets Manager,
  DynamoDB PITR, S3 version storage, invalidations above the free allowance, and
  retained backup/log objects all have usage or storage costs. The account-budget
  template remains intentionally blocked until two human responders and an
  owner-approved monthly amount are supplied; it never creates a subscriber or
  automatically disables a security control.

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
