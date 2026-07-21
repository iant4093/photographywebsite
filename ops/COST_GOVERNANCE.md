# Guarded cost budget operations

`security_budget_template.yaml` owns one retained monthly account cost budget.
It never creates an email address, SNS topic, endpoint, subscription, cost-cutoff
action, or automatic security-service disablement. The owner must choose the
monthly USD limit and confirm two responders on the existing encrypted security
topic before deployment.

The budget measures the account's total monthly cost. This is intentionally
broader than a tag filter: not every paid security service supports consistent
cost-allocation tags, and a narrow filter could silently omit GuardDuty,
Security Hub, Config, WAF, Backup, RUM, Synthetics, CloudWatch, or data-transfer
charges. The actual-spend notification starts above 80% and the forecasted
notification above 100% of the owner-approved limit. Neither notification
changes AWS resources.

## Prerequisites

1. Deploy the reviewed notification-stack update that grants only the exact
   named budget permission to publish to the encrypted topic.
2. Attach and confirm a primary and backup human destination outside this
   repository. Record owners and a synthetic delivery test in
   `alarm_registry.json`; never commit endpoint addresses.
3. Choose the monthly amount after reviewing current billing and the 24-hour,
   7-day, and 30-day paid-service cost observations. Do not treat a default or
   guessed number as approval.

## Read-only preflight

The preflight lists budgets, verifies the exact same-account/same-Region topic,
and counts unique confirmed human-compatible destinations (`email`,
`email-json`, or `sms`) without printing endpoint addresses or subscription
identifiers. Confirmed HTTPS, SQS, Lambda, and Firehose fan-out can be useful,
but proves only a machine route and does not satisfy the two-human gate. It
never calls a write API.

```bash
python3 ops/security_budget_preflight.py \
  --stage prod \
  --region us-west-2 \
  --expected-account-id EXPECTED_12_DIGIT_ACCOUNT \
  --security-notification-topic-arn EXACT_REVIEWED_TOPIC_ARN \
  --monthly-limit-usd OWNER_APPROVED_AMOUNT \
  --confirm-budget-name ian-photography-monthly-prod
```

Exit status `2` and `BudgetDeploymentMode=skip` are expected while the topic has
fewer than two confirmed destinations, the exact budget already exists, or the
name confirmation is absent. An existing budget requires an ownership/import
review; never delete or replace it merely to satisfy the preflight.

The inventory digest binds only aggregate counts, the approved limit, and topic
existence. Save it with the change record, but rerun immediately before creating
the CloudFormation change set because subscriptions and budgets can change.

## Deployment and validation

Create a non-executing change set with the exact preflight parameters and
`BudgetDeploymentMode=create-confirmed-absent`. Confirm it creates only
`AWS::Budgets::Budget`, has no email subscriber, and does not replace any
existing budget or notification resource. Execute only after owner approval,
enable stack termination protection, then verify the actual and forecast
notifications both reference the reviewed SNS topic.

Send a privacy-safe synthetic topic message separately to test delivery; do not
force real account spend. Review actual costs daily during the first week and
monthly afterward. A budget alert must never automatically disable logging,
detection, backup, WAF, rollback access, or evidence retention.

## Update and rollback

Changing `NotificationsWithSubscribers` can replace the CloudFormation budget
resource. Treat recipient or threshold changes as a replacement-risk change set
and preserve the old budget until the replacement is verified. To stop alert
noise, correct routing or the limit through the reviewed template. Do not delete
the security topic, KMS key, evidence, detector, backup, or observability stack.
