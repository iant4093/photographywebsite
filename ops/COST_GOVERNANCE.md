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

## Admin cost report

The protected `/admin/costs` page provides an account-wide Cost Explorer
summary without granting the browser AWS credentials or billing permissions.
Its Lambda accepts no billing query parameters and can call only
`ce:GetCostAndUsage`, `ce:GetCostForecast`, and item operations on the dedicated
`GoldenHour-CostReportCache-prod` table. The stored and returned payload contains
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
existing Google Drive credential and `drive.file` scope. It requires no browser
credential, no broader OAuth scope, and no additional Google Cloud setup. The
Lambda can read only the configured credential secret, its dedicated
`GoldenHour-DriveUsageCache-prod` table, the fixed Drive account summary, and
the configured website-backup folder tree.

The first authorized request in each UTC day refreshes one aggregate snapshot.
Later requests use that snapshot; a failed refresh serves the prior snapshot as
stale and is not retried until the next UTC day. The stored and returned report
contains quota totals, category byte/file counts, and folder counts only. It
never contains Google file names, file IDs, folder IDs, credentials, account
identifiers, or provider error details, and browser responses are `no-store`.

Some service accounts and pooled Google Workspace accounts do not expose an
individual storage limit. In that case the page still reports the bounded
website-backup totals and clearly marks account capacity as unavailable.
