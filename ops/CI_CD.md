# CI/CD operations guide

Releases run on GitHub Actions from the workflows in `.github/workflows/`. The
repository stores no AWS credentials or GitHub secrets; AWS access uses OIDC
roles from the bootstrap stack described below. A production release requires
line and branch coverage of at least 80% in each of four coverage domains:
frontend, backend, operations, and the preview worker.

## Workflows

| Workflow | Trigger | Jobs |
|---|---|---|
| `pull-request.yml` | Pull request to `main` | Reusable quality gate plus `dependency-review` (fails on severity `low` and above). |
| `release-production.yml` | Push to `main` | `quality` → `attest` → `backend-plan` → `backend-deploy` (skipped for an empty change set) → `backend-smoke` → `frontend-deploy` (deploy, then smoke with the release SHA) → `release-storage-cleanup` → `release-record`. |
| `manual-release.yml` | `workflow_dispatch` | `prepare`, then `backend-plan`, `backend-deploy`, `frontend-deploy`, or `backend-only-smoke` to redeploy `frontend`, `backend`, or `both` from an earlier successful production run. |
| `scheduled-security.yml` | Mondays 09:23 UTC and `workflow_dispatch` | `quality`, `release-idle`, then `history-and-public-posture` and `production-drift`. |

`release-production.yml` and `manual-release.yml` share the concurrency group
`iantruongphotography-production` and never cancel a run in progress.

The reusable `_quality.yml` gate runs five jobs. A final `quality-gate` job fails
unless all of them succeeded:

- `frontend-unit-build`: ESLint, the RAW-decoder test, Vitest coverage, the
  preview worker's coverage, the production build, the built theme/bootstrap
  check, the Playwright release and visitor-gallery journeys, and the frontend
  artifact budget.
- `backend-unit`: all backend tests with branch coverage.
- `infrastructure`: ops tests with branch coverage,
  `validate_infrastructure.sh --build`, the Lambda environment policy, the SAM
  credential-artifact scan, and the SAM artifact budget.
- `dependency-workflow-security`: `npm audit` and `pip-audit`, CycloneDX SBOMs,
  `workflow_policy.py`, checksum-pinned `actionlint`, `zizmor`, a separate
  `cfn-lint` pass over `backend/template.yaml` and the `ops/*_template.yaml`
  stacks except `security_budget_template.yaml`, and the full-history credential
  scan.
- `codeql`: JavaScript/TypeScript and Python analysis.

## What the pipeline checks

### Pull requests

Pull requests run the frontend, backend, operations, SAM, dependency, workflow,
credential-pattern, and CodeQL checks with no AWS identity.

Infrastructure policy comes from `sam validate --lint`, a separately pinned
`cfn-lint`, and the repository's tests over source and templates.

`workflow_policy.py` rejects `pull_request_target`, `write-all` permissions,
persisted checkout credentials, GitHub Environments, and actions not pinned to a
full commit SHA.

### Artifact budgets and credential scans

Before packaging, CI measures the frontend and SAM build directories against
`ops/ci/artifact_budgets.json`. The limits cover total uncompressed and gzip
frontend bytes, entry JavaScript and CSS, the largest chunk, and each Lambda's
unpacked bytes and file count. SAM artifacts are also checked against the
`SOURCES_<LogicalId>` allowlists in `backend/Makefile`, so a function cannot
include another function's local modules. Some functions have larger, finite
overrides (see [Artifact budget maintenance](#artifact-budget-maintenance)).

Both checks write JSON evidence and upload it even when a budget fails. The
reports contain logical IDs, counts, byte totals, limits, and violation codes.
They do not contain runner paths, source content, object keys, album IDs,
credentials, or environment values.

`credential_artifact_scan.py` scans the generated SAM artifacts for forbidden
credential-file names, private-key blocks (including legacy encrypted PEM
headers), AWS access-key IDs, GitHub, Google API, Slack, and Stripe live-secret
tokens, URLs with embedded credentials, and symlinks that leave the artifact
tree. It ignores the example key ID from the AWS documentation and one
hash-verified Pillow source file. The only credential-like JSON filename it
allows is
`GoogleDriveBackupFunction/googleapiclient/discovery_cache/documents/iamcredentials.v1.json`,
and only when its content matches the public IAM Credentials v1 discovery
schema. If it cannot read a file, it fails. Findings list the detector and the
path inside the artifact, never the matched value.

`git_history_credential_scan.py` scans every reachable Git blob, including
lockfiles, for the same detectors without printing paths or values. It fails if
a blob is larger than 25 MB or the total exceeds 2 GB. It runs in every quality
gate (pull requests, `main` releases, and the weekly run) and again in the
weekly `history-and-public-posture` job.

### How a `main` release deploys

A push to `main` runs the reusable quality gate, which builds the SAM and
frontend artifacts once. The `attest` job verifies their checksums and creates
build-provenance and SBOM attestations. Later jobs deploy those same bytes and
never rebuild from source.

`backend_plan.sh` packages SAM code under
`releases/<sha>/<run>-<attempt>/backend/` in the release bucket, encrypted with
the bootstrap KMS key. `bind_s3_versions.py` rewrites every packaged `CodeUri` to
a specific S3 object `Version` and requires the object count to equal
`codeUriCount` in `ops/ci/release_artifact_contract.json`. The packaged template
is uploaded with `--if-none-match '*'`, and its versioned URL and SHA-256 are
recorded in the change set description that later steps check.

Backend planning requires the stack to be `IN_SYNC` in a drift check, keeps
every current stack parameter with `UsePreviousValue`, and creates a change set
without executing it. `release_guard.py` rejects removals, replacements and
recreations other than reviewed dependency cascades, changes outside
`ops/ci/release_intent.json`, protected-resource changes not approved by an
intent rule, and stacks that fail its stack checks
(deployable status, termination protection, and the front-door, execute-api,
private-media, and album-index outputs). CloudFormation can report dependency
cascades on protected resources. Those pass only when every detail matches a
`Dynamic` `ResourceAttribute` relationship listed in
`ops/ci/release_dependencies.json`.

Execution checks again before running. The change set must keep every live
parameter's resolved value, including `NoEcho` parameters. Only `ReleaseSha`
and the reviewed parameter additions may get new values. After the update,
`backend_execute.sh` reruns the stack checks, requires
`UPDATE_COMPLETE`, and requires the `ReleaseSha` output to match the release.
Every changed logical ID, resource type, action, and property path must match a
rule in `ops/ci/release_intent.json` or a listed dependency. Wildcard property paths, duplicate rules,
unknown keys, and changes with no property detail (unless the rule is an `Add`
that sets `allowNoDetails`) fail.

`ops/ci/release_parameter_additions.json` allows
`OriginalComparisonsEnabled=true` and `AlbumWorkRouting=legacy`, only when
those parameters do not exist on the stack yet. Planning and execution both
validate it. Once a parameter exists, its current value is kept like any other.

Backend execution uses a separate role. The stack must reach `UPDATE_COMPLETE`,
and the credential-free public smoke must pass, before the frontend deploys. An
empty backend change set is deleted and the deploy job is skipped.

Frontend deployment never deletes S3 objects. `frontend_deploy.sh` verifies the
bucket's public-access block and that the distribution is deployed, enabled, and
OAC-backed. `frontend_changes.py` compares object content and cache metadata,
uploads only changed files, and uploads `print.html` and `index.html` last.
Files under `assets/` get `public,max-age=31536000,immutable`. Other static
files get `public,max-age=300,must-revalidate`, and the HTML entrypoints get
`no-cache,max-age=0,must-revalidate`.

CloudFront does not follow that metadata everywhere. The default behavior (the
SPA shell and other unhashed root files) has a one-day minimum TTL, and the
`/album/*` and `/video/*` social documents, which embed the shell's hashed asset
names, are cached for up to an hour. Any changed file therefore triggers one
invalidation of `/*`. That path also clears the public API and private-media
edge caches on the same distribution.

The published manifest (`_deployment/frontend-manifest.json`) advances only
after the invalidation waiter succeeds, so an interrupted deployment repeats
any outstanding invalidation. Because the upload compares actual objects, a
redeploy also repairs a partial failed upload. Redeploying unchanged files
creates no invalidation. Objects changed in the frontend bucket outside this
script must be invalidated manually.

### Manual redeploys

`manual-release.yml` redeploys only artifacts from a successful `push` run of
`Release production` on `main`, and only if the selected SHA is still in `main`
history. The `prepare` job downloads that run's `attested-release` artifact,
verifies its manifests, and runs `gh attestation verify`. The guard, deploy, and
smoke scripts come from the current control SHA; the selected SHA is never run
as CI code.

### The weekly run

`scheduled-security.yml` runs the quality gate and, in parallel, the
`release-idle` job, which uses `wait_for_release_idle.py` to wait up to an hour
for any production release to finish. After that, it scans every reachable Git
blob, runs the credential-free public smoke test against the latest
successful release SHA, and runs `audit_stack_drift.sh`.

That script checks drift for every stack in `ops/ci/audit_stacks.json`
(application, CI bootstrap, security audit, security notifications, managed
security, backup primary, observability, WAF, and backup replica) across
`us-west-2`, `us-east-1`, and `us-east-2`. It also checks the frontend edge and
bucket settings (`audit_frontend_edge.sh`). In `us-west-2` it verifies the
GuardDuty detector and a Security Hub hub with no enabled standards
(`home_security_posture.py`). It makes no coverage claims for other Regions and
does not fix drift.

## Required GitHub settings

`main` is the only deployment branch. Every push to `main` runs the quality and
security gate and, only when that passes, deploys the attested backend and
frontend artifacts. The repository uses no GitHub Environments, and
`workflow_policy.py` rejects them. Set these non-secret variables at repository
scope:

| Variable | Purpose |
|---|---|
| `AWS_REGION` | Application Region, `us-west-2`. |
| `AWS_ACCOUNT_ID` | The allowed account. `assert_aws_account.sh` compares the assumed identity with it, and the cleanup job builds its role ARN from it. |
| `AWS_STACK_NAME` | Application stack name. |
| `AWS_RELEASE_ARTIFACT_BUCKET` | Encrypted, versioned release package bucket. |
| `AWS_RELEASE_ARTIFACT_KEY_ARN` | Bootstrap KMS key ARN used for every SAM package upload. |
| `AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN` | CloudFormation execution role that the plan role passes. |
| `AWS_PLAN_ROLE_ARN` | OIDC role that plans the application stack and writes only the `releases/` prefix. |
| `AWS_EXECUTE_ROLE_ARN` | OIDC role that executes and monitors an existing change set. |
| `AWS_FRONTEND_ROLE_ARN` | OIDC role for non-deleting frontend uploads and invalidation of the one distribution. |
| `AWS_AUDIT_ROLE_ARN` | Read-only OIDC role for the scheduled drift and configuration checks. |
| `FRONTEND_BUCKET` | Private, OAC-backed frontend bucket. |
| `FRONTEND_DISTRIBUTION_ID` | Frontend distribution. |
| `SITE_URL` | Canonical HTTPS site URL. |
| `API_ORIGIN_URL` | Regional custom API origin including `/api`; used for the expected 403 direct-origin check. |
| `EXECUTE_API_URL` | Default execute-api stage URL; used to check that the endpoint is disabled. |
| `VITE_API_BASE_URL` | Production API base: same-origin `/api` or an HTTPS URL. Currently `/api`. |
| `VITE_CLOUDFRONT_DOMAIN` | Public media CDN hostname. |
| `MEDIA_BUCKET_NAME` | Media bucket name; the smoke requests one public CDN object's path directly from regional S3 and expects 403. |
| `VITE_COGNITO_USER_POOL_ID` | Public Cognito user pool ID. |
| `VITE_COGNITO_CLIENT_ID` | Public Cognito app client ID. |
| `VITE_TURNSTILE_SITE_KEY` | Public Turnstile site key, not the Turnstile secret. |

None of these is a credential. Do not put AWS access keys, Cognito tokens,
Turnstile secrets, provider secrets, CloudFormation parameter values, or
application data in GitHub.

Catalog, album, photo, and video counts are not deployment gates, and no
workflow reads a count variable. The credential-free smoke checks the live
catalog instead: it must be nonempty, fully paginated, consistent, and serve
public media through the CDN.

The four role ARN variables point at four separate roles. The fifth GitHub role,
`ian-website-release-storage-cleanup`, has a fixed name, and its ARN is built
from `AWS_ACCOUNT_ID`.

The reusable quality workflow sets `VITE_RELEASE_SHA` to `github.sha` at build
time. Do not create a GitHub variable for the release SHA.

### The public smoke test

`ops/ci/public_smoke.sh` wraps `ops/ci/public_posture_smoke.py`. It:

- checks security headers (HSTS, `nosniff`, `DENY` framing, referrer policy,
  permissions policy, and CSP) and the absence of cookies on the homepage and
  on sensitive SPA routes requested with `DNT` and `Sec-GPC` headers;
- requires the deployed entry module to contain `EXPECTED_RELEASE_SHA` when it
  is set;
- requires the direct custom-origin request to return a 403 JSON denial with
  `private, no-store`, and the default execute-api endpoint to return API
  Gateway's JSON `Not Found` 404;
- checks that a hostile `Origin` receives no CORS allow-origin header, checks
  the public stats response, and requires a 401 on the protected `/users` route;
- pages through the anonymous catalog (100 per page, at most 100 pages), samples
  album details, and requires the catalog to be nonempty and complete;
- requests one CDN media object with a ranged request and checks that the same
  path is denied directly from S3;
- when a ready original-comparison preview is present, checks that its signed
  URL works and its unsigned URL returns 403.

The protected response must not show cache-hit evidence, and if it carries a
cache directive, that directive must include `private` and `no-store`. The
script prints only aggregate counts.

CI allows one retry after five seconds, only for a transport error, HTTP 429,
500, 502, 503, or 504, an unexpected status or content type, or an unavailable
CDN media object. Other failures, such as CORS, cache, header, cookie,
catalog-integrity, release-marker, or direct-storage failures, are not retried.

## OIDC trust and permissions

The album-continuation workers invoke themselves, so the CloudFormation
execution role must read and set Lambda recursion configuration. The
`ManageContinuationWorkerRecursion` statement grants
`lambda:GetFunctionRecursionConfig` and `lambda:PutFunctionRecursionConfig` only
on `${ApplicationStackName}-CacheInvalidationWorkerFunction-*` and
`${ApplicationStackName}-AlbumWorkWorkerFunction-*`. The plan, execute,
frontend, audit, and cleanup roles do not have these actions.

Before releasing another function with `RecursiveLoop: Allow`, update the
bootstrap first with a non-executing change set that keeps all live parameters.
The only change should be to
`CloudFormationExecutionIdentityAndComputePolicy`, with no replacement. Apply
that change before merging the application release. The release intent allows
`RecursiveLoop` changes only on `CacheInvalidationWorkerFunction` and
`AlbumWorkWorkerFunction`.

The bootstrap template is `ops/ci_bootstrap_template.yaml`, and its resources
are retained. It creates or references the GitHub OIDC provider with audience
`sts.amazonaws.com`. Every GitHub role's trust policy requires that audience and
this subject:

```text
repo:iant4093/photographywebsite:ref:refs/heads/main
```

The roles are:

| Role | Purpose |
|---|---|
| `ian-photography-github-production-plan` | Create, describe, and delete `gha-*` change sets, detect drift, pass only the execution role, and write only `releases/*`. Executing change sets and direct stack updates are denied. |
| `ian-photography-github-production-execute` | Describe and execute `gha-*` change sets on the application stack. Creating change sets and direct stack updates are denied. |
| `ian-photography-github-production-frontend` | Upload to and read the frontend bucket, and get and invalidate the frontend distribution. Object and bucket deletion, bucket ACL, policy, and public-access changes, and distribution updates are denied. |
| `ian-photography-github-production-audit` | Drift detection on the audited stacks, home-Region GuardDuty and Security Hub reads, and frontend distribution and bucket configuration reads. All CloudFormation mutations are denied. |
| `ian-website-release-storage-cleanup` | Read the application and bootstrap stacks, and list and delete object versions under `releases/`. |
| `ian-photography-cloudformation-execution` | Assumed by CloudFormation for application stack changes. |

Never use a wildcard for the repository, organization, branch, or tag. The audit
role has no `secretsmanager:GetSecretValue`, `s3:GetObject`, `s3:GetObjectAcl`,
`dynamodb:GetItem`, `kms:Decrypt`, log-event, Cognito-user, or
`cloudformation:DescribeStackResourceDrifts` permission.

Drift detection calls each resource provider's read handler with the caller's
permissions. The audit role's `CloudFormationForwardAccessReads` statement
grants those metadata-only actions only when
`aws:CalledVia=cloudformation.amazonaws.com`, so the GitHub session cannot call
them directly. The scheduled script reports only aggregate detection status.

The list includes `lambda:GetEventSourceMapping` and `lambda:ListTags` for the
notification stack's `AWS::Lambda::EventSourceMapping`, which sets neither
`KmsKeyArn` nor `FilterCriteria`, and `lambda:GetPolicy` for the backup
freshness `AWS::Lambda::Permission`. It omits `kms:Decrypt` (no Lambda function
in these stacks sets `KmsKeyArn`) and `s3:GetBucketAcl` (no bucket sets
`AccessControl`).

The observability stack contains only a dashboard, so the scheduled audit runs
whole-stack drift detection on it with no exclusions. The edge alarms are in the
`us-east-1` WAF stack.

### GuardDuty and Security Hub

`GuardDutyDetector` declares six detector features, while the live detector
reports twelve. It is excluded from CloudFormation drift and checked directly
instead. Three other resources in `ian-photography-security-managed`
(`ConfigDeliveryBucketPolicy`, `ConfigDeliveryChannel`, and `ConfigRecorder`)
are also excluded because resource-level drift detection does not support them.
`audit_stack_drift.sh` requires that four-item exclusion set and nothing else,
requires every excluded ID to exist in the stack, and runs resource drift
detection on every other resource in that stack.

`home_security_posture.py` requires one enabled detector in `us-west-2`, the
expected twelve-feature map, `FIFTEEN_MINUTES` publishing, and the
`Application` and `Stage` tags. It also requires the default Security Hub hub,
the `SECURITY_CONTROL` finding generator, the same tags, and zero enabled
standards (`EXPECTED_SECURITY_HUB_STANDARDS` is empty). `audit_stack_drift.sh`
additionally requires zero provider transitions.

Extra tags added by AWS or CloudFormation are allowed. Missing required tags, or
any difference in detector, features, hub, generator, or standards, fails the
audit. Output is aggregate counts only. The audit role's GuardDuty and Security
Hub permissions are limited to `us-west-2`, and the audit does not inventory
other Regions.

### Which stacks the audit covers

The audited stacks are the entries in `ops/ci/audit_stacks.json`. The
cross-Region entries are the WAF stack in `us-east-1` and the backup replica in
`us-east-2`. The audit role's drift-status and type-configuration reads are
limited by `aws:RequestedRegion` to those three Regions. Change the inventory
and the audit role's list of stack ARNs together, and deploy the bootstrap
update before the next scheduled or manual audit.

If a stack gains a new CloudFormation resource type, compare that type's
registry read-handler permissions with `CloudFormationForwardAccessReads`,
validate the rendered policy with IAM Access Analyzer, and add only the missing
metadata actions. If a provider needs a data-plane permission, exclude that
logical resource and add a configuration-only check scoped to it instead of
widening the audit role.

### The frontend edge hashes

The frontend distribution is not managed by CloudFormation, so
`ops/ci/frontend_edge_contract.json` stores SHA-256 hashes of the full
distribution configuration and of the bucket's public-access block, encryption,
ownership, versioning, and policy-status documents. Before hashing, every
origin custom header value (including the origin-verification secret) is
replaced with a fixed presence marker.

`audit_frontend_edge.sh` waits for the distribution to reach `Deployed` before
reading it. The `release-idle` wait exists because a deploy in progress looks
like drift: CloudFormation does not start drift detection on a stack that is
updating, and the site may still serve the previous commit.

When the edge does not match, the failure names which documents differ
(`distribution`, `publicAccessBlock`, `encryption`, `ownership`, `versioning`,
`policyStatus`), never their values. Every edge change needs its new hashes
recorded in that file, or the weekly audit fails. When the stack inventory
grows, execute the bootstrap update change set before the next audit; the audit
role does not get the new stack ARN until then.

### The CloudFormation execution role

Most of `ian-photography-cloudformation-execution`'s statements are limited to
the application's resource name families (`ian-website-*`, `goldenhour-*`,
`GoldenHour-*`, and `ian-photography-*`). The KMS key, Cognito user pool, HTTP
API, and CloudFront statements cover those resource types account-wide in their
Region. The role also covers a few named notification-stack resources: the
security signal processor function and role, three notification alarms, the
security log group's metric filters, and the `ian-photography-waf-alarm-prod`
rule. The `ProtectRetainedApplicationData` statement denies deleting
distributions, Cognito user pools, DynamoDB tables, S3 buckets, and Secrets
Manager secrets, and disabling or scheduling deletion of KMS keys.

Its permissions are split across four `AWS::IAM::ManagedPolicy` resources:
`CloudFormationExecutionIdentityAndComputePolicy`,
`CloudFormationExecutionDataAndMessagingPolicy`,
`CloudFormationExecutionEdgeAndIdentityPolicy`, and
`CloudFormationExecutionEncryptionAndObservabilityPolicy`. Each managed policy
document must stay under IAM's 6,144-character limit. Do not move these
statements back into inline role policies, which share a 10,240-character
aggregate limit per role (commit `05ab3e6`).

The SAM template attaches no IAM permissions boundary to its roles. The
bootstrap instead limits role management and `iam:PassRole` to roles named
`ian-website-*` and the notification stack's
`ian-photography-security--SecuritySignalProcessorRo-*` role, and `PassRole`
only to `lambda.amazonaws.com` and `mediaconvert.amazonaws.com`. Adding a
boundary later must be coordinated with `backend/template.yaml`. EventBridge
rule access is limited to `ian-website-*` rules and the
`ian-photography-waf-alarm-prod` rule, which routes the CloudFront 5xx alarms.
The role has no `events:PutEvents` permission.

OIDC, the roles, and release storage are in a separate stack with termination
protection. The application stack does not create the role that deploys it.

## Bootstrap preflight and deployment

An account has one IAM OIDC provider for GitHub. Check for it before creating a
change set and choose a provider mode. Both commands are read-only:

```bash
python3 ops/ci_bootstrap_preflight.py \
  --provider-mode create \
  --expected-account-id AWS_ACCOUNT_ID

python3 ops/ci_bootstrap_preflight.py \
  --provider-mode use-existing \
  --existing-provider-arn arn:aws:iam::AWS_ACCOUNT_ID:oidc-provider/token.actions.githubusercontent.com \
  --expected-account-id AWS_ACCOUNT_ID
```

`create` stops if the provider already exists. `use-existing` requires a
same-account ARN and checks the GitHub URL and the `sts.amazonaws.com` audience.
The preflight calls only STS and IAM read APIs and does not retrieve, print, or
store credentials.

Validate the template locally, and with CloudFormation's read-only parser when
signed in:

```bash
cfn-lint ops/ci_bootstrap_template.yaml
aws cloudformation validate-template \
  --region us-west-2 \
  --template-body file://ops/ci_bootstrap_template.yaml
```

Deploying the bootstrap is a separate, reviewed operation. Use the dedicated
stack, review its change set, pass `CAPABILITY_NAMED_IAM`, use the provider mode
the preflight approved, and enable termination protection after creation. Run
these commands only from a reviewed commit. The template's `Rules` require
`us-west-2`.

```bash
aws cloudformation deploy \
  --region us-west-2 \
  --stack-name ian-photography-ci-bootstrap \
  --template-file ops/ci_bootstrap_template.yaml \
  --capabilities CAPABILITY_NAMED_IAM \
  --no-execute-changeset \
  --parameter-overrides \
    GitHubOidcProviderMode=use-existing \
    ExistingGitHubOidcProviderArn=arn:aws:iam::AWS_ACCOUNT_ID:oidc-provider/token.actions.githubusercontent.com

aws cloudformation update-termination-protection \
  --region us-west-2 \
  --stack-name ian-photography-ci-bootstrap \
  --enable-termination-protection
```

`--no-execute-changeset` creates the change set without running it. Review it,
then execute it with `aws cloudformation execute-change-set`. If the provider
does not exist yet, use `GitHubOidcProviderMode=create` and omit the existing
ARN. The live stack uses `use-existing`.

These resources use `DeletionPolicy: RetainExceptOnCreate` with
`UpdateReplacePolicy: Retain`: the provider, the KMS key and alias, the
versioned artifact bucket and its policy, the five GitHub roles (plan, execute,
frontend, audit, and release-storage cleanup), the CloudFormation execution
role, and its four managed policies. Established and replaced resources stay
recoverable, and CloudFormation can still clean up resources it created during a
failed first create. If a bootstrap create fails, confirm the stack reaches
`ROLLBACK_COMPLETE` without leaving new named roles, providers, buckets, aliases,
or policies before retrying.

The bucket has a full public-access block, `BucketOwnerEnforced` ownership,
default encryption with a customer-managed KMS key that has rotation enabled,
and a seven-day incomplete multipart upload cleanup. Its policy denies
non-TLS requests and uploads that name a different encryption type or KMS key.
`release_storage_cleanup.py` retires old versions (see
[Release archive retention](#release-archive-retention)). Deleting the bootstrap
stack does not remove the retained resources.

The template pins the application identifiers (stack name, API domain, HTTP
API, hosted zone, frontend bucket, frontend distribution, and default branch) as
parameters with a single allowed value, so the deploy command overrides only the
provider mode.

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

Set the remaining repository variables from the current account, Region,
application stack, frontend bucket, and frontend distribution. Do not commit
their physical identifiers to this document. The OIDC subject limits AWS access
to `refs/heads/main`. The manual workflow's `prepare` job, the scheduled
`release-idle`, `history-and-public-posture`, and `production-drift` jobs, and
the release cleanup job also fail unless `GITHUB_REF` is `refs/heads/main`.

### What the execution role is allowed to do

The execution role's managed policies grant no `AdministratorAccess` and no
wildcard actions. The release KMS key policy uses the standard account-root
`kms:*` statement so that IAM policies in this account apply. No outside
principal is granted access.

The execution role uses `Resource: '*'` only for these actions, because the APIs
do not expose a usable resource ARN before creation or do not support
resource-level permissions:

- `lambda:CreateEventSourceMapping` (conditioned on an `ian-website-*` function
  ARN), `lambda:GetEventSourceMapping`, and `lambda:ListEventSourceMappings`
- `secretsmanager:GetRandomPassword`
- `acm:RequestCertificate`
- `cognito-idp:CreateUserPool` with the `Application` request tag
- CloudFront resource creation and list calls
- CloudFront key-group and public-key read, update, and delete
- `kms:CreateKey` with the `Application` request tag
- `cloudwatch:DescribeAlarms`, `logs:DescribeLogGroups`, and
  `logs:DescribeIndexPolicies`
- CloudWatch Logs delivery and resource-policy actions, limited to `us-west-2`

The ACM certificate request requires the API origin domain, DNS validation, and
`us-west-2`. `acm:AddTagsToCertificate` is allowed on any certificate ARN in the
account in `us-west-2`, so the first tag call can succeed. Other certificate
actions require the `Application=IanTruongPhotography` resource tag. CloudFront
update and delete actions are limited to the account's distribution,
cache-policy, function, origin-access-control, and response-headers-policy ARN
families, and distribution deletion is denied. The only CloudFormation transform
the role may invoke is `Serverless-2016-10-31` in `us-west-2`.

CloudFormation drift detection on the application and bootstrap stacks also runs
as this role. Its read-only grants include `logs:DescribeIndexPolicies`, which
cannot be scoped to a resource. SNS topic-tag reads are limited to the
`ian-photography-*` topic family in this account and Region. No statement grants
`logs:GetLogEvents`, and no role in the bootstrap has SSM parameter read access.

The `UpdateExactSecurityEventMetricFilters` statement grants
`logs:PutMetricFilter` and `logs:DeleteMetricFilter` on the
`/aws/security/ian-photography-prod` log group only. It does not allow deleting
the log group or changing its retention. The
`ManageExactSecurityNotificationAlarms` statement allows creating, updating,
deleting, and tagging three named alarms: `ian-photography-root-activity-prod`,
`ian-photography-security-events-dlq-prod`, and
`ian-photography-infrastructure-protection-change-prod`. Apply bootstrap
changes to these statements before executing the notification stack change
that needs them.

HTTP API access logging uses CloudWatch Logs delivery and resource-policy APIs,
which do not support resource-level permissions. The role grants only
`logs:CreateLogDelivery`, `logs:DeleteLogDelivery`, `logs:GetLogDelivery`,
`logs:ListLogDeliveries`, `logs:UpdateLogDelivery`,
`logs:DescribeResourcePolicies`, and `logs:PutResourcePolicy` on
`Resource: '*'`, limited to `us-west-2`. Log-group creation and retention are
limited separately to the `/aws/apigateway/ian-photography-*` and
`/ian-photography/application/*` log groups.

Front-door resources are limited to the `origin-api.iantruongphotography.com`
API Gateway domain, its mappings and tag path, application-tagged ACM
certificates in `us-west-2`, and record changes in the configured hosted zone.
`route53:ChangeResourceRecordSets` is scoped to that hosted zone with no
record-name condition. `route53:GetChange` uses a `change/*` resource because
change IDs are not known in advance. The origin-verification value is an
encrypted SSM parameter that the stack does not write. The only Secrets Manager
secrets the role can create or update are
`ian-photography/prod/fotomoto-print-session-*`.

When changing these policies, validate them with IAM Access Analyzer and test a
non-executing change set against the current `backend/template.yaml`. Add only
the specific action or resource that CloudTrail reports as missing. Do not
attach a managed administrator policy.

## Repository rules

`main` is the only deployment branch, and each push to it starts the production
quality, security, deployment, and smoke workflow. Block force pushes and
deletion of `main`. Keep GitHub secret scanning and push protection enabled.
Commits that change workflows, infrastructure, lockfiles, operations scripts,
or security boundaries deploy on push, so review them before pushing.

Keep automatic production deployment enabled only while all of these hold:

1. Frontend, backend, ops, and the separately packaged Node preview worker each
   pass their 80% line and branch coverage gates.
2. A production drift audit reports `IN_SYNC`, and any direct changes have been
   brought back under infrastructure code.
3. IAM Access Analyzer validates all five OIDC role policies and the execution
   role's managed policies.
4. A plan-only test shows that each role can do only what it is meant to.
5. Frontend and backend rollback artifacts are kept, and a recovery drill has
   passed.

## Release archive retention

The `release-storage-cleanup` job runs after each successful frontend deploy,
inside the same concurrency group as manual redeploys. It first runs
`ops.tests.test_release_storage_cleanup`, then assumes
`ian-website-release-storage-cleanup`. That role can read the application and
bootstrap stacks, and list and delete object versions under `releases/` in the
release bucket. It cannot read application data, decrypt secrets, upload
artifacts, or change any stack.

`ops/ci/release_storage_cleanup.py` keeps every artifact referenced by the
application stack's processed template, the current release SHA, and up to five
of the most recent distinct successful `Release production` SHAs (at least two
are required). Every other recognized release attempt is kept for at least
`ReleaseArtifactNoncurrentRetentionDays` (default 60, minimum 30, currently 60).
If an attempt has any recent object or any key with an unrecognized layout, the
whole attempt is kept. Cleanup considers both current and noncurrent versions,
and inventories only the `releases/` prefix.

Cleanup runs only when the application stack is stable and
termination-protected, the bootstrap stack is `UPDATE_COMPLETE` and
termination-protected, bucket versioning is enabled, the GitHub release runs
check out, and the application stack has no available or executing change set.
It rechecks the application stack before each deletion batch of 100, deletes by
version ID, and stops on any partial failure. Each run deletes at most 1,000
versions and 5 GiB; the rest waits for later runs. Manual stack deployments
outside the production concurrency group must not overlap cleanup.

The bucket has no noncurrent-version expiration rule, because it could delete
a version that a retained release still references. The script defaults to a
dry run, and the workflow passes `--apply`. Its output contains only aggregate
counts and bytes.

## Running the checks locally

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

CI uses Python 3.12. The browser journeys need `npx playwright install chromium`
once, and they run against the built `dist`. If a local `.env` sets an API base,
it is built into `dist` and `test:browser` no longer matches CI's configuration.
Coverage output is ignored by git. Do not commit reports that contain test
fixtures or runner paths.

## Release-intent maintenance

`ops/ci/release_intent.json` is part of what authorizes a production release.
It is not generated. Each rule names one logical ID, resource type, action, and
the property paths it may change (for example Lambda `Code` and `Environment`,
alarm `AlarmActions`, or an `Add` of a new function, role, queue, or table). If
a release changes another resource or property, add its logical ID, resource
type, action, and property paths in the same commit. A rule may set
`allowNoDetails` only for an `Add` whose change set has no property detail.

A protected resource (by logical ID or resource type in `release_guard.py`) can
change only through an `Add` rule or a `Modify` rule that sets
`allowProtectedModify` and lists the property paths. Removals are always
rejected. A `Conditional` replacement or an `Always` recreation is accepted only
for reviewed dependency details; any other replacement or recreation is
rejected.

Do not add a `RateLimitTable` `PointInTimeRecoverySpecification` rule. The
guard rejects that change on the protected table
(`ops/tests/test_ci_release_guard.py`), so it is made outside the release
pipeline, after which ordinary plans should show no DynamoDB table change.

CloudFormation reports Lambda environment changes only at the top-level
`Environment` property, so `ops/ci/template_environment_policy.json` also pins
digests of the source and SAM-built `Environment` blocks. To change a variable,
update that policy in the same commit.

CloudFormation also reports dependency cascades when an unchanged protected
resource refers to a Lambda function or bucket that is part of the release.
`ops/ci/release_dependencies.json` lists those relationships by logical ID,
resource type, property, and causing entity. A dependency rule is accepted only
for a `Dynamic` `ResourceAttribute` detail. It cannot authorize a direct edit,
replacement, removal, or an unlisted relationship. Add a relationship only after
reviewing a real non-executing change set and confirming that the protected
resource's definition has not changed.

## Artifact budget maintenance

`ops/ci/artifact_budgets.json` holds the size limits. Raise a limit only in the
same commit that explains the dependency or bundle growth behind it. Do not
derive limits from a local `.aws-sam` directory; CI always does a clean SAM
build first. The evidence files are for diagnosis and are never deployed.

The frontend check measures every deployed file with deterministic per-file
gzip, all JavaScript and CSS referenced by `index.html`, and the largest
JavaScript or CSS chunk. The SAM check applies a default limit (20,000,000
bytes and 350 files) to every Lambda, with larger finite overrides in
`sam.overrides` for `AddImagesFunction`, `GetGoogleDriveUsageFunction`,
`RefreshGoogleDriveUsageFunction`, `GoogleDriveBackupFunction`,
`PreviewWorkerFunction`, `OriginalIndexRefreshFunction`,
`OriginalComparisonWorkerFunction`, and `HeroReelFunction`. Every allowlisted
local source file must be present, and any other module from
`backend/functions` at the artifact root is rejected. A new Lambda needs a
`SOURCES_<LogicalId>` entry in `backend/Makefile` before the quality gate
passes.

## Load-testing the public catalog outside production

`ops/public_catalog_load_test.py` is manual and runs as a dry run by default. No
workflow runs its CLI. The public smoke test imports only its read-only
catalog probe. A dry run makes no AWS or HTTP calls:

```bash
python3 ops/public_catalog_load_test.py \
  --output evidence/public-catalog-load-dry-run.json
```

With `--apply`, it sends requests one at a time and stops at the `--max-pages`
and `--detail-sample` limits. It checks page completeness, cursor progress, no
duplicate albums, list/detail count consistency, public DTO allowlists, safe
public media URLs, the EXIF allowlist, and public edge-cache headers. The JSON
evidence contains only counts. It does not record the base URL, AWS account,
album IDs, cursors, response bodies, or media URLs.

Run it only against a separate nonproduction AWS account and endpoint. Every
guard is required:

- The active STS account must match both `--expected-account-id` and
  `--confirm-account-id`.
- It must differ from `--production-account-id`.
- `--environment nonproduction` and `--confirm NONPRODUCTION_LOAD_TEST` are
  required.
- Hosts or paths labelled `prod` or `production`, and `iantruongphotography.com`
  and its subdomains, are refused.

For example:

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

The helper calls `sts get-caller-identity` before the first HTTP request.
Because the production account is refused, a staging stage in the production
account cannot be load-tested; use a dedicated nonproduction account.
