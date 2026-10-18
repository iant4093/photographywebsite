# Alarm registry and response notes

Every alarm, budget notification and signal rule I run is listed in
`ops/alarm_registry.json`. Each group there names its logical resource IDs, a
severity, a route and the `## ` heading below that tells me what to do about it.
The route is one of `security-notification-topic`, the cross-Region signal queue
that validates edge events, `cloudwatch-audit-only`, or the budget's optional
owner email.

`ops/tests/test_security_baseline.py` keeps the two files in sync. It fails if
an alarm, budget notification or signal rule in `backend/template.yaml` or the
notification, backup, budget, observability or WAF templates isn't registered,
or if a runbook heading the registry points to is missing from this page.

Notification endpoints aren't stored in Git. One destination that I control is
confirmed on the central topic, and for a personal site that's all the delivery
I need. I still record a synthetic end-to-end delivery test every quarter and
after any routing change.

## Email routing policy

I only want email when I have to do something. That comes down to four cases:
the site is down, data is at risk, the account may be compromised, or spend is
over budget. Everything else (25 alarms today) is record-only
(`cloudwatch-audit-only`). Those sit in CloudWatch for the dashboard or for
when I'm already investigating. Adding a route must not add AWS cost, so no
composite alarms, health checks or extra metric alarms.

| Outcome | Signals that email |
| --- | --- |
| Site down | `ApiServerErrorAlarm`; frontend and media CloudFront 5xx rate (3 of 3 five-minute periods, via the edge signal queue) |
| Data at risk | `AsyncFailureQueueAlarm`, `PreviewDeadLetterQueueAlarm`, `ZipPreparationFailureAlarm`, `OriginalComparisonFailureAlarm`, `AlbumWorkDeadLetterQueueAlarm`, `BackupFreshnessAlarm`, `BackupJobFailureRule`, `SecurityEventDlqAlarm` |
| Account compromised | `RootActivityAlarm` |
| Spend | `ian-photography-monthly-<stage>` budget, actual or forecasted spend over 100% (direct AWS Budgets email when `BudgetAlertEmail` is set) |

Only the website's own backup and edge 5xx events go through the security
signal queue, which is scoped to those rules and checked against a strict
allowlist. The topic policy only accepts native CloudWatch notifications from
the alarm name patterns above. `ops/tests/test_security_operations.py` fails if
an alarm targets the topic without being on that allowlist. Other account
identity, managed-security and configuration signals stay in their own services
and in record-only CloudWatch alarms.

Never copy any of these into a notification, ticket or chat: raw events,
request or response bodies, emails, album or media identifiers, object keys,
request URLs, credentials, provider errors or log messages.

## First five minutes on any alarm

1. Note the Region, signal name, transition time and current release, and
   whether I was in the middle of a deploy or a recovery drill.
2. Check the stack status and the aggregate service metrics. Don't start by
   deleting, redriving, suppressing, unlocking or widening access.
3. Correlate only by generated request/trace ID or CloudTrail role session.
4. If an approved release caused it, roll back the way that release's plan
   says to. Keep the evidence and any retained resources.
5. Write down the owner, when I acknowledged it, severity, where the safe
   evidence lives, what I did to contain it, how I proved it closed, and a
   follow-up date.

## Application API health

Compare API 5xx and latency with Lambda errors, throttles and duration for the
release that's live. Check a small public request before rolling back. Don't
turn on body or query logging to debug an API failure. Only the 5xx alarm
emails. The p95 latency alarm is record-only.

## Front-door denial

Check the API custom origin and that the default endpoint is still disabled.
Look at the `current`/`previous` values in the origin-verification SSM parameter
by version metadata only, and check the CloudFront origin-header path. If the
origin is accepting requests that bypass CloudFront, treat that as critical.
Rotate the origin verifier only with its dual-version runbook. That has nothing
to do with provider credential rotation.

This alarm is record-only. Denied direct-origin requests mean the check is
doing its job.

## Application async and preview

Look at queue depth, oldest message age, DLQ depth, the workers' aggregate
reason codes and metadata conflict counts. If failures are systematic, stop
dispatch or the event mapping.

Only the dead-letter alarms email: async failure, preview, ZIP,
original-comparison and album-work DLQs. A message there has failed for good.
The rest share this procedure but are record-only diagnostics: queue age,
preview queue depth, worker failure/error/duration/throttle, metadata
system-error/throttle, hover-preview and original-index alarms. Retries and the
DLQs catch anything that actually gets lost.

The same rules apply to the queues behind `ZipPreparationFailureAlarm` and the
album-work alarms. Never purge or bulk-redrive. Pick out only messages I know
are safe to replay.

For hover-preview signals, also compare the builder's native errors with the
privacy-safe `ManifestBuildFailure` metric. Look only at aggregate
reconciliation state, and check one immutable manifest through the public alias.
Leave the album-detail compatibility path on until catalog reconciliation is
done and the refresh queue has no old messages.

For `OriginalComparisonFailureAlarm` and `OriginalIndexRefreshErrorsAlarm`,
compare comparison DLQ depth and worker errors with how fresh the private index
is. Follow [photo-original failure recovery](PHOTO_ORIGINAL_COMPARISONS.md#failure-recovery-and-retention)
to check the read-only Drive boundary, and retry only website jobs I know are
safe to replay. Keep the published index, the retained private previews and the
raw archive. An original that can't be found is a matching result, not an
indexing outage.

## Authentication and authorization

Group denials by stable reason, route template, status and release. Work out
whether it's a client or session regression or abuse, without enumerating
accounts. Leave CAPTCHA, rate limits, JWT validation and the
owner/admin/share boundaries alone. These alarms are record-only because the
internet scans login pages all day and I don't want email for that.

## Application audit failure

Send one synthetic safe success and one denial, and check that the central log
group and metric filters pick them up. Audit logging must never break the user's
action, but a silent audit outage stays open until event delivery and the
forbidden-field tests pass. The alarm is record-only. I look at it alongside the
audit log when I'm investigating something.

## Account identity and encryption change

Match root, IAM and KMS changes to an operator session I approved. If a change
wasn't approved, contain the identity, keep CloudTrail intact, and check that
keys are still enabled and not scheduled for deletion before restoring policy
through IaC.

`RootActivityAlarm` emails because I never use the root identity for routine
work. The IAM and KMS change alarms are record-only.

## Trail and notification change

Check trail logging, S3 and CloudWatch delivery, digest creation, topic policy,
EventBridge targets, retries and DLQ depth. Never delete evidence or a failed
delivery message just to make the dashboard green. The control-plane change
alarms are record-only.

## Website notification delivery

Look at the website security-event DLQ and the backup/edge EventBridge targets.
Don't purge or redrive in bulk. Confirm the fixed signal format, retry only
events that are safe to replay, and check the owner subscription is still
confirmed without writing its endpoint down anywhere.

## Security service change

Check the home-Region recorder and delivery status, the detector's feature map
and publishing frequency, that Security Hub still has no standards enabled, CI
security coverage, and Access Analyzer state. Restore only through the templates
that own them, rerun the home check (`ops/ci/home_security_posture.py`,
which exits non-zero on any mismatch), and note why the service changed. This
alarm covers the whole account and is record-only.

The configuration-change metric still flags any create, update or delete of a
Security Hub finding aggregator as unauthorized. I don't manage an aggregator in
this repo, so if that fires, investigate it. It isn't expected drift.

## Data protection change

Check S3 public access, TLS policy, encryption, versioning and access logging;
DynamoDB PITR and deletion protection; backup vault lock and recovery points;
and the approved backup plan, selection, lifecycle and access policy. Planned
changes still need a note on what happened, because CloudFormation can briefly
toggle a protection off and on during an update.

## Backup job failure

Work from aggregate AWS Backup job state and resource type. Check that the
protected selection still has the approved resource count, role access, vault
encryption, and start/completion windows. Retry only after the cause is fixed.

## Backup freshness

Missing metric data counts as a failure. Check that the scheduled freshness
function ran, then compare the aggregate expected, healthy and failed counts.
The expected count is two source resources. Don't print recovery-point ARNs or
resource ARNs. Close it only once both metadata tables have a completed recovery
point inside the approved age window in the source vault.

## Edge health

Compare frontend and media 5xx rates and request volume by release. The us-east-1
WAF stack owns both alarms. Each fires on more than 5% 5xx in three of three
five-minute periods, and the edge event rule forwards it to the notification
pipeline in the home Region. Paid origin-latency and cache-hit metrics are off.
The observability stack collects no browser telemetry and runs no synthetic
browser probe. For release checks, use the credential-free public smoke test.

The web ACL has five rules: per-IP rate limits for Explore (600), the API
(3000) and media (4000), each per 5 minutes, plus two AWS managed rule groups.
The frontend and the media CDN share it. There are no global circuit breakers.

I don't alarm on WAF blocks, because a block means the WAF is working. After a
reported false positive, look at the redacted block log and the per-rule WAF
metrics. Put only the affected rule back into count mode, and only once the
false positive is confirmed. Any exclusion needs an owner, a reason, an expiry,
a regression fixture and a rollback record.

## Monthly spend

The optional `ian-photography-monthly-<stage>` AWS Budget emails me directly
(no SNS) when actual or forecasted monthly spend goes over 100% of the limit.
The limit is a deploy-time parameter and is $60 today. Use Cost Explorer by
service and usage type to find what's driving it, compare that with the latest
release and the WAF rule metrics, and fix the cause before raising the limit.
The budget never turns off a control.

## Testing delivery

Every quarter, and after any routing change, send synthetic messages that carry
only a test marker, signal ID, timestamp and release. Confirm I got them, note
how long acknowledgment took, check the delivery DLQ is still empty, and update
`lastEndToEndTestDate` in the JSON registry. A topic ARN or a pending
subscription doesn't count as working delivery.
