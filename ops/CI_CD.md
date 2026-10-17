# CI/CD operations guide

The workflows under `.github/workflows/` implement a credential-free GitHub
Actions release path. They are deliberately fail-closed: a production release
remains blocked until the four independent coverage domains meet 80%, and
deployment cannot begin until the AWS/GitHub bootstrap described below exists.

## Workflows

| Workflow | Trigger | Jobs |
|---|---|---|
| `pull-request.yml` | Pull request to `main` | Reusable quality gate plus `dependency-review` (fails on any severity from `low`). |
| `release-production.yml` | Push to `main` | `quality` → `attest` → `backend-plan` → `backend-deploy` (skipped for an empty change set) → `backend-smoke` → `frontend-deploy` (deploy, then smoke with the release SHA) → `release-storage-cleanup` → `release-record`. |
| `manual-release.yml` | `workflow_dispatch` | Verified redeploy or forward rollback of `frontend`, `backend`, or `both` from an earlier successful production run. |
| `scheduled-security.yml` | Mondays 09:23 UTC and `workflow_dispatch` | Quality gate, `release-idle`, `history-and-public-posture`, `production-drift`. |

The reusable `_quality.yml` gate has five independent domains, joined by a
final `quality-gate` job that fails unless every domain succeeded:

- `frontend-unit-build`: ESLint, the RAW-decoder exercise, Vitest coverage, the
  preview worker's coverage, the production build, the built theme/bootstrap
  check, Playwright release and visitor-gallery journeys, and the frontend
  artifact budget.
- `backend-unit`: all backend tests with branch coverage.
- `infrastructure`: ops tests with branch coverage, `validate_infrastructure.sh
  --build`, the Lambda environment policy, the SAM credential-artifact scan, and
  the SAM artifact budget.
- `dependency-workflow-security`: `npm audit` and `pip-audit`, CycloneDX SBOMs,
  `workflow_policy.py`, checksum-pinned `actionlint`, `zizmor`, independent
  `cfn-lint` of every CloudFormation template, and the full-history credential
  scan.
- `codeql`: JavaScript/TypeScript and Python analysis.

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
  another function's local modules. A few heavier functions, such as Google
  Drive and the Sharp preview worker, have explicit larger ceilings; none
  inherits an unlimited exception.
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
  packaged `CodeUri` is rewritten to its exact S3 `Version` (the object count
  must equal `codeUriCount` in `ops/ci/release_artifact_contract.json`), the template is
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
  `OriginalComparisonsEnabled=true` and `AlbumWorkRouting=legacy` only when
  introducing those parameters for the first time. Planning and execution both
  validate it. Once present, each current value is preserved like every other
  parameter. Other additions or changes to existing values remain rejected.
- Backend execution uses a separate role and must reach `UPDATE_COMPLETE`, and
  the credential-free public smoke must pass, before frontend deployment. Empty
  backend changes are an explicit safe no-op.
- Frontend deployment never deletes S3 objects. The uploader compares object
  content and cache metadata and uploads only changed files, with `index.html`
  last. Fingerprinted assets retain immutable caching; other static files use
  five-minute caching and HTML entrypoints use no-cache metadata. CloudFront
  holds the default behavior (the SPA shell and other unhashed root files) for
  one day regardless of that metadata, and the `/album/*` and `/video/*` social
  documents, which embed the shell's hashed asset names, for up to an hour, so
  any changed or unpublished file invalidates the single path `/*`. That one
  billable path also purges the public API and private-media edge caches.
  The publication manifest advances after the invalidation waiter succeeds, so
  an interrupted publication repeats its outstanding invalidations. Actual
  object checks also repair a rollback after a partial failed upload. Unchanged
  redeployments create no invalidation. These steps run under the existing
  production release/rollback lock and need no new IAM grants. An object changed
  in the frontend bucket outside this script needs its own invalidation.
- A manual workflow can only redeploy independently attested artifacts from a
  successful `main` production workflow path whose exact SHA remains in `main`
  history. Guard, deploy, and smoke scripts stay at the current trusted control
  SHA; the selected historical SHA is never executed as CI code.
- The weekly workflow runs the complete quality suite, waits for any production
  release to finish (`wait_for_release_idle.py`), scans every reachable Git blob
  without printing values or paths, runs the credential-free public posture
  smoke against the latest successful release SHA, and runs
  `audit_stack_drift.sh`. That script detects drift for the versioned
  application, CI bootstrap, security, WAF, backup, and observability stack
  inventory in `us-west-2`, `us-east-1`, and `us-east-2`, plus exact
  secret-redacted frontend edge and bucket posture (`audit_frontend_edge.sh`).
  It also verifies the exact GuardDuty detector and the standards-free Security
  Hub contract in the home Region (`home_security_posture.py`); any enabled
  standard fails the audit because targeted Config rules are the approved
  cost-bounded checks. It does not claim managed detector or hub coverage in
  other Regions, and it never remediates drift.

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
Environment gates does not combine their permissions. The fifth GitHub role,
`ian-website-release-storage-cleanup`, has a fixed name and is addressed from
`AWS_ACCOUNT_ID`, so it needs no variable.

The reusable quality workflow always injects the exact tested `github.sha` as
`VITE_RELEASE_SHA`; do not create a mutable GitHub variable for the release SHA.

`ops/ci/public_smoke.sh` wraps `ops/ci/public_posture_smoke.py`. The helper
paginates the complete anonymous catalog with a hard bound, requires it to be
nonempty and complete, validates DTO allowlists and CDN-only media URLs, samples
album details and one ranged CDN object, proves direct S3 remains denied, and,
when a ready original-comparison preview is present, proves its signed URL works
and its unsigned URL is denied. It requires the custom origin and execute-api
bypasses to stay closed (including API Gateway's exact JSON 404 response for its
disabled default endpoint), checks hostile-origin CORS, the public stats
response, and the protected-user 401 boundary, and checks sensitive SPA routes
under DNT/GPC headers for security headers and cookies. When
`EXPECTED_RELEASE_SHA` is set it also requires the deployed release marker. It
emits only aggregate counts. The protected response must never show cache-hit evidence;
when it carries a cache directive, that directive must be `private, no-store`.
CI permits one five-second retry only for an allowlisted transport, HTTP
429/5xx, content-type/status, or CDN availability failure and logs the safe
failure reason. CORS, bypass, caching, header, cookie, catalog-integrity,
release-marker, and direct-storage posture failures are never retried.

## OIDC trust and permissions

The intentional album-continuation loops require CloudFormation's execution
policy to read and set Lambda recursion configuration. The exact
`ManageContinuationWorkerRecursion` statement grants these two actions only
for `${ApplicationStackName}-CacheInvalidationWorkerFunction-*` and
`${ApplicationStackName}-AlbumWorkWorkerFunction-*`; it does not grant them to
the GitHub plan, execute, frontend, audit, or cleanup sessions. Before
releasing a new `RecursiveLoop: Allow` function, update the bootstrap through
a reviewed non-executing change set preserving all live parameters. The only
expected change is `CloudFormationExecutionIdentityAndComputePolicy`, without
replacement. Apply this separately approved prerequisite before merging the
application release. The application release intent permits `RecursiveLoop`
only on `CacheInvalidationWorkerFunction` and `AlbumWorkWorkerFunction`.

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

The observability stack contains only a
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
finding generator, required application/stage tags, and zero enabled standards
(`EXPECTED_SECURITY_HUB_STANDARDS` is empty). If a standard is ever added to
that contract, each must be `READY`, or provider-reconciling `PENDING` with
controls still `READY_FOR_UPDATES` and no status reason. Extra AWS- or
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
The weekly audit first waits, for up to an hour, until no production release is
running, and checks the public site against the commit of the latest successful
release; it reads the distribution only after CloudFront reports it `Deployed`.
Otherwise a deploy in progress looks like drift: CloudFormation refuses to start
drift detection on an updating stack, and the site still serves the previous
commit. When the edge differs from the contract, the failure names the drifted
documents (`distribution`, `publicAccessBlock`, `encryption`, `ownership`,
`versioning`, `policyStatus`), never their values. Every reviewed edge change
must record its new hashes in the contract, or each later weekly run fails.
When the stack inventory grows, execute the reviewed bootstrap UPDATE change set
before the next scheduled or manual audit; the audit role does not gain a new
exact stack ARN until that update is executed.

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
to the application stack's `ian-website-*` rule family and the existing exact
`ian-photography-waf-alarm-prod` notification rule, which carries the
website's CloudFront 5xx alarms. The execution role has
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
policy, five GitHub roles (plan, execute, frontend, audit, and release-storage
cleanup), CloudFormation execution role, and its four managed
policies all use `DeletionPolicy: RetainExceptOnCreate` with
`UpdateReplacePolicy: Retain`. This keeps established resources and replaced
resources recoverable while allowing CloudFormation to clean up resources it
created during a failed initial stack create. Always confirm a failed bootstrap
reaches `ROLLBACK_COMPLETE` without newly orphaned named roles, providers,
buckets, aliases, or policies before retrying. The bucket has full public-access
block, bucket-owner-enforced ownership, a rotating customer-managed KMS key,
and incomplete multipart cleanup; version retirement belongs to
`release_storage_cleanup.py` (see below). Retention is a recovery control, so
deleting the bootstrap stack is not a cleanup procedure.

The template pins its application identifiers (stack name, API domain, HTTP
API, hosted zone, frontend bucket, and distribution) as single-value parameter
defaults, so the deploy command overrides only the provider mode.

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

Security event metric updates have a separate `logs:PutMetricFilter` grant on
the exact production security log group. This permits the notification stack
to remove continuous zero publication while retaining its matching patterns,
event metrics, and alarms. It does not grant log-group deletion, filter deletion,
retention changes, or notification changes. Review and apply the bootstrap
managed-policy change before executing the notification filter change set;
rollback requires the same permission. Confirm the former changes only that
managed policy and the latter changes only the 13 metric transformations.

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
wildcard, but is not a `Resource: '*'` grant. The origin-verification value is
an encrypted SSM parameter that the stack never writes; its read-only IAM
managed policy uses only the application stack's policy-name family. The only
Secrets Manager family the execution role may create or update is
`ian-photography/prod/fotomoto-print-session-*`. Retained
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
3. IAM Access Analyzer validates all five OIDC role policies and the execution
   role's managed policies.
4. A plan-only test proves the roles can perform only their intended actions.
5. Frontend and backend rollback artifacts are retained and a synthetic recovery
   drill has passed.

## Release archive retention

The `release-storage-cleanup` job runs after each successful production
deployment, inside its existing concurrency lock with manual rollbacks. It uses a
separate main-only OIDC role (`ian-website-release-storage-cleanup`) with
permission to read the application and bootstrap stacks and to list and delete
exact versions only in the release bucket's `releases/` prefix. It cannot read
application data, decrypt secrets, upload artifacts, or change any stack. The
job first reruns `ops.tests.test_release_storage_cleanup`.

`ops/ci/release_storage_cleanup.py` retains every artifact referenced by the live
processed stack template, the current release SHA, and the five latest distinct
successful production release SHAs. All other recognized backend release
attempts remain for at least `ReleaseArtifactNoncurrentRetentionDays` (60 days
by default). An attempt with any recent or unknown object is retained. Both
current and noncurrent versions are considered, fixing indefinite accumulation
under unique release paths. Unrecognized paths, website media, audit evidence,
and the frontend serving bucket are outside this cleanup.

Cleanup requires stable protected stacks, enabled bucket versioning, verified
successful GitHub runs, and no pending application change set. It rechecks the
stack before each deletion batch, deletes explicit version IDs, and stops on
partial failures. Each run is limited to 1,000 versions and 5 GiB. Larger work
is left for later releases. If deployments stop, storage stops growing and
cleanup resumes on the next release. Keep releases and rollbacks inside the production lock;
out-of-band manual stack deployments must not overlap cleanup.

The bucket has no blanket noncurrent-version expiration because it could delete
a version still referenced by a retained release. Multipart-upload cleanup
remains enabled. The Python command defaults to dry-run; the workflow supplies
`--apply`. Its logs contain aggregate counts and bytes only.

## Local parity

Run these before pushing to `main`:

```bash
npm ci
npm run verify
npm run test:raw-decoder
npm run test:coverage
npm ci --prefix backend/preview_worker
npm run test:coverage --prefix backend/preview_worker
npm run test:browser
npm run test:browser:visitors
python3 -m venv .venv-ci
.venv-ci/bin/pip install -r backend/requirements-dev.txt
(cd backend && PYTHONPATH=functions ../.venv-ci/bin/coverage run --rcfile=.coveragerc -m unittest discover -s tests -p 'test_*.py')
(cd backend && ../.venv-ci/bin/coverage json --rcfile=.coveragerc --fail-under=0)
.venv-ci/bin/python ops/ci/coverage_gate.py backend/coverage/backend/coverage.json
PYTHONPATH=. .venv-ci/bin/coverage run --rcfile=ops/.coveragerc -m unittest discover -s ops/tests -p 'test_*.py'
.venv-ci/bin/coverage json --rcfile=ops/.coveragerc --fail-under=0
.venv-ci/bin/python ops/ci/coverage_gate.py coverage/ops/coverage.json
./ops/validate_infrastructure.sh --build
python3 ops/ci/release_guard.py template-environment-policy backend/template.yaml ops/ci/template_environment_policy.json --template-kind source
python3 ops/ci/release_guard.py template-environment-policy backend/.aws-sam/build/template.yaml ops/ci/template_environment_policy.json --template-kind built
python3 ops/ci/credential_artifact_scan.py backend/.aws-sam/build
python3 ops/ci/artifact_budget.py --output evidence/frontend-artifact-budget.json frontend --root dist
python3 ops/ci/artifact_budget.py --output evidence/backend-artifact-budget.json sam --build-root backend/.aws-sam/build
python3 ops/ci/workflow_policy.py .github/workflows/*.yml
python3 ops/ci/git_history_credential_scan.py .
```

The browser journeys need `npx playwright install chromium` once and exercise
the built `dist`; a local `.env` API base baked into that build makes
`test:browser` diverge from CI's deterministic configuration. Coverage output is transient and ignored. Never commit reports
containing test fixtures or runner paths.

## Release-intent maintenance

`ops/ci/release_intent.json` is part of the production authorization boundary,
not generated evidence. Each rule names one exact logical ID, resource type,
action, and the property paths it may change (for example Lambda `Code` and
`Environment`, alarm `AlarmActions`, or the reviewed `Add` of a new function,
role, queue, or table). If a reviewed release
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
JavaScript/CSS chunk. The SAM check applies a default limit to every Lambda
and explicit, still-bounded overrides to the heavier functions named in the
config's `sam.overrides` (Google Drive, the Sharp preview worker, hero reel,
original-comparison, and image-upload functions). It requires every allowlisted local source file to
be present and rejects any other module from `backend/functions` at artifact
root. A newly added Lambda must have a `SOURCES_<LogicalId>` entry before the
quality gate can pass.

## Nonproduction public-catalog load validation

`ops/public_catalog_load_test.py` is intentionally manual and dry-run by
default. No workflow invokes its CLI, so it cannot load-test production
automatically; the public posture smoke imports only its bounded read-only
catalog probe. A dry run performs no AWS or HTTP call:

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
