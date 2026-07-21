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
- `dns_hardening.py` manages CAA and `www` alias records after CloudFront is
  ready for `www`.
- `dnssec-key-template.yaml` is a deliberately separate, explicit DNSSEC stack.
- The separated account-security templates, singleton inventory, Inspector guard,
  restore gate, and retained audit dependency chain are documented in
  [`SECURITY_ACCOUNT_BASELINE.md`](SECURITY_ACCOUNT_BASELINE.md). The unsafe
  all-in-one security template was removed.
- `ci/home_security_posture.py` is the aggregate-only, read-only scheduled
  verifier for the home Region. It fails closed unless exactly one GuardDuty
  detector and one Security Hub hub match the reviewed feature, frequency,
  tag, control-generator, and two-standard contract. A provider `PENDING`
  transition is accepted only while both standards remain fully updatable and
  have no failure reason. It never prints
  provider identifiers, tags, Region names, or findings.
- `security_budget_template.yaml`, `security_budget_preflight.py`, and
  [`COST_GOVERNANCE.md`](COST_GOVERNANCE.md) define a retained, alert-only
  account budget. No budget is created until an owner approves the amount and
  one owner-controlled human notification destination is confirmed. The wider
  alarm-routing readiness gate still requires primary and backup responders.
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
  paid CloudFront metrics, dashboard, and edge-alarm operations.

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

Preview metadata is additive derivative state. New photo album creates/appends
enqueue V2 work only after the existing JPEG fallback is committed and tagged.
An absent, delayed, or failed V2 never removes or modifies the raw image or
current 800px JPEG.

Historical-media backfill is dry-run by default and may only dispatch the exact
digest-bound plan reviewed by an operator. The complete canary, apply,
reconciliation, monitoring, partial-batch, and rollback procedure lives only in
[`PREVIEW_V2.md`](PREVIEW_V2.md); do not duplicate or abbreviate its guards in a
change ticket. The online path remains additive, and the existing JPEG is the
fallback whenever a complete ready V2 record is unavailable. Dispatch uses
bounded `SendMessageBatch` calls and requires the reviewed
`--expected-plan-digest` plus `--confirm backfill-preview-v2` guards.

## Production change boundary

Routine production changes run only through the tested `main` release described
in [`CI_CD.md`](CI_CD.md). Operator helpers remain dry-run-first for recovery or
an explicitly reviewed infrastructure operation; they are not an alternative
deployment path.

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
- Production provider credentials are referenced through Secrets Manager ARNs.
  Legacy raw `NoEcho` transition parameters stay empty, and the rate-limit HMAC
  secret is stack generated and retained.
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

The alarm registry currently records notification delivery as blocked: the
primary owner, backup owner, and two confirmed human destinations are still
unassigned. Do not call the route operational until those owners confirm both
destinations and a controlled privacy-safe test alarm succeeds. Periodically
test DLQ replay procedures with synthetic, non-sensitive payloads; never blindly
redrive old messages into production. Review log and media-log retention against
traffic, privacy, and cost after 30 days.

## Paid-control boundaries

- Route 53 DNSSEC is prepared but deferred until the registrar ceremony is
  scheduled. Its required customer-managed KMS key has ongoing key/request cost.
- The retained CloudFront WAF rollout keeps the common managed group in COUNT
  and runs known-bad input, IP reputation, and per-IP rate rules in BLOCK, with
  request sampling disabled and sensitive fields redacted. Return an individual
  rule to COUNT only for a verified false positive with a documented rollback.
- Guarded CloudTrail, Config, GuardDuty, Security Hub, Access Analyzer, Inspector,
  and AWS Backup controls are active and source controlled separately from the
  application stack. Use the home-Region singleton inventory, scheduled posture
  audit, and reviewed change sets in
  `SECURITY_ACCOUNT_BASELINE.md`; centralized multi-account archival remains a
  future organization-level decision.
- CloudFront standard logs, CloudWatch logs/metrics/alarms, Secrets Manager,
  DynamoDB PITR, S3 version storage, invalidations above the free allowance, and
  retained backup/log objects all have usage or storage costs. Budget creation
  requires an owner-approved monthly amount and one confirmed owner-controlled
  destination; the complete alert route remains non-operational until a backup
  responder and second destination are tested. The budget never creates a
  subscriber or automatically disables a security control.

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
