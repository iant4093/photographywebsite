# Alarm registry and response notes

Every alarm, budget notification and signal rule is listed in
`ops/alarm_registry.json`. Each group there names its logical resource IDs, a
severity, a route and the `## ` heading on this page that holds its runbook.
The routes are:

- `security-notification-topic`: native CloudWatch or validated EventBridge
  signals to the `ian-photography-security-<stage>` SNS topic
- `security-notification-topic-via-cross-region-validated-signal-queue`: the
  `us-east-1` edge alarms, forwarded to the home Region and validated before
  publishing
- `cloudwatch-audit-only`: record-only, no action
- `aws-budgets-owner-email-when-configured`: AWS Budgets email to the optional
  `BudgetAlertEmail` address

`ops/tests/test_security_baseline.py` keeps the two files in sync. It fails if
an alarm, budget notification or signal rule in `backend/template.yaml` or the
notification, backup, budget, observability or WAF templates is not
registered, or if a runbook heading the registry points to is missing from
this page.

Notification endpoints are not stored in Git. The central topic has one
confirmed subscription, and the registry's delivery state is
`active-one-confirmed-owner-destination`. A synthetic end-to-end delivery test
is recorded every 90 days (`testIntervalDays`) and after any routing change.

## Email routing policy

Email is sent for four outcomes: the site is down, data is at risk, the account
may be compromised, or spend is over budget. In `us-west-2`, 9 CloudWatch alarms
publish to the topic, and the 25 other alarms there are record-only
(`cloudwatch-audit-only`). Record-only alarms stay in CloudWatch for dashboards
and investigation. The routing uses no composite alarms or health checks.

| Outcome | Signals that email |
| --- | --- |
| Site down | `ApiServerErrorAlarm`; frontend and media CloudFront 5xx rate (`FrontendFiveXxAlarm`, `MediaFiveXxAlarm`: over 5% in 3 of 3 five-minute periods, via the signal queue) |
| Data at risk | `AsyncFailureQueueAlarm`, `PreviewDeadLetterQueueAlarm`, `ZipPreparationFailureAlarm`, `OriginalComparisonFailureAlarm`, `AlbumWorkDeadLetterQueueAlarm`, `BackupFreshnessAlarm`, `BackupJobFailureRule`, `SecurityEventDlqAlarm` |
| Account compromised | `RootActivityAlarm` |
| Spend | `ian-photography-monthly-<stage>` budget, actual or forecasted spend over 100% (direct AWS Budgets email when `BudgetAlertEmail` is set) |

Only the backup-job failure rule and the edge 5xx forwarding rule can send to
the signal queue, and the signal-processor Lambda accepts only their fixed
message formats. The topic policy accepts native CloudWatch notifications only
from the alarm names above. `ops/tests/test_security_operations.py` fails if an
alarm targets the topic without being on that allowlist. Other identity,
managed-security and configuration signals stay in their own services and in
record-only CloudWatch alarms.

Never copy any of these into a notification, ticket or chat: raw events,
request or response bodies, emails, album or media identifiers, object keys,
request URLs, credentials, provider errors or log messages.

## First five minutes on any alarm

1. Note the Region, signal name, transition time and current release, and
   whether a deploy or recovery drill was in progress.
2. Check the stack status and the aggregate service metrics. Do not start by
   deleting, redriving, suppressing, unlocking or widening access.
3. Correlate only by generated request or trace ID or CloudTrail role session.
4. If an approved release caused it, roll back as that release's plan
   describes. Keep the evidence and any retained resources.
5. Record the owner, acknowledgment time, severity, where the safe evidence
   is, containment steps, how closure was confirmed, and a follow-up date.

## Application API health

Compare API 5xx and latency with Lambda errors, throttles and duration for the
live release. Check a small public request before rolling back. Do not turn on
body or query logging to debug an API failure. Only `ApiServerErrorAlarm` (5 or
more 5xx responses in 5 minutes) emails. `ApiLatencyAlarm` (p95 integration
latency) is record-only.

## Front-door denial

Check the API custom origin and that the default `execute-api` endpoint is
still disabled. Inspect the `current`/`previous` values in the
origin-verification SSM parameter by version metadata only, and check the
CloudFront origin-header path. If the origin accepts requests that bypass
CloudFront, treat that as critical. Rotate the origin verifier only with its
dual-version runbook in [`API_FRONT_DOOR.md`](API_FRONT_DOOR.md). That is
separate from provider credential rotation.

`FrontDoorDeniedAlarm` is record-only. Denied direct-origin requests mean the
check is working.

## Application async and preview

Look at queue depth, oldest message age, DLQ depth, the workers' aggregate
reason codes and metadata conflict counts. If failures are systematic, stop
dispatch or the event source mapping.

Only the dead-letter alarms email: async failure, preview, ZIP,
original-comparison and album-work DLQs. A message there has exhausted its
retries. The rest use this procedure but are record-only diagnostics: queue
age, preview queue depth, worker failure, error, duration and throttle,
metadata system-error and throttle, hover-preview and original-index alarms.
Retries and the DLQs catch messages that fail.

The same rules apply to the queues behind `ZipPreparationFailureAlarm` and the
album-work alarms. Do not purge or bulk-redrive. Replay only messages known to
be safe.

For hover-preview signals, also compare the builder's native errors with the
`ManifestBuildFailure` metric. Look only at aggregate reconciliation state, and
check one immutable manifest through the public alias. Leave the album-detail
fallback path on until catalog reconciliation is done and the refresh queue has
no old messages.

For `OriginalComparisonFailureAlarm` and `OriginalIndexRefreshErrorsAlarm`,
compare comparison DLQ depth and worker errors with the private index's age.
Follow [photo-original failure recovery](PHOTO_ORIGINAL_COMPARISONS.md#failure-recovery-and-retention)
to check the read-only Drive boundary, and retry only website jobs known to be
safe to replay. Keep the published index, the retained private previews and the
raw archive. An original that cannot be found is a matching result, not an
indexing outage.

## Authentication and authorization

Group denials by stable reason, route template, status and release. Decide
whether it is a client or session regression or abuse, without enumerating
accounts. Leave CAPTCHA, rate limits, JWT validation and the owner, admin and
share boundaries unchanged. `LoginThrottleAlarm`, `LoginDeniedAlarm` and
`ApiAuthorizationDeniedAlarm` are record-only.

## Application audit failure

Send one synthetic success and one denial, and check that the central log group
and metric filters pick them up. Audit logging does not block the user's
action, so an audit outage stays open until event delivery and the
forbidden-field tests pass. `AuditFailureAlarm` is record-only.

## Account identity and encryption change

Match root, IAM and KMS changes to an approved operator session. If a change
was not approved, contain the identity, keep CloudTrail intact, and check that
keys are still enabled and not scheduled for deletion before restoring policy
through IaC.

`RootActivityAlarm` emails on any root API action other than AWS service
events. `IamChangeAlarm` and `KmsChangeAlarm` are record-only.

## Trail and notification change

Check trail logging, S3 and CloudWatch delivery, log file validation, topic
policy, EventBridge targets, retries and DLQ depth. Do not delete evidence or a
failed delivery message to clear the dashboard. `CloudTrailChangeAlarm` and
`SecurityRoutingChangeAlarm` are record-only.

## Website notification delivery

Look at the security-event DLQ and the backup and edge EventBridge targets. Do
not purge or redrive in bulk. Confirm the fixed signal format, retry only
events that are safe to replay, and check that the topic subscription is still
confirmed without recording its endpoint.

## Security service change

Check the home-Region Config recorder and delivery status, the GuardDuty
feature map and publishing frequency, that Security Hub has no enabled
standards, Inspector status, and Access Analyzer state. Restore only through the
templates that own them, rerun `ops/ci/home_security_posture.py` (exit status
`2` on any mismatch), and record why the service changed.
`SecurityServiceChangeAlarm` covers the whole account and is record-only.

Its metric also counts `CreateFindingAggregator`, `UpdateFindingAggregator` and
`DeleteFindingAggregator`. No Security Hub finding aggregator is managed in this
repo, so investigate any such event.

## Data protection change

Check S3 public access, TLS policy, encryption, versioning, lifecycle and access
logging; DynamoDB PITR, TTL and deletion protection; backup vault lock and
recovery points; and the backup plan, selection and vault access policy. Stack
updates that change these settings also trigger `DataProtectionChangeAlarm`, so
record the change set that caused it. The alarm is record-only.

## Backup job failure

Work from aggregate AWS Backup job state and resource type. Check that the
backup selection still covers the two metadata tables, and check role access,
vault encryption, and the start and completion windows. Retry only after the
cause is fixed.

## Backup freshness

Missing metric data counts as breaching. Check that the freshness function ran
in the last six hours, then compare the aggregate expected, healthy and failed
counts. The expected count is two (the Albums and PreviewMetadata tables). Do
not print recovery-point ARNs or resource ARNs. Close it only once both tables
have a completed recovery point in the metadata vault within
`FreshnessMaximumAgeHours` (default 36).

## Edge health

Compare frontend and media 5xx rates and request volume by release. The
`us-east-1` WAF stack owns both alarms. Each fires on more than 5% 5xx in three
of three five-minute periods. A `us-east-1` EventBridge rule forwards the state
change to the home-Region default event bus, and the notification stack's rule
sends it to the signal queue. CloudFront additional metrics (monitoring
subscriptions) are off for both distributions. The observability stack is a
CloudWatch dashboard only; it collects no browser telemetry and runs no
synthetic probe. For release checks, use `ops/ci/public_smoke.sh`.

The web ACL has five rules: per-IP rate limits for Explore (600), the API
(3000) and media (4000), each per 5 minutes, plus the AWS managed Known Bad
Inputs and Amazon IP Reputation rule groups. The frontend and media
distributions share it. There are no global rate-limit rules.

There are no alarms on WAF blocks. After a reported false positive, look at
the WAF log (the `authorization`, `cookie` and `x-origin-verify` headers are
redacted) and the per-rule WAF metrics. Put only the affected rule into count
mode, and only once the false positive is confirmed. Any exclusion needs an
owner, a reason, an expiry, a regression fixture and a rollback record.

## Monthly spend

The `ian-photography-monthly-<stage>` AWS Budget emails the `BudgetAlertEmail`
address directly (no SNS) when actual or forecasted monthly spend goes over
100% of the limit. The limit is the `MonthlyLimitUsd` deploy-time parameter,
currently 60 USD. Use Cost Explorer by service and usage type to find the
driver, compare it with the latest release and the WAF rule metrics, and fix
the cause before raising the limit. The budget has no actions and does not turn
off any control.

## Testing delivery

Every 90 days, and after any routing change, send synthetic messages that carry
only a test marker, signal ID, timestamp and release. Confirm receipt, record
the acknowledgment time, check that the delivery DLQ is still empty, and update
`lastEndToEndTestDate` in `ops/alarm_registry.json`. A topic ARN or a pending
subscription does not count as working delivery.
