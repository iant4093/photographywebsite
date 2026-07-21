# CloudFront edge observability operations

`ops/observability_template.yaml` is the separately deployed, retained source
of truth for edge monitoring. It does not own either CloudFront distribution.
It owns only each distribution's real-time metrics subscription, a 5xx alarm
for each distribution, and one CloudWatch dashboard.

Browser RUM and synthetic canaries are not part of this stack. Adding either
requires a new privacy, security, cost, dependency, and operational review; it
is not an observability-stack toggle.

## Cost and data boundary

The retained paid boundary is deliberately small:

- additional one-minute CloudFront metrics for exactly the frontend and media
  distributions;
- two CloudWatch metric alarms; and
- one aggregate dashboard.

These resources process CloudFront metrics only. They do not collect request or
response bodies, cookies, browser events, album identifiers, media object keys,
credentials, or screenshots. Before changing metric subscriptions or alarm
periods, review current CloudFront and CloudWatch pricing and the account budget.

## Validate and inventory

Run the repository checks before AWS inventory:

```bash
cfn-lint ops/observability_template.yaml
python3 -m unittest ops.tests.test_observability -v
```

CloudFront monitoring subscriptions are paid singleton resources. First-time
creation must prove both are absent. This preflight is read-only and fails
closed on an unknown AWS response:

```bash
python3 ops/observability_preflight.py \
  --deployment-mode create \
  --frontend-distribution-id FRONTEND_DISTRIBUTION_ID \
  --media-distribution-id MEDIA_DISTRIBUTION_ID \
  --expected-account-id AWS_ACCOUNT_ID
```

For an update, the helper requires two enabled subscriptions and verifies that
the exact observability stack owns both logical resources:

```bash
python3 ops/observability_preflight.py \
  --deployment-mode update \
  --frontend-distribution-id FRONTEND_DISTRIBUTION_ID \
  --media-distribution-id MEDIA_DISTRIBUTION_ID \
  --expected-account-id AWS_ACCOUNT_ID \
  --stack-name ian-photography-observability
```

If create mode finds a subscription, stop. Determine whether another stack,
Terraform state, or a manual operator owns it. Do not delete or adopt it merely
to make deployment pass. If ownership is intentionally transferred, use a
reviewed CloudFormation import plan and update the runbook evidence first.

An authenticated operator can also run CloudFormation's read-only parser:

```bash
aws cloudformation validate-template \
  --region us-west-2 \
  --template-body file://ops/observability_template.yaml
```

## Update procedure

1. Run update-mode preflight and save only its aggregate result.
2. Create a CloudFormation change set with the exact two distribution IDs,
   optional exact SNS topic ARN, and tested `ReleaseSha`.
3. Confirm the change set preserves both monitoring subscriptions, both 5xx
   alarms, and the dashboard, and changes no other resource.
4. Execute the reviewed change set and retain termination protection.
5. Run the public edge-posture smoke and scheduled drift audit. Confirm the
   canonical site remains healthy and the full observability stack is in
   sync without exclusions or service-specific posture bypasses.

## Alarm ownership and triage

`AlarmTopicArn` must remain set in production to the exact encrypted central
security topic ARN. This stack never creates an email endpoint or subscription.
An empty value is useful only for an intentionally non-alerting initial stack
creation and is not an acceptable production state. Test and document
notification delivery separately.

For a frontend or media 5xx alarm, compare the two distributions, origin
latency, request volume, and cache-hit metrics before changing cache behavior.
Missing data is not breaching because a low-traffic photography site can have
quiet windows.

`ops/alarm_registry.json` and `ops/ALARM_REGISTRY.md` remain the versioned
signal inventory and runbook map.

## Rollback and cost stop

If real-time metrics cost must stop, use the explicit CloudFront
`delete-monitoring-subscription` operation only after recording that it creates
CloudFormation drift. Remove or update the corresponding retained resource in
a reviewed change set before any later stack update. Disabling monitoring never
authorizes deleting either distribution or weakening application, logging,
backup, WAF, or security controls.
