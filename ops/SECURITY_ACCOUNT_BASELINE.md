# Guarded AWS account security operations

These templates implement the account security baseline. They are
separated by lifecycle and ownership boundary so a failed update or stack
deletion cannot strand a retained CloudTrail while deleting its bucket policy,
log group, or delivery role.

Reading or validating this repository never creates an SNS subscription, sends
email, deploys a stack, imports a resource, enables Inspector, or enables
another paid account service. Those remain explicit owner decisions after
inventory and a reviewed change set.

## Files and ownership

| Layer | File | Ownership and guard |
| --- | --- | --- |
| Audit foundation | `security_audit_foundation_template.yaml` | One home-region stack. The Object-Locked CloudTrail evidence bucket, bucket policy, log group, role, and multi-region trail are retained together. After Config is healthy, an opt-in parameter adds exact-bucket Config delivery object events. |
| Notifications | `security_notifications_template.yaml` | Regional encrypted SNS/KMS routing, encrypted SQS DLQ, metrics, and alarms. It creates no subscriber. |
| Managed services | `security_managed_services_template.yaml` | Config, GuardDuty, Security Hub, and account Access Analyzer. Every singleton defaults to `skip`. |
| Home detection posture | `ci/home_security_posture.py` | Aggregate-only, read-only verification of the exact home-Region GuardDuty and Security Hub contract. It fails closed and never prints provider identifiers, tags, findings, or Region names. |
| Backups | `security_backup_template.yaml` | Daily backup of both metadata tables into a retained CMK-encrypted vault. Creation and Vault Lock default off. |
| Cost governance | `security_budget_template.yaml`, `security_budget_preflight.py` | One retained, alert-only account budget. Creation defaults off and requires an owner-approved amount plus one confirmed owner-controlled human destination. |
| Alarm map | `alarm_registry.json`, `ALARM_REGISTRY.md` | Complete source signal inventory, privacy contract, runbook routing, response ownership, and quarterly delivery-test state. |
| Inventory | `security_preflight.py` | Read-only AWS inventory. Access errors become `skip-inventory-incomplete`, never “absent.” |
| Inspector | `enable_inspector_lambda_scanning.py` | Dry-run-by-default Inspector Lambda and Lambda code scanning enrollment with exact apply guards. |

`us-west-2` is the reviewed home Region. The foundation trail already records
multi-region and global management events, so do not deploy another foundation
copy elsewhere. Config delivery, the managed GuardDuty detector, Security Hub,
Access Analyzer, and their notification routing are home-region-only in this
design. This repository does not claim GuardDuty or Security Hub coverage in
other Regions and does not deploy or manage a Security Hub finding aggregator.

## Validate before an AWS decision

Run:

```bash
./ops/validate_infrastructure.sh
```

The focused checks are:

```bash
python3 -m unittest \
  ops.tests.test_config_delivery_orchestrator \
  ops.tests.test_home_security_posture \
  ops.tests.test_security_operations \
  -v
cfn-lint \
  ops/security_audit_foundation_template.yaml \
  ops/security_notifications_template.yaml \
  ops/security_managed_services_template.yaml \
  ops/security_backup_template.yaml \
  ops/security_budget_template.yaml
```

With authenticated read-only AWS access, perform the additional service-side
schema check in the intended region:

```bash
aws cloudformation validate-template --region us-west-2 \
  --template-body file://ops/security_audit_foundation_template.yaml
aws cloudformation validate-template --region us-west-2 \
  --template-body file://ops/security_notifications_template.yaml
aws cloudformation validate-template --region us-west-2 \
  --template-body file://ops/security_managed_services_template.yaml
aws cloudformation validate-template --region us-west-2 \
  --template-body file://ops/security_backup_template.yaml
aws cloudformation validate-template --region us-west-2 \
  --template-body file://ops/security_budget_template.yaml
```

## Inventory and conflict decisions

Use the same identity that would deploy:

```bash
python3 ops/security_preflight.py --region us-west-2 --stage prod
```

After the foundation exists, include its exact log group so metric filters are
inventoried too:

```bash
python3 ops/security_preflight.py \
  --region us-west-2 \
  --stage prod \
  --audit-log-group-name /aws/security/ian-photography-prod \
  --details
```

The normal report hides AWS identifiers. `--details` reveals only AWS
names/identifiers needed for ownership or import review, never log events,
findings, table items, or backup content. Exit status `2` means the inventory is
incomplete; keep every create mode at `skip` while `inventoryErrors` is nonempty.

For any existing singleton or matching fixed name, stop and determine the
current owner:

- Existing recorder or channel: `ConfigDeploymentMode=skip`.
- Existing detector: `GuardDutyDeploymentMode=skip` only after `get-detector`
  proves it is enabled and all 12 reported feature states exactly match the
  reviewed inventory. The six CloudFormation-configurable states are S3/Lambda
  enabled and EKS audit, EBS malware, RDS login, and runtime monitoring
  disabled. GuardDuty's service-managed CloudTrail, DNS, and flow-log sources
  must be enabled; AI analyst, AI protection, and legacy EKS runtime monitoring
  must be disabled. A missing, extra, suspended, drifted, or newly unreviewed
  feature blocks rollout.
  Check Organizations and delegated-
  administrator ownership before changing features.
- Existing hub: `SecurityHubDeploymentMode=skip` only after the home hub has
  exactly the reviewed Foundational Security Best Practices and CIS 1.2.0
  default standards. Each standard must be `READY`, or provider-reconciling
  `PENDING` while controls remain `READY_FOR_UPDATES` and no status reason is
  present. Also check central configuration and delegated administration before
  changing its configuration.
- Existing account analyzer: `AccessAnalyzerDeploymentMode=skip`; preserve its
  archive rules.
- Existing named trail, log group, topic, KMS alias, queue, rule, alarm, vault,
  or plan: use its current stack, perform a separately reviewed supported
  import, or keep it externally managed. Never deploy over an unexplained name.

Import is not automatic. First verify that the resource type supports import,
capture its identifier and current configuration, retain it in the template,
create an import change set, and review drift afterward. Never delete an account
security service merely to make this template create a replacement.

Every managed-services stack operation must now pass `ExpectedAccountId` and
`ExpectedRegion`. CloudFormation rules compare them to `AWS::AccountId` and
`AWS::Region` before evaluating resources, including a nominal all-`skip`
deployment. Never use a guessed value or reuse a regional parameter file in a
different Region.

### Home-Region GuardDuty and Security Hub posture

Run the read-only home posture verifier:

```bash
python3 ops/ci/home_security_posture.py --region us-west-2
```

The verifier accepts only a syntactically valid Region and then requires exactly
one enabled GuardDuty detector with 15-minute publishing, the complete reviewed
12-feature map, and the required application/stage tags. Additional AWS- or
CloudFormation-managed tags are allowed, but missing or changed required tags,
unknown features, duplicate features, or any feature-state difference fail
closed.

It also requires the home Security Hub default hub, the `SECURITY_CONTROL`
finding generator, the required application/stage tags, and exactly the reviewed
Foundational Security Best Practices and CIS 1.2.0 standards. `READY` is the
steady state. AWS also uses `PENDING` while it adds controls to an already
enabled standard; that state is accepted only when controls remain
`READY_FOR_UPDATES` and no status reason exists. A missing hub, extra or missing
standard, non-updatable transition, failure reason, malformed provider response,
access failure, or timeout returns exit status `2`. Errors are generic, and a
successful report contains only detector, hub, standard, and provider-transition
counts plus `IN_SYNC`; it never exposes detector IDs, ARNs, account identity,
tags, findings, or provider responses.

This verifier performs no mutation and does not inventory or claim protection
outside the home Region. Create or update the managed-services stack only through
a separately reviewed CloudFormation change set with the exact account and home-
Region parameters. Require no unexplained replacement or deletion, enable stack
termination protection, and rerun the home posture check after the stack reaches
a stable state. Do not infer GuardDuty or Security Hub cross-Region coverage
from the multi-region CloudTrail foundation.

## Guarded stack operations

### 1. Audit foundation

Create only a reviewed change set for
`security_audit_foundation_template.yaml` after confirming that the exact trail
and log-group names are free and another multi-region management trail is not
already preferred. Immediately after successful creation, enable termination
protection on the foundation stack.

The complete five-resource delivery chain uses `RetainExceptOnCreate` and
retained replacements. This cleans up a normal initial rollback and keeps the
whole evidence path after successful creation. S3 Object Lock can still retain
objects written during an unusual failed create, which is why this is a small
foundation-only stack and the trail depends on the bucket policy. Never
force-delete the bucket or policy to resolve a stack operation.

Verify trail logging, digest validation, CloudWatch delivery, versioning, Object
Lock governance retention, public access block, and the TLS deny. Confirm the
bucket policy and role trust constrain CloudTrail to the exact trail ARN and
account. Confirm termination protection is enabled.

Leave `ConfigDeliveryBucketName` empty during initial foundation creation. The
dedicated Config delivery bucket does not exist until the managed-services
stack is successfully created, and an empty value preserves management-event
logging without enabling any S3 object data-event selector. Do not guess or
precompute the generated bucket name.

### 2. Notifications and alarms

Pass the foundation log-group output to
`security_notifications_template.yaml`. The topic uses a retained rotating
customer KMS key. Native CloudWatch and Budget publishers are limited to the
exact account/source resources, topic encryption context, and regional SNS
service. EventBridge never publishes directly to the trusted responder topic:
the exact four managed-finding and three backup-failure rule ARNs may send only
to an encrypted SQS ingress queue. A bounded Lambda validates the complete fixed
signal contract before publishing through its exact IAM role. This avoids the
unscopable EventBridge-to-SNS topic-policy trust boundary.

All managed-finding EventBridge targets use bounded retries and an encrypted
14-day SQS DLQ. Both queue policies accept only the exact seven rule ARNs. A
DLQ-depth alarm alerts
on the first visible failed delivery. Additional audit alarms cover KMS key
disable/deletion/policy/alias changes and security routing changes, along with
root, IAM, CloudTrail, managed-security-service, data-protection, and
infrastructure-protection configuration activity. GuardDuty and Security Hub
targets send only static signal/severity/stage/runbook JSON; raw finding payloads
never enter either queue or the notification channel. HIGH and CRITICAL findings
use separate rules and retain their response severity.

No subscriber is created. Attach a monitored destination only after the owner
approves it and completes its confirmation flow. Test a controlled alarm and
EventBridge event after routing exists. Inspect only aggregate DLQ counts; do
not print finding messages.

### 3. Managed security services

For a new account or an intentional re-creation, first deploy
`security_managed_services_template.yaml` with every mode at `skip`; that
produces a no-op singleton layer. Routine updates preserve the current live
parameters. Only a fresh complete inventory proving one service absent justifies
its exact `create-confirmed-absent` value.

Config no longer accepts or uses the audit-foundation bucket. AWS Config does
not support a delivery channel targeting an S3 bucket with Object Lock default
retention, so this stack creates a separate, retained Config-history bucket. It
is private, SSE-S3 encrypted, versioned, TLS-only, lifecycle-managed, and has no
Object Lock default retention. Its three Config service grants are restricted
to the exact account and regional Config source ARN. The recorder role has the
same exact bucket and object-prefix scope as a fallback. The CloudTrail evidence
bucket policy contains no Config grant.

The Config control-plane startup order needs special handling. The native
`AWS::Config::ConfigurationRecorder` provider calls `PutConfigurationRecorder`
and then waits for a delivery channel before it stabilizes. `PutDeliveryChannel`
in turn rejects a request until that recorder API record exists. Native recorder
and channel handlers can therefore both remain `CREATE_IN_PROGRESS` without the
channel handler ever issuing `PutDeliveryChannel`.

This template keeps the native recorder, but replaces the native delivery
channel with a narrowly scoped `Custom::ConfigDeliveryChannel`. The custom
resource starts concurrently with the native recorder, polls only the aggregate
recorder description until the exact expected recorder appears, rejects any
other recorder or channel, then calls `PutDeliveryChannel` for the exact
stack-created bucket. This unblocks the native provider, which starts and
stabilizes the recorder normally. Config rules depend on both completed
resources. Do not add a recorder dependency to the custom channel or a channel
dependency to the recorder; either change recreates the deadlock.

The orchestration Lambda can only describe Config state, put/delete the sole
regional delivery channel, stop the exact expected recorder during an
initial-create rollback, and get/put/delete one fixed regional SSM ownership
parameter. IAM applies the active-region condition, while the SSM statement is
also restricted to the exact account, stage, and parameter ARN. The handler
independently verifies the expected account, region, names, bucket, frequency,
recorder role ARN, exact resource-type set, old update state, stack ARN, and
CloudFormation physical ownership before mutation. It logs only request type,
aggregate outcome, and exception class; it never logs a CloudFormation event,
response URL, bucket name, marker token, or service response.

Create and update are retry-safe. Before `PutDeliveryChannel`, the handler
creates `/ian-photography/config-delivery/ian-photography-STAGE/owner` with
overwrite disabled. Its value is a one-way SHA-256 token derived from the stack
ID, not the stack ID itself. A retry from the same stack recovers that marker
and the exact channel. Another token, a pre-existing exact channel without the
marker, a missing marker during update, or drifted channel state fails closed.
There is no adoption path in the custom resource.

On a create failure, the callback returns the deterministic owned physical ID
as soon as the account/region/property scope is valid, even if the failure
happened after AWS accepted `PutDeliveryChannel`. Initial rollback may delete a
channel only when the physical ID, StackId-derived marker, channel definition,
recorder role ARN, and recorder resource-type set all still match. A missing or
mismatched marker, pre-existing channel, or drifted recorder/channel is never
stopped or deleted. If the channel never existed, rollback removes only its own
matching marker. The bounded 420-second recorder wait runs inside a 600-second
Lambda and 660-second custom-resource timeout, reserving at least 90 seconds for
verification and a three-attempt CloudFormation callback.

After a successful create, `RetainExceptOnCreate` preserves the recorder,
channel and its ownership marker, delivery bucket, bucket policy, and recorder
role on ordinary stack deletion, matching the rest of the account-security
retention posture.

Use `GlobalResourceRecordingMode=record-confirmed-home-region` only in the
chosen home region. The explicit resource list conditionally adds IAM and
CloudFront in that mode; it deliberately omits `IncludeGlobalResourceTypes`,
whose behavior is ambiguous alongside explicit types.

Before an enabled deployment, inventory must show no recorder and no delivery
channel. Also require the fixed SSM ownership parameter to be absent; check its
name only and never print its value:

```bash
aws ssm get-parameter \
  --region us-west-2 \
  --name /ian-photography/config-delivery/ian-photography-prod/owner \
  --query 'Parameter.Name' \
  --output text
```

`ParameterNotFound` is the expected pre-create result. Any returned parameter
requires ownership investigation; do not delete it merely to make a deployment
pass. If a previous failed native rollout is still `CREATE_IN_PROGRESS`, do
not manually create a channel or update the in-progress stack. Let the exact
stack reach rollback, confirm the failed stack no longer owns a recorder or
channel and the marker is absent, delete only the failed stack through
CloudFormation if required, rerun preflight, and then use a newly reviewed
create change set. If either singleton or the marker survives or belongs to
another owner, keep `ConfigDeploymentMode=skip` and use a separately reviewed
import/adoption plan; this template intentionally fails closed rather than
taking it over.

After the stack completes, verify without printing configuration content:

```bash
aws configservice describe-configuration-recorders \
  --region us-west-2 \
  --query 'ConfigurationRecorders[].name'
aws configservice describe-configuration-recorder-status \
  --region us-west-2 \
  --query 'ConfigurationRecordersStatus[].{name:name,recording:recording,lastStatus:lastStatus}'
aws configservice describe-delivery-channels \
  --region us-west-2 \
  --query 'DeliveryChannels[].{name:name,bucket:s3BucketName,frequency:configSnapshotDeliveryProperties.deliveryFrequency}'
aws configservice describe-delivery-channel-status \
  --region us-west-2 \
  --query 'DeliveryChannelsStatus[].{name:name,historyStatus:configHistoryDeliveryInfo.lastStatus,snapshotStatus:configSnapshotDeliveryInfo.lastStatus}'
aws ssm get-parameter \
  --region us-west-2 \
  --name /ian-photography/config-delivery/ian-photography-prod/owner \
  --query 'Parameter.Name' \
  --output text
```

Require exactly one expected recorder, `recording=true`, exactly one expected
channel targeting the `ConfigDeliveryBucketName` stack output, and no failed
delivery status. Require the SSM command to return only the expected parameter
name; never query its value. Confirm the delivery bucket still has versioning,
encryption, public access blocks, and no Object Lock configuration. Do not print
delivered configuration objects in deployment or CI logs.

Only after those checks pass, update the audit-foundation stack through a
reviewed change set and pass the managed-services stack's exact
`ConfigDeliveryBucketName` output to the audit foundation parameter of the same
name. The resulting basic event selector keeps all read/write management,
multi-region, and global-service coverage and adds one `AWS::S3::Object` data
resource with the exact trailing-slash bucket ARN. It does not audit any other
application, media, release, or audit bucket.

Verify the selector shape without querying or printing events:

```bash
aws cloudtrail get-event-selectors \
  --region us-west-2 \
  --trail-name ian-photography-security-prod \
  --query 'EventSelectors[].{management:IncludeManagementEvents,readWrite:ReadWriteType,dataResources:DataResources}'
```

Require management events to remain enabled with `ReadWriteType=All`, and
require exactly one data resource of type `AWS::S3::Object` whose only value is
`arn:aws:s3:::EXACT_CONFIG_DELIVERY_BUCKET/`. If the managed Config stack is
intentionally removed or externally managed later, update this parameter only
after an ownership review; an empty value removes the Config object selector
but leaves management-event coverage intact.

GuardDuty's complete reported feature inventory is explicit. CloudFormation
configures six protection plans: S3 data events and Lambda network logs are
enabled; EKS audit logs, EBS malware protection, RDS login events, and runtime
monitoring are disabled. The home posture verifier additionally requires the
service-managed CloudTrail, DNS, and flow-log sources to be enabled and AI
analyst, AI protection, and legacy EKS runtime monitoring to be disabled.
Enable other protection plans only with a documented threat model,
supported-resource inventory, and cost approval. Confirm
Security Hub standards and organization ownership before creating the hub. The
home posture verifier requires both reviewed standards to be fully updatable
and free of a failure reason; the steady state is `READY`, while AWS control
expansion may temporarily report `PENDING`. The managed-services template
enables them when the same home stack creates the Config recorder.
The Config layer also checks public S3 writes, default S3 encryption, public
Lambda function access, and customer-managed KMS key rotation. These rules use
only resource types already recorded by the exact home-region recorder. The
rollout deliberately omits the us-east-1-only CloudFront HTTPS managed rule and
noisy blanket versioning/deletion-protection rules that would flag intentional
ephemeral or log resources.

### 4. Inspector Lambda scanning

Inspector cannot be enrolled through a normal CloudFormation resource. First
run the helper without `--apply`:

```bash
python3 ops/enable_inspector_lambda_scanning.py --region us-west-2
```

It reports only status and never enables EC2 or ECR scanning. Apply only after
the paid-service cost and code-retention implications are approved and both
Lambda modes are exactly `DISABLED`:

```bash
python3 ops/enable_inspector_lambda_scanning.py \
  --region us-west-2 \
  --apply \
  --expected-account-id EXPECTED_12_DIGIT_ACCOUNT \
  --expected-region us-west-2 \
  --expected-lambda-state DISABLED \
  --expected-lambda-code-state DISABLED \
  --confirm enable-inspector-lambda-code-scanning
```

The helper rejects partial or preexisting enrollment instead of taking over an
unknown configuration. It has no disable action. After an approved apply, it
waits up to five minutes by default for both requested modes to move through
the eventually consistent `DISABLED`/`ENABLING` transition and reach exactly
`ENABLED`; any other state or a bounded-wait expiry fails the operation. A mode
that remains `DISABLED` never satisfies the postcondition.
`--wait-timeout-seconds` accepts 30 through 900 seconds and
`--poll-interval-seconds` accepts 1 through 30 seconds when a different bounded
wait is operationally necessary. Review findings without exporting code or
secrets, and document a rollback decision separately if cost or compatibility
is unacceptable.

### 5. Scheduled backup and restore gate

Pass exact names for both the Albums and PreviewMetadata DynamoDB tables. Their
ARNs are constructed from the active partition, region, and account, so index,
stream, cross-account, and cross-region ARNs cannot be supplied. Use
`BackupDeploymentMode=create-confirmed-no-conflict` only when the vault, plan,
and backup KMS alias are absent.

The retained vault uses a retained, rotating customer KMS key and retained
alias. Its key policy limits AWS Backup use to the active account and regional
Backup source ARN. The scheduled role includes backup-only managed policies;
it cannot restore. Its trust policy keeps `aws:SourceAccount` exact and accepts
AWS Backup source ARNs only from the home Region and the fixed replica Region.
Both entries are required because AWS Backup assumes the same role while
creating the cross-Region copy; a wildcard Region is not used.

Keep `VaultLockMode=unlocked` until a scheduled recovery point exists. Create a
separate temporary least-privilege restore role, restore both tables under new
names, compare schemas and aggregate record counts, exercise application reads,
record recovery time, and remove the test tables through approved cleanup. Only
then may a reviewed update use
`governance-confirmed-after-restore-test`. Governance mode remains reversible
by sufficiently privileged identities. Compliance mode requires a separate
legal and retention decision because it can become irreversible.

The primary backup stack also owns privacy-safe EventBridge failure signals for
backup jobs, replica copy jobs, and restore jobs. Every target receives a fixed
signal/stage/runbook payload instead of the AWS event, resource ARN, job ID,
object key, provider error, or table/media identifier. The existing security
topic, exact-rule signal queue, and delivery DLQ are mandatory whenever the
backup plan is created. Their ARNs are not operator inputs: the backup template
derives the exact same-account, `us-west-2`, and stage-owned names used by the
notification stack. Update the notification stack first so both queue policies
trust the three exact backup rules before enabling them.

A six-hour scheduled verifier reads recovery-point metadata only and publishes
aggregate expected, healthy, and failed counts. It requires a fresh completed
recovery point for the two tables and media bucket in the source vault and,
when configured, the exact same-account replica vault. The alarm treats missing
metrics as breaching, so a stopped verifier or stopped backup schedule cannot
remain silently green. Neither logs nor metrics include resource or recovery-
point ARNs.

The replica vault is intentionally a separate `us-east-2` stack and has no
invented cross-Region human route. After that exact same-account, same-stage
stack is deployed, set
`ReplicaBackupDeploymentMode=use-existing-same-account-stage`; the primary
template derives its ARN rather than accepting a caller-supplied destination.
A restore started directly in that Region is not covered by the `us-west-2`
restore-failure rule. Keep replica-region restore operations gated until an
owner approves and tests same-Region notification routing; do not route raw
restore events across Regions as a shortcut.

### 6. Cost budget and notification ownership

Follow [`COST_GOVERNANCE.md`](COST_GOVERNANCE.md). The source-controlled budget
has no default spending amount, email address, subscription, resource action,
or automatic security-control disablement. Its read-only preflight recommends
creation only when the exact budget name is absent, the exact encrypted security
topic exists, and one confirmed owner-controlled human-compatible destination is
present. HTTPS, SQS, and Lambda fan-out do not satisfy that ownership gate. The
separate alarm-routing readiness contract still requires primary and backup
responders with two tested destinations.

The current checked-in alarm registry is
`degraded-one-confirmed-human-destination`: the site owner has one confirmed
destination, while the backup owner, second destination, and last end-to-end
test date remain unassigned. Those remaining items are human decisions, not safe
repository defaults. Complete them and test sanitized delivery before calling
the route fully redundant.

## Maintenance, cost, and evidence

Before enabling a paid service, record its owner, region scope, estimated
monthly cost, retention, and alert destination. CloudTrail S3 object data events
are billable and can increase CloudTrail, S3, and CloudWatch ingestion volume;
this design limits them to the dedicated low-volume Config delivery bucket.
Data-event records can include Config object keys and request metadata, but not
the delivered object body. Treat those records as security evidence: do not
print event payloads or object keys in CI, deployment output, tickets, or chat.
Review CloudTrail/CloudWatch ingestion and retention, Config items/rules,
GuardDuty plans, Security Hub checks, Inspector Lambda/code coverage,
KMS/SNS/SQS requests, AWS Backup storage and restore tests, and S3
archive/retrieval.

Quarterly, rerun preflight and drift detection. Check trail delivery and digest
validation, Config status, detector/hub/analyzer ownership, Inspector coverage,
KMS rotation, DLQ depth, alarms, backup jobs, and a sample restore. Never put
event payloads, finding bodies, tokens, table items, contact content, object
keys, code findings, or backup contents in CI or runbook output.

AWS behavior references:

- [CloudTrail S3 bucket policy](https://docs.aws.amazon.com/awscloudtrail/latest/userguide/create-s3-bucket-policy-for-cloudtrail.html)
- [AWS Config delivery channel](https://docs.aws.amazon.com/config/latest/developerguide/manage-delivery-channel.html)
- [GuardDuty Regions](https://docs.aws.amazon.com/guardduty/latest/ug/guardduty_regions.html)
- [EventBridge resource policies](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-use-resource-based.html)
- [SNS encrypted-topic key management](https://docs.aws.amazon.com/sns/latest/dg/sns-key-management.html)
- [CloudFormation RetainExceptOnCreate](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-attribute-deletionpolicy.html)
- [AWS Backup Vault Lock](https://docs.aws.amazon.com/backup/latest/devguide/vault-lock.html)
- [AWS Budgets SNS policy and encrypted-topic permissions](https://docs.aws.amazon.com/cost-management/latest/userguide/budgets-sns-policy.html)
- [CloudFormation AWS Budgets resource](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-budgets-budget.html)
