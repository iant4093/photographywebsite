# Guarded AWS account security rollout

These templates replace the former all-in-one security baseline. They are
separated by lifecycle and ownership boundary so a failed update or stack
deletion cannot strand a retained CloudTrail while deleting its bucket policy,
log group, or delivery role.

Nothing in this rollout creates an SNS subscription, sends email, deploys a
stack, imports a resource, enables Inspector, or enables another paid account
service by itself. Those are explicit owner decisions after inventory and a
reviewed change set.

## Files and ownership

| Layer | File | Ownership and guard |
| --- | --- | --- |
| Audit foundation | `security_audit_foundation_template.yaml` | One home-region stack. The evidence bucket, bucket policy, log group, role, and multi-region trail are retained together. |
| Notifications | `security_notifications_template.yaml` | Regional encrypted SNS/KMS routing, encrypted SQS DLQ, metrics, and alarms. It creates no subscriber. |
| Managed services | `security_managed_services_template.yaml` | Config, GuardDuty, Security Hub, and account Access Analyzer. Every singleton defaults to `skip`. |
| Backups | `security_backup_template.yaml` | Daily backup of both metadata tables into a retained CMK-encrypted vault. Creation and Vault Lock default off. |
| Inventory | `security_preflight.py` | Read-only AWS inventory. Access errors become `skip-inventory-incomplete`, never “absent.” |
| Inspector | `enable_inspector_lambda_scanning.py` | Dry-run-by-default Inspector Lambda and Lambda code scanning enrollment with exact apply guards. |

Use `us-west-2` as the initial home region. The foundation trail already records
multi-region and global management events, so do not deploy another foundation
copy elsewhere. Config delivery is home-region-only in this design. If regional
GuardDuty coverage is expanded later, inventory each region and use a separate
regional stack with Config, Security Hub, and Access Analyzer left at `skip`;
approve corresponding regional notification routing and cost separately.

## Validate before an AWS decision

Run:

```bash
./ops/validate_infrastructure.sh
```

The focused checks are:

```bash
python3 -m unittest ops.tests.test_security_operations -v
cfn-lint \
  ops/security_audit_foundation_template.yaml \
  ops/security_notifications_template.yaml \
  ops/security_managed_services_template.yaml \
  ops/security_backup_template.yaml
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
- Existing detector: `GuardDutyDeploymentMode=skip`; check Organizations and
  delegated-administrator ownership before changing features.
- Existing hub: `SecurityHubDeploymentMode=skip`; check central configuration,
  regional aggregation, standards, and delegated administration.
- Existing account analyzer: `AccessAnalyzerDeploymentMode=skip`; preserve its
  archive rules.
- Existing named trail, log group, topic, KMS alias, queue, rule, alarm, vault,
  or plan: use its current stack, perform a separately reviewed supported
  import, or keep it externally managed. Never deploy over an unexplained name.

Import is not automatic. First verify that the resource type supports import,
capture its identifier and current configuration, retain it in the template,
create an import change set, and review drift afterward. Never delete an account
security service merely to make this template create a replacement.

## Staged rollout

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

### 2. Notifications and alarms

Pass the foundation log-group output to
`security_notifications_template.yaml`. The topic uses a retained rotating
customer KMS key because EventBridge and CloudWatch publishers need explicit
KMS grants. The EventBridge SNS policy statement intentionally has no condition:
EventBridge-to-SNS policies do not support condition blocks. It is still scoped
to the EventBridge service, `sns:Publish`, and this exact topic. CloudWatch is
limited to the exact account and exact alarm ARNs.

Both EventBridge targets use bounded retries and an encrypted 14-day SQS DLQ.
The queue policy accepts only the exact two rule ARNs. A DLQ-depth alarm alerts
on the first visible failed delivery. Additional audit alarms cover KMS key
disable/deletion/policy/alias changes and security routing changes, along with
root, IAM, and CloudTrail configuration activity.

No subscriber is created. Attach a monitored destination only after the owner
approves it and completes its confirmation flow. Test a controlled alarm and
EventBridge event after routing exists. Inspect only aggregate DLQ counts; do
not print finding messages.

### 3. Managed security services

First deploy `security_managed_services_template.yaml` with every mode at
`skip`; that produces a no-op singleton layer. Only a fresh complete inventory
proving one service absent justifies its exact `create-confirmed-absent` value.

For Config, pass the audit bucket output. Use
`GlobalResourceRecordingMode=record-confirmed-home-region` only in the chosen
home region. The explicit resource list conditionally adds IAM and CloudFront in
that mode; it deliberately omits `IncludeGlobalResourceTypes`, whose behavior is
ambiguous alongside explicit types. The delivery channel and recorder must be
created without an explicit dependency between them: Config requires the
channel before the recorder can start, while CloudFormation can register the
recorder and create the channel concurrently before stabilizing both. The
foundation bucket policy restricts Config by account and regional Config source
ARN.

GuardDuty features are explicit: S3 data events and Lambda network logs are
enabled; EKS audit logs, EBS malware protection, RDS login events, and runtime
monitoring are disabled. Enable other protection plans only with a documented
threat model, supported-resource inventory, and cost approval. Confirm
Security Hub standards and organization ownership before creating the hub.

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
unknown configuration. It has no disable action. After an approved apply,
verify both modes reach `ENABLED`, review findings without exporting code or
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
Backup source ARN. The scheduled role includes only the backup managed policy;
it cannot restore.

Keep `VaultLockMode=unlocked` until a scheduled recovery point exists. Create a
separate temporary least-privilege restore role, restore both tables under new
names, compare schemas and aggregate record counts, exercise application reads,
record recovery time, and remove the test tables through approved cleanup. Only
then may a reviewed update use
`governance-confirmed-after-restore-test`. Governance mode remains reversible
by sufficiently privileged identities. Compliance mode requires a separate
legal and retention decision because it can become irreversible.

## Maintenance, cost, and evidence

Before enabling a paid service, record its owner, region scope, estimated
monthly cost, retention, and alert destination. Review CloudTrail/CloudWatch
ingestion and retention, Config items/rules, GuardDuty plans, Security Hub
checks, Inspector Lambda/code coverage, KMS/SNS/SQS requests, AWS Backup storage
and restore tests, and S3 archive/retrieval.

Quarterly, rerun preflight and drift detection. Check trail delivery and digest
validation, Config status, detector/hub/analyzer ownership, Inspector coverage,
KMS rotation, DLQ depth, alarms, backup jobs, and a sample restore. Never put
event payloads, finding bodies, tokens, table items, contact content, object
keys, code findings, or backup contents in CI or runbook output.

AWS behavior references:

- [CloudTrail S3 bucket policy](https://docs.aws.amazon.com/awscloudtrail/latest/userguide/create-s3-bucket-policy-for-cloudtrail.html)
- [AWS Config delivery channel](https://docs.aws.amazon.com/config/latest/developerguide/manage-delivery-channel.html)
- [EventBridge resource policies](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-use-resource-based.html)
- [SNS encrypted-topic key management](https://docs.aws.amazon.com/sns/latest/dg/sns-key-management.html)
- [CloudFormation RetainExceptOnCreate](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-attribute-deletionpolicy.html)
- [AWS Backup Vault Lock](https://docs.aws.amazon.com/backup/latest/devguide/vault-lock.html)
