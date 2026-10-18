# Ops notes for iantruongphotography.com

This folder holds the production runbooks, the helper scripts, and the
CloudFormation templates that are deployed separately from the main application
stack. [`CI_CD.md`](CI_CD.md) describes how a release ships. The index below
lists the runbook for each area.

## CI deployments and manual deployments

A push to `main` runs the `Release production` workflow
(`.github/workflows/release-production.yml`, described in
[`CI_CD.md`](CI_CD.md)). It deploys the SAM application stack
(`backend/template.yaml`) and the frontend build. The `manual-release.yml`
workflow redeploys the frontend, the backend or both from an earlier successful
production run. These two workflows are the only automated path to production.

The remaining stacks and settings are deployed by hand from their runbooks:

- the WAF stack (`waf_front_door_template.yaml`);
- the CI bootstrap stack (`ci_bootstrap_template.yaml`);
- the account-security stacks (`security_*_template.yaml`, including
  notifications and the budget);
- the observability stack (`observability_template.yaml`);
- the DNSSEC stack (`dnssec-key-template.yaml`);
- the CloudFront frontend distribution settings, through
  `cloudfront_frontend.py`.

The helper scripts are for recovery and for reviewed one-off infrastructure
changes, not for routine deploys. Scripts that change resources are
dry-run by default. Apply requires the guard values printed by the dry run
(account ID, counts, digests, ETags, confirmation phrases).

## Runbook index

| Runbook | Covers |
| --- | --- |
| [`CI_CD.md`](CI_CD.md) | `main` release workflow, manual redeploys, OIDC bootstrap, release guards |
| [`API_FRONT_DOOR.md`](API_FRONT_DOOR.md) | Same-origin API, origin verification, WAF, rotation, rollback |
| [`PRIVATE_MEDIA.md`](PRIVATE_MEDIA.md) | Signed-cookie delivery of protected album media |
| [`FOTOMOTO_PRINTS.md`](FOTOMOTO_PRINTS.md) | Isolated print-store origin and manual print-file delivery |
| [`PHOTO_ORIGINAL_COMPARISONS.md`](PHOTO_ORIGINAL_COMPARISONS.md) | Drive original matching and private Before/After previews |
| [`HOVER_PREVIEW_MANIFESTS.md`](HOVER_PREVIEW_MANIFESTS.md) | Album-card hover manifests, reconciliation, rollback |
| [`MAINTENANCE_AND_RECOVERY.md`](MAINTENANCE_AND_RECOVERY.md) | Dependency updates, durable-work repair, comparison cleanup, restore drills |
| [`PRIVACY_REQUESTS.md`](PRIVACY_REQUESTS.md) | Privacy request intake, inventory, erasure, retention review |
| [`SECURITY_ACCOUNT_BASELINE.md`](SECURITY_ACCOUNT_BASELINE.md) | Account-security stacks, singleton inventory, backup restore gate |
| [`SECURITY_OBSERVABILITY.md`](SECURITY_OBSERVABILITY.md) | Structured audit logging, alert ownership, triage |
| [`ALARM_REGISTRY.md`](ALARM_REGISTRY.md) | Alarm-to-runbook map and notification delivery |
| [`OBSERVABILITY.md`](OBSERVABILITY.md) | Free CloudFront metrics dashboard, edge 5xx alarms, API metrics |

## What's in source control

- `backend/template.yaml` defines the API, the Lambda functions, Cognito,
  DynamoDB, the media bucket, the media CloudFront distribution, logs, the
  dead-letter queues and the application alarms.
- `backend/Makefile` builds each Lambda artifact from an explicit allow-list of
  Python source files and installs pinned runtime dependencies. Local OAuth or
  service-account JSON files are not copied into an artifact.
- `frontend_cloudfront_baseline.json` and `cloudfront_frontend.py` manage the
  frontend distribution settings. The script makes no certificate, DNS, origin
  or logging change unless a flag asks for it.
- [`API_FRONT_DOOR.md`](API_FRONT_DOOR.md) covers the same-origin API, origin
  verification, the WAF, secret rotation, validation and rollback.
- [`PRIVATE_MEDIA.md`](PRIVATE_MEDIA.md) covers signed-cookie delivery of
  protected album media through the frontend distribution: the SAM resources,
  the `--include-private-media` edge change, rollout, verification, key
  rotation, revocation timing, and rollback.
- [`FOTOMOTO_PRINTS.md`](FOTOMOTO_PRINTS.md) covers the isolated print-store
  origin, the scope of a private-gallery print link, the Free-plan preview
  handoff, and manual upload of print-ready files.
- [`PHOTO_ORIGINAL_COMPARISONS.md`](PHOTO_ORIGINAL_COMPARISONS.md) covers the
  read-only Drive matcher, private Before/After previews, the backfill, the
  separate CloudFront CSP rollout, and failure recovery.
- `dns_hardening.py` manages CAA records and the `www` alias record once the
  CloudFront distribution lists `www` as an alias.
- `dnssec-key-template.yaml` is a separate DNSSEC stack (see
  [DNSSEC](#dnssec)).
- [`SECURITY_ACCOUNT_BASELINE.md`](SECURITY_ACCOUNT_BASELINE.md) documents the
  account-security templates (`security_audit_foundation_template.yaml`,
  `security_notifications_template.yaml`,
  `security_managed_services_template.yaml`, `security_backup_template.yaml`,
  `security_backup_replica_template.yaml`, `security_budget_template.yaml`), the
  singleton inventory, the Inspector check, the restore gate, and the retained
  audit dependency chain.
- `ci/home_security_posture.py` is a read-only check of the home Region, run by
  the weekly scheduled audit. It fails unless there is one GuardDuty detector
  and one Security Hub hub with no standards enabled, matching the expected
  features, publishing frequency, tags and control finding generator. It prints
  aggregate counts only, never identifiers, tags, Region names or findings.
- `security_budget_template.yaml` and `security_budget_preflight.py` define an
  optional retained monthly cost budget. An owner email passed at deploy time
  receives AWS Budgets alerts when actual or forecasted spend exceeds 100% of
  the limit. The budget is separate from website incident delivery.
- Migration helpers cover album ownership, legacy media prefixes, GSIs, media
  visibility tags, media-cache invalidation and Lambda log retention (see
  [Operator scripts](#operator-scripts)).
- [`SECURITY_OBSERVABILITY.md`](SECURITY_OBSERVABILITY.md) defines the
  structured audit log format, the centralized Lambda log group, alert
  ownership, privacy rules, triage and rollback.
- [`ALARM_REGISTRY.md`](ALARM_REGISTRY.md) and `alarm_registry.json` map each
  application, WAF, observability, account-security, backup and budget signal
  to a runbook. The registry records which signals send email (API and edge
  5xx, failed async work, root activity, notification delivery failures, backup
  failures and freshness, spend) and which are only recorded in CloudWatch.
- `observability_template.yaml` and [`OBSERVABILITY.md`](OBSERVABILITY.md) cover
  the CloudWatch dashboard of free CloudFront metrics. `observability_preflight.py`
  checks CloudFront monitoring-subscription ownership before a stack change.

Most scripts look up physical table, bucket, user-pool, API, distribution and
hosted-zone IDs from the CloudFormation stack name or canonical domain passed
in. Account IDs and current ETags are passed at run time as guard values.
`us-west-2` is the default application Region. The DNSSEC KMS stack must be
deployed in `us-east-1`.

## Responsive preview V3 rollout

During a canary, dispatch or reconciliation, keep the same eligible inventory
digest from the canary through the full reconciliation. Use
`--representative-canary` for the production canary, not a sorted
`--max-jobs` slice.

`backend/template.yaml` defines the online path for versioned responsive
previews:

- `PreviewMetadataTable`: retained, deletion protection on, point-in-time
  recovery on, encrypted with the AWS managed DynamoDB KMS key;
- `PreviewQueue`: SSE-SQS encryption, 14-day retention, and a dead-letter queue
  after five receives;
- `PreviewWorkerFunction`: Node.js 22 on x86_64, reserved concurrency of two,
  SQS event-source maximum concurrency of two, and partial batch failure
  reporting;
- a protected preview behavior with zero edge TTL, so each uncached request
  rechecks the S3 visibility tag at the origin, plus a validated
  `public-previews/{albumId}/v3/...` alias that caches public WebP responses at
  the edge for one day.

The alias rewrites to the same tagged canonical S3 object, so no object is
stored twice. Private and unlisted serializers never use it. Public visibility
and deletion changes send album-level invalidations. Malformed aliases get
`private, no-store`, origin 403/404 responses have zero edge TTL, and the public
response policy doesn't add immutable browser caching to errors. A preview
requested before it exists can therefore appear later.

The worker is a separate locked Node package under `backend/preview_worker/`.
The SAM makefile build runs `npm ci` for Linux x86_64 (glibc), so the ZIP gets
the Linux Sharp binaries even when built on macOS. The build needs npm registry
access and doesn't touch the root frontend package or lockfile. Run its
dependency install and tests:

```bash
cd backend/preview_worker
npm ci
npm test
cd ../..
sam build --template-file backend/template.yaml
```

Preview metadata only adds derived state. New photo album creates and appends
queue V3 work only after the 800px JPEG fallback is committed and tagged. If V3
is missing, late or broken, the original image and the 800px JPEG are not
changed.

Historical-media backfill is dry-run by default and dispatches only the
digest-bound plan from the dry run (`ops/backfill_preview_v3.py`, verified
read-only with `ops/reconcile_preview_v3.py`). The existing JPEG is the
fallback whenever a complete ready V3 record is missing. Dispatch sends
`SendMessageBatch` calls of up to 10 messages and needs the
`--expected-account-id`, `--expected-record-count`,
`--expected-preview-record-count`, `--expected-job-count`,
`--expected-plan-digest`, `--confirm-stack-name` and
`--confirm backfill-preview-v3` guards.

## Explore materialized index

Color, lens, exposure, time-of-day and season discovery use sparse reference
rows in the retained `PreviewMetadataTable`. The public reader joins those rows
back to the current preview metadata and the public album manifest, so index
rows alone cannot make private or deleted media public.

Until the READY marker exists, the color and lens readers use the capped scan
fallback. Exposure has its own EXPOSURE_READY marker; until it exists, the
reader serves the five-minute cached scan. Temporal readers return no results
until the versioned TEMPORAL_READY marker exists, so a new API cannot serve a
partly backfilled archive.

The preview worker derives a camera-local time-of-day bucket and a Northern
Hemisphere meteorological season from the capture EXIF. Full capture
timestamps are not written to the public index or returned by the Explore API.
If a date is missing or malformed, the photo is marked processed but
unclassified. It is not inferred from upload time or other mutable fields.

`backfill_explore_index.py` is dry-run by default and prints aggregate counts
and a content-bound plan digest. Apply needs the account ID, the put and delete
counts, the digest and the `APPLY_EXPLORE_INDEX_BACKFILL` confirmation, and it
refuses while Explore metadata is incomplete. Apply then:

1. Deletes the TEMPORAL_READY marker and waits 31 seconds for warm readiness
   caches (30 seconds) to expire.
2. Invalidates `/api/public/explore*` on the frontend distribution and waits
   for the invalidation to finish.
3. Writes the index rows, then the READY and EXPOSURE_READY markers.
4. Re-reads both source tables and writes TEMPORAL_READY only if no changes
   remain, followed by a second invalidation.

If changes remain, the script exits non-zero and TEMPORAL_READY stays absent
until a later run succeeds.

Run it only after the online worker, album visibility and deletion paths are
deployed. For a temporal rollout:

1. Run `backfill_explore_metadata.py` with its apply guards (account ID, job
   count, plan digest, stack name and confirmation phrase).
2. Wait for the preview queue to drain, and confirm the dead-letter queue stays
   at zero.
3. Run a second metadata dry run and require zero planned jobs.
4. Dry-run and apply the materialized index backfill.

## Random-photo materialized decks

The global and category shuffle endpoints read sharded reference decks from the
retained `PreviewMetadataTable`. Refresh messages on `RandomPhotoRefreshQueue`
and an hourly schedule invoke `RandomPhotoPoolBuilderFunction` (reserved
concurrency of one). Its album-table stream mapping is kept in the template but
disabled. The builder
publishes immutable generation shards, switches each pool's metadata pointer,
and deletes the superseded shards last.

Public requests pick an 80-photo window that changes every five minutes and
read only the deck shards, albums and preview metadata they need. Each
reference is checked against the current album visibility and media manifest.
If a pool is missing or malformed, the endpoint falls back to a scan.

After the first deploy, invoke `RandomPhotoPoolBuilderFunction` once and check
that it reports aggregate `poolCount` and `totalPhotos` before clearing the
public random-photo cache. Don't log category names, album IDs or media keys
during this check.

## Album hover-preview manifests

Public photo-album cards use small immutable JSON manifests, so a hover doesn't
load the whole album record. The manifest builder runs on ready
preview-metadata changes and on cover or visibility refresh messages. It picks
up to twelve landscape 640px WebP previews, skips the current cover, writes a
content-addressed public object, and publishes the pointer only if the album is
still active, public and unchanged. The browser then shuffles up to five frames
locally on each hover (three on mobile).

A reconciliation page runs every fifteen minutes and covers each public album
at least once a day. Until an album has a valid manifest pointer, the existing
public album-detail loader is the fallback. Albums marked unavailable skip that
extra request. Deployment, verification, incidents and rollback are in
[`HOVER_PREVIEW_MANIFESTS.md`](HOVER_PREVIEW_MANIFESTS.md).

## Album QR-code reconciliation

Public albums, and unlisted albums with an active share, get a deterministic
SVG QR code when the album moves from pending to active. The file is stored in
the album's canonical S3 prefix and uses the same `visibility` tag check as the
rest of the album. API serializers never return a QR URL for private or
revoked albums.

`backfill_album_qr_codes.py` adds QR codes to older eligible albums. It is
dry-run by default and prints aggregate counts plus a deterministic plan
digest. It never prints album IDs, titles, share codes or object keys. Apply
needs the AWS account ID, plan count, plan digest and the
`APPLY_ALBUM_QR_BACKFILL` confirmation from the dry run. Each repair writes a
pending-tagged object, commits its DynamoDB key only if the visibility and
share state are unchanged, and then sets the final public or unlisted tag. Run
the dry run again after apply and check that `plannedRepairCount` is zero.

## Before a manual change

1. Run the full repository tests and `ops/validate_infrastructure.sh`.
2. Check the active AWS identity, account, Region, stack and current drift.
3. Confirm a recent completed recovery point exists, and save the current
   change set and distribution metadata outside the repository.
4. Read the helper's `--help` output, the dry-run aggregates, the account and
   resource guards, the digest or ETag, the confirmation phrase and the
   rollback.

Never save table items, object keys, credentials, provider responses, physical
resource IDs or raw production snapshots in this repository or in shared deploy
output.

## Data and secret rules

- `legacyS3Prefix` is the fixed approval boundary for legacy media. Other
  stored prefixes are not valid input for authorization or deletion.
- All four album GSIs (`ShareCodeIndex`, `VisibilityCreatedAtIndex`,
  `VisibilityCreatedAtSummaryIndex`, `OwnerSubCreatedAtIndex`) and the migrated
  owner IDs must stay active. Run `check_album_indexes.py` (read-only) before
  any related data or template change.
- The legacy-prefix and owner backfill tools are kept for aggregate audits and
  recovery. Don't rerun an apply against migrated data without a fresh dry run,
  matching record count and digest guards, and a recovery check.
- Production provider credentials are referenced by their encrypted SSM
  SecureString parameter names. The legacy `NoEcho` parameters (`ResendApiKey`,
  `TurnstileSecretKey`) stay empty, and the rate-limit HMAC value
  (`/ian-website/<stage>/rate-limit-hash`) stays encrypted with scoped read
  access.
- Provider-side credential rotation is a separate, separately approved task. A
  release must not rotate, revoke, reveal or copy provider credentials.

Each release passes the tested `ReleaseSha`, adds the values listed in
`ops/ci/release_parameter_additions.json` for new parameters, and keeps every
other live parameter with `UsePreviousValue`. Application logging and alert
validation are in [`SECURITY_OBSERVABILITY.md`](SECURITY_OBSERVABILITY.md).

## Media privacy

Media objects carry `visibility` tags. The media bucket blocks public access
and denies non-TLS requests. The bucket policy denies the media distribution
any object not tagged `public` when `EnforcePrivateMediaCloudFrontDeny` is
`true` (the production setting), and always does so for responsive previews.
The frontend distribution can read `albums/*` only through the signed-cookie
`private-media/*` behavior described in [`PRIVATE_MEDIA.md`](PRIVATE_MEDIA.md).
The legacy tagging helper (`tag_existing_media.py`) is for aggregate audits and
recovery, not a deploy step. Never turn off the deny control, retag a whole
bucket, or run a wildcard invalidation to make a failing smoke test pass.

For an approved media repair, inventory the full paginated keyspace, reject
unknown or missing tags and cross-album conflicts, bind the apply to the
reviewed count and plan digest, and rerun the read-only audit afterward. For a
cache invalidation, use `invalidate_media_cache.py` with the discovered
distribution guard and wait for it to finish. Then recheck public, private,
unlisted, download, ZIP, expired-URL and anonymous-guess behavior.

## Frontend and DNS

The frontend distribution uses the private S3 REST origin with Origin Access
Control, hardened response headers, immutable fingerprinted assets, SPA
navigation rewriting and the path-preserving `www` redirect. The HTML shell is
compressed and cached at the edge for one day under the
`IanTruong-Frontend-Shell-v1` cache policy. Browsers get
`no-cache, max-age=0, must-revalidate`. A frontend release that changes any
file invalidates `/*`; an unchanged redeploy creates no invalidation.

The `album/*` and `video/*` behaviors return the current SPA shell from the
public API origin, with server-rendered social metadata for public items only.
Private, unlisted, missing or malformed IDs get the generic shell with no
record details. The homepage metadata uses the stable current-hero alias. The
migration from the S3 website origin to the private REST origin is complete and
is not a repeatable procedure.

For an edge update, run `cloudfront_frontend.py` without `--apply` first. Bind
the apply to the current ETag, account and origin guards, wait for `Deployed`,
then check the canonical host, deep links, sign-in, API, media, headers,
caching and direct-S3 denial. Same-origin API front-door changes follow
[`API_FRONT_DOOR.md`](API_FRONT_DOOR.md). `dns_hardening.py` refuses to create
the `www` alias before the distribution lists it, and DNS aliases alone don't
redirect browsers.

## DNSSEC

DNSSEC is prepared but not enabled: the template is in the repository and the
hosted zone is not signing. Enabling it creates a customer-managed KMS key with
a monthly and per-request cost and adds a dependency on the registrar. It is
not part of a normal release.

1. Confirm the registrar supports DS records and write down a rollback plan.
2. Lower the relevant TTLs ahead of time and set up DNSSEC health and
   validation alarms.
3. Validate and deploy `ops/dnssec-key-template.yaml` in `us-east-1`, passing
   the `HostedZoneId`. The stack creates the KMS key, the key-signing key and
   enables zone signing. Check the KMS cost first.
4. Wait for Route 53 signing and the KSK to report healthy and `INSYNC`.
5. Get the DS record from `aws route53 get-dnssec` and add the same value at
   the registrar.
6. Validate through several independent DNSSEC resolvers for at least one TTL
   window.

If validation fails, remove the DS record at the registrar first, wait for
caches to expire, then turn off Route 53 signing. Never delete the retained KMS
or KSK resources while a chain of trust is active.

## Logs, alarms and routine upkeep

The SAM stack creates the API access log group, the media CDN access-log
bucket, an encrypted async-failure queue, and alarms for API 5xx, API p95
latency, front-door denials, queue and DLQ depth and age, the preview and
hover-manifest workers, ZIP and comparison failures, audit failures and login
throttling. The full list is in [`ALARM_REGISTRY.md`](ALARM_REGISTRY.md). The
account-security and observability stacks add retained audit logs and detection
alarms. Don't add request or response bodies, tokens, email addresses, album
IDs, share codes, object keys or query strings to any log or notification
format.

The SAM functions write to the shared `ApplicationLogGroup`
(`/ian-photography/application/<stage>`) through the template's `LoggingConfig`.
Older per-function `/aws/lambda/<name>` log groups created by Lambda are not
managed by CloudFormation, so set their retention separately. Preview, then
apply:

```bash
python3 ops/set_lambda_log_retention.py --stack-name STACK_NAME  # --days defaults to 30
python3 ops/set_lambda_log_retention.py \
  --stack-name STACK_NAME \
  --apply \
  --expected-account-id EXPECTED_ACCOUNT_ID \
  --confirm-stack-name STACK_NAME
```

The alarm registry records one confirmed notification destination. Record a
synthetic end-to-end delivery test at least every 90 days (`testIntervalDays`
in `alarm_registry.json`) and after any routing change. Test DLQ replay with
synthetic payloads that contain no sensitive data. Don't redrive old messages
into production without reviewing them. Review log and media-log retention
against traffic, privacy and cost.

## Cost notes

- DNSSEC is not enabled (see [DNSSEC](#dnssec)). Enabling it adds a
  customer-managed KMS key with an ongoing key and request cost.
- The retained CloudFront WAF web ACL is attached to both the frontend and the
  media distribution. It has five rules: per-IP limits of 600 Explore, 3,000
  API and 4,000 media requests per 5 minutes (all BLOCK; the media rule is
  scoped to the media CDN host), plus the AWS known-bad-inputs and Amazon IP
  reputation managed groups with their default actions. Request sampling is
  off, the `authorization`, `cookie` and `x-origin-verify` headers and the query
  string are redacted from WAF logs, and only blocked requests are logged. There are no global WAF
  circuit breakers; API Gateway stage and route throttles limit total API
  request rates. Move a single rule to COUNT only for a confirmed false
  positive, and write down the rollback.
- CloudTrail, scoped Config, GuardDuty, Security Hub, IAM Access Analyzer and
  AWS Backup are enabled in the home Region and defined in templates separate
  from the application stack. Paid Inspector Lambda and Lambda code scanning
  are disabled; CI runs dependency audits, CodeQL, workflow policy checks and
  credential scans. Use the home-Region singleton inventory, the scheduled
  security audit, and reviewed change sets, as described in
  [`SECURITY_ACCOUNT_BASELINE.md`](SECURITY_ACCOUNT_BASELINE.md).
- CloudFront standard logs, CloudWatch logs, metrics and alarms, SSM
  SecureString API calls, DynamoDB PITR, S3 version storage, invalidations past
  the free allowance, and retained backup and log objects are billed by usage
  or storage. Creating the budget requires a positive `MonthlyLimitUsd`. Its
  only notification is the optional AWS Budgets email. It creates no SNS
  subscription, sends no website incident email, and doesn't change any
  security control.

## After a release

- Run `curl -I` against HTTP and HTTPS on the apex and `www`, a few SPA routes
  and a fingerprinted asset. Check the redirect, the
  CSP/HSTS/nosniff/frame/referrer/permissions headers, and the cache control
  on HTML and assets.
- Test API preflights from the canonical origin, and check that a hostile
  Origin doesn't get CORS authorization.
- Test login, the forced-password challenge, failures that don't reveal whether
  an account exists, Turnstile, rate limiting, logout and token revocation, and
  Cognito recovery.
- Test public, private and unlisted album access as an anonymous user, the
  owner, another user and an admin, including the download and ZIP paths.
- Confirm DynamoDB PITR, deletion protection, S3 versioning, the public-access
  block, the TLS-only bucket policy, CloudFront OAC, media logs, API logs, the
  DLQ and the alarms.
- Watch CloudWatch error rate, latency, Lambda throttles and concurrency,
  DynamoDB throttles, S3 and CloudFront 4xx/5xx, cache hit ratio and cost for
  at least one normal traffic cycle.

A successful deploy does not by itself show that privacy controls work. The
release workflow's public smoke test (`ops/ci/public_smoke.sh`) checks
anonymous denial on a protected endpoint, that the denial is not served from
cache, direct-bucket denial and hostile-origin CORS. The authenticated checks
above are manual.

## Operator scripts

Every runnable script supports `--help`. Scripts that change resources are
dry-run by default; most print aggregate counts only. To apply, pass the guards
reported by the dry run.

| Script | Purpose |
| --- | --- |
| `validate_infrastructure.sh` | Local gate: compile, ops tests, template lint (cfn-lint or `sam validate --lint`), SAM validate, preview worker tests; `--build` also runs `sam build` and checks Lambda artifacts for credential-like JSON |
| `aws_stack.py` | Shared read-only AWS CLI discovery helpers (not run directly) |
| `cloudfront_frontend.py` | Frontend distribution baseline, `www` redirect, front door, print store, private media |
| `cloudfront_www_redirect.js`, `cloudfront_social_router.js` | CloudFront viewer-request functions bound by `cloudfront_frontend.py` |
| `dns_hardening.py` | CAA and `www` alias records |
| `front_door_preflight.py` | Read-only CloudFront/WAF/API boundary check |
| `ci_bootstrap_preflight.py` | Read-only OIDC bootstrap stack check ([`CI_CD.md`](CI_CD.md)) |
| `observability_preflight.py` | Read-only CloudFront monitoring-subscription ownership check |
| `security_preflight.py`, `security_budget_preflight.py` | Read-only account-security and budget stack inventory |
| `disable_inspector_lambda_scanning.py` | Disables paid Inspector Lambda and Lambda code scanning, behind guards |
| `backfill_preview_v3.py`, `reconcile_preview_v3.py` | Responsive-preview backfill and read-only verification |
| `backfill_explore_metadata.py`, `backfill_explore_index.py` | Explore metadata jobs and materialized-index reconciliation |
| `backfill_album_qr_codes.py` | Adds QR codes to older eligible albums |
| `backfill_album_owner_sub.py`, `backfill_legacy_media_prefix.py`, `tag_existing_media.py` | Migration and audit tools for owner IDs, legacy prefixes and visibility tags |
| `check_album_indexes.py` | Read-only album GSI readiness |
| `invalidate_media_cache.py` | Full (`/*`) media-CDN invalidation, behind guards |
| `set_lambda_log_retention.py` | Retention on Lambda-created log groups |
| `reconcile_durable_work.py`, `sweep_comparison_previews.py`, `recovery_reconstruction.py` | Durable-work repair, comparison-orphan cleanup, offline restore filter ([`MAINTENANCE_AND_RECOVERY.md`](MAINTENANCE_AND_RECOVERY.md)) |
| `public_catalog_load_test.py` | Small nonproduction load test; refuses the production account and domain |
| `feature_costs.py` | Per-feature cost labels and reports (below) |

The CloudFormation templates in this folder (`ci_bootstrap_template.yaml`,
`dnssec-key-template.yaml`, `observability_template.yaml`,
`waf_front_door_template.yaml` and the six `security_*_template.yaml` files)
are linted by `validate_infrastructure.sh` and deployed by hand through their
runbooks. `ops/ci/` holds the release and scheduled-audit tooling described in
[`CI_CD.md`](CI_CD.md).

### Feature cost reporting

`feature_costs.json` maps each SAM logical resource to a `Feature` tag value
(for example `album-management`, `discovery`, `original-comparisons` or
`shared-platform`), and the template applies those tags. `feature_costs.py`
requires `--expected-account-id` and one command:

- `tag-frontend --distribution-id ID` and `tag-frontend-storage --bucket-name
  NAME` add `Application` and `Feature` tags (and `Stage` with `--stage`) to the
  frontend distribution and bucket, which are outside CloudFormation;
- `activate` activates the `Application`, `Stage` and `Feature` cost-allocation
  tags, and `status` reports their state; and
- `report --start YYYY-MM-DD --end YYYY-MM-DD` (1 to 31 days, end exclusive)
  prints the Cost Explorer request, grouped by feature and service.

`tag-frontend`, `tag-frontend-storage`, `activate` and `report` are dry runs
until `--apply` is added. `report --apply` makes one billed Cost Explorer
query. Shared tables, buckets, queues and logs stay tagged `shared-platform`,
because tags can't split their usage between callers.
