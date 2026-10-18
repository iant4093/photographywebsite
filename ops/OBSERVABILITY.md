# Website monitoring and cost controls

Website monitoring uses free metrics. The `ian-photography-observability` stack
in `us-west-2` (`ops/observability_template.yaml`) contains one resource, a
CloudWatch dashboard of free request and error metrics. The template defines no
CloudFront monitoring subscriptions, and neither distribution has one.

## Edge alarms

CloudFront publishes its metrics in `us-east-1`, so the frontend and media 5xx
alarms are defined in the `ian-photography-front-door-waf` stack
(`ops/waf_front_door_template.yaml`) in that Region. When updating that stack,
pass the correct `FrontendDistributionId` and `MediaDistributionId`. Alarm
forwarding is created only when `SecurityEventBusArn` is set.

Both alarms use the free `5xxErrorRate` metric and go to ALARM when the rate is
above 5% for three of three five-minute periods. Missing data is treated as not
breaching. The `ian-photography-waf-cross-region-prod` rule forwards state
changes for these two alarms to the `us-west-2` default event bus. There, the
`ian-photography-waf-alarm-prod` rule in the notification stack matches ALARM
states and sends a fixed payload to the encrypted security signal queue. The
signal processor Lambda validates it as the `edge.alarm` signal and publishes
the owner notification. The rule has a retry policy and a dead-letter queue.

WAF blocks have no alarm. They are visible in the redacted WAF log, which keeps
only BLOCK actions, and in the per-rule CloudWatch metrics.

## API and application metrics

API Gateway detailed route metrics are off (`DetailedMetricsEnabled: false` in
`backend/template.yaml`). Stage-level latency and `5xx` metrics remain. The
HTTP API error alarm uses the metric name `5xx`; `5XXError` is the REST API
metric name.

Application custom metrics, operational alarms, and audit logs stay on. Traffic
and error alarms treat missing data as not breaching. The backup freshness alarm
is the exception: it treats missing data as breaching.

## What Site Health reads

The admin Site Health page (`backend/functions/get_site_health.py`) reads:

- every alarm whose name starts with the application stack name, in `us-west-2`;
- the backup freshness and alert-delivery DLQ alarms in `us-west-2`;
- the frontend and media 5xx alarms in `us-east-1`;
- the application stack status.

It pages through the alarms and reports degraded health if an expected alarm is
missing or a lookup fails. It does not include the account-wide
identity/security-change alarms, and it does not return AWS identifiers.

The website and API checks are plain HTTP probes. Audit Log queries CloudWatch
Logs, and Website Analytics reads DynamoDB aggregates. None of them use paid
CloudFront or API route metrics.

## Updating these stacks

CI does not deploy the observability or WAF stacks. Update them manually through
reviewed change sets. Before that, run `cfn-lint` on the affected templates, the
operations test suite, the backend health and audit tests, and the frontend
checks. Then run the read-only preflight:

```bash
python3 ops/observability_preflight.py \
  --deployment-mode update \
  --frontend-distribution-id FRONTEND_DISTRIBUTION_ID \
  --media-distribution-id MEDIA_DISTRIBUTION_ID \
  --expected-account-id EXPECTED_ACCOUNT_ID
```

In update mode, `observability_preflight.py` accepts either confirmed absence of
both monitoring subscriptions (the current state) or both subscriptions present
and owned by the stack. Create mode requires them to be absent. The script calls
only STS, CloudFront read, and CloudFormation describe APIs.

For any change, keep the live secret parameters and unrelated resources as they
are, then check final drift and public health.
[`ALARM_REGISTRY.md`](ALARM_REGISTRY.md) lists the response for each edge alarm.

## Retiring the monitoring subscriptions

The paid subscriptions were removed in commit `18b99f6` with two change sets.
The first changed each subscription's `DeletionPolicy` from `Retain` to
`Delete`. The second removed the resources. The CloudFormation
`AWS::CloudFront::MonitoringSubscription` provider has no update handler, so
changing an existing subscription to `Disabled` is rejected. Deleting a
monitoring subscription turns off the additional metrics and does not change
the distribution.

## Cost

In Cost Explorer for August 2026, global `CW:MetricMonitorUsage` (the
additional CloudFront metrics) was $1.83. API route metrics are billed inside
`us-west-2` CloudWatch metric usage and are not shown separately. This stack
adds no browser telemetry, synthetic browser probes, or notification
destination. To roll back, restore an earlier approved template. Leaving the
paid metrics off does not affect basic error metrics or application logging.
