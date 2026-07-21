# CI/CD operations guide

The workflows under `.github/workflows/` implement a credential-free GitHub
Actions release path. They are deliberately fail-closed: merging must remain
blocked until the three independent coverage domains meet 80%, and production
deployment cannot begin until the AWS/GitHub bootstrap described below exists.

## Workflow contract

- Pull requests run frontend, backend, operations, SAM, dependency, workflow,
  credential-pattern, and CodeQL checks with no AWS identity.
- Infrastructure policy is enforced by `sam validate --lint`, independently
  pinned `cfn-lint`, and the repository's source/template invariant tests. These
  tests are the current code-native equivalent of a separate CloudFormation
  Guard pack and cover the specific privacy and durability controls in this
  stack.
- The exact frontend and SAM build directories are measured before packaging.
  Source-controlled limits cover total compressed/uncompressed frontend bytes,
  entry JavaScript/CSS, the largest chunk, and every Lambda's unpacked bytes
  and file count. SAM artifacts are also checked against the explicit
  `backend/Makefile` source allowlists so one function cannot silently acquire
  another function's local modules. Google Drive and the Sharp preview worker
  have explicit larger ceilings; they do not inherit an unlimited exception.
- Both artifact checks write aggregate-only JSON evidence and upload it even
  when a budget fails. Reports contain logical IDs, counts, byte totals, limits,
  and violation codes—not runner paths, source content, object keys, album IDs,
  credentials, or environment values.
- Generated SAM artifacts are scanned separately for forbidden credential-file
  names, complete private-key blocks (including legacy encrypted PEM metadata),
  and AWS access-key IDs. The published AWS documentation example ID and
  dependency source that merely names private-key formats are not credential
  material. The only credential-like JSON filename exception is the exact
  `GoogleDriveBackupFunction/googleapiclient/discovery_cache/documents/`
  `iamcredentials.v1.json` path, and its service identity fields must match the
  public IAM Credentials v1 schema. Directory enumeration and file reads fail
  closed. Every PR and `main` release also scans all reachable, size-bounded Git
  blobs without printing paths or values. It covers private keys, AWS IDs,
  high-confidence GitHub/Google/Slack/Stripe tokens, and credentialed URLs,
  including lockfiles; the weekly run repeats the same full-history proof.
- A push to `main` repeats that exact reusable quality gate, builds the SAM and
  frontend artifacts once, checksums them, attests them, and deploys those same
  bytes. Deployment never rebuilds source.
- SAM code and the packaged CloudFormation template are uploaded beneath the
  exact release SHA plus unique run/attempt with the bootstrap KMS key. Every
  packaged `CodeUri` is rewritten to its exact S3 `Version`, the template is
  uploaded with `If-None-Match`, and its versioned URL plus SHA-256 is bound to
  the guarded change set.
- Backend planning detects CloudFormation drift, retains every current stack
  parameter through `UsePreviousValue`, creates a non-executing change set, and
  rejects removals, replacements, recreation, protected-resource changes, and
  migration/security invariant changes. Execution independently requires the
  change set to retain `UsePreviousValue` for every live parameter (including
  `NoEcho` parameters) while only `ReleaseSha` receives an exact new value, and
  rechecks security/migration invariants after the update. The versioned
  `ops/ci/release_intent.json` also requires every observed logical ID,
  resource type, action, and CloudFormation property path to match an exact
  reviewed rule. Wildcards, duplicate rules, unknown properties, and
  unexplained detail-free changes fail closed.
- Backend execution uses a separate role and must reach `UPDATE_COMPLETE` before
  frontend deployment. Empty backend changes are an explicit safe no-op.
- Frontend deployment never deletes S3 objects. Fingerprinted assets receive
  immutable caching, other static files receive short caching, `index.html` is
  uploaded last with no-cache metadata, and a full `/*` CloudFront invalidation
  is awaited. This covers SPA HTML plus every non-fingerprinted public path,
  including `/.well-known/security.txt`.
- A manual workflow can only redeploy independently attested artifacts from a
  successful `main` production workflow path whose exact SHA remains in `main`
  history. Guard, deploy, and smoke scripts stay at the current trusted control
  SHA; the selected historical SHA is never executed as CI code.
- The weekly workflow runs the complete quality suite, scans every reachable
  Git blob without printing values or paths, runs the credential-free public
  posture smoke, and detects drift for the versioned application, CI bootstrap,
  security, WAF, backup, and observability stack inventory in `us-west-2`,
  `us-east-1`, and `us-east-2`, plus exact secret-redacted frontend edge and
  bucket posture. It also inventories GuardDuty, Security Hub, the home
  standards/aggregator, and protected two-resource satellite stacks in every
  enabled Region. It never remediates drift.

## Required GitHub settings

Create protected environments named `production-plan`, `production`, and
`production-audit`. Limit all three to protected `main`; require maintainer
approval for `production`, including manual redeploys. Configure these
non-secret variables at repository or environment scope as appropriate:

| Variable | Scope/purpose |
|---|---|
| `AWS_REGION` | Application region, currently `us-west-2`. |
| `AWS_ACCOUNT_ID` | Exact allowed account for credential-action confused-deputy protection; the action masks it. |
| `AWS_STACK_NAME` | Exact SAM/CloudFormation application stack. |
| `AWS_RELEASE_ARTIFACT_BUCKET` | Encrypted, versioned release package bucket. |
| `AWS_RELEASE_ARTIFACT_KEY_ARN` | Exact bootstrap KMS key ARN required for every SAM package upload. |
| `AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN` | Exact CloudFormation service execution role passed by the plan role. |
| `AWS_PLAN_ROLE_ARN` | OIDC role that may read/plan the exact stack and write only its release prefix. |
| `AWS_EXECUTE_ROLE_ARN` | OIDC role that may execute and monitor an already-created change set. |
| `AWS_FRONTEND_ROLE_ARN` | OIDC role for non-deleting frontend writes and exact-distribution invalidation. |
| `AWS_AUDIT_ROLE_ARN` | Read-only OIDC role for scheduled drift/posture checks. |
| `FRONTEND_BUCKET` | Exact private/OAC frontend bucket. |
| `FRONTEND_DISTRIBUTION_ID` | Exact frontend distribution. |
| `SITE_URL` | Canonical HTTPS site URL. |
| `API_ORIGIN_URL` | Regional custom API origin including `/api`; used only for the expected anonymous 403 bypass test. |
| `EXECUTE_API_URL` | Default execute-api stage URL; used only to prove the endpoint remains disabled. |
| `VITE_API_BASE_URL` | Public production API base; use same-origin `/api` after front-door cutover. |
| `VITE_CLOUDFRONT_DOMAIN` | Public media CDN hostname. |
| `MEDIA_BUCKET_NAME` | Exact media bucket name; smoke reuses one public CDN object's path to prove the corresponding direct regional S3 request remains denied. |
| `EXPECTED_PUBLIC_ALBUM_COUNT` | Reviewed positive production catalog count; update after an intentional public-album addition or removal. |
| `VITE_COGNITO_USER_POOL_ID` | Public Cognito pool identifier. |
| `VITE_COGNITO_CLIENT_ID` | Public Cognito app-client identifier. |
| `VITE_TURNSTILE_SITE_KEY` | Public Turnstile site key, never the Turnstile secret. |
| `VITE_RUM_APPLICATION_ID` | Optional public CloudWatch RUM app-monitor ID; configure only with the complete RUM set. |
| `VITE_RUM_IDENTITY_POOL_ID` | Optional public RUM-only unauthenticated Cognito identity-pool ID. |
| `VITE_RUM_GUEST_ROLE_ARN` | Optional public ARN of the guest role restricted to the exact app monitor. |
| `VITE_RUM_REGION` | Optional public RUM region, currently `us-west-2`. |

None of these variables is a credential. Do not add AWS access keys, Cognito
tokens, Turnstile secrets, provider secrets, CloudFormation parameter values,
or application data to GitHub.

`SITE_URL`, `API_ORIGIN_URL`, `EXECUTE_API_URL`, `MEDIA_BUCKET_NAME`,
`EXPECTED_PUBLIC_ALBUM_COUNT`, and all
public Vite build variables must be repository-scoped because reusable quality
and credential-free smoke jobs do not attach a GitHub environment. Role ARNs
and release-storage identifiers should remain scoped to their matching
environment.

The four RUM variables are an all-or-none optional set until the separately
reviewed observability stack is deployed. Test and pre-deployment builds do not
require them. The reusable quality workflow always injects the exact tested
`github.sha` as `VITE_RELEASE_SHA`; do not create a mutable GitHub variable for
the release SHA. See [`OBSERVABILITY.md`](OBSERVABILITY.md) for privacy, cost,
activation, and rollback controls.

The public posture helper paginates the complete anonymous catalog with a hard
bound, requires its reviewed aggregate count, validates DTO allowlists and CDN-only media URLs, samples album details
and one ranged CDN object, proves direct S3 remains denied, requires the custom
origin and execute-api bypasses to stay closed (including API Gateway's exact
JSON 404 response for its disabled default endpoint), checks hostile-origin CORS and
the protected-user 401 boundary, and checks sensitive SPA routes under DNT/GPC
headers for security headers, cookies, and eager RUM references. It emits only
aggregate counts. The protected response must never show cache-hit evidence;
when it carries a cache directive, that directive must be `private, no-store`.
Source unit tests remain the authoritative proof that browser
GPC/DNT and sensitive-route gates prevent RUM SDK initialization before a
network import.

## OIDC trust and permissions

The retained bootstrap source is `ops/ci_bootstrap_template.yaml`. It creates or
references the GitHub OIDC provider with audience `sts.amazonaws.com`. Each role's
trust policy must match both the exact repository and its exact environment
subject, for example:

```text
repo:iant4093/photographywebsite:environment:production
```

Use separate subjects for `production-plan` and `production-audit`. Never use a
repository, organization, branch, or tag wildcard. The production execution
role must not create arbitrary change sets; the plan role must not execute one.
The frontend role must not have `s3:DeleteObject`, bucket-policy, public-access,
distribution-update, application-data, or secret-value permissions. The audit
role has no `secretsmanager:GetSecretValue`, `s3:GetObject`, `s3:GetObjectAcl`,
`dynamodb:GetItem`, `kms:Decrypt`, log-event, Cognito-user, or detailed drift
property permission. AWS requires CloudFormation drift detection to have each
selected resource provider's read-handler permissions. Metadata-only provider
calls are allowed only when `aws:CalledVia=cloudformation.amazonaws.com`, so
the GitHub session cannot call them directly, and the scheduled script emits
only aggregate detection status.

The notification stack's unencrypted-filter `AWS::Lambda::EventSourceMapping`
adds only `lambda:GetEventSourceMapping` and `lambda:ListTags` to that called-via
allowlist; its source declares neither `KmsKeyArn` nor `FilterCriteria`, so the
generic provider's `kms:Decrypt` is still denied. The backup freshness
`AWS::Lambda::Permission` adds only called-via `lambda:GetPolicy`. Tests bind
these exceptions to the exact source properties and continue to forbid direct
Lambda invocation, queue message reads, and KMS decryption.

The CloudFormation RUM provider declares DynamoDB item and S3 object reads even
when JavaScript source-map deobfuscation is disabled. `RumAppMonitor` is
therefore excluded from the observability stack's exact logical-resource drift
filter. The audit instead uses resource-scoped `rum:GetAppMonitor`—never
`rum:GetAppMonitorData`—to verify its privacy, telemetry, source-map, and
sensitive-route exclusion configuration. Tests require the filter to equal all
observability template resources except that one documented exception, so a new
resource cannot silently escape review.

The GuardDuty CloudFormation provider reports the six service-managed detector
features as additions even though CloudFormation can configure only the other
six features. `GuardDutyDetector` is therefore the one reviewed exclusion from
the managed-security stack's provider drift request. The scheduled audit does
not ignore the detector: `regional_security_posture.py` inventories every
enabled Region and requires exactly one enabled detector, the exact combined
12-feature map, 15-minute publishing, and exact application/stage tags. It also
requires one exact Security Hub per Region, two `READY` standards only in the
home Region, zero satellite standards, one `ALL_REGIONS` aggregator, and every
satellite stack to be stable, termination-protected, parameter-exact, and to
own exactly its detector and hub. Output contains aggregate counts only. The
audit role's read permissions are bounded to the currently reviewed enabled
Region list; enabling another Region makes the audit fail closed until both
the regional rollout and IAM allowlist are reviewed.

The CloudFormation resources are the exact entries in
`ops/ci/audit_stacks.json`; cross-region entries are the CloudFront WAF stack in
`us-east-1` and retained backup replica in `us-east-2`, and drift-status polling
is region-conditioned to those three reviewed regions. A change to the inventory and its exact audit-role ARN
list must be reviewed and deployed together before the scheduled job is enabled.
If a reviewed stack adds a CloudFormation resource type, compare that type's
current registry read-handler permissions with
`CloudFormationForwardAccessReads`, validate the rendered identity policy with
IAM Access Analyzer, and add only the missing metadata called-via actions. If a
provider requires a data-plane permission, filter that logical resource and add
a resource-scoped configuration-only posture check instead of broadening the
audit role.

The initial permission derivation was checked against the live stack resource
types and their current CloudFormation registry `read` handlers. The application
stack already has its dedicated CloudFormation execution role, so application-
only API Gateway, Cognito, DynamoDB, Secrets Manager, and edge-provider reads do
not belong to the GitHub audit role. In the retained stacks without a service
role, the generic Lambda handler's `kms:Decrypt` is unnecessary because the
configuration-delivery function has no `KmsKeyArn`; the EventBridge handler's
`iam:PassRole` is unnecessary because both exact targets have no `RoleArn`.
Likewise, the current S3 bucket handler does not declare `s3:GetBucketAcl`, and
none of the exact buckets defines `AccessControl`, so that action is not granted.
The remaining called-via list exactly matches the metadata handler union after
those property-specific removals and the documented RUM filter.
The non-CloudFormation frontend edge contract is
`ops/ci/frontend_edge_contract.json`. Its hashes cover the complete distribution
configuration and exact bucket public-access, encryption, ownership, versioning,
and policy-status documents; only the origin-verification header value is
replaced with a fixed presence marker before hashing.
After this source update, deploy the reviewed, non-executing bootstrap stack
UPDATE change set before enabling or manually running the scheduled workflow;
the existing audit role does not gain the new exact stack ARNs until that update
is executed.

The CloudFormation execution role is scoped to resources owned by the
application stack and explicitly denies deletion of protected tables, buckets,
Cognito resources, distributions, KMS keys, and secrets. Its permissions are
split across four attached `AWS::IAM::ManagedPolicy` resources. Every compact
policy document must remain below IAM's 6,144-character managed-policy
limit; do not move these statements back into role inline policies, whose
10,240-character aggregate quota caused the original bootstrap create to roll
back. The current SAM
template does not attach an IAM permissions boundary to generated roles, so the
bootstrap instead restricts role management and `iam:PassRole` to the exact
`ian-website-*` family. Adding a boundary later must be coordinated with
`backend/template.yaml`; requiring one only in the execution policy would break
the current deployment. Bootstrap OIDC, roles, and release storage through the
separately protected stack with termination protection. The application stack
must never create the role that can deploy it.

## Bootstrap preflight and deployment

The IAM OIDC provider is an account singleton. Inventory it before creating a
change set, and explicitly choose one mode. Both commands below are read-only:

```bash
python3 ops/ci_bootstrap_preflight.py \
  --provider-mode create \
  --expected-account-id AWS_ACCOUNT_ID

python3 ops/ci_bootstrap_preflight.py \
  --provider-mode use-existing \
  --existing-provider-arn arn:aws:iam::AWS_ACCOUNT_ID:oidc-provider/token.actions.githubusercontent.com \
  --expected-account-id AWS_ACCOUNT_ID
```

`create` refuses to continue if the provider exists. `use-existing` requires
the exact same-account ARN and verifies the GitHub URL and
`sts.amazonaws.com` audience. The preflight calls only STS and IAM read APIs;
it does not retrieve, print, or store credentials.

Validate the source locally and, when authenticated, with CloudFormation's
read-only parser:

```bash
cfn-lint ops/ci_bootstrap_template.yaml
aws cloudformation validate-template \
  --region us-west-2 \
  --template-body file://ops/ci_bootstrap_template.yaml
```

Deployment is a separately approved one-time operation. Use a dedicated stack,
review its change set, pass `CAPABILITY_NAMED_IAM`, select the preflight-approved
provider mode, and enable termination protection immediately after creation.
Never run these commands from an unreviewed pull request:

```bash
aws cloudformation deploy \
  --region us-west-2 \
  --stack-name ian-photography-ci-bootstrap \
  --template-file ops/ci_bootstrap_template.yaml \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
    GitHubOidcProviderMode=use-existing \
    ExistingGitHubOidcProviderArn=arn:aws:iam::AWS_ACCOUNT_ID:oidc-provider/token.actions.githubusercontent.com

aws cloudformation update-termination-protection \
  --region us-west-2 \
  --stack-name ian-photography-ci-bootstrap \
  --enable-termination-protection
```

For a genuinely absent provider, use `GitHubOidcProviderMode=create` and omit
the existing ARN. The provider, KMS key and alias, versioned artifact bucket and
policy, four GitHub roles, CloudFormation execution role, and its four managed
policies all use `DeletionPolicy: RetainExceptOnCreate` with
`UpdateReplacePolicy: Retain`. This keeps established resources and replaced
resources recoverable while allowing CloudFormation to clean up resources it
created during a failed initial stack create. Always confirm a failed bootstrap
reaches `ROLLBACK_COMPLETE` without newly orphaned named roles, providers,
buckets, aliases, or policies before retrying. The bucket has full public-access
block, bucket-owner-enforced ownership, a rotating customer-managed KMS key,
incomplete multipart cleanup, and noncurrent-version expiration. Retention is a
recovery control, so deleting the bootstrap stack is not a cleanup procedure.

Copy the stack outputs into the matching GitHub variables:

| Bootstrap output | GitHub variable |
|---|---|
| `ReleaseArtifactBucketName` | `AWS_RELEASE_ARTIFACT_BUCKET` |
| `ReleaseArtifactKeyArn` | `AWS_RELEASE_ARTIFACT_KEY_ARN` |
| `CloudFormationExecutionRoleArn` | `AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN` |
| `PlanRoleArn` | `AWS_PLAN_ROLE_ARN` |
| `ExecuteRoleArn` | `AWS_EXECUTE_ROLE_ARN` |
| `FrontendRoleArn` | `AWS_FRONTEND_ROLE_ARN` |
| `AuditRoleArn` | `AWS_AUDIT_ROLE_ARN` |

Set `AWS_ACCOUNT_ID`, `AWS_REGION=us-west-2`, `AWS_STACK_NAME=ian-website`,
`FRONTEND_BUCKET=iantruong-photography`, and
`FRONTEND_DISTRIBUTION_ID=EIOCCNR8XGQ1B` separately. CloudFormation cannot
create or protect GitHub environments: create `production-plan`, `production`,
and `production-audit` in `iant4093/photographywebsite`, restrict all three to
`main`, and require approval for `production` before enabling release jobs.
Environment-based OIDC subjects do not contain a branch ref, so this GitHub
environment protection is the enforcement point for the default branch.
The workflows also fail when `GITHUB_REF` is not `refs/heads/main`, but that is
only defense in depth because untrusted workflow source could remove its own
check. Do not push while a required environment is absent or permits arbitrary
deployment branches.

The execution identity policy deliberately has no `AdministratorAccess` and no
wildcard actions. The release KMS key policy uses the standard account-root
`kms:*` statement solely to enable this account's IAM policies; it grants no
external principal access. The execution role's allow statements use
`Resource: '*'` only for Lambda event-source-mapping creation/listing, Secrets
Manager random-password generation, ACM certificate requests, tagged Cognito,
CloudFront creation and account inventory, KMS creation, and global log/alarm
inventory reads. Those APIs do not expose a usable resource ARN before
creation (or do not support resource authorization). The ACM certificate grant
requires the exact API-origin domain, DNS validation, and deployment region;
its initial tag call permits only the application, stage, and CloudFormation
tag-key families before later certificate access becomes application-tag
scoped. CloudFront cache-policy,
response-header-policy, and origin-access-control update and rollback deletion
remain bounded to those exact account ARN families; distribution deletion
remains explicitly denied. Creation is narrowed with exact region/account
families, request tags where the resource provider supplies them, the exact
certificate domain and DNS validation method,
or the exact `ian-website-*` function condition where the service supports it.
The exact regional `Serverless-2016-10-31` transform ARN is the only
CloudFormation macro resource the application execution role may invoke while
creating the already-guarded application change set.

CloudFormation drift detection also uses the stack execution role. Its
read-only inspection grants include account-level field-index metadata because
`logs:DescribeIndexPolicies` does not support resource-level IAM scoping, and
secret metadata only for the exact regional/account
`RateLimitHashSecret-*` family. SNS topic-tag reads are limited to the existing
regional/account `ian-photography-*` family so the resource provider can
compare declared alarm-topic tags instead of reporting a false removal. The
inventory statement never grants
`logs:GetLogEvents`, and the secret statement never grants
`secretsmanager:GetSecretValue`.

HTTP API access-log reconciliation uses CloudWatch Logs delivery metadata and
resource-policy APIs. AWS does not support resource-level IAM scoping for
these actions, so the execution role grants only their documented lifecycle
set on `Resource: '*'`, restricted to `us-west-2`. This statement cannot read,
filter, write, or delete log events; log-group creation and retention remain
separately limited to the exact application families.

Front-door updates are otherwise bounded to
`origin-api.iantruongphotography.com`, hosted zone `Z0915663I4P8Y0MEDWH`, its
API Gateway domain/mapping/tag paths, application-tagged regional ACM
certificates, and A/CNAME changes at that hostname or its validation-record
subtree. The Route53 change-status ARN necessarily contains a change-ID
wildcard, but is not a `Resource: '*'` grant. The generated front-door secret
uses only its `ian-photography/front-door/*` ARN family, and its read-only IAM
managed policy uses only the application stack's policy-name family. Retained
resources remain protected by explicit destructive denies. Before enabling the
workflow, run IAM Access Analyzer policy validation and a sandboxed change-set
test against the current `backend/template.yaml`; extend only the specific
missing action/resource reported by CloudTrail, never a managed administrator
policy.

## Repository rules

Protect `main` from direct/force pushes and deletion. Require pull requests,
conversation resolution, the `quality-gate` check, dependency review, and
CodeQL. Apply the rules to administrators and require CODEOWNER review for
workflow, infrastructure, lockfile, operations, and security-boundary changes.
Enable GitHub secret scanning and push protection.

Do not enable automatic production deployment until all of these are true:

1. Frontend, backend, ops, and the separately packaged Node preview worker line
   and branch gates independently pass at 80%.
2. A bounded production drift audit reports `IN_SYNC` and all direct changes
   have been reconciled into reviewed infrastructure ownership.
3. IAM Access Analyzer validates all four OIDC role policies and the execution
   role policy/boundary.
4. A plan-only test proves the roles can perform only their intended actions.
5. Frontend and backend rollback artifacts are retained and a synthetic recovery
   drill has passed.

## Local parity

Run these before opening a pull request:

```bash
npm ci
npm run verify
npm run test:coverage
npm run test:coverage --prefix backend/preview_worker
python3 -m venv .venv-ci
.venv-ci/bin/pip install -r backend/requirements-dev.txt
(cd backend && PYTHONPATH=functions ../.venv-ci/bin/coverage run --rcfile=.coveragerc -m unittest discover -s tests -p 'test_*.py')
(cd backend && ../.venv-ci/bin/coverage json --rcfile=.coveragerc --fail-under=0)
.venv-ci/bin/python ops/ci/coverage_gate.py backend/coverage/backend/coverage.json
PYTHONPATH=. .venv-ci/bin/coverage run --rcfile=ops/.coveragerc -m unittest discover -s ops/tests -p 'test_*.py'
.venv-ci/bin/coverage json --rcfile=ops/.coveragerc --fail-under=0
.venv-ci/bin/python ops/ci/coverage_gate.py coverage/ops/coverage.json
./ops/validate_infrastructure.sh --build
python3 ops/ci/artifact_budget.py --output evidence/frontend-artifact-budget.json frontend --root dist
python3 ops/ci/artifact_budget.py --output evidence/backend-artifact-budget.json sam --build-root backend/.aws-sam/build
python3 ops/ci/workflow_policy.py .github/workflows/*.yml
python3 ops/ci/git_history_credential_scan.py .
```

Coverage output is transient and ignored. Never commit reports containing test
fixtures or runner paths.

## Release-intent maintenance

`ops/ci/release_intent.json` is part of the production authorization boundary,
not generated evidence. Its initial rules allow only `Code` and `Environment`
modifications for the exact current Lambda logical IDs. If a reviewed release
intentionally changes another unprotected resource or property, add the exact
logical ID, CloudFormation resource type, action, and property paths in the same
pull request. A new resource may set `allowNoDetails` only when its exact
`Action=Add` change set legitimately contains no property detail; never use that
flag to permit an unexplained modification. Protected resource types, removals,
replacements, and recreations remain blocked even if an intent rule names them.
In particular, do not add `RateLimitTable` PITR to the persistent release
intent: its one-time `PointInTimeRecoverySpecification` update must use the
separately reviewed protected change-set workflow before CI is enabled, after
which ordinary CI plans must observe no DynamoDB table change.
Because CloudFormation exposes Lambda environment changes only at top-level
`Environment`, `ops/ci/template_environment_policy.json` additionally pins the
exact source and SAM-built Environment-block digests. Intentional variable
changes must update that policy in the same reviewed pull request.

## Artifact budget maintenance

`ops/ci/artifact_budgets.json` is the reviewed performance contract. Raise a
limit only with the same pull request that explains the intended dependency or
bundle growth. Do not calculate limits from whichever artifact happens to be in
`.aws-sam`; CI always performs a clean SAM build first. The evidence files are
diagnostic artifacts, not deployable inputs.

The frontend check measures every deployed file with deterministic per-file
gzip, all JavaScript and CSS referenced by `index.html`, and the largest
JavaScript/CSS chunk. The SAM check applies a default limit to every Python
Lambda and explicit, still-bounded overrides to `GoogleDriveBackupFunction`
and `PreviewWorkerFunction`. It requires every allowlisted local source file to
be present and rejects any other module from `backend/functions` at artifact
root. A newly added Lambda must have a `SOURCES_<LogicalId>` entry before the
quality gate can pass.

## Nonproduction public-catalog load validation

`ops/public_catalog_load_test.py` is intentionally manual and dry-run by
default. It is not referenced by any workflow and therefore cannot target
production automatically. A dry run performs no AWS or HTTP call:

```bash
python3 ops/public_catalog_load_test.py \
  --output evidence/public-catalog-load-dry-run.json
```

Network execution is sequential and bounded. It validates page completeness,
cursor progress, duplicate-free albums, list/detail count consistency, exact
public DTO allowlists, safe public media URLs, a narrow EXIF allowlist, and
public edge-cache headers. The JSON evidence contains counts only; it never
records the base URL, AWS account, album IDs, cursors, response bodies, or media
URLs.

Use only a separate nonproduction AWS account and endpoint. All guards are
required: the active STS account must match the expected and repeated account,
must differ from the explicitly named production account, the environment and
confirmation phrase must match exactly, and production-labelled stages plus
`iantruongphotography.com` are refused. For example:

```bash
python3 ops/public_catalog_load_test.py \
  --apply \
  --base-url https://NONPRODUCTION_API_ID.execute-api.us-west-2.amazonaws.com/dev \
  --environment nonproduction \
  --confirm NONPRODUCTION_LOAD_TEST \
  --expected-account-id NONPRODUCTION_ACCOUNT_ID \
  --confirm-account-id NONPRODUCTION_ACCOUNT_ID \
  --production-account-id PRODUCTION_ACCOUNT_ID \
  --max-pages 20 \
  --detail-sample 5 \
  --output evidence/public-catalog-load.json
```

The helper makes a read-only `sts:GetCallerIdentity` call before the first HTTP
request. It will not run against a same-account staging stage because that
would weaken the account guard; create or use a dedicated nonproduction
account for this test.
