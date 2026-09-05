# CI/CD operations guide

The workflows under `.github/workflows/` implement a credential-free GitHub
Actions release path. They are deliberately fail-closed: a production release
remains blocked until the four independent coverage domains meet 80%, and
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
  rejects removals, replacements, recreation, direct protected-resource
  changes, and migration/security invariant changes. Conservative dependency
  cascades on protected resources pass only when every detail is an exact
  reviewed dynamic reference in `ops/ci/release_dependencies.json`. Execution
  independently requires the
  change set to retain `UsePreviousValue` for every live parameter (including
  `NoEcho` parameters) while only `ReleaseSha` receives an exact new value, and
  rechecks security/migration invariants after the update. The versioned
  `ops/ci/release_intent.json` also requires every observed logical ID,
  resource type, action, and CloudFormation property path to match an exact
  reviewed rule. Wildcards, duplicate rules, unknown properties, and
  unexplained detail-free changes fail closed.
- The exact `ops/ci/release_parameter_additions.json` contract permits
  `OriginalComparisonsEnabled=true` only when introducing that parameter for
  the first time. Planning and execution both validate it. Once present, its
  current value is preserved like every other parameter, including `false`.
  Other additions or changes to existing values remain rejected.
- Backend execution uses a separate role and must reach `UPDATE_COMPLETE` before
  frontend deployment. Empty backend changes are an explicit safe no-op.
- Frontend deployment never deletes S3 objects. Fingerprinted assets receive
  immutable caching, other static files receive short caching, `index.html` is
  uploaded last with no-cache metadata, and an exact invalidation for `/`,
  `/index.html`, hero assets, and the favicon is awaited. Fingerprinted
  `/assets/*` objects intentionally survive deploys in edge caches; other
  non-fingerprinted files naturally revalidate on their five-minute metadata.
- A manual workflow can only redeploy independently attested artifacts from a
  successful `main` production workflow path whose exact SHA remains in `main`
  history. Guard, deploy, and smoke scripts stay at the current trusted control
  SHA; the selected historical SHA is never executed as CI code.
- The weekly workflow runs the complete quality suite, scans every reachable
  Git blob without printing values or paths, runs the credential-free public
  posture smoke, and detects drift for the versioned application, CI bootstrap,
  security, WAF, backup, and observability stack inventory in `us-west-2`,
  `us-east-1`, and `us-east-2`, plus exact secret-redacted frontend edge and
  bucket posture. It also verifies the exact GuardDuty detector and the
  standards-free Security Hub contract in the home Region; any enabled standard
  fails the audit because targeted Config rules are the approved cost-bounded
  checks. It does not claim managed
  detector or hub coverage in other Regions, and it never remediates drift.

## Required GitHub settings

The production path has one deployment branch: every push to `main` runs the
complete quality and security gate and, only after it passes, deploys the exact
attested backend and frontend artifacts. GitHub Environments are deliberately
not used. Configure all of these non-secret variables at repository scope:

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
| `VITE_COGNITO_USER_POOL_ID` | Public Cognito pool identifier. |
| `VITE_COGNITO_CLIENT_ID` | Public Cognito app-client identifier. |
| `VITE_TURNSTILE_SITE_KEY` | Public Turnstile site key, never the Turnstile secret. |

None of these variables is a credential. Do not add AWS access keys, Cognito
tokens, Turnstile secrets, provider secrets, CloudFormation parameter values,
or application data to GitHub.

Catalog, album, photo, and video counts are deliberately not repository
variables or deployment gates. The credential-free smoke test instead proves
that the live catalog is nonempty, fully paginated, internally consistent, and
serves usable public media through the exact CDN. Normal content changes
therefore require no GitHub configuration maintenance.

All variables above are repository-scoped so the reusable quality, deployment,
and credential-free smoke jobs share one reviewed configuration. The AWS role
ARNs still identify four independently least-privileged roles; removing GitHub
Environment gates does not combine their permissions.

The reusable quality workflow always injects the exact tested `github.sha` as
`VITE_RELEASE_SHA`; do not create a mutable GitHub variable for the release SHA.

The public posture helper paginates the complete anonymous catalog with a hard
bound, requires its reviewed aggregate count, validates DTO allowlists and CDN-only media URLs, samples album details
and one ranged CDN object, proves direct S3 remains denied, requires the custom
origin and execute-api bypasses to stay closed (including API Gateway's exact
JSON 404 response for its disabled default endpoint), checks hostile-origin CORS and
the protected-user 401 boundary, and checks sensitive SPA routes under DNT/GPC
headers for security headers and cookies. It emits only
aggregate counts. The protected response must never show cache-hit evidence;
when it carries a cache directive, that directive must be `private, no-store`.
CI permits one five-second retry only for an allowlisted transport, HTTP
429/5xx, content-type/status, or CDN availability failure and logs the safe
failure reason. CORS, bypass, caching, header, cookie, catalog-integrity,
release-marker, and direct-storage posture failures are never retried.

## OIDC trust and permissions

The retained bootstrap source is `ops/ci_bootstrap_template.yaml`. It creates or
references the GitHub OIDC provider with audience `sts.amazonaws.com`. Every
role's trust policy must match the exact repository and the exact `main` ref
subject:

```text
repo:iant4093/photographywebsite:ref:refs/heads/main
```

Never use a repository, organization, branch, or tag wildcard. The production
execution role must not create arbitrary change sets; the plan role must not execute one.
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

The observability stack contains only disabled CloudFront subscriptions and a
free-metric dashboard, so the scheduled audit can use ordinary whole-stack drift
detection without a service-specific exclusion or posture
bypass. The edge alarms belong to the us-east-1 WAF stack. Browser telemetry and
synthetic probes are not part of the release.

The GuardDuty CloudFormation provider reports the six service-managed detector
features as additions even though CloudFormation can configure only the other
six features. `GuardDutyDetector` is therefore the one reviewed configuration
exception from the managed-security provider drift request. Three other exact
logical resources—the Config bucket policy, custom delivery channel, and
configuration recorder—are explicitly counted as provider-unsupported because
CloudFormation's resource-level drift API cannot evaluate them. The inventory
requires that four-item set exactly, dynamically proves that every other live
stack resource is checked, and fails if a new exclusion appears. Source tests
continue to bind the unsupported resources to their least-privilege contracts.
The scheduled audit does not ignore the detector: `home_security_posture.py`
requires exactly one enabled detector in the home Region, the exact combined
12-feature map, 15-minute publishing, and the required application/stage tags.
It also requires the home Security Hub default hub, the `SECURITY_CONTROL`
finding generator, required application/stage tags, and exactly the two reviewed
standards. Each must be `READY`, or provider-reconciling `PENDING` with controls
still `READY_FOR_UPDATES` and no status reason. Extra AWS- or
CloudFormation-managed tags are allowed, but missing required tags or any
detector, feature, hub, generator, standard, or updatability difference fails
closed. Output contains aggregate counts only, including the number of provider
transitions. The audit role's
direct GuardDuty and Security Hub permissions are bounded to the home Region;
the audit neither inventories nor claims managed coverage in other Regions.

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
only API Gateway, Cognito, DynamoDB, SSM parameter, and edge-provider reads do
not belong to the GitHub audit role. In the retained stacks without a service
role, the generic Lambda handler's `kms:Decrypt` is unnecessary because the
configuration-delivery function has no `KmsKeyArn`; the EventBridge handler's
`iam:PassRole` is unnecessary because both exact targets have no `RoleArn`.
Likewise, the current S3 bucket handler does not declare `s3:GetBucketAcl`, and
none of the exact buckets defines `AccessControl`, so that action is not granted.
The remaining called-via list exactly matches the metadata handler union after
those property-specific removals.
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
the current deployment. EventBridge rule lifecycle access is likewise limited
to the application stack's `ian-website-*` rule family; the execution role has
no event-bus publishing access. Bootstrap OIDC, roles, and release storage through the
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
Never run these commands from an unreviewed commit:

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

Set the remaining repository variables from the exact current account, Region,
application stack, frontend bucket, and frontend distribution. Do not commit
their physical identifiers to this runbook. No GitHub Environment setup is
required. The OIDC subject itself restricts AWS access to
`refs/heads/main`; scheduled and manual workflows additionally fail when their
control revision is not running from that exact ref. No non-`main` ref can
assume a production role.

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
`logs:DescribeIndexPolicies` does not support resource-level IAM scoping. SNS
topic-tag reads are limited to the existing
regional/account `ian-photography-*` family so the resource provider can
compare declared alarm-topic tags instead of reporting a false removal. The
inventory statement never grants `logs:GetLogEvents`, and the deployment roles
never receive secure-parameter values.

HTTP API access-log reconciliation uses CloudWatch Logs delivery metadata and
resource-policy APIs. AWS does not support resource-level IAM scoping for
these actions, so the execution role grants only their documented lifecycle
set on `Resource: '*'`, restricted to `us-west-2`. This statement cannot read,
filter, write, or delete log events; log-group creation and retention remain
separately limited to the exact application families.

Front-door updates are otherwise bounded to
`origin-api.iantruongphotography.com`, the exact hosted zone supplied by the
reviewed stack configuration, its
API Gateway domain/mapping/tag paths, application-tagged regional ACM
certificates, and A/CNAME changes at that hostname or its validation-record
subtree. The Route53 change-status ARN necessarily contains a change-ID
wildcard, but is not a `Resource: '*'` grant. The generated front-door secret
uses only its `ian-photography/front-door/*` ARN family, and its read-only IAM
managed policy uses only the application stack's policy-name family. Retained
resources remain protected by explicit destructive denies. When changing these
policies, run IAM Access Analyzer validation and a sandboxed change-set
test against the current `backend/template.yaml`; extend only the specific
missing action/resource reported by CloudTrail, never a managed administrator
policy.

## Repository rules

`main` is the sole deployment branch, and an ordinary push to it starts the
complete production quality, security, deployment, and smoke workflow. Permit
ordinary reviewed pushes, but prohibit force pushes and branch deletion. Enable
GitHub secret scanning and push protection. Treat workflow, infrastructure,
lockfile, operations, and security-boundary commits as deployment-authorizing
changes and review them before pushing.

Keep automatic production deployment enabled only while all of these are true:

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

Run these before pushing to `main`:

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
not generated evidence. Its current rules allow only `Code` and `Environment`
modifications for the exact current Lambda logical IDs. If a reviewed release
intentionally changes another unprotected resource or property, add the exact
logical ID, CloudFormation resource type, action, and property paths in the same
reviewed change. A new resource may set `allowNoDetails` only when its exact
`Action=Add` change set legitimately contains no property detail; never use that
flag to permit an unexplained modification. Protected resource types, removals,
replacements, and recreations remain blocked even if an intent rule names them.
In particular, do not add `RateLimitTable` PITR to the persistent release
intent: a `PointInTimeRecoverySpecification` update must use the separately
reviewed protected change-set workflow, after which ordinary CI plans must
observe no DynamoDB table change.
Because CloudFormation exposes Lambda environment changes only at top-level
`Environment`, `ops/ci/template_environment_policy.json` additionally pins the
exact source and SAM-built Environment-block digests. Intentional variable
changes must update that policy in the same reviewed change.

CloudFormation also reports conservative dependency cascades when an unchanged
protected resource refers to a Lambda or bucket that appears in the release.
`ops/ci/release_dependencies.json` names those relationships exactly by logical
ID, resource type, property, and causing attribute. A dependency rule is
accepted only for a `Dynamic` `ResourceAttribute` detail; it cannot authorize a
direct edit, replacement, recreation, removal, or an unlisted relationship.
Keep this file narrow. Add a relationship only after reviewing a real
non-executing change set and proving that the protected resource definition is
unchanged.

## Artifact budget maintenance

`ops/ci/artifact_budgets.json` is the reviewed performance contract. Raise a
limit only with the same reviewed change that explains the intended dependency
or bundle growth. Do not calculate limits from whichever artifact happens to be in
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
