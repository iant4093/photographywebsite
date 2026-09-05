# Alarm registry and privacy-safe response map

The machine-readable inventory is `ops/alarm_registry.json`. It is the source
of truth for alarm-to-runbook coverage. Notification endpoints are deliberately
not stored in Git. One owner-controlled human destination is confirmed on the
central topic, which is the complete delivery requirement for this personal
website. A synthetic end-to-end delivery test should still be recorded
quarterly and after routing changes.

Only exact website backup and WAF events pass through the rule-scoped security
signal queue and strict allowlist validator. Native CloudWatch notifications
are restricted by topic policy to exact website alarm name patterns. Account
identity, managed-security, configuration, and cost signals remain available in
their source services and audit-only CloudWatch alarms but never route to this
email topic. Never copy raw events, request or response bodies, emails, album or
media identifiers, object keys, request URLs, credentials, provider errors, or
log messages into notifications, tickets, or chat.

## Common first five minutes

1. Confirm Region, signal name, transition time, current release, and whether a
   reviewed deployment or recovery drill was active.
2. Check the exact stack status and aggregate service metrics. Do not begin by
   deleting, redriving, suppressing, unlocking, or broadening access.
3. Correlate only by generated request/trace ID or CloudTrail role session.
4. If an approved release caused the signal, use its reviewed rollback path.
   Preserve evidence and retained resources.
5. Record owner, acknowledgment time, severity, safe evidence location,
   containment decision, closure proof, and follow-up due date.

## Application API health

Compare API 5xx/latency with Lambda errors, throttles, duration, and the exact
release. Verify a bounded public request before rollback. Never enable body or
query logging to diagnose an API failure.

## Front-door denial

Confirm the API custom origin, disabled default endpoint, expected secret
version, and CloudFront origin-header path. Treat unexpected direct-origin
acceptance as critical. Rotate the origin verifier only through its explicit
dual-version runbook; provider credential rotation is unrelated.

## Application async and preview

Inspect queue depth, oldest age, DLQ depth, worker aggregate reason codes, and
metadata conflict counts. Stop dispatch or the event mapping when failures are
systematic. Never purge or bulk-redrive; select only proven idempotent messages.
For hover-preview signals, also compare the builder's native errors with the
privacy-safe `ManifestBuildFailure` metric, inspect only aggregate reconciliation
state, and verify one immutable manifest through the public alias. Keep the
album-detail compatibility path enabled until the catalog reconciliation is
complete and the refresh queue has no old messages.

For `OriginalComparisonFailureAlarm` and `OriginalIndexRefreshErrorsAlarm`,
compare comparison DLQ depth and worker errors with private index freshness.
Follow [photo-original failure recovery](PHOTO_ORIGINAL_COMPARISONS.md#failure-recovery-and-retention)
to check the read-only Drive boundary and retry only proven idempotent website
jobs. Preserve the published index, retained private previews, and raw archive;
an unavailable original is a matching result rather than an indexing outage.

## Authentication and authorization

Group denials by stable reason, route template, status, and release. Separate a
client/session regression from abuse without enumerating accounts. Preserve
CAPTCHA, rate limits, JWT validation, and owner/admin/share boundaries. These
alarms are audit-only to avoid emailing on routine internet scanning.

## Application audit failure

Prove the central log group and metric filters are accepting a synthetic safe
success and denial. Audit logging must not break the user action, but a silent
audit outage remains open until event delivery and forbidden-field tests pass.

## Account identity and encryption change

Correlate root, IAM, and KMS changes to an approved operator/session. For an
unapproved change, contain the identity, preserve CloudTrail, and verify keys
remain enabled and unscheduled for deletion before restoring policy via IaC.
These are account-wide audit alarms and do not publish to the website topic.

## Trail and notification change

Verify trail logging, S3 and CloudWatch delivery, digest creation, topic policy,
EventBridge targets, retries, and DLQ depth. Never delete evidence or a failed
delivery message merely to make the dashboard green. The control-plane change
alarms are audit-only.

## Website notification delivery

Inspect the website security-event DLQ and the exact backup/WAF EventBridge
targets. Do not purge or redrive messages in bulk. Confirm the fixed signal
contract, retry only proven idempotent events, and verify the owner subscription
remains confirmed without recording its endpoint.

## Security service change

Check home-Region recorder/delivery status, the exact detector feature map and
publishing frequency, both Security Hub standards, CI security coverage,
and Access Analyzer state. Restore only through the owning templates, rerun the
fail-closed home posture audit, and record why the service changed. This
account-wide alarm is audit-only.

The configuration-change metric intentionally continues to flag creation,
update, or deletion of a Security Hub finding aggregator as unauthorized
security-topology activity. This repository does not manage an aggregator;
investigate that signal rather than treating it as expected drift.

## Data protection change

Verify S3 public access, TLS policy, encryption, versioning, and access logging;
DynamoDB PITR/deletion protection; backup vault lock/recovery points; and the
approved backup plan/selection/lifecycle/access policy; and the latest successful
copies. Planned changes still require a disposition because CloudFormation can
transiently toggle a protection.

## Infrastructure protection change

Compare CloudFormation change set, termination protection, stack policy, drift,
CloudFront configuration, and WAF association/logging. Reject unexplained
replacement, deletion, public access, direct-origin bypass, or blocking-rule
promotion.

## Backup job failure

Use aggregate AWS Backup job state and resource type. Confirm the protected
selection still has exactly the approved resource count, role access, vault
encryption, and start/completion windows. Retry only after the cause is fixed.

## Backup freshness

Treat missing metric data as a failed control. Verify the scheduled freshness
function ran, then compare aggregate expected, healthy, and failed counts. The
expected count is exactly two source resources. Do not print recovery-point
ARNs or resource ARNs. Close only after both exact metadata tables have a
completed recovery point inside the approved age window in the source vault.

## Edge health

Compare frontend and media 5xx rates and request volume by release. Both alarms
are owned by the us-east-1 WAF stack and forwarded through the exact edge event
rule to the existing home-region notification pipeline. Paid origin-latency and
cache-hit metrics are disabled. The observability stack intentionally collects no browser
telemetry and runs no synthetic browser probe; use the credential-free public
posture smoke test for release verification.

## WAF observation

Use aggregate rule labels/actions and the redacted count/block log. Email is
reserved for sustained known-bad or rate-limit blocking; the common managed
group remains in count mode and audit-only. Return only an affected
high-confidence rule to count mode after a verified false positive. Any
exclusion needs an owner, reason, expiry, regression fixture, and rollback
record.

## Delivery test and review record

Quarterly and after routing changes, send synthetic messages containing only a
test marker, signal ID, timestamp, and release. Confirm owner receipt, record
acknowledgment latency, verify the delivery DLQ remains empty, and update
`lastEndToEndTestDate` in the JSON registry. A topic ARN or pending subscription
is not successful delivery.
