# Privacy-controlled observability operations

`ops/observability_template.yaml` is the separately deployed, retained source
of truth for public browser, edge, and synthetic monitoring. It intentionally
does not own either CloudFront distribution. It owns only each distribution's
paid monitoring-subscription singleton, a sampled CloudWatch RUM monitor and
its exact unauthenticated writer role, a public-only Synthetics canary, private
artifact storage, alarms, and a dashboard.

Nothing in this rollout authorizes a deployment from an untrusted pull request.
Creating the stack, starting the canary, configuring an SNS subscription, or
adding GitHub variables is a separately approved production operation.

## Privacy contract

The approved collection boundary is deliberately smaller than the website:

- The browser decides whether it is in the 10% sample before downloading
  `aws-rum-web`. Global Privacy Control and Do Not Track always opt out.
- `/admin`, `/login`, `/dashboard`, and `/sharedalbum` (including descendants)
  are excluded before SDK loading and again by the SDK and RUM app-monitor
  configuration. Do not weaken any of these three independent controls.
- RUM cookies, X-Ray propagation, W3C tracing, custom events, session replay,
  debug logging, and the CloudWatch Logs copy of raw RUM events are disabled.
  Only performance, unhandled JavaScript error, and HTTP error telemetry is
  enabled. The restricted Cognito guest role can call only `rum:PutRumEvents`
  on the exact app-monitor name in this account and Region.
- The public canary accepts no album ID, share code, credential, cookie, or
  token. It discovers one item from `/public/albums?limit=1&type=photo`, verifies
  that item's anonymous public detail response, and downloads one responsive
  preview no larger than 512 KiB. It never calls authenticated, private,
  unlisted, dashboard, login, admin, or shared-album routes.
- Canary reports omit request/response headers and bodies. Automatic step
  screenshots are disabled except for one successful public-homepage
  screenshot. Error messages never contain the discovered public album ID or
  object URL. Artifacts are still internal operational data and remain in the
  private encrypted bucket for only the configured lifecycle period.

CloudWatch RUM still processes coarse browser, device, location, performance,
resource URL, and error context for sampled public sessions. Review the AWS
[RUM data contract](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch-RUM-datacollected.html)
and the site's privacy notice before changing telemetry, retention, domains,
sampling, or route exclusions.

## Cost boundary

This stack intentionally enables paid services:

- additional one-minute CloudFront metrics for exactly two distributions;
- RUM event ingestion for a locally selected 10% of eligible public sessions;
- one Synthetics run every 15 minutes after the canary is explicitly started;
- five alarms, one dashboard, Cognito unauthenticated identity requests, and
  short-lived S3 artifacts.

The canary is created stopped by default. `DryRunAndUpdate: true` validates code
and runtime changes before an update is accepted. Artifact current and
noncurrent versions expire after 31 days by default. RUM does not copy events to
CloudWatch Logs. Before activation, configure a cost budget/anomaly alert and
record the operator who accepted the current CloudFront, RUM, Synthetics,
CloudWatch, Cognito, and S3 prices. Review spend and event volume after 24 hours,
7 days, and 30 days; do not raise sampling or canary frequency merely to make a
dashboard look smoother.

## Validate and inventory

Run the repository checks before AWS inventory:

```bash
cfn-lint ops/observability_template.yaml
python3 -m unittest ops.tests.test_observability -v
npm test -- src/utils/rum.test.js
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
to make this deployment pass. If ownership is intentionally transferred, use a
reviewed CloudFormation import plan and update the runbook evidence first.

An authenticated operator can also run CloudFormation's read-only parser:

```bash
aws cloudformation validate-template \
  --region us-west-2 \
  --template-body file://ops/observability_template.yaml
```

## Staged rollout

1. Run create-mode preflight and save only the aggregate result with the change
   record. Do not publish credentials or canary artifacts.
2. Create and review a CloudFormation change set with the exact two distribution
   IDs, canonical site/API URLs, optional exact SNS topic ARN, exact tested
   `ReleaseSha`, and `StartPublicCanary=false`. Acknowledge IAM capabilities.
3. Confirm all resources are tagged. In particular, the Synthetics canary has
   explicit `Environment` and `ManagedBy=CloudFormation` tags because its
   resource provider does not reliably inherit those stack tags. Also confirm
   the RUM role ARN names only the expected app monitor, the artifact bucket is
   private/encrypted/versioned/lifecycle managed, and alarms route only to the
   reviewed topic (or nowhere when empty).
4. Execute the approved change set and enable termination protection. Do not
   start the canary from an unreviewed CI job.
5. Manually start the stopped canary once. Inspect the public-only screenshot,
   sanitized report, S3 encryption, logs, and all three public API/media checks.
   Stop it immediately if any artifact contains a header, body, identifier, or
   route outside this contract.
6. After that successful run, update the stack with
   `StartPublicCanary=true`. Keep `DryRunAndUpdate=true`.
7. Copy the four public outputs to the complete GitHub variable set:
   `VITE_RUM_APPLICATION_ID`, `VITE_RUM_IDENTITY_POOL_ID`,
   `VITE_RUM_GUEST_ROLE_ARN`, and `VITE_RUM_REGION`. They are identifiers, not
   credentials. The workflow injects the exact tested commit as
   `VITE_RELEASE_SHA`; never configure it manually.
8. Release the already-tested frontend. Verify GPC/DNT and sensitive routes do
   not download the RUM chunk, no RUM cookies appear, and eligible sampled public
   sessions send only to the exact app monitor.

The CI build accepts either all four RUM variables or none. Pull requests and
pre-deployment builds do not require them, so landing the stack source before
the production stack exists does not break the quality gate.

## Alarm ownership and triage

When `AlarmTopicArn` is empty, alarms exist without actions. When supplied, it
must be the exact pre-existing SNS topic ARN; this stack never invents an email
endpoint or subscription. Test and document delivery separately.

- Canary alarm: verify all public routes independently, then inspect the
  sanitized log and homepage screenshot. Never paste full artifacts into chat
  or tickets.
- CloudFront 5xx: compare frontend and media distributions, origin latency, and
  cache-hit metrics before changing cache behavior.
- RUM JavaScript errors: use aggregate error type/release correlation. Do not
  enable raw CloudWatch Logs or replay as a shortcut.
- RUM LCP: require sustained p75 regression across the configured windows and
  compare against canary/edge health before rolling back.

Treat missing canary data as breaching only after the canary is intentionally
started. RUM and low-traffic edge alarms treat missing data as not breaching.

## Rollback and cost stop

Rollback is layered and does not begin by deleting retained resources:

1. Stop the canary and set `StartPublicCanary=false` in the next reviewed stack
   update. This stops recurring runs but preserves evidence.
2. Remove all four RUM GitHub variables as one set and redeploy the previous
   attested frontend (or an otherwise identical build without the variables).
   The application then skips the SDK entirely. RUM service data ages out under
   AWS's 30-day retention because `CwLogEnabled` remains false.
3. If CloudFront metric charges must stop immediately, use the explicit
   `delete-monitoring-subscription` API only after recording that this creates
   CloudFormation drift. Reconcile ownership with a reviewed change/import
   plan before any future observability update.
4. Keep the retained app monitor, identity pool/attachment/role, canary role,
   and private artifact bucket until incident, billing, and retention reviews
   are complete. Delete them only with an explicit resource-by-resource plan.

Never delete the application stack, either CloudFront distribution, media,
albums, or security evidence as an observability rollback.
