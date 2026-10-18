# AWS account security stacks

These templates set up the account-level security baseline. I split them by
lifecycle and by who owns what, so a failed update or a stack deletion can't
leave a retained CloudTrail behind after deleting its bucket policy, log group
or delivery role.

Reading or validating this repo never creates an SNS subscription, sends
email, deploys a stack, imports a resource or turns on a paid account service.
I make each of those calls myself, after an inventory and a change set I've
looked over.

## What's in each file

| Layer | File | What it owns and what stops it doing damage |
| --- | --- | --- |
| Audit foundation | `security_audit_foundation_template.yaml` | One home-Region stack. The Object-Locked CloudTrail evidence bucket, bucket policy, log group, role and multi-region trail are retained together. Once Config is healthy, an opt-in parameter adds Config delivery object events for that one bucket. |
| Notifications | `security_notifications_template.yaml` | Regional SNS routing for privacy-safe website alarms and the root-activity alarm, encrypted SQS delivery queues, and record-only account alarms. It keeps the subscriber I approved without paying for a dedicated KMS key every month. |
| Managed services | `security_managed_services_template.yaml` | Config, GuardDuty, Security Hub and the account Access Analyzer. Every singleton defaults to `skip`. |
| Home detection check | `ci/home_security_posture.py` | Read-only check of the home-Region GuardDuty and Security Hub setup that reports aggregates only. Any mismatch fails it, and it never prints provider identifiers, tags, findings or Region names. |
| Backups | `security_backup_template.yaml`, `security_backup_replica_template.yaml` | Daily backup of both metadata tables into a retained vault using the AWS-managed key, plus the old `us-east-2` replica vault, kept only until its recovery points age out. S3 relies on versioning and the existing external media backup. Creation and Vault Lock are off by default. |
| Cost | `security_budget_template.yaml`, `security_budget_preflight.py` | One optional retained account budget. Creation is off by default and needs an amount I've approved. An optional owner email, set at deploy time, gets free alerts when actual or forecast spend goes over 100%. |
| Alarm map | `alarm_registry.json`, `ALARM_REGISTRY.md` | Every source signal, the privacy rules, which runbook handles it, who responds, and when delivery was last tested (quarterly). |
| Inventory | `security_preflight.py` | Read-only AWS inventory. Access errors show up as `skip-inventory-incomplete`, never as “absent.” |
| Inspector | `disable_inspector_lambda_scanning.py` | Turns off the redundant paid Lambda scanners. It's a dry run unless every apply flag matches. CI stays the code and dependency scanner. |

`us-west-2` is the home Region. The foundation trail already records
multi-region and global management events, so don't deploy a second copy of the
foundation anywhere else. Config delivery, the managed GuardDuty detector,
Security Hub and Access Analyzer only run in the home Region. They stay
queryable and audited, but their account-wide findings don't go to the website
email topic. I don't claim GuardDuty or Security Hub coverage in any other
Region, and this repo doesn't deploy or manage a Security Hub finding
aggregator.

## Validate before touching AWS

Run:

```bash
./ops/validate_infrastructure.sh
```

The focused checks are:

```bash
python3 -m unittest \
  ops.tests.test_config_delivery_orchestrator \
  ops.tests.test_home_security_posture \
  ops.tests.test_security_baseline \
  ops.tests.test_security_budget \
  ops.tests.test_security_operations \
  -v
cfn-lint \
  ops/security_audit_foundation_template.yaml \
  ops/security_notifications_template.yaml \
  ops/security_managed_services_template.yaml \
  ops/security_backup_template.yaml \
  ops/security_backup_replica_template.yaml \
  ops/security_budget_template.yaml
```

With read-only AWS credentials, also run CloudFormation's own schema check in
the target Region:

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

## Inventory first, then decide what to create

Run this as the same identity that would deploy:

```bash
python3 ops/security_preflight.py --region us-west-2 --stage prod
```

Once the foundation exists, pass its log group so the metric filters get
inventoried too:

```bash
python3 ops/security_preflight.py \
  --region us-west-2 \
  --stage prod \
  --audit-log-group-name /aws/security/ian-photography-prod \
  --details
```

The normal report hides AWS identifiers. `--details` shows only the AWS names
and identifiers I need to work out ownership or plan an import. It never shows
log events, findings, table items or backup content. Exit status `2` means the
inventory is incomplete. While `inventoryErrors` has anything in it, leave every
create mode at `skip`.

If a singleton already exists, or something already has one of the fixed names,
stop and find out who owns it:

- Existing recorder or channel: `ConfigDeploymentMode=skip`.
- Existing detector: `GuardDutyDeploymentMode=skip`, but only after
  `get-detector` shows it's enabled and all 12 reported feature states match
  the inventory I signed off on. CloudFormation can configure six of them: S3
  and Lambda on; EKS audit, EBS malware, RDS login and runtime monitoring off.
  GuardDuty's service-managed CloudTrail, DNS and flow-log sources must be on,
  and AI analyst, AI protection and legacy EKS runtime monitoring must be off.
  Any feature that's missing, extra, suspended, drifted or new blocks the
  rollout. Check Organizations and delegated-administrator ownership before
  changing features.
- Existing hub: `SecurityHubDeploymentMode=skip`, but only after the home hub
  shows zero enabled standards, the `SECURITY_CONTROL` finding generator and
  the required tags. I keep the broad standards off because their paid Config
  evaluations cost far too much for an account this size. The targeted Config
  rules further down are the control set I actually use. Check central
  configuration and delegated administration before changing the hub.
- Existing account analyzer: `AccessAnalyzerDeploymentMode=skip`, and keep its
  archive rules.
- Existing trail, log group, topic, KMS alias, queue, rule, alarm, vault or plan
  with a matching name: manage it from the stack it's already in, do a separate
  supported import, or leave it managed outside this repo. Never deploy over a
  name I can't explain.

Imports don't happen on their own. First check that the resource type supports
import, capture its identifier and current configuration, set it to retain in
the template, create an import change set, and check drift afterwards. Never
delete an account security service just so this template can create a fresh
one.

Every managed-services stack operation has to pass `ExpectedAccountId` and
`ExpectedRegion`. CloudFormation rules compare them to `AWS::AccountId` and
`AWS::Region` before any resource is evaluated, even on an all-`skip` deploy.
Never guess these values, and never reuse one Region's parameter file in
another Region.

### Checking GuardDuty and Security Hub in the home Region

Run the read-only home check:

```bash
python3 ops/ci/home_security_posture.py --region us-west-2
```

It only accepts a well-formed Region name. It then requires exactly one enabled
GuardDuty detector with 15-minute publishing, the full 12-feature map I signed
off on, and the required application/stage tags. Extra tags added by AWS or
CloudFormation are fine. Missing or changed required tags, unknown features,
duplicate features or any difference in feature state fail the check.

It also requires the home Security Hub default hub, the `SECURITY_CONTROL`
finding generator, the required application/stage tags and zero enabled
standards. An enabled standard counts as drift from the low-cost setup I chose.
A missing hub, an enabled standard, a malformed provider response, an access
failure or a timeout all return exit status `2`. Errors are generic. A passing
report only contains detector, hub, standard and provider-transition counts
plus `IN_SYNC`. It never shows detector IDs, ARNs, account identity, tags,
findings or provider responses.

The check changes nothing, and it doesn't inventory or vouch for anything
outside the home Region. Create or update the managed-services stack only
through its own CloudFormation change set with the right account and home-Region
parameters. Don't accept a replacement or deletion I can't explain, turn on
stack termination protection, and rerun the home check once the stack is stable.
The multi-region CloudTrail foundation doesn't mean GuardDuty or Security Hub
cover other Regions.

## Stack operations, in order

### 1. Audit foundation

Create `security_audit_foundation_template.yaml` only from a change set I've
read, after confirming the trail and log-group names are free and that I don't
already have another multi-region management trail I'd rather keep. As soon as
it's created, turn on termination protection for the foundation stack.

All five resources in the delivery chain use `RetainExceptOnCreate` and
retained replacements. A normal rollback during initial creation cleans up, and
after a successful create the whole evidence path survives. S3 Object Lock can
still hold on to objects written during an odd failed create. That's why this
stack is small and foundation-only, and why the trail depends on the bucket
policy. Never force-delete the bucket or policy to get a stack operation
unstuck.

Check trail logging, digest validation, CloudWatch delivery, versioning, Object
Lock governance retention, the public access block and the TLS deny. Confirm the
bucket policy and role trust limit CloudTrail to this trail's ARN and this
account. Confirm termination protection is on.

Leave `ConfigDeliveryBucketName` empty when first creating the foundation. The
Config delivery bucket doesn't exist until the managed-services stack has been
created. An empty value keeps management-event logging and doesn't turn on any
S3 object data-event selector. Don't guess or precompute the generated bucket
name.

### 2. Notifications and alarms

Pass the foundation's log-group output to
`security_notifications_template.yaml`. The `ian-photography-security-<stage>`
topic only carries privacy-safe operational signals, so it doesn't get its own
customer-managed KMS key. The topic policy only lets native CloudWatch publish
from this account and from the name patterns of alarms that are meant to email.
A test fails if any alarm that targets the topic is missing from that
allowlist.

EventBridge never publishes straight to the responder topic. Only the website
backup-failure and edge 5xx alarm rules can send fixed signals to the ingress
queue, which uses SQS-managed SSE. A small Lambda checks every field of the
signal before publishing with its own IAM role.

Website EventBridge targets have a retry limit and a 14-day DLQ, also with
SQS-managed SSE. A DLQ-depth alarm fires on the first failed delivery that
shows up. The root-activity alarm emails because I never use the root identity
for routine work. Record-only account alarms cover KMS key, routing, IAM,
CloudTrail, managed security service and data-protection activity without
sending email. Routine stack, CloudFront and WAF updates aren't alarmed, since
every deploy makes them; CloudTrail and drift checks are the record for those.
GuardDuty and Security Hub stay enabled, queryable and checked in their own
services, but their account-wide findings aren't website notifications.

The template creates no subscriber. I attach a monitored destination only after
I've approved it and finished its confirmation flow. Once routing exists, test
one controlled alarm and one EventBridge event. Look only at aggregate DLQ
counts, and don't print finding messages.

### 3. Managed security services

For a new account, or when re-creating on purpose, first deploy
`security_managed_services_template.yaml` with every mode at `skip`. That gives
a singleton layer that does nothing yet. Routine updates keep the current live
parameters. Only switch a service to `create-confirmed-absent` when a fresh,
complete inventory shows it doesn't exist.

Config doesn't use the audit-foundation bucket any more. AWS Config can't
deliver to an S3 bucket with Object Lock default retention, so this stack
creates its own retained Config-history bucket. It's private, SSE-S3
encrypted, versioned, TLS-only, lifecycle-managed, and has no Object Lock
default retention. Its three Config service grants only allow this account and
this Region's Config source ARN. The recorder role is scoped to the same bucket
and object prefix as a backstop. The CloudTrail evidence bucket policy has no
Config grant.

#### Why the delivery channel is a custom resource

Config's startup order is awkward. The native
`AWS::Config::ConfigurationRecorder` provider calls `PutConfigurationRecorder`
and then waits for a delivery channel before it stabilizes. `PutDeliveryChannel`
rejects requests until that recorder record exists. So the native recorder and
channel handlers can both sit in `CREATE_IN_PROGRESS` forever, with the channel
handler never calling `PutDeliveryChannel`.

I keep the native recorder but swap the native delivery channel for a tightly
scoped `Custom::ConfigDeliveryChannel`. The custom resource starts alongside the
native recorder and polls only the aggregate recorder description until the
expected recorder shows up. It rejects any other recorder or channel, then calls
`PutDeliveryChannel` for the bucket this stack created. That unblocks the native
provider, which starts and stabilizes the recorder as normal. Config rules
depend on both finished resources. Don't add a recorder dependency to the custom
channel or a channel dependency to the recorder. Either one brings the deadlock
back.

The orchestration Lambda can only:

- describe Config state
- put or delete the one regional delivery channel
- stop the expected recorder during a rollback of the initial create
- get, put or delete one fixed regional SSM ownership parameter

IAM applies the active-Region condition, and the SSM statement is also limited
to this account, stage and parameter ARN. Before changing anything, the handler
checks for itself the expected account, Region, names, bucket, frequency,
recorder role ARN, resource-type set, old update state, stack ARN and
CloudFormation physical ownership. It logs only the request type, aggregate
outcome and exception class. It never logs a CloudFormation event, response
URL, bucket name, marker token or service response.

Create and update are safe to retry. Before `PutDeliveryChannel`, the handler
creates `/ian-photography/config-delivery/ian-photography-STAGE/owner` with
overwrite disabled. Its value is a one-way SHA-256 token derived from the stack
ID, not the stack ID itself. A retry from the same stack finds that marker and
the matching channel. The handler refuses to continue if it finds a different
token, a matching channel with no marker, no marker during an update, or a
channel that has drifted. The custom resource has no way to adopt an existing
channel.

If a create fails, the callback returns the deterministic owned physical ID as
soon as the account, Region and properties check out, even if the failure came
after AWS accepted `PutDeliveryChannel`. During the initial rollback it deletes
a channel only if the physical ID, the StackId-derived marker, the channel
definition, the recorder role ARN and the recorder resource-type set all still
match. It never stops or deletes anything with a missing or mismatched marker, a
channel that was there before, or a drifted recorder or channel. If the channel
never existed, rollback removes only its own matching marker. The recorder wait
is capped at 420 seconds inside a 600-second Lambda and a 660-second
custom-resource timeout. That leaves at least 90 seconds for verification and a
three-attempt CloudFormation callback.

After a successful create, `RetainExceptOnCreate` keeps the recorder, the
channel and its ownership marker, the delivery bucket, the bucket policy and the
recorder role when the stack is deleted normally. That matches the retention
rules for the rest of the account security stacks.

#### What Config records and checks

The recorder only covers CloudTrail trails, DynamoDB tables, KMS keys and S3
buckets. Lambda deployments aren't recorded. The periodic root-access-key and
key-rotation rules still run without broad configuration-item recording.
`ConfigLambdaPermissionsDaily` invokes a restricted Lambda once every 24 hours
that reads live function, alias and version policies. It reports one
account-level compliance result with counts only. Public grants or an incomplete
inventory are NON_COMPLIANT. It logs no function environment, policy body or
identifier. Detection can take up to a day. Deploy and verify the daily rule
before retiring the change-triggered Lambda rule.

#### Before and after an enabled deploy

Before an enabled deploy, the inventory has to show no recorder and no delivery
channel. The fixed SSM ownership parameter must also be absent. Check its name
only, and never print its value:

```bash
aws ssm get-parameter \
  --region us-west-2 \
  --name /ian-photography/config-delivery/ian-photography-prod/owner \
  --query 'Parameter.Name' \
  --output text
```

`ParameterNotFound` is what I expect before the create. If the parameter comes
back, find out who owns it. Don't delete it just to get a deploy through.

If an earlier failed native rollout is still `CREATE_IN_PROGRESS`, don't create
a channel by hand or update the in-progress stack. Let that stack reach
rollback. Confirm it no longer owns a recorder or channel and that the marker is
gone. Delete only the failed stack, through CloudFormation, if needed. Rerun
preflight, then use a new create change set. If either singleton or the marker
survives or belongs to someone else, keep `ConfigDeploymentMode=skip` and plan a
separate import or adoption. The template won't take it over.

Once the stack completes, verify without printing any configuration content:

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

There should be one recorder, the expected one, with `recording=true`, one
expected channel pointing at the `ConfigDeliveryBucketName` stack output, and no failed
delivery status. The SSM command should return only the expected parameter
name. Never query its value. Confirm the delivery bucket still has versioning,
encryption and public access blocks, and no Object Lock configuration. Don't
print delivered configuration objects in deploy or CI logs.

#### Adding Config bucket events to the trail

Only once those checks pass, update the audit-foundation stack through its own
change set. Pass the managed-services stack's `ConfigDeliveryBucketName` output
into the audit foundation parameter of the same name. The resulting basic event
selector keeps all read/write management, multi-region and global-service
coverage, and adds one `AWS::S3::Object` data resource for that bucket's ARN
with a trailing slash. It doesn't audit any other application, media, release or
audit bucket.

Check the selector shape without querying or printing events:

```bash
aws cloudtrail get-event-selectors \
  --region us-west-2 \
  --trail-name ian-photography-security-prod \
  --query 'EventSelectors[].{management:IncludeManagementEvents,readWrite:ReadWriteType,dataResources:DataResources}'
```

Management events must stay on with `ReadWriteType=All`, and there should be
exactly one data resource of type `AWS::S3::Object` whose only value is
`arn:aws:s3:::EXACT_CONFIG_DELIVERY_BUCKET/`. If I later remove the managed
Config stack or move it outside this repo, I'll update this parameter only after
checking ownership. An empty value drops the Config object selector but leaves
management-event coverage alone.

#### GuardDuty, Security Hub and the Config rules

Every GuardDuty feature state is spelled out. CloudFormation configures six
protection plans: S3 data events and Lambda network logs on; EKS audit logs,
EBS malware protection, RDS login events and runtime monitoring off. The home
check also requires the service-managed CloudTrail, DNS and flow-log sources to
be on, and AI analyst, AI protection and legacy EKS runtime monitoring to be
off. Turn on other protection plans only with a written threat model, an
inventory of supported resources, and a cost sign-off.

Confirm Security Hub and organization ownership before creating the hub. The
home check requires the hub to have no standards, and the managed-services
template also sets `EnableDefaultStandards: false`. Turning on a broad standard
needs its own cost and coverage decision, and that change has to update the
home check and its tests.

The Config rules check that CloudTrail is enabled, S3 public read and write are
blocked, S3 default encryption and TLS-only requests are enforced, DynamoDB PITR
is on, no Lambda function is publicly accessible, customer-managed KMS keys
rotate, and the root user has no access key. They use the scoped recorder,
except the daily Lambda policy audit, which calls the Lambda APIs directly and
doesn't need Lambda configuration items. I left out the us-east-1-only
CloudFront HTTPS managed rule, and the blanket versioning and
deletion-protection rules, which would flag short-lived and log resources that
are set up that way on purpose.

### 4. Inspector Lambda scanning

CI already scans dependencies, source, workflows and credentials before every
deploy, so I turned off the recurring paid Inspector Lambda and Lambda code
scanners. Inventory first, without `--apply`:

```bash
python3 ops/disable_inspector_lambda_scanning.py --region us-west-2
```

It only reports status and never touches EC2 or ECR scanning. Apply only when
both Lambda modes are `ENABLED`:

```bash
python3 ops/disable_inspector_lambda_scanning.py \
  --region us-west-2 \
  --apply \
  --expected-account-id EXPECTED_12_DIGIT_ACCOUNT \
  --expected-region us-west-2 \
  --expected-lambda-state ENABLED \
  --expected-lambda-code-state ENABLED \
  --confirm disable-inspector-lambda-scanning
```

The helper refuses partial or unexpected enrollment instead of changing a
configuration it doesn't recognize. After an approved apply, it waits up to five
minutes by default for both modes to go through `DISABLING` and land on
`DISABLED`. Any other state, or running out of time, fails the operation. If I
need a different wait, `--wait-timeout-seconds` takes 30 to 900 seconds and
`--poll-interval-seconds` takes 1 to 30 seconds. Review findings without
exporting code or secrets. If cost or compatibility turns out to be a problem,
write up the rollback decision separately.

### 5. Scheduled backup and the restore test

Pass the names of both the Albums and PreviewMetadata DynamoDB tables. The
template builds their ARNs from the active partition, Region and account, so
index, stream, cross-account and cross-Region ARNs can't be passed in. Use
`BackupDeploymentMode=create-confirmed-no-conflict` only after inventory.

The retained metadata vault uses the AWS-managed Backup key, which avoids a
monthly customer-managed key charge. The scheduled role has the backup-only
managed policy and can't restore. Its trust policy pins `aws:SourceAccount` and
the home-Region Backup source ARN. The old source and replica vaults, keys and
recovery points stay until their existing lifecycle dates. New backups don't
extend them.

Keep `VaultLockMode=unlocked` until a scheduled recovery point exists. Then
test a restore:

1. Create a separate temporary restore role with only the permissions the
   restore needs.
2. Restore both tables under new names.
3. Compare schemas and aggregate record counts.
4. Exercise application reads against them.
5. Record how long recovery took.
6. Remove the test tables through the approved cleanup.

Only after that can an update set `governance-confirmed-after-restore-test`.
Governance mode can still be undone by identities with enough privilege.
Compliance mode needs its own legal and retention decision, because it can
become permanent.

The primary backup stack also owns a privacy-safe EventBridge failure signal for
the website's backup jobs. Restore operations stay visible in AWS Backup and
CloudTrail but don't trigger website email for the whole account. Each routed
target gets a fixed signal/stage/runbook payload, not the AWS event, resource
ARN, job ID, object key, provider error or table/media identifier.

The existing security topic, the signal queue scoped to these rules, and the
delivery DLQ are required whenever the backup plan is created. Their ARNs
aren't inputs. The backup template derives the same same-account, `us-west-2`,
stage-owned names that the notification stack uses. Update the notification
stack first, so both queue policies trust the two backup rules before they're
turned on.

A verifier runs every six hours. It reads recovery-point metadata only and
publishes aggregate expected, healthy and failed counts. It requires a fresh
completed recovery point for both metadata tables in the source vault. The
alarm treats missing metrics as breaching, so a stopped verifier or a stopped
backup schedule can't quietly stay green. Neither the logs nor the metrics
include resource or recovery-point ARNs.

The old `us-east-2` replica vault isn't a copy destination any more. I keep it
only so its existing recovery points can age out normally. Restores from it
still go through the same restore gate in AWS Backup.

### 6. Cost budget and who gets notified

Use `security_budget_preflight.py` with `security_budget_template.yaml`:

```bash
python3 ops/security_budget_preflight.py \
  --expected-account-id EXPECTED_12_DIGIT_ACCOUNT \
  --monthly-limit-usd OWNER_APPROVED_AMOUNT \
  --confirm-budget-name ian-photography-monthly-prod
```

The budget in Git has no default amount, email address, resource action or
automatic disabling of security controls. The read-only preflight only
recommends `BudgetDeploymentMode=create-confirmed-absent` when the budget name
doesn't exist yet and I've confirmed both the name and the amount.

Set the optional `BudgetAlertEmail` parameter (NoEcho, empty by default) at
deploy time to have AWS Budgets email me directly when actual or forecast
monthly spend goes over 100% of the limit. Leaving it empty creates no
notification. The address is never committed or printed by the preflight, and
the budget never publishes to the website responder topic. It's free: the
account's first two budgets and their email notifications cost nothing. AWS
treats budget notifications as create-only, so changing or removing the address
later means replacing the budget (or editing the alert in the Budgets console
and living with the drift).

The alarm registry in Git is set to `active-one-confirmed-owner-destination`. I
have one confirmed destination, and that's all this personal site needs. Record
a sanitized end-to-end delivery test every quarter and after any routing change.

## Cost, upkeep and evidence

Before turning on a paid service, write down its owner, Region scope, estimated
monthly cost, retention and alert destination. CloudTrail S3 object data events
are billed and can push up CloudTrail, S3 and CloudWatch ingestion, so I limit
them to the small Config delivery bucket. Data-event records can include Config
object keys and request metadata, but not the delivered object body. Treat them
as security evidence: don't print event payloads or object keys in CI, deploy
output, tickets or chat.

Costs to keep an eye on: CloudTrail and CloudWatch ingestion and retention,
Config items and rules, GuardDuty plans, Security Hub checks, CI security
coverage, KMS/SNS/SQS requests, AWS Backup storage and restore tests, and S3
archive and retrieval.

Every quarter, rerun preflight and drift detection. Check trail delivery and
digest validation, Config status, detector/hub/analyzer ownership, CI scan
results, KMS rotation, DLQ depth, alarms, backup jobs and a sample restore.
Never put event payloads, finding bodies, tokens, table items, contact content,
object keys, code findings or backup contents in CI or runbook output.

AWS docs I relied on:

- [CloudTrail S3 bucket policy](https://docs.aws.amazon.com/awscloudtrail/latest/userguide/create-s3-bucket-policy-for-cloudtrail.html)
- [AWS Config delivery channel](https://docs.aws.amazon.com/config/latest/developerguide/manage-delivery-channel.html)
- [GuardDuty Regions](https://docs.aws.amazon.com/guardduty/latest/ug/guardduty_regions.html)
- [EventBridge resource policies](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-use-resource-based.html)
- [CloudFormation RetainExceptOnCreate](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-attribute-deletionpolicy.html)
- [AWS Backup Vault Lock](https://docs.aws.amazon.com/backup/latest/devguide/vault-lock.html)
- [CloudFormation AWS Budgets resource](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-budgets-budget.html)
