# Ops notes for iantruongphotography.com

This folder holds the production runbooks, the helper scripts, and the
CloudFormation templates that sit outside the main app stack.

[`CI_CD.md`](CI_CD.md) explains how a release ships. The index below lists the
runbook for each area.

## What CI deploys and what I deploy by hand

A push to `main` runs the tested release workflow in [`CI_CD.md`](CI_CD.md).
It deploys two things: the SAM application stack (`backend/template.yaml`) and
the frontend build. That's the only way routine changes reach production.

Everything else here I deploy by hand from its runbook. That covers the WAF,
notification, CI bootstrap and budget stacks, the observability, account-security
and DNSSEC stacks, and the settings on the CloudFront frontend distribution
(through `cloudfront_frontend.py`).

The helper scripts aren't a second way to deploy. I use them for recovery, or
for a one-off infrastructure change I've already looked over. Every script that
changes something is **dry-run by default** and won't apply until you hand it
the guard values its dry run printed (account ID, counts, digests, ETags,
confirmation phrases). The procedures in this folder are still my recovery
reference, so they have to keep matching the release guards in `CI_CD.md`.

## Runbook index

| Runbook | Covers |
| --- | --- |
| [`CI_CD.md`](CI_CD.md) | Tested `main` release workflow, OIDC bootstrap, release guards |
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
| [`OBSERVABILITY.md`](OBSERVABILITY.md) | Paid CloudFront metrics, dashboard, edge alarms |

## What's in source control

- `backend/template.yaml` owns the API, the Lambda functions, Cognito, DynamoDB,
  the private media bucket, the media CloudFront distribution, logs, the
  dead-letter queue and the alarms.
- `backend/Makefile` builds Lambda artifacts from an allow-list of Python source
  files and installs pinned top-level runtime dependencies. The build can't pick
  up local OAuth or service-account JSON.
- `frontend_cloudfront_baseline.json` and `cloudfront_frontend.py` harden the
  existing frontend distribution. They won't quietly change its origin,
  certificate, DNS or logging destination.
- [`API_FRONT_DOOR.md`](API_FRONT_DOOR.md) covers the same-origin API, origin
  verification, the WAF, secret rotation, validation and rollback.
- [`PRIVATE_MEDIA.md`](PRIVATE_MEDIA.md) covers signed-cookie delivery of
  protected album media through the frontend distribution: the SAM resources,
  the `--include-private-media` edge change, rollout, verification, key
  rotation, how long revocation takes, and rollback.
- [`FOTOMOTO_PRINTS.md`](FOTOMOTO_PRINTS.md) covers the isolated print-store
  origin, what a private-gallery print link is allowed to do, the Free-plan
  preview handoff, and how I upload print-ready files by hand.
- [`PHOTO_ORIGINAL_COMPARISONS.md`](PHOTO_ORIGINAL_COMPARISONS.md) covers the
  read-only Drive matcher, private Before/After previews, the automatic
  backfill, the separate CloudFront CSP rollout, and failure recovery.
- `dns_hardening.py` manages CAA and `www` alias records once CloudFront is
  ready to serve `www`.
- `dnssec-key-template.yaml` is its own DNSSEC stack, kept apart from
  everything else on purpose.
- [`SECURITY_ACCOUNT_BASELINE.md`](SECURITY_ACCOUNT_BASELINE.md) documents the
  split account-security templates, the singleton inventory, the Inspector
  check, the restore gate, and the retained audit dependency chain. I removed
  the old all-in-one security template because it wasn't safe to deploy.
- `ci/home_security_posture.py` is a read-only scheduled check for the home
  Region that reports aggregates only. It fails unless there's one GuardDuty
  detector and one Security Hub hub with no standards enabled, and both match
  the expected features, frequency, tags and control generator. Any enabled
  Security Hub standard counts as drift, because targeted Config rules already
  cover the required checks at lower cost. It never prints provider
  identifiers, tags, Region names or findings.
- `security_budget_template.yaml` and `security_budget_preflight.py` define an
  optional retained account budget. You can pass an owner email at deploy time
  to get actual/forecast alerts above 100%. It has nothing to do with website
  incident delivery.
- Migration helpers cover existing album ownership, legacy media prefixes,
  GSIs, media visibility tags, media-cache invalidation and Lambda log
  retention (see [Operator scripts](#operator-scripts)).
- [`SECURITY_OBSERVABILITY.md`](SECURITY_OBSERVABILITY.md) defines the
  structured audit log format, the centralized Lambda log group, who owns which
  alert, the privacy rules, triage and rollback.
- [`ALARM_REGISTRY.md`](ALARM_REGISTRY.md) and `alarm_registry.json` map every
  application, WAF, observability, account-security and backup failure or
  freshness signal to a runbook that doesn't leak private data. They also split
  the signals that email me (site down, data at risk, root activity, spend) from
  the ones that are only recorded.
- `observability_template.yaml`, `observability_preflight.py` and
  [`OBSERVABILITY.md`](OBSERVABILITY.md) cover the retained paid CloudFront
  metrics, the dashboard and the edge alarms, with privacy controls on all of
  it.

The scripts look up physical table, bucket, user-pool, API, distribution and
hosted-zone IDs from the CloudFormation stack name or canonical domain you pass
in. Account IDs and current ETags are supplied at run time as guard values and
never committed. `us-west-2` is the default application Region. The DNSSEC KMS
stack has to go in `us-east-1`.

## Responsive preview V3 rollout

When you run a canary, dispatch or reconciliation, keep the same eligible
inventory digest from the canary through the full reconciliation. Don't use a
sorted `--max-jobs` slice as the production canary.

`backend/template.yaml` owns the online path for versioned responsive previews:

- `PreviewMetadataTable`, which is retained, deletion-protected, has
  point-in-time recovery, and is encrypted with DynamoDB's AWS-owned key;
- `PreviewQueue`, encrypted with SSE-SQS, plus a 14-day dead-letter queue;
- a Node.js 22 worker with reserved and event-source concurrency of two and
  partial SQS batch failure reporting; and
- a protected preview behavior that rechecks the S3 visibility tag at the
  origin, plus a strictly validated `public-previews/{albumId}/v3/...` alias
  that caches public WebP responses at the edge for one day.

The alias rewrites to the same tagged canonical S3 object, so nothing is stored
twice. Private and unlisted serializers never use it, and public visibility or
deletion changes send narrow album-level invalidations. Malformed aliases get
`no-store`, origin 403/404 responses have zero edge TTL, and the public response
policy doesn't stamp immutable browser caching onto errors. That way a preview
requested before it exists can still show up later.

The worker is its own locked Node package under `backend/preview_worker/`. The
SAM make build installs pinned Linux x86_64 native Sharp binaries into the ZIP,
even when you build on macOS. The build needs npm registry access, and it
doesn't touch the root frontend package or lockfile. Run its dependency
checks and tests yourself:

```bash
cd backend/preview_worker
npm ci
npm test
cd ../..
sam build --template-file backend/template.yaml
```

Preview metadata only ever adds derived state. New photo album creates and
appends queue V3 work only after the existing JPEG fallback is committed and
tagged. If V3 is missing, late or broken, the raw image and the current 800px
JPEG are left alone.

Historical-media backfill is dry-run by default, and it can only dispatch the
digest-bound plan I've checked (`ops/backfill_preview_v3.py`, verified
read-only with `ops/reconcile_preview_v3.py`). The online path still only adds
data, and the existing JPEG is the fallback whenever a complete ready V3 record
isn't there. Dispatch sends small `SendMessageBatch` calls and needs both the
`--expected-plan-digest` and `--confirm backfill-preview-v3` guards.

## Explore materialized index

Color, lens, exposure, time-of-day and season discovery use sparse reference
rows inside the retained `PreviewMetadataTable`. The public reader always joins
those rows back to the current preview metadata and the authoritative public
album manifest, so index rows on their own can never make private or deleted
media public.

Until the READY marker exists, the color and lens readers keep the capped scan
fallback. Exposure has its own EXPOSURE_READY marker, so a deploy can keep
serving the old five-minute snapshot until every historical exposure row is
written. Temporal readers return nothing until their versioned TEMPORAL_READY
marker exists, so a new API can't serve a half-backfilled archive.

The preview worker only derives a fixed camera-local time-of-day bucket and a
Northern Hemisphere meteorological season from the capture EXIF. Full capture
timestamps never go into the public index or out through the Explore API. If a
date is missing or malformed, the photo is marked processed-but-unclassified.
It isn't guessed from upload time or anything else that can change.

`backfill_explore_index.py` is dry-run by default and prints only aggregate
counts and a plan digest tied to the content. Apply needs the account ID, the
put/delete counts, the digest and the `APPLY_EXPLORE_INDEX_BACKFILL`
confirmation. After its batch the script writes the legacy READY and
EXPOSURE_READY markers. Then it re-reads both source tables and writes
TEMPORAL_READY only once it sees zero remaining changes. It waits for each
Explore API cache invalidation to finish before moving on.

Only run it after the online worker, album visibility and deletion paths are
deployed. For a temporal rollout:

1. Run `backfill_explore_metadata.py` with its digest-bound apply guard.
2. Wait for the preview queue to drain, and make sure the dead-letter queue
   stays at zero.
3. Do a second metadata dry run and require zero planned jobs.
4. Only then dry-run and apply the materialized index backfill.

Metadata apply also needs the AWS account ID and the planned job count from the
dry run. A matching digest in some other account doesn't count. Index apply
removes the temporal readiness marker, lets warm readiness caches expire, and
invalidates the edge before its first index write. It puts the current-version
marker back only after the post-write inventory settles, so a failed retry
stays closed until a later reconciliation succeeds.

## Random-photo materialized decks

The global and category shuffle endpoints read sharded reference decks from the
retained `PreviewMetadataTable`. A `KEYS_ONLY` stream on the album table invokes
a single-concurrency builder after content changes. The builder queries the
authoritative public album index once, publishes immutable generation shards,
switches each pool's metadata pointer, and deletes the superseded shards last.

Public requests pick a new 80-photo window every five minutes and batch-read
only the deck shards, albums and preview metadata they need. Every reference is
checked again against the current album visibility and media manifest. If a
pool is stale or malformed, the endpoint falls back to the old full scan instead
of exposing removed media.

After the first deploy, invoke `RandomPhotoPoolBuilderFunction` once and check
that it reports aggregate `poolCount` and `totalPhotos` before you clear the
public random-photo cache. Don't log category names, album IDs or media keys
while doing this.

## Album hover-preview manifests

Public photo-album cards use small immutable JSON manifests so a normal hover
doesn't load the whole album record. The manifest builder reacts to ready
preview-metadata changes and to targeted cover or visibility refresh messages.
It picks up to twelve landscape 640px WebP previews, skips the current cover,
writes a content-addressed public object, and publishes the pointer only if the
album is still active, public and unchanged. The browser then shuffles five
frames locally on each hover.

A small reconciliation page runs every fifteen minutes and gets through every
public album at least once a day. Until an album has a valid manifest pointer,
the existing public album-detail loader is the fallback. Albums marked
unavailable skip that extra request. Deployment, verification, incidents and
rollback are in [`HOVER_PREVIEW_MANIFESTS.md`](HOVER_PREVIEW_MANIFESTS.md).

## Album QR-code reconciliation

New public albums, and link-only albums with an active share, get a
deterministic SVG QR code when the album moves from pending to active. The file
sits in the album's canonical S3 prefix and uses the same `visibility` tag
check as the rest of the album. Private and revoked albums never get a QR URL
from an API serializer.

`backfill_album_qr_codes.py` fills in older albums that should have one. It's
dry-run by default and prints aggregate counts plus a deterministic plan digest.
It never prints album IDs, titles, share codes or object keys. Apply needs the
AWS account, plan count, plan digest and confirmation phrase from the dry run
you just ran. Each repair writes a pending-tagged object, commits its DynamoDB
key only if the visibility and share state haven't changed, and only then sets
the final public or unlisted tag. Run the dry run again after apply and check
that `plannedRepairCount` is zero.

## Before you change anything by hand

1. Run the full repository tests and infrastructure validation.
2. Check the active AWS identity, account, Region, stack and current drift.
3. Confirm there's a recent healthy recovery point, and save the current
   change-set and distribution metadata somewhere outside the repo.
4. Read the helper's current `--help` output, the dry-run aggregates, the
   account and resource guards, the digest or ETag, the confirmation phrase and
   the rollback.

Never save table items, object keys, credentials, provider responses, physical
resource IDs or raw production snapshots in this repo or in shared deploy
output.

## Data and secret rules that have to stay true

- `legacyS3Prefix` is the one fixed approval boundary for legacy media. Older
  prefixes that can change aren't valid input for authorization or deletion.
- All three album GSIs and the migrated owner IDs have to stay active. Run
  `check_album_indexes.py` (read-only) before any related data or template
  change.
- I keep the legacy-prefix and owner backfill tools around only for aggregate
  audits and unusual recovery. Don't rerun an apply against data that's already
  migrated without a fresh dry run, matching record count and digest guards, and
  a recovery check.
- Production provider credentials are referenced by their encrypted SSM
  SecureString parameter names. The old raw `NoEcho` transition parameters stay
  empty, and the rate-limit HMAC value stays encrypted with scoped access.
- Rotating credentials on the provider side is its own job that I approve
  separately. A release should never rotate, revoke, reveal or copy provider
  credentials as a side effect.

Every release passes the tested `ReleaseSha` and keeps every other live
parameter with `UsePreviousValue`. Application logging and alert validation are
in [`SECURITY_OBSERVABILITY.md`](SECURITY_OBSERVABILITY.md).

## How media privacy works today

Media objects carry visibility tags, direct S3 access is denied, and CloudFront
origin access refuses anything not tagged `public`. I keep the legacy tagging
helper for aggregate audits and recovery. It's not a normal deploy step. Never
turn off the deny control, retag a whole bucket, or fire a wildcard
invalidation just to get a failing smoke test to pass.

For an approved media repair, inventory the full paginated keyspace, reject
unknown or missing tags and cross-album conflicts, tie the apply to the count
and plan digest you checked, and rerun the read-only audit afterward. If you
need a cache invalidation, use `invalidate_media_cache.py` with the discovered
distribution guard and wait for it to finish. Then recheck public, private,
unlisted, download, ZIP, expired-URL and anonymous-guess behavior.

## Frontend and DNS today

The frontend distribution uses the private S3 REST origin with Origin Access
Control, hardened response headers, immutable fingerprinted assets, SPA
navigation rewriting and the path-preserving `www` redirect. The HTML shell is
compressed and cached at the edge under `IanTruong-Frontend-Shell-v1`: one day
at the edge, purged by every frontend release, while browsers still get
`no-cache`.

The `/album/*` and `/video/*` behaviors return the current SPA shell from the
existing public API origin, with social metadata the server can see for public
items only. Private, unlisted, missing or malformed IDs get the generic shell
with no record details. The homepage metadata uses the stable current-hero
alias. The move from the legacy S3 website origin to this private REST origin
is done. It isn't a routine operation, so don't replay it.

For an edge update, run `cloudfront_frontend.py` without `--apply` first. Tie
the apply to the current ETag, account and origin guards, wait for `Deployed`,
then check canonical host, deep links, sign-in, API, media, headers, caching
and direct-S3 denial. Same-origin API front-door changes follow
[`API_FRONT_DOOR.md`](API_FRONT_DOOR.md). `dns_hardening.py` must never create
an alias before the distribution advertises it, and DNS aliases on their own
don't redirect browsers.

## DNSSEC is its own ceremony

DNSSEC creates a customer-managed KMS key that costs money and adds a
dependency on the registrar. Don't deploy it as part of a normal release.

1. Confirm the registrar supports DS records and write down an on-call rollback.
2. Lower the relevant TTLs ahead of time and set up DNSSEC health/validation
   alarms.
3. Validate and deploy `ops/dnssec-key-template.yaml` in **us-east-1**, passing
   the hosted zone ID. Check the KMS monthly and per-request cost first.
4. Wait for Route 53 signing and the KSK to be healthy/`INSYNC`.
5. Get the DS record from `aws route53 get-dnssec` and add that same value at
   the registrar.
6. Validate through several independent DNSSEC resolvers for at least one TTL
   window before calling it done.

If validation fails, remove the DS record at the registrar first, wait for
caches, then turn off Route 53 signing. Never delete the retained KMS/KSK
resources while a chain of trust is active.

## Logs, alarms and routine upkeep

The SAM stack creates API access logs and media origin/CDN access logs with as
little personal data as possible, an encrypted async-failure queue, and alarms
for API 5xx, API p95 latency, front-door denials, queue/DLQ depth and age, the
preview and hover-manifest workers, and login throttling (the full list is in
[`ALARM_REGISTRY.md`](ALARM_REGISTRY.md)). The separate account-security and
observability stacks add retained audit logs and detection alarms that don't
leak private data. Don't add request or response bodies, tokens, email
addresses, album IDs, share codes, object keys or query strings to any log or
notification format.

Lambda created some of the SAM function log groups in production before
CloudFormation managed them, so their retention has to be set separately.
Preview, then apply:

```bash
python3 ops/set_lambda_log_retention.py --stack-name STACK_NAME  # --days defaults to 30
python3 ops/set_lambda_log_retention.py \
  --stack-name STACK_NAME \
  --apply \
  --expected-account-id EXPECTED_ACCOUNT_ID \
  --confirm-stack-name STACK_NAME
```

The alarm registry records one confirmed notification destination that I
control. For a personal site that's all the delivery I need, but I still record
a synthetic end-to-end delivery test every quarter and after any routing
change. Every so often, test DLQ replay with synthetic payloads that hold
nothing sensitive. Don't blindly redrive old messages into production. Review
log and media-log retention against traffic, privacy and cost after 30 days.

## Things that cost money

- Route 53 DNSSEC is ready but on hold until I schedule the registrar ceremony.
  The customer-managed KMS key it needs has an ongoing key and request cost.
- The retained CloudFront WAF is shared by the frontend and the media CDN. It
  has five rules, all in BLOCK: per-IP limits of 600 Explore, 3,000 API and
  4,000 media requests per 5 minutes, plus the AWS known-bad-inputs and IP
  reputation managed groups. Request sampling is off and sensitive fields are
  redacted. There are no global WAF circuit breakers; API Gateway stage and
  route throttles cap total API spend. Only move a single rule back to COUNT for
  a confirmed false positive, and write down the rollback.
- CloudTrail, scoped Config, GuardDuty, Security Hub, Access Analyzer and AWS
  Backup are on and live in source control separately from the application
  stack. Paid Inspector Lambda scanning is off because CI already scans source,
  dependencies, workflows and credentials. Use the home-Region singleton
  inventory, the scheduled posture audit, and change sets you've read through,
  as described in [`SECURITY_ACCOUNT_BASELINE.md`](SECURITY_ACCOUNT_BASELINE.md).
  Central multi-account archiving is a decision for later, at the organization
  level.
- CloudFront standard logs, CloudWatch logs/metrics/alarms, SSM SecureString API
  calls, DynamoDB PITR, S3 version storage, invalidations past the free
  allowance, and retained backup/log objects all cost something to use or
  store. Creating the budget needs a monthly amount I've approved. Its only
  notification is the optional direct AWS Budgets email to me. It never creates
  an SNS subscriber, sends website incident email, or switches off a security
  control on its own.

## After a release

- `curl -I` HTTP and HTTPS on the apex and `www`, a few SPA routes and a
  fingerprinted asset. Check the redirect, the
  CSP/HSTS/nosniff/frame/referrer/permissions headers, and that HTML and assets
  get the right cache control.
- Test API preflights from the canonical origin, and check that a hostile
  Origin doesn't get CORS authorization.
- Test login, the forced-password challenge, failures that don't reveal whether
  an account exists, Turnstile, rate limiting, logout/token revocation and
  Cognito recovery.
- Test public/private/unlisted album access as an anonymous user, the owner,
  another user and an admin, including the download and ZIP paths.
- Confirm DynamoDB PITR, deletion protection, S3 versioning, the public-access
  block, the TLS-only bucket policy, CloudFront OAC, media logs, API logs, the
  DLQ and the alarms.
- Watch CloudWatch error rate, latency, Lambda throttles/concurrency, DynamoDB
  throttles, S3/CloudFront 4xx/5xx, cache hit ratio and cost for at least one
  normal traffic cycle.

A successful infrastructure deploy doesn't prove privacy. The authorization
matrix and live CDN cache tests are release gates for that reason.

## Operator scripts

Every Python script supports `--help`. Scripts that change things are dry-run
by default and print aggregate counts only. To apply, pass the guards their dry
run reports.

| Script | Purpose |
| --- | --- |
| `validate_infrastructure.sh` | Local gate: compile, ops tests, template lint, SAM validate; `--build` also checks Lambda artifacts for credential-like JSON |
| `aws_stack.py` | Shared read-only AWS CLI discovery helpers (not run directly) |
| `cloudfront_frontend.py` | Frontend distribution baseline, front door, print store, private media |
| `cloudfront_www_redirect.js`, `cloudfront_social_router.js` | CloudFront viewer-request functions bound by `cloudfront_frontend.py` |
| `dns_hardening.py` | CAA and `www` alias records |
| `front_door_preflight.py` | Read-only CloudFront/WAF/API boundary check |
| `ci_bootstrap_preflight.py` | Read-only OIDC bootstrap stack check ([`CI_CD.md`](CI_CD.md)) |
| `observability_preflight.py` | Read-only CloudFront monitoring-subscription ownership check |
| `security_preflight.py`, `security_budget_preflight.py` | Read-only account-security and budget stack inventory |
| `disable_inspector_lambda_scanning.py` | Turns off paid Inspector Lambda scanning, behind guards |
| `backfill_preview_v3.py`, `reconcile_preview_v3.py` | Responsive-preview backfill and read-only verification |
| `backfill_explore_metadata.py`, `backfill_explore_index.py` | Explore metadata jobs and materialized-index reconciliation |
| `backfill_album_qr_codes.py` | Repairs QR codes for older albums |
| `backfill_album_owner_sub.py`, `backfill_legacy_media_prefix.py`, `tag_existing_media.py` | Kept-around migration/audit tools for owner IDs, legacy prefixes and visibility tags |
| `check_album_indexes.py` | Read-only album GSI readiness |
| `invalidate_media_cache.py` | Full media-CDN invalidation, behind guards |
| `set_lambda_log_retention.py` | Retention on Lambda-created log groups |
| `reconcile_durable_work.py`, `sweep_comparison_previews.py`, `recovery_reconstruction.py` | Durable-work repair, comparison-orphan cleanup, offline restore filter ([`MAINTENANCE_AND_RECOVERY.md`](MAINTENANCE_AND_RECOVERY.md)) |
| `public_catalog_load_test.py` | Small nonproduction load test; refuses the production account and domain |
| `feature_costs.py` | Per-feature cost labels and reports (below) |

The CloudFormation templates kept here (`ci_bootstrap_template.yaml`,
`dnssec-key-template.yaml`, `observability_template.yaml`,
`waf_front_door_template.yaml` and the `security_*_template.yaml` stacks) are
linted by `validate_infrastructure.sh` and deployed by hand, only through their
runbooks. `ops/ci/` holds the release and scheduled-audit tooling described in
[`CI_CD.md`](CI_CD.md).

### Feature cost reporting

`feature_costs.json` maps each SAM logical resource to a `Feature` tag value
(for example `album-management`, `discovery`, `original-comparisons` or
`shared-platform`), and the template applies those tags. `feature_costs.py`
needs `--expected-account-id` and one command:

- `tag-frontend --distribution-id ID` and `tag-frontend-storage --bucket-name
  NAME` add `Application`/`Feature` (and optional `--stage`) tags to the
  frontend distribution and bucket, which live outside CloudFormation;
- `activate` turns on the `Application`, `Stage` and `Feature` cost-allocation
  tags, and `status` reports them; and
- `report --start YYYY-MM-DD --end YYYY-MM-DD` (1–31 days, end exclusive) prints
  the Cost Explorer request, grouped by feature and service.

Every command is a dry run until you add `--apply`. `report --apply` makes one
Cost Explorer query, which is billed. Shared tables, buckets, queues and logs
stay tagged `shared-platform`, since tags can't split their usage between
callers.
