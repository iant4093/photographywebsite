# Website monitoring and cost controls

I keep monitoring on free metrics. The home-region `ian-photography-observability`
stack owns one dashboard, and it only shows free request and error metrics. I
used to pay for two CloudFront monitoring subscriptions. They're gone from AWS
and from the template, so a future stack deploy won't bring them back.

## Edge alarms

CloudFront publishes its metrics in **us-east-1**, so the frontend and media
5xx alarms live there, in the existing `ian-photography-front-door-waf` stack.
When you update that stack, pass the correct `FrontendDistributionId` and
`MediaDistributionId`.

Both alarms use the free `5xxErrorRate` metric and fire when the rate is above
5% for three of three five-minute periods. State changes for just these alarms
cross over to the home EventBridge bus. From there the notification stack turns
ALARM states into the fixed `edge.alarm` signal and sends it through the
existing encrypted queue, retry/DLQ, validation Lambda, and owner notification
route.

I don't alarm on WAF blocks. If I need to look at them, they're in the redacted
WAF log and the per-rule metrics.

## API and application metrics

API Gateway detailed route metrics are off. Stage-level latency and `5xx`
metrics are still there. One gotcha: the HTTP API error alarm has to use `5xx`.
`5XXError` is the REST API metric name.

Application custom metrics, operational alarms, and audit logs all stay on.
Traffic and error alarms treat quiet windows as not breaching. Backup freshness
is the exception, where missing data counts as a failure.

## What Site Health reads

The admin Site Health page reads the application-stack alarm prefix in the home
region plus four specific website alarms: backup freshness, alert-delivery DLQ,
frontend 5xx, and media 5xx. It pages through the application alarms and
reports degraded health if an expected alarm is missing or a regional lookup
fails. It doesn't include the account-wide identity/security-change alarms, and
it doesn't expose AWS identifiers.

The live website and API latency checks are plain HTTP probes. Audit Log queries
CloudWatch Logs, and Website Analytics reads DynamoDB aggregates. None of them
depend on paid CloudFront or API route metrics.

## Updating these stacks

CI never deploys the observability or WAF stacks. I update them by hand through
change sets that I look over first. Run `cfn-lint` on the affected templates,
the operations suite, the backend health and audit tests, and the frontend
checks. Then run the read-only preflight:

```bash
python3 ops/observability_preflight.py \
  --deployment-mode update \
  --frontend-distribution-id FRONTEND_DISTRIBUTION_ID \
  --media-distribution-id MEDIA_DISTRIBUTION_ID \
  --expected-account-id EXPECTED_ACCOUNT_ID
```

In update mode, `observability_preflight.py` accepts a confirmed absence of the
paid monitoring subscriptions, which is the current state. Before I retired
them, it only accepted them when both specific resources belonged to the
existing stack. Create mode requires them to be absent. The script only calls
STS, CloudFront GET, and CloudFormation describe APIs, and it never changes
anything in AWS.

## How I retired the paid subscriptions

It took two change sets. The first only changed each legacy subscription's
`DeletionPolicy` from `Retain` to `Delete`. The second removed the resources. I
couldn't just set them to `Disabled`, because the CloudFormation resource
provider has no update handler and rejects that change. Deleting a monitoring
subscription turns off the additional metrics and leaves its distribution
alone.

For any change here, keep the live secret parameters and unrelated resources as
they are, then check final drift and public health.
[`ALARM_REGISTRY.md`](ALARM_REGISTRY.md) maps the edge alarms to what to do when
they fire.

## What it saves

The August 2026 bill put $2.26 on API route metrics and $1.83 on additional
CloudFront metrics. Treat those as historical savings estimates, not fixed
quotes. None of this adds browser telemetry, synthetic browser probes, or a new
notification destination. To roll back, restore an earlier approved template.
Leaving the paid metrics off doesn't affect basic error metrics or application
logging.
