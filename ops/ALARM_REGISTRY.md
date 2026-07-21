# Alarm registry and privacy-safe response map

The machine-readable inventory is `ops/alarm_registry.json`. It is the source
of truth for alarm-to-runbook coverage. Notification endpoints are deliberately
not stored in Git. One owner-controlled human destination is confirmed on the
central topic. Delivery remains degraded until a backup responder is assigned,
a second destination is confirmed, and a synthetic end-to-end delivery test is
recorded.

EventBridge findings and backup events pass through the exact-rule security
signal queue and a strict allowlist validator, so only fixed signal names,
severity, stage, and runbook IDs reach the topic. Native CloudWatch and Budget
notifications may additionally contain stable AWS alarm/budget names, account
scope, aggregate metric or cost state, and AWS-generated state reasons. Never
copy raw findings or Backup events, request or response bodies, emails, album or
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

## Authentication and authorization

Group denials by stable reason, route template, status, and release. Separate a
client/session regression from abuse without enumerating accounts. Preserve
CAPTCHA, rate limits, JWT validation, and owner/admin/share boundaries.

## Application audit failure

Prove the central log group and metric filters are accepting a synthetic safe
success and denial. Audit logging must not break the user action, but a silent
audit outage remains open until event delivery and forbidden-field tests pass.

## Account identity and encryption change

Correlate root, IAM, and KMS changes to an approved operator/session. For an
unapproved change, contain the identity, preserve CloudTrail, and verify keys
remain enabled and unscheduled for deletion before restoring policy via IaC.

## Trail and notification change

Verify trail logging, S3 and CloudWatch delivery, digest creation, topic policy,
EventBridge targets, retries, and DLQ depth. Never delete evidence or a failed
delivery message merely to make the dashboard green.

## Security service change

Check home-Region recorder/delivery status, the exact detector feature map and
publishing frequency, both Security Hub standards, Inspector Lambda coverage,
and Access Analyzer state. Restore only through the owning templates, rerun the
fail-closed home posture audit, and record why the service changed.

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

## Managed security findings

The notification deliberately contains no raw GuardDuty or Security Hub finding.
Open the source service in the signaled Region using an approved incident role,
then review severity, resource scope, evidence, and workflow there. Preserve the
finding, contain the affected resource or identity through its owning control,
and record only a sanitized incident reference in shared systems. A duplicate
Security Hub copy does not require a second incident, but both source workflows
must receive an explicit disposition.

## Backup job failure

Use aggregate AWS Backup job state and resource type. Confirm the protected
selection still has exactly the approved resource count, role access, vault
encryption, and start/completion windows. Retry only after the cause is fixed.

## Backup copy failure

Verify source recovery point health, replica vault/key state, Region, copy
permissions, and retention. A successful source backup does not close a failed
replica copy; require later replica recovery-point evidence.

## Backup restore failure

Keep the source recovery point and vault unchanged. Review the isolated restore
role and destination preflight, then retry to a new approved isolation target.
Close only after aggregate count/checksum/schema/authorization validation.

## Backup freshness

Treat missing metric data as a failed control. Verify the scheduled freshness
function ran, then compare aggregate expected, healthy, and failed counts. The
expected count is exactly three source resources, or six when the configured
replica vault is present. Do not print recovery-point ARNs or resource ARNs.
Close only after every exact table and media bucket has a completed recovery
point inside the approved age window in the source vault and configured replica.

## Account cost budget

Confirm whether actual spend exceeded 80% or forecast spend exceeded 100% of
the owner-approved monthly limit. Review aggregate service cost by the approved
billing workflow. Cost pressure never authorizes disabling logging, detection,
backup, WAF, evidence retention, or rollback access. Escalate an unexplained
increase without copying billing exports or account identifiers into chat.

## Edge health

Compare frontend and media 5xx rates, request volume, origin latency, and cache
behavior by release. The observability stack intentionally collects no browser
telemetry and runs no synthetic browser probe; use the credential-free public
posture smoke test for release verification.

## WAF observation

Use aggregate rule labels/actions and the redacted count/block log. The common
managed group remains in count mode; known-bad inputs, Amazon IP reputation,
and the per-IP rate limit block. Return only an affected high-confidence rule to
count mode after a verified false positive. Any exclusion needs an owner,
reason, expiry, regression fixture, and rollback record.

## Delivery test and review record

Quarterly and after routing changes, send synthetic messages containing only a
test marker, signal ID, timestamp, and release. Confirm primary and backup
receipt, record acknowledgment latency, verify the delivery DLQ remains empty,
and update `lastEndToEndTestDate` in the JSON registry. A topic ARN or pending
subscription is not successful delivery.
