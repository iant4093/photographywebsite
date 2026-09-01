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
- [`API_FRONT_DOOR.md`](API_FRONT_DOOR.md) defines current same-origin API,
  origin-verification, WAF, rotation, validation, and rollback operations.
- [`FOTOMOTO_PRINTS.md`](FOTOMOTO_PRINTS.md) defines the isolated print-store
  origin, private-gallery capability boundary, Free-plan preview handoff, and
  manual print-ready upload procedure.
- `dns_hardening.py` manages CAA and `www` alias records after CloudFront is
  ready for `www`.
- `dnssec-key-template.yaml` is a deliberately separate, explicit DNSSEC stack.
- The separated account-security templates, singleton inventory, Inspector guard,
  restore gate, and retained audit dependency chain are documented in
  [`SECURITY_ACCOUNT_BASELINE.md`](SECURITY_ACCOUNT_BASELINE.md). The unsafe
  all-in-one security template was removed.
- `ci/home_security_posture.py` is the aggregate-only, read-only scheduled
  verifier for the home Region. It fails closed unless exactly one GuardDuty
  detector and one standards-free Security Hub hub match the reviewed feature,
  frequency, tag, and control-generator contract. Any enabled Security Hub
  standard is treated as drift because targeted Config rules provide the
  approved, cost-bounded checks. It never prints
  provider identifiers, tags, Region names, or findings.
- `security_budget_template.yaml`, `security_budget_preflight.py`, and
  [`COST_GOVERNANCE.md`](COST_GOVERNANCE.md) define an optional retained,
  console-only account budget. It has no notification route and is not part of
  website incident delivery.
- Migration helpers cover existing album ownership, GSIs, media visibility
  tags, media-cache invalidation, and Lambda log retention.
- `SECURITY_OBSERVABILITY.md` defines the structured audit contract, centralized
  Lambda log group, alert ownership, privacy rules, triage, and rollback steps.
- [`ALARM_REGISTRY.md`](ALARM_REGISTRY.md) and `alarm_registry.json` map every
  declared application, WAF, observability, account-security, and backup
  failure/freshness signal to a privacy-safe runbook, separating website email
  delivery from audit-only account signals.
- `observability_template.yaml`, `observability_preflight.py`, and
  [`OBSERVABILITY.md`](OBSERVABILITY.md) define the retained, privacy-controlled
  paid CloudFront metrics, dashboard, and edge-alarm operations.

The scripts discover physical table, bucket, user-pool, API, distribution, and
hosted-zone IDs from a caller-supplied CloudFormation stack name or canonical
domain. Account IDs and current ETags are deliberately runtime guard values and
are never committed. `us-west-2` is the application-region default; the DNSSEC
KMS stack must be deployed in `us-east-1`.

## Responsive preview V3 rollout

The exact canary, dispatch, reconciliation, monitoring, and rollback sequence is
documented in [`PREVIEW_V3.md`](PREVIEW_V3.md). Preserve its stable eligible
inventory digest across canary and full reconciliation; do not use a sorted
`--max-jobs` slice as the production canary.

`backend/template.yaml` owns the online path for versioned responsive previews:

- a retained, deletion-protected, point-in-time-recoverable
  `PreviewMetadataTable` encrypted with DynamoDB's AWS-owned key;
- an SSE-SQS encrypted `PreviewQueue` and 14-day dead-letter queue;
- a Node.js 22 worker with reserved/event-source concurrency of two and partial
  SQS batch failure reporting; and
- a protected preview behavior that rechecks the S3 visibility tag at the
  origin, plus a strictly validated `public-previews/{albumId}/v3/...` alias
  that edge-caches public WebP responses for one day. The alias rewrites to the
  same tagged canonical S3 object (no duplicate media storage), never applies
  to private/unlisted serializers, and public visibility/deletion mutations
  submit narrow album-level invalidations. Malformed aliases are `no-store`,
  origin 403/404 responses have zero edge TTL, and the public response policy
  does not override errors with immutable browser caching, so a preview
  requested before generation can recover.

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

Preview metadata is additive derivative state. New photo album creates/appends
enqueue V3 work only after the existing JPEG fallback is committed and tagged.
An absent, delayed, or failed V3 never removes or modifies the raw image or
current 800px JPEG.

Historical-media backfill is dry-run by default and may only dispatch the exact
digest-bound plan reviewed by an operator. The complete canary, apply,
reconciliation, monitoring, partial-batch, and rollback procedure lives only in
[`PREVIEW_V3.md`](PREVIEW_V3.md); do not duplicate or abbreviate its guards in a
change ticket. The online path remains additive, and the existing JPEG is the
fallback whenever a complete ready V3 record is unavailable. Dispatch uses
bounded `SendMessageBatch` calls and requires the reviewed
`--expected-plan-digest` plus `--confirm backfill-preview-v3` guards.

## Explore materialized index

Color, lens, and exposure discovery use sparse reference rows inside the retained
`PreviewMetadataTable`. The public reader always joins those references back to
the current preview metadata and authoritative public album manifest; index rows
alone can never make private or deleted media public. Until the READY marker is
present, color and lens readers retain the bounded scan fallback. Exposure uses
its own EXPOSURE_READY marker so a deployment can keep serving the legacy
five-minute snapshot until all historical exposure rows are durable.

`backfill_explore_index.py` is dry-run by default and prints only aggregate
counts plus a content-bound plan digest. Apply requires the exact account ID,
put/delete counts, digest, and `APPLY_EXPLORE_INDEX_BACKFILL` confirmation. The
script writes both readiness markers last, re-reads both source tables, verifies
zero remaining changes, and only then invalidates the Explore API cache. Run it
only after the online worker, album visibility, and deletion paths have been
deployed.

## Random-photo materialized decks

The global and category shuffle endpoints read sharded reference decks from the
retained `PreviewMetadataTable`. An album-table `KEYS_ONLY` stream invokes the
single-concurrency builder after content mutations. The builder queries the
authoritative public album index once, publishes immutable generation shards,
switches each pool's metadata pointer, and removes superseded shards last.

Public requests derive a new 80-photo window every five minutes and batch-read
only the required deck shards, albums, and preview metadata. Every reference is
rechecked against the current authoritative album visibility and media manifest;
stale or malformed pools fail over to the legacy full scan rather than exposing
removed media. After first deployment, invoke `RandomPhotoPoolBuilderFunction`
once and require aggregate `poolCount` and `totalPhotos` output before clearing
the public random-photo cache. Never log category names, album IDs, or media keys
during this reconciliation.

## Album hover-preview manifests

Public photo-album cards use small immutable JSON manifests instead of loading
the full album record on ordinary hover. The manifest builder reacts to ready
preview-metadata changes and targeted cover or visibility refresh messages. It
selects at most twelve landscape 640px WebP previews, excludes the current
cover, writes a content-addressed public object, and conditionally publishes the
pointer only while the album is still active, public, and unchanged. The browser
then shuffles five frames locally for each hover.

A bounded reconciliation page runs every fifteen minutes and completes a full
public-album cycle at least daily. Until an album has a valid manifest pointer,
the existing public album-detail loader remains the compatibility fallback;
albums explicitly marked unavailable do not issue that extra request. The
deployment, verification, incident, and rollback procedure is in
[`HOVER_PREVIEW_MANIFESTS.md`](HOVER_PREVIEW_MANIFESTS.md).

## Production change boundary

Routine production changes run only through the tested `main` release described
in [`CI_CD.md`](CI_CD.md). Operator helpers remain dry-run-first for recovery or
an explicitly reviewed infrastructure operation; they are not an alternative
deployment path.

## Album QR-code reconciliation

New public and actively shared link-only albums receive a deterministic SVG QR
asset during the guarded pending-to-active album transition. The asset stays in
the album's canonical S3 prefix and uses the same `visibility` tag authorization
boundary as the rest of the album. Private and revoked albums never receive a
QR URL from an API serializer.

`backfill_album_qr_codes.py` reconciles historical eligible albums. It is
dry-run by default and emits aggregate counts plus a deterministic plan digest;
it never prints album IDs, titles, share codes, or object keys. Apply requires
the exact AWS account, plan count, plan digest, and confirmation phrase reported
by the immediately preceding dry run. Each repair writes a pending-tagged object,
conditionally commits its DynamoDB key against the current visibility/share
state, and only then applies its final public or unlisted tag. Rerun the dry run
after apply and require `plannedRepairCount` to be zero.

Before any manual mutation:

1. run the complete repository tests and infrastructure validation;
2. verify the active AWS identity, account, Region, stack, and current drift;
3. confirm a recent healthy recovery point and preserve the current change-set
   and distribution metadata outside the repository; and
4. review the helper's current `--help` output, dry-run aggregates, exact account
   and resource guards, digest/ETag, confirmation phrase, and rollback.

Never save table items, object keys, credentials, provider responses, physical
resource identifiers, or raw production snapshots in this repository or shared
deployment output.

## Current data and secret invariants

- `legacyS3Prefix` is the immutable approval boundary for legacy media; mutable
  historical prefixes are not authorization or deletion input.
- All three album GSIs and migrated owner identifiers must remain active. Use
  `check_album_indexes.py` as a read-only readiness check before a related data
  or template change.
- Legacy-prefix and owner backfill tools are retained for aggregate audit and
  exceptional recovery only. Never rerun an apply against already-migrated data
  without a new dry run, exact record count/digest guards, and recovery review.
- Production provider credentials are referenced through exact encrypted SSM
  SecureString parameter names. Legacy raw `NoEcho` transition parameters stay
  empty, and the rate-limit HMAC value remains encrypted and access-scoped.
- Provider-side credential rotation is a separate owner-authorized operation.
  Never rotate, revoke, reveal, or copy provider credentials as a release side
  effect.

Every release passes the exact tested `ReleaseSha` and preserves all other live
parameters with `UsePreviousValue`. Application logging and alert validation are
defined in [`SECURITY_OBSERVABILITY.md`](SECURITY_OBSERVABILITY.md).

## Current media privacy boundary

Media objects use the reviewed visibility tags, direct S3 access remains denied,
and CloudFront origin access fails closed for anything not tagged exactly
`public`. The legacy tagging helper is retained for aggregate audit and guarded
recovery; it is not a routine deployment step. Never disable the deny control,
retag a full bucket, or issue a wildcard invalidation merely to make a failing
smoke test pass.

For an approved media repair, inventory the full paginated keyspace, reject
unknown/missing tags and cross-album conflicts, bind apply to the reviewed count
and plan digest, and rerun the read-only audit afterward. If a cache invalidation
is necessary, use `invalidate_media_cache.py` with the exact discovered
distribution guard and wait for completion. Recheck public, private, unlisted,
download, ZIP, expired-URL, and anonymous-guess behavior.

## Current frontend and DNS boundary

The frontend distribution uses the private S3 REST origin with Origin Access
Control, hardened response headers, immutable fingerprinted assets, short-lived
HTML, SPA navigation rewriting, and the path-preserving `www` redirect. The
dedicated `/album/*` and `/video/*` behaviors return the current SPA shell from
the existing public API origin with server-visible, public-only social metadata;
private, unlisted, missing, or malformed identifiers receive the generic shell
without record details. The homepage metadata uses the stable current-hero alias.
The
completed S3-website-origin migration is not a routine operation and must not be
replayed.

For a reviewed edge update, run `cloudfront_frontend.py` without `--apply`, bind
the apply to the exact current ETag/account/origin guards, wait for `Deployed`,
then run canonical-host, deep-link, authentication, API, media, headers, caching,
and direct-S3 denial checks. Same-origin API front-door changes follow
[`API_FRONT_DOOR.md`](API_FRONT_DOOR.md). `dns_hardening.py` must never create an
alias before the distribution advertises it; DNS aliases alone do not redirect
browsers.

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
DLQ depth, and login throttling. The separate account-security and observability
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

The alarm registry currently records notification delivery as degraded: the
site owner and one owner-controlled human destination are confirmed, while a
backup owner, second independent destination, and controlled privacy-safe
end-to-end test are still outstanding. Do not call the route fully redundant
until those remaining checks succeed. Periodically
test DLQ replay procedures with synthetic, non-sensitive payloads; never blindly
redrive old messages into production. Review log and media-log retention against
traffic, privacy, and cost after 30 days.

## Paid-control boundaries

- Route 53 DNSSEC is prepared but deferred until the registrar ceremony is
  scheduled. Its required customer-managed KMS key has ongoing key/request cost.
- The retained CloudFront WAF rollout runs known-bad input, IP reputation,
  per-IP API/Explore limits, and distributed API/Explore circuit breakers in
  BLOCK, with request sampling disabled and sensitive fields redacted. The
  circuit breakers intentionally preserve bounded origin spend over API
  availability. Return an individual rule to COUNT only for a verified false
  positive with a documented rollback.
- Guarded CloudTrail, scoped Config, GuardDuty, Security Hub, Access Analyzer,
  and AWS Backup controls are active and source controlled separately from the
  application stack. Paid Inspector Lambda scanning is disabled because CI
  already performs source, dependency, workflow, and credential scans. Use the
  home-Region singleton inventory, scheduled posture
  audit, and reviewed change sets in
  `SECURITY_ACCOUNT_BASELINE.md`; centralized multi-account archival remains a
  future organization-level decision.
- CloudFront standard logs, CloudWatch logs/metrics/alarms, SSM SecureString API
  usage, DynamoDB PITR, S3 version storage, invalidations above the free allowance, and
  retained backup/log objects all have usage or storage costs. Budget creation
  requires an owner-approved monthly amount. The budget remains console-only;
  it never creates a subscriber, sends website incident email, or automatically
  disables a security control.

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
