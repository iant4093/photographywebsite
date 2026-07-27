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
