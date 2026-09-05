# Website monitoring and cost controls

The home-region `ian-photography-observability` stack owns a dashboard containing
only free request/error metrics. The two paid CloudFront monitoring subscriptions
have been removed from both AWS and the template, so future stack deployments do
not recreate them.

The existing `ian-photography-front-door-waf` stack owns the frontend and media
5xx alarms in **us-east-1**, where CloudFront publishes its metrics. Pass the
exact `FrontendDistributionId` and `MediaDistributionId` when updating that stack.
The alarms use the free `5xxErrorRate` metric. Exact edge and WAF state events
cross to the home EventBridge bus; the notification stack converts ALARM states
to fixed `edge.alarm`/`waf.alarm` signals through the existing encrypted queue,
retry/DLQ, validation Lambda, and owner notification route.

API Gateway detailed route metrics are disabled. Stage-level latency and `5xx`
metrics remain available; the HTTP API error alarm must use `5xx`, not the REST
API metric name `5XXError`. Application custom metrics, operational alarms, and
audit logs remain enabled. Quiet windows remain non-breaching for traffic/error
alarms; backup freshness explicitly treats missing data as a failure.

## Admin dependencies

Site Health reads the application-stack alarm prefix in the home region plus
five exact website alarms: backup freshness, alert-delivery DLQ, frontend 5xx,
media 5xx, and WAF blocks. It paginates application alarms and returns degraded
health if an expected alarm is missing or a regional lookup fails. It does not
include account-wide identity/security-change alarms or expose AWS identifiers.
The live website/API latency checks are direct HTTP probes. Audit Log queries
CloudWatch Logs; Website Analytics reads DynamoDB aggregates. Neither relies on
paid CloudFront or API route metrics.

## Validation and rollout

Run `cfn-lint` on the affected templates, the operations suite, backend health
and audit tests, and frontend checks. The read-only `observability_preflight.py`
update mode accepts confirmed absence after retirement. Before retirement it
accepts enabled or disabled subscriptions only when both exact resources are
owned by the existing stack. Create mode requires confirmed absence. It never
mutates AWS resources.

Deploy notification forwarding before the new us-east-1 alarms. Confirm the
new alarms read real CloudFront data and have their exact EventBridge route,
then update the home observability stack to remove the two obsolete alarms and
paid subscriptions. For legacy subscriptions, first change only their
`DeletionPolicy` from `Retain` to `Delete`, then remove their resources in a second
reviewed change set. The deployed CloudFormation resource provider has no update
handler and rejects changing an existing subscription to `Disabled`. Deleting a
monitoring subscription disables additional metrics without changing its
distribution. Deploy the application metric/health changes
and UI copy. Review each CloudFormation change set, preserve live secret
parameters and unrelated resources, and verify final drift and public health.

The August 2026 bill attributed $2.26 to API route metrics and $1.83 to additional
CloudFront metrics. These are historical savings estimates, not fixed quotes.
No browser telemetry, synthetic browser probes, or new notification destination
is introduced. Rollback should restore a prior reviewed template; keeping paid
metrics disabled does not affect basic error metrics or application logging.
