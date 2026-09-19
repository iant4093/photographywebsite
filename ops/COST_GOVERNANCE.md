# Guarded cost budget operations

`security_budget_template.yaml` can create one retained, console-only monthly
account cost budget. It creates no email address, SNS topic, endpoint,
subscription, notification, cost-cutoff action, or automatic security-service
disablement. The budget is deliberately excluded from the website responder
topic because account-wide billing is not a website incident.

The budget measures the account's total monthly cost. This is broader than a tag
filter because not every paid security service supports consistent cost
allocation tags. Review it in AWS Billing when performing monthly maintenance.

## Read-only preflight

The preflight verifies the exact account, validates the owner-approved amount,
checks whether the fixed budget name already exists, and prints only aggregate
state. It never calls a write API.

```bash
python3 ops/security_budget_preflight.py \
  --stage prod \
  --region us-west-2 \
  --expected-account-id EXPECTED_12_DIGIT_ACCOUNT \
  --monthly-limit-usd OWNER_APPROVED_AMOUNT \
  --confirm-budget-name ian-photography-monthly-prod
```

Exit status `2` and `BudgetDeploymentMode=skip` are expected when the exact
budget already exists or the name confirmation is absent. Never delete or
replace an existing budget merely to satisfy the preflight.

## Deployment and validation

Create a non-executing change set with the exact preflight parameters and
`BudgetDeploymentMode=create-confirmed-absent`. Confirm it creates only
`AWS::Budgets::Budget`, contains no `NotificationsWithSubscribers`, and does not
replace an existing budget or website notification resource. Execute only after
owner approval and enable stack termination protection.

Review actual costs daily during the first week after enabling a new paid
service and monthly afterward. Cost pressure never authorizes disabling
logging, detection, backup, WAF, rollback access, or evidence retention.

## Random-photo cache costs

The hourly random-photo reconciliation compares a stable digest of public photo
membership, categories, and validated preview data. Shuffle order is excluded.
It reuses a complete unchanged generation without DynamoDB writes or CloudFront
invalidations; the reader still rotates its sample every five minutes. Missing
metadata or shards, legacy generations without digests, and incomplete prior
publications trigger a rebuild. Inventory reads are strongly consistent, and
obsolete generations are removed only after new shards and metadata publish.

Changed decks enqueue only the two random-photo API paths, including query-string
variants. The existing worker coalesces these with any pending album/catalog
changes. Privacy and visibility-revocation invalidations retain their synchronous
media and public API paths. The optional `randomPhotos` field extends the existing
queue message format; during a mixed-version rollout or rollback, old consumers
can omit that refresh, with staleness bounded by the existing public API cache TTL.

The first deployment rebuilds legacy decks once to establish digests. Verify a
subsequent unchanged invocation reports `changed=false` and creates no invalidation.
Before this change, the hourly job submitted six paths per run: 4,320 paths in a
30-day month, or $16.60 after the shared 1,000-path free allowance, excluding other
invalidation activity. This is an avoided-usage estimate, not a guaranteed bill.

## Original-photo comparison retries

The index coordinator still polls Drive changes every 15 minutes and rebuilds
the inventory daily to cover cursor/metadata gaps. Its matching generation is
a stable digest of archive membership and matching inputs, independent of the
snapshot object key and provider bookkeeping. Unchanged snapshots are reused
and renewed at least daily, before the existing seven-day S3 expiration.

Unavailable and ambiguous matches are retried on a changed archive generation
or changed photo metadata, and otherwise once 24 hours have elapsed, at the next
15-minute reconciliation. There is no final-attempt cutoff: photos continue to
be checked indefinitely. A later original can therefore be discovered at the
next archive refresh without waiting for the daily fallback. A match still
requires the existing filename, capture-time, and camera evidence; retries
cannot guarantee a match when originals or matching evidence never arrive.

Transient failures back off from 15 minutes to a maximum of 24 hours. Queue
redeliveries respect the same cooldown and leave the existing comparison result
intact. Deferred failures remain batch failures so SQS redrive and DLQ alarms
still detect persistent failures; scheduled discovery continues after the
cooldown even if an older delivery has reached the DLQ. Leases, atomic
membership/state checks, and private preview storage are
preserved. After rollout, verify unchanged refreshes stop requeueing the same
unavailable photos; verify a changed original and an elapsed daily deadline
each make a comparison eligible again. Cost Explorer can lag the live metric
improvement, so first inspect worker invocation and DynamoDB consumed-write
metrics.

## Sparse event metrics and storage

Application log filters publish a value only when an event
matches, without continuously publishing zeroes. Their matching patterns,
metric names, alarm thresholds and notification routes remain intact. Event
alarms use `Sum`, one evaluation period, and `TreatMissingData: notBreaching`.
CloudWatch may retain a sparse breach in its evaluation lookback longer than a
zero-filled series; detection remains active. The separate security-notification
stack's filters keep their existing zero defaults. The backup-freshness heartbeat
continues publishing its regular values and treats missing data as breaching.
Do not apply sparse-event semantics to that heartbeat.

Release cleanup preserves the existing 180-day/five-known-good-release policy.
Current photos, derivatives and album ZIPs used by downloads remain live data.
Reusing archive snapshots reduces repeated `index/` objects, and the existing
seven-day lifecycle ages out prior snapshots automatically. No photo, backup,
or rollback retention is shortened.

## Admin cost report

The protected `/admin/costs` page provides an account-wide Cost Explorer
summary without granting the browser AWS credentials or billing permissions.
Its Lambda accepts no billing query parameters and can call only
`ce:GetCostAndUsage`, `ce:GetCostForecast`, and item operations on the dedicated
legacy physical `GoldenHour-CostReportCache-prod` table. The stored and returned payload contains
aggregate month/service amounts only—never account IDs, resources, tags,
invoices, payment details, or provider errors.

The first authorized request in each UTC day claims that day's refresh and
stores one aggregate snapshot. Later requests use the same snapshot, keeping
Cost Explorer calls and cost bounded to one usage query (plus bounded
pagination) and one optional forecast query per day. A failed refresh serves
the prior snapshot as stale and is not retried until the next UTC day. The
browser response is always `no-store` even when the server-side daily cache is
fresh.

Cost Explorer must already be enabled in the AWS Billing console. Its data can
lag more than 24 hours, and the page is an estimated operational view rather
than a final invoice. Enabling Cost Explorer can also create an account-wide
Cost Anomaly Detection monitor and daily-summary subscription; review that
subscription separately instead of routing it into the website incident SNS
topic.

## Admin Google Drive usage report

The protected `/admin/drive-usage` page reuses the website backup worker's
existing encrypted Google credential secret. Account quota and website-backup
totals continue to use the OAuth credential's narrow `drive.file` scope. Raw
Photo Backup totals use the nested service account with metadata-only Drive
access; Google Drive ACLs limit that identity to folders explicitly shared with
it. The secret also stores the fixed Raw Photo Backup folder ID so the report
does not depend on a mutable folder name. The Lambda can read only this fixed
credential secret and its dedicated legacy physical
`GoldenHour-DriveUsageCache-prod` table.

An EventBridge rule refreshes one aggregate snapshot daily at 09:15 UTC. The
Lambda has a bounded five-minute background runtime because the raw archive can
contain tens of thousands of metadata records; browser requests never wait for
that scan and read the cached snapshot immediately. A failed refresh retains
the prior snapshot as stale and releases its daily claim for at most two
bounded EventBridge retries. The stored and returned report contains quota
totals, website and raw-backup category byte/file counts, and folder counts only. It
never contains Google file names, file IDs, folder IDs, credentials, account
identifiers, or provider error details, and browser responses are `no-store`.

Some service accounts and pooled Google Workspace accounts do not expose an
individual storage limit. In that case the page still reports the bounded
website-backup totals and clearly marks account capacity as unavailable.
