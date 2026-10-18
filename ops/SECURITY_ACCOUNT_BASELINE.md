# AWS account security stacks

These templates set up the account-level security baseline. They are split by
lifecycle and ownership. The CloudTrail trail, its bucket, bucket policy, log
group, delivery role and KMS key live in one small stack and are retained
together, so a failed update or a stack deletion cannot leave a trail without
its delivery chain.

Reading or validating this repo does not create an SNS subscription, send
email, deploy a stack, import a resource or turn on a paid account service.
Each of those is a separate operator action, taken after an inventory and a
reviewed change set.

## What's in each file

| Layer | File | What it owns |
| --- | --- | --- |
| Audit foundation | `security_audit_foundation_template.yaml` | One home-Region stack: the CloudTrail evidence bucket (Object Lock, governance mode, 365-day default retention, SSE-KMS), its bucket policy, the customer-managed KMS key and alias, the `/aws/security/ian-photography-<stage>` log group (365-day retention), the CloudTrail delivery role and the multi-region trail. All are retained. An optional parameter adds S3 object data events for the Config delivery bucket. |
| Notifications | `security_notifications_template.yaml` | The `ian-photography-security-<stage>` SNS topic (no customer-managed KMS key), the signal queue and delivery DLQ (SQS-managed SSE), the signal-processor Lambda, the edge alarm forwarding rule, CloudTrail metric filters, the root-activity alarm and the record-only account alarms. It creates no subscription. |
| Managed services | `security_managed_services_template.yaml` | AWS Config (recorder, delivery bucket, delivery channel, rules), the GuardDuty detector, the Security Hub hub and the account Access Analyzer. Every singleton defaults to `skip`. |
| Home detection check | `ci/home_security_posture.py` | Read-only check of the home-Region GuardDuty detector and Security Hub hub. It prints counts only and exits `2` on any mismatch. |
| Backups | `security_backup_template.yaml`, `security_backup_replica_template.yaml` | A daily backup of the Albums and PreviewMetadata tables into a retained vault that uses the AWS-managed Backup key, a backup-job failure rule and a freshness check. The replica template defines a retained `us-east-2` vault with its own KMS key; no backup plan copies to it. S3 relies on bucket versioning and the external media backup. Creation and Vault Lock are off by default. |
| Cost | `security_budget_template.yaml`, `security_budget_preflight.py` | One optional retained monthly cost budget. Creation is off by default and needs an approved amount. An optional deploy-time email gets AWS Budgets alerts when actual or forecasted spend goes over 100%. |
| Alarm map | `alarm_registry.json`, `ALARM_REGISTRY.md` | Every alarm, budget notification and signal rule, its route and runbook heading, and the date of the last end-to-end delivery test (90-day interval). |
| Inventory | `security_preflight.py` | Read-only AWS inventory. Access errors show up as `skip-inventory-incomplete`, never as absent. |
| Inspector | `disable_inspector_lambda_scanning.py` | Turns off Inspector Lambda and Lambda code scanning. It is a dry run unless every apply flag matches. |

`us-west-2` is the home Region. The foundation trail records multi-region and
global service management events, so a second copy of the foundation is not
needed in another Region. Config, the GuardDuty detector, Security Hub and
Access Analyzer are managed only in the home Region. Their findings are not
routed to the website email topic. This repo makes no GuardDuty or Security Hub
coverage claims for other Regions, and it does not deploy or manage a Security
Hub finding aggregator.

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

Once the foundation exists, pass its log group so the metric filters are
inventoried too:

```bash
python3 ops/security_preflight.py \
  --region us-west-2 \
  --stage prod \
  --audit-log-group-name /aws/security/ian-photography-prod \
  --details
```

The default report hides AWS identifiers. `--details` adds the AWS names and
identifiers needed for an ownership or import review. Exit status `2` means the
inventory is incomplete. While `inventoryErrors` is not empty, leave every
create mode at `skip`.

If a singleton already exists, or a resource already uses one of the fixed
names, stop and find its owner:

- Existing recorder or channel: `ConfigDeploymentMode=skip`.
- Existing detector: `GuardDutyDeploymentMode=skip`, but only after
  `get-detector` shows it is enabled and all 12 reported feature states match
  the expected map. CloudFormation configures six of them: S3 data events and
  Lambda network logs on; EKS audit logs, EBS malware protection, RDS login
  events and runtime monitoring off. The home check also expects the
  CloudTrail, DNS and flow-log sources on, and AI analyst, AI protection and
  EKS runtime monitoring off. Any missing, extra or different feature blocks
  the rollout. Check Organizations and delegated-administrator ownership
  before changing features.
- Existing hub: `SecurityHubDeploymentMode=skip`, but only after the home hub
  shows zero enabled standards, the `SECURITY_CONTROL` finding generator and
  the required tags. Standards stay off; the template comment notes that broad
  standards add many paid Config rule evaluations. The Config rules listed
  below are the control set in use. Check central configuration and delegated
  administration before changing the hub.
- Existing account analyzer: `AccessAnalyzerDeploymentMode=skip`, and keep its
  archive rules.
- Existing trail, log group, topic, KMS alias, queue, rule, alarm, vault or plan
  with a matching name: manage it from the stack that already owns it, run a
  separate supported import, or leave it managed outside this repo. Do not
  deploy over a name whose owner is unknown.

Imports are manual. Check that the resource type supports import, capture its
identifier and current configuration, set it to retain in the template, create
an import change set, and check drift afterwards. Do not delete an account
security service so that this template can create a new one.

Every managed-services stack operation passes `ExpectedAccountId` and
`ExpectedRegion`. A CloudFormation rule compares them to `AWS::AccountId` and
`AWS::Region` before any resource is evaluated, including on an all-`skip`
deploy. Do not reuse one Region's parameter file in another Region.

The live managed-services stack runs with `ConfigDeploymentMode`,
`GuardDutyDeploymentMode` and `AccessAnalyzerDeploymentMode` set to
`create-confirmed-absent` and `SecurityHubDeploymentMode=skip`. The home
Security Hub hub exists outside that stack.

### Checking GuardDuty and Security Hub in the home Region

Run the read-only home check:

```bash
python3 ops/ci/home_security_posture.py --region us-west-2
```

It accepts only a well-formed Region name. It requires one enabled GuardDuty
detector with `FIFTEEN_MINUTES` publishing, the 12-feature map above, and the
`Application=IanTruongPhotography` and `Stage=prod` tags. Extra tags are
allowed. Missing or changed required tags, unknown features, duplicate features
or a different feature state fail the check.

It also requires the default Security Hub hub in that Region, the
`SECURITY_CONTROL` finding generator, the same required tags and zero enabled
standards. A missing hub, an enabled standard, a malformed response, an access
failure or a timeout returns exit status `2` with a generic error. A passing
report contains only detector, hub, standard and provider-transition counts and
`"status":"IN_SYNC"`. It does not print detector IDs, ARNs, account identity,
tags, findings or provider responses.

The check changes nothing and does not cover any Region other than the one
passed. Create or update the managed-services stack only through its own
change set with the correct account and Region parameters. Reject any
replacement or deletion that is not explained, keep termination protection on,
and rerun the home check once the stack is stable.

## Stack operations, in order

### 1. Audit foundation

Create `security_audit_foundation_template.yaml` only from a reviewed change
set, after confirming the trail and log-group names are free and that no other
multi-region management trail should be kept instead. Turn on termination
protection for the stack as soon as it is created.

Every resource in the template uses `DeletionPolicy: RetainExceptOnCreate` and
`UpdateReplacePolicy: Retain`. A rollback during the initial create cleans up;
after a successful create the evidence path survives a stack deletion. The
trail has `DependsOn: SecurityAuditBucketPolicy`. S3 Object Lock can keep
objects written during a failed create. Do not force-delete the bucket or
policy to unblock a stack operation.

After creation, check trail logging, log file validation, CloudWatch delivery,
versioning, Object Lock governance retention, the public access block and the
TLS deny. Confirm the bucket policy, KMS key policy and role trust limit
CloudTrail to this trail's ARN and this account. Confirm termination protection
is on.

Leave `ConfigDeliveryBucketName` empty when first creating the foundation. The
Config delivery bucket does not exist until the managed-services stack has
created it. An empty value keeps management-event logging and adds no S3 object
data-event selector. Do not guess or precompute the generated bucket name.

### 2. Notifications and alarms

Pass the foundation's log-group name to `security_notifications_template.yaml`
as `SecurityAuditLogGroupName`. The `ian-photography-security-<stage>` topic
carries only fixed operational signals and has no customer-managed KMS key.
The topic policy lets CloudWatch publish only from this account and only from
the names of alarms that are meant to email. A test fails if an alarm that
targets the topic is missing from that allowlist.

EventBridge does not publish to the topic directly. Only the
`ian-photography-backup-job-failed-<stage>` and
`ian-photography-waf-alarm-<stage>` rules can send to the signal queue. The
signal-processor Lambda checks every field of each signal against a fixed
contract before publishing with its own IAM role.

The EventBridge targets retry for up to 10 attempts or one hour, then send to a
DLQ with 14-day retention. `SecurityEventDlqAlarm` fires when one message is
visible in that DLQ. `RootActivityAlarm` emails. The record-only account alarms
cover CloudTrail, IAM, KMS, notification routing, managed security service and
data-protection changes. There are no alarms for routine CloudFormation,
CloudFront or WAF updates; CloudTrail and drift checks record those. GuardDuty
and Security Hub findings stay in their own services and are not website
notifications.

The template creates no subscriber. Attach a monitored destination only after
it is approved and has completed confirmation. Once routing exists, test one
controlled alarm and one EventBridge event. Look only at aggregate DLQ counts,
and do not print message bodies.

### 3. Managed security services

For a new account, or a planned re-creation, first deploy
`security_managed_services_template.yaml` with every mode at `skip`. Routine
updates keep the current live parameters. Switch a service to
`create-confirmed-absent` only when a fresh, complete inventory shows it does
not exist.

Config delivers to its own retained bucket created by this stack, not to the
audit-foundation bucket. The bucket is private, SSE-S3 encrypted, versioned and
TLS-only, moves objects to Glacier Instant Retrieval after 90 days, expires them
after 2555 days, and has no Object Lock. Its three Config service statements
allow only this account and this Region's Config source ARN. The recorder uses
the `AWSServiceRoleForConfig` service-linked role. The CloudTrail evidence
bucket policy has no Config grant.

#### Delivery channel custom resource

The recorder is a native `AWS::Config::ConfigurationRecorder`. The delivery
channel is a `Custom::ConfigDeliveryChannel` backed by the
`ian-photography-config-delivery-<stage>` Lambda. The custom channel depends on
the delivery bucket policy and the recorder. The recorder does not depend on
the channel. `ops/tests/test_security_operations.py` checks both. The Config
rules depend on the recorder and the channel.

On create or update, the handler waits for the expected recorder, rejects any
other recorder or channel, and then calls `PutDeliveryChannel` for the bucket
this stack created.

The orchestration Lambda's role can only:

- describe Config recorders, recorder status and delivery channels
- put or delete a delivery channel
- stop a configuration recorder
- get, put or delete the one SSM ownership parameter

The Config and SSM statements have an `aws:RequestedRegion` condition for the
stack's Region, and the SSM statement is limited to the ownership parameter's ARN. Before
changing anything, the handler checks the expected account, Region, names,
bucket, frequency, recorder role ARN, resource-type set, the old properties on
update, the stack ARN and the physical resource ID. It logs only the request
type, outcome and exception class.

Create and update are safe to retry. Before `PutDeliveryChannel`, the handler
creates `/ian-photography/config-delivery/ian-photography-STAGE/owner` with
overwrite disabled. Its value is a SHA-256 token derived from the stack ID. A
retry from the same stack finds that marker and the matching channel. The
handler refuses to continue if it finds a different token, a matching channel
with no marker on create, no marker on update, or a channel that has drifted.
The custom resource cannot adopt an existing channel.

If a create fails, the callback returns the deterministic physical ID once the
account, Region and properties pass validation. During the initial rollback,
the handler deletes the channel only if the physical ID, the marker token, the
channel definition, the recorder role ARN and the recorder resource-type set
all still match. It retains anything with a missing or mismatched marker or a
drifted recorder or channel. If the channel never existed, rollback removes only
its own matching marker. The recorder wait is capped at 420 seconds (and at
least 90 seconds below the remaining Lambda time) inside a 600-second Lambda
timeout and a 660-second custom-resource `ServiceTimeout`. The CloudFormation
callback is tried up to three times.

After a successful create, `RetainExceptOnCreate` keeps the recorder, the
custom channel and its ownership marker, the delivery bucket and the bucket
policy when the stack is deleted. The detector, hub and analyzer use the same
policy.

#### What Config records and checks

The recorder covers only `AWS::CloudTrail::Trail`, `AWS::DynamoDB::Table`,
`AWS::KMS::Key` and `AWS::S3::Bucket`, with global resource types off. Lambda
functions are not recorded. The root-access-key and KMS rotation rules run on a
24-hour schedule. `ConfigLambdaPermissionsDaily` invokes the
`ian-photography-lambda-permissions-<stage>` Lambda once every 24 hours. It
reads live function, alias and version policies and reports one account-level
compliance result with counts only. Public grants or an incomplete inventory
are `NON_COMPLIANT`. Detection can take up to a day.

#### Before and after an enabled deploy

Before an enabled deploy, the inventory has to show no recorder and no delivery
channel. The SSM ownership parameter must also be absent. Check its name only,
and do not print its value:

```bash
aws ssm get-parameter \
  --region us-west-2 \
  --name /ian-photography/config-delivery/ian-photography-prod/owner \
  --query 'Parameter.Name' \
  --output text
```

`ParameterNotFound` is the expected result before the create. If the parameter
exists, find its owner. Do not delete it to get a deploy through.

If an earlier failed rollout is still `CREATE_IN_PROGRESS`, do not create a
channel by hand or update the in-progress stack. Let that stack reach rollback.
Confirm it no longer owns a recorder or channel and that the marker is gone.
Delete only the failed stack, through CloudFormation, if needed. Rerun
preflight, then use a new create change set. If either singleton or the marker
survives or belongs to someone else, keep `ConfigDeploymentMode=skip` and plan a
separate import. The template does not take it over.

Once the stack completes, verify without printing configuration content:

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

Expect one recorder, `ian-photography-prod`, with `recording=true`; one channel
of the same name pointing at the `ConfigDeliveryBucketName` stack output with
`TwentyFour_Hours` frequency; and no failed delivery status. The SSM command
should return only the parameter name. Do not query its value. Confirm the
delivery bucket still has versioning, encryption and the public access block,
and no Object Lock configuration. Do not print delivered configuration objects
in deploy or CI logs.

#### Adding Config bucket events to the trail

Only after those checks pass, update the audit-foundation stack through its own
change set. Pass the managed-services stack's `ConfigDeliveryBucketName` output
into the foundation parameter of the same name. The resulting event selector
keeps read/write management events and adds one `AWS::S3::Object` data
resource for that bucket's ARN with a trailing slash. No other bucket gets
object data events.

Check the selector shape without querying or printing events:

```bash
aws cloudtrail get-event-selectors \
  --region us-west-2 \
  --trail-name ian-photography-security-prod \
  --query 'EventSelectors[].{management:IncludeManagementEvents,readWrite:ReadWriteType,dataResources:DataResources}'
```

Management events must stay on with `ReadWriteType=All`, and there should be
one data resource of type `AWS::S3::Object` whose only value is
`arn:aws:s3:::CONFIG_DELIVERY_BUCKET_NAME/`. If the Config stack is later removed
or moved outside this repo, update this parameter after checking ownership. An
empty value drops the Config object selector and keeps management events.

#### GuardDuty, Security Hub and the Config rules

The template sets every GuardDuty protection plan it manages: S3 data events
and Lambda network logs on; EKS audit logs, EBS malware protection, RDS login
events and runtime monitoring off. The home check also expects the CloudTrail,
DNS and flow-log sources on, and AI analyst, AI protection and EKS runtime
monitoring off. Turn on other protection plans only with a written threat
model, an inventory of supported resources and a cost sign-off.

Confirm Security Hub and organization ownership before creating the hub. The
home check requires the hub to have no enabled standards, and the template
sets `EnableDefaultStandards: false`. Enabling a standard needs its own cost
and coverage decision, and that change has to update the home check and its
tests.

The Config rules are:

| Rule | Source |
| --- | --- |
| `ian-photography-cloudtrail-enabled-<stage>` | `CLOUD_TRAIL_ENABLED` |
| `ian-photography-s3-public-read-prohibited-<stage>` | `S3_BUCKET_PUBLIC_READ_PROHIBITED` |
| `ian-photography-s3-public-write-prohibited-<stage>` | `S3_BUCKET_PUBLIC_WRITE_PROHIBITED` |
| `ian-photography-s3-encryption-enabled-<stage>` | `S3_BUCKET_SERVER_SIDE_ENCRYPTION_ENABLED` |
| `ian-photography-s3-ssl-only-<stage>` | `S3_BUCKET_SSL_REQUESTS_ONLY` |
| `ian-photography-dynamodb-pitr-<stage>` | `DYNAMODB_PITR_ENABLED` |
| `ian-photography-cmk-rotation-enabled-<stage>` | `CMK_BACKING_KEY_ROTATION_ENABLED` (24 hours) |
| `ian-photography-root-access-key-<stage>` | `IAM_ROOT_ACCESS_KEY_CHECK` (24 hours) |
| `ian-photography-lambda-permissions-daily-<stage>` | Custom Lambda, scheduled every 24 hours |

The managed rules use the scoped recorder. The daily Lambda rule calls the
Lambda APIs directly. The template does not include the CloudFront
viewer-HTTPS managed rule or blanket S3 versioning or deletion-protection rules.

### 4. Inspector Lambda scanning

Inspector Lambda and Lambda code scanning are off. CI covers dependencies
(`npm audit` and `pip_audit`), source (CodeQL), workflows and
committed credentials. Inventory first, without `--apply`:

```bash
python3 ops/disable_inspector_lambda_scanning.py --region us-west-2
```

The dry run only reports status and does not change EC2 or ECR scanning. Apply
only when both Lambda modes are `ENABLED`:

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

The helper refuses partial or unexpected enrollment. After an approved apply, it
waits up to 300 seconds by default for both modes to reach `DISABLED`. Any state
other than `ENABLED`, `DISABLING` or `DISABLED`, or a timeout, fails the
operation. `--wait-timeout-seconds` accepts 30 to 900 seconds and
`--poll-interval-seconds` accepts 1 to 30 seconds (default 5). Review findings
without exporting code or secrets. Record any rollback decision separately.

### 5. Scheduled backup and the restore test

Pass the names of the Albums and PreviewMetadata DynamoDB tables. The template
builds their ARNs from the active partition, Region and account, so index,
stream, cross-account and cross-Region ARNs cannot be passed in. A
CloudFormation rule requires `us-west-2`. Use
`BackupDeploymentMode=create-confirmed-no-conflict` only after inventory.

The plan `ian-photography-protected-data-<stage>` runs daily at 08:00 UTC
(`cron(0 8 * * ? *)`) with a 60-minute start window and a 180-minute completion
window, and deletes recovery points after 35 days. The retained
`ian-photography-metadata-<stage>` vault uses the AWS-managed Backup key. The
backup role has only the `AWSBackupServiceRolePolicyForBackup` managed policy
and cannot restore. Its trust policy pins `aws:SourceAccount` and the
home-Region Backup source ARN.

Keep `VaultLockMode=unlocked` until a scheduled recovery point exists. Then
test a restore:

1. Create a separate temporary restore role with only the permissions the
   restore needs.
2. Restore both tables under new names.
3. Compare schemas and aggregate record counts.
4. Exercise application reads against them.
5. Record how long recovery took.
6. Remove the test tables through the approved cleanup.

Only after that can an update set `governance-confirmed-after-restore-test`,
which adds a governance-mode Vault Lock with 35-day minimum and 365-day maximum
retention. The live stack uses that value. Identities with enough privilege
can still remove a governance lock. Compliance mode is not used by this
template and needs its own legal and retention decision.

The backup stack also owns `BackupJobFailureRule`. It matches Backup job
state changes to `ABORTED`, `EXPIRED`, `FAILED` or `PARTIAL` for the metadata
vault only. Restore jobs stay visible in AWS Backup and CloudTrail and do not
send website email. The rule's target gets a fixed
schemaVersion/eventName/severity/stage/runbook payload, not the AWS event,
resource ARN, job ID or provider error.

The notification stack's topic, signal queue and delivery DLQ must exist before
the backup plan is created. Their ARNs are not inputs: the backup template
builds the same account-local `us-west-2` names from the stage. Update the
notification stack first, so both queue policies trust the
`ian-photography-backup-job-failed-<stage>` rule before it is turned on.

A freshness Lambda runs every six hours. It reads recovery-point metadata only
and publishes aggregate expected, healthy and failed counts. It requires a
completed recovery point for both tables in the metadata vault within
`FreshnessMaximumAgeHours` (default 36). The alarm treats missing data as
breaching, so a stopped verifier or backup schedule turns it red. Neither the
logs nor the metrics include resource or recovery-point ARNs.

The `us-east-2` replica vault (`ian-photography-replica-<stage>`) is not a copy
destination. The backup plan has no copy actions. Restores from any vault go
through the same restore test.

### 6. Cost budget and who gets notified

Use `security_budget_preflight.py` with `security_budget_template.yaml`:

```bash
python3 ops/security_budget_preflight.py \
  --expected-account-id EXPECTED_12_DIGIT_ACCOUNT \
  --monthly-limit-usd OWNER_APPROVED_AMOUNT \
  --confirm-budget-name ian-photography-monthly-prod
```

The budget template has no default amount, email address or budget action, and
it does not turn off any control. The read-only preflight recommends
`BudgetDeploymentMode=create-confirmed-absent` only when the budget name does
not exist yet and `--confirm-budget-name` matches it. Both the preflight and the
template are limited to `us-west-2`.

Set the optional `BudgetAlertEmail` parameter (NoEcho, empty by default) at
deploy time to have AWS Budgets email that address when actual or forecasted
monthly spend goes over 100% of the limit. Leaving it empty creates no
notification. The address is not committed or printed by the preflight, and the
budget does not publish to the website topic. Budget notifications are
create-only in CloudFormation, so changing or removing the address later
requires replacing the budget. The live budget is
`ian-photography-monthly-prod` with a 60 USD limit and both notifications set.

The alarm registry's delivery state is `active-one-confirmed-owner-destination`,
and the topic has one confirmed subscription. Record a sanitized end-to-end
delivery test every 90 days and after any routing change.

## Cost, upkeep and evidence

Before turning on a paid service, record its owner, Region scope, estimated
monthly cost, retention and alert destination. CloudTrail S3 object data
events are limited to the Config delivery bucket. Data-event records can
include Config object keys and request metadata, but not object bodies. Treat
them as security evidence: do not print event payloads or object keys in CI,
deploy output, tickets or chat.

Costs to watch: CloudTrail and CloudWatch ingestion and retention, Config items
and rules, GuardDuty plans, Security Hub checks, KMS, SNS and SQS requests, AWS
Backup storage and restore tests, and S3 archive storage and retrieval.

Every quarter, rerun preflight and drift detection. Check trail delivery and
log file validation, Config status, detector, hub and analyzer ownership, CI
scan results, KMS rotation, DLQ depth, alarms, backup jobs and a sample
restore. Do not put event payloads, finding bodies, tokens, table items,
contact content, object keys, code findings or backup contents in CI or runbook
output.

AWS references:

- [CloudTrail S3 bucket policy](https://docs.aws.amazon.com/awscloudtrail/latest/userguide/create-s3-bucket-policy-for-cloudtrail.html)
- [AWS Config delivery channel](https://docs.aws.amazon.com/config/latest/developerguide/manage-delivery-channel.html)
- [GuardDuty Regions](https://docs.aws.amazon.com/guardduty/latest/ug/guardduty_regions.html)
- [EventBridge resource policies](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-use-resource-based.html)
- [CloudFormation RetainExceptOnCreate](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-attribute-deletionpolicy.html)
- [AWS Backup Vault Lock](https://docs.aws.amazon.com/backup/latest/devguide/vault-lock.html)
- [CloudFormation AWS Budgets resource](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-budgets-budget.html)
