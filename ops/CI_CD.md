# CI/CD operations guide

Releases run on GitHub Actions from the workflows in `.github/workflows/`, and
GitHub holds no AWS credentials. The pipeline stops at anything it can't verify.
A production release stays blocked until each of the four independent coverage
domains reaches 80%, and nothing deploys until the AWS/GitHub bootstrap
described below exists.

## Workflows

| Workflow | Trigger | Jobs |
|---|---|---|
| `pull-request.yml` | Pull request to `main` | Reusable quality gate plus `dependency-review` (fails on any severity from `low`). |
| `release-production.yml` | Push to `main` | `quality` → `attest` → `backend-plan` → `backend-deploy` (skipped for an empty change set) → `backend-smoke` → `frontend-deploy` (deploy, then smoke with the release SHA) → `release-storage-cleanup` → `release-record`. |
| `manual-release.yml` | `workflow_dispatch` | Verified redeploy or forward rollback of `frontend`, `backend`, or `both` from an earlier successful production run. |
| `scheduled-security.yml` | Mondays 09:23 UTC and `workflow_dispatch` | Quality gate, `release-idle`, `history-and-public-posture`, `production-drift`. |

The reusable `_quality.yml` gate runs five independent domains. A final
`quality-gate` job fails unless all of them succeeded:

- `frontend-unit-build`: ESLint, the RAW-decoder exercise, Vitest coverage, the
  preview worker's coverage, the production build, the built theme/bootstrap
  check, Playwright release and visitor-gallery journeys, and the frontend
  artifact budget.
- `backend-unit`: all backend tests with branch coverage.
- `infrastructure`: ops tests with branch coverage, `validate_infrastructure.sh
  --build`, the Lambda environment policy, the SAM credential-artifact scan, and
  the SAM artifact budget.
- `dependency-workflow-security`: `npm audit` and `pip-audit`, CycloneDX SBOMs,
  `workflow_policy.py`, checksum-pinned `actionlint`, `zizmor`, a separate
  `cfn-lint` pass over every CloudFormation template, and the full-history
  credential scan.
- `codeql`: JavaScript/TypeScript and Python analysis.

## What the pipeline checks

### Pull requests

Pull requests run the frontend, backend, operations, SAM, dependency, workflow,
credential-pattern, and CodeQL checks without any AWS identity.

Infrastructure policy comes from `sam validate --lint`, a separately pinned
`cfn-lint`, and the repo's own tests over source and templates. Those tests do
the job a separate CloudFormation Guard pack would, and they cover the specific
privacy and durability controls in this stack.

### Artifact budgets and credential scans

Before packaging, CI measures the frontend and SAM build directories. Limits
checked into source cover total compressed and uncompressed frontend bytes,
entry JavaScript/CSS, the largest chunk, and each Lambda's unpacked bytes and
file count. SAM artifacts are also checked against the source allowlists in
`backend/Makefile`, so one function can't quietly pick up another function's
local modules. A few heavier functions, like Google Drive and the Sharp preview
worker, have their own larger ceilings. None of them gets an unlimited
exception.

Both artifact checks write aggregate-only JSON evidence and upload it even when
a budget fails. The reports contain logical IDs, counts, byte totals, limits,
and violation codes. They don't contain runner paths, source content, object
keys, album IDs, credentials, or environment values.

A separate scan looks through the generated SAM artifacts for forbidden
credential-file names, complete private-key blocks (including legacy encrypted
PEM metadata), and AWS access-key IDs. The example ID from AWS's published
documentation doesn't count, and neither does dependency source that just names
private-key formats. Only one credential-looking JSON filename is allowed,
`GoogleDriveBackupFunction/googleapiclient/discovery_cache/documents/iamcredentials.v1.json`,
and its service identity fields have to match the public IAM Credentials v1
schema. If the scan can't list a directory or read a file, it fails.

Every PR and `main` release also scans all reachable Git blobs (up to a size
limit) without printing paths or values. It looks for private keys, AWS IDs,
high-confidence GitHub/Google/Slack/Stripe tokens, and URLs with credentials in
them, lockfiles included. The weekly run repeats the same full-history scan.

### How a `main` release deploys

A push to `main` runs the same reusable quality gate again, builds the SAM and
frontend artifacts once, checksums and attests them, and deploys those same
bytes. Deployment never rebuilds from source.

SAM code and the packaged CloudFormation template are uploaded under the
release SHA plus a unique run/attempt, encrypted with the bootstrap KMS key.
Every packaged `CodeUri` is rewritten to point at its S3 `Version`, and the
object count has to equal `codeUriCount` in
`ops/ci/release_artifact_contract.json`. The template is uploaded with
`If-None-Match`, and its versioned URL and SHA-256 are tied to the change set
the release guard checks.

Backend planning checks for CloudFormation drift, keeps every current stack
parameter with `UsePreviousValue`, and creates a change set without executing
it. It rejects removals, replacements, recreation, direct changes to protected
resources, and anything that would break the migration or security rules.
CloudFormation is cautious and sometimes reports dependency cascades on
protected resources. Those pass only when every detail matches a dynamic
reference listed in `ops/ci/release_dependencies.json`.

Execution checks again on its own. The change set must keep `UsePreviousValue`
for every live parameter (including `NoEcho` parameters), and only `ReleaseSha`
may get a new value. After the update it rechecks the security and migration
rules. The versioned `ops/ci/release_intent.json` also requires every observed
logical ID, resource type, action, and CloudFormation property path to match a
specific rule. Wildcards, duplicate rules, unknown properties, and unexplained
changes with no detail all fail.

`ops/ci/release_parameter_additions.json` allows
`OriginalComparisonsEnabled=true` and `AlbumWorkRouting=legacy`, but only when
those parameters are being introduced for the first time. Planning and
execution both validate it. Once a parameter exists, its current value is kept
like any other. Any other addition, or a change to an existing value, is still
rejected.

Backend execution uses a separate role. It has to reach `UPDATE_COMPLETE`, and
the credential-free public smoke has to pass, before the frontend deploys. An
empty backend change set is a safe no-op.

Frontend deployment never deletes S3 objects. The uploader compares object
content and cache metadata, uploads only changed files, and does `index.html`
last. Fingerprinted assets keep immutable caching. Other static files get
five-minute caching, and HTML entrypoints get no-cache metadata.

CloudFront doesn't follow that metadata everywhere. It holds the default
behavior (the SPA shell and other unhashed root files) for one day regardless,
and it holds the `/album/*` and `/video/*` social documents, which embed the
shell's hashed asset names, for up to an hour. So any changed or unpublished
file invalidates the single path `/*`. That one billable path also clears the
public API and private-media edge caches.

The publication manifest only advances after the invalidation waiter succeeds,
so an interrupted publication repeats any invalidations it still owes. Checking
the actual objects also repairs a rollback after a partial failed upload.
Redeploying unchanged files creates no invalidation. All of this runs under the
existing production release/rollback lock and needs no new IAM grants. If you
change an object in the frontend bucket outside this script, you have to
invalidate it yourself.

### Manual redeploys

The manual workflow can only redeploy artifacts that were independently
attested by a successful `main` production run, and only if that SHA is still
in `main` history. The guard, deploy, and smoke scripts always come from the
current trusted control SHA. The older SHA you pick is never run as CI code.

### The weekly run

The weekly workflow runs the full quality suite, then waits for any production
release to finish (`wait_for_release_idle.py`). It scans every reachable Git
blob without printing values or paths, runs the credential-free public posture
smoke against the latest successful release SHA, and runs
`audit_stack_drift.sh`.

That script checks drift for the versioned stack inventory (application, CI
bootstrap, security, WAF, backup, and observability) across `us-west-2`,
`us-east-1`, and `us-east-2`. It also checks the frontend edge and bucket
settings with secrets redacted (`audit_frontend_edge.sh`). In the home Region it
verifies the GuardDuty detector and a Security Hub setup with no standards
enabled (`home_security_posture.py`). Any enabled standard fails the audit,
because I use targeted Config rules instead to keep the cost down. It doesn't
claim managed detector or hub coverage in other Regions, and it never fixes
drift on its own.

## Required GitHub settings

There's one deployment branch. Every push to `main` runs the full quality and
security gate and, only once that passes, deploys the attested backend and
frontend artifacts. I don't use GitHub Environments. Set all of these
non-secret variables at repository scope:

| Variable | Scope/purpose |
|---|---|
| `AWS_REGION` | Application region, currently `us-west-2`. |
| `AWS_ACCOUNT_ID` | The one allowed account, used for the credential action's confused-deputy protection; the action masks it. |
| `AWS_STACK_NAME` | SAM/CloudFormation application stack name. |
| `AWS_RELEASE_ARTIFACT_BUCKET` | Encrypted, versioned release package bucket. |
| `AWS_RELEASE_ARTIFACT_KEY_ARN` | Bootstrap KMS key ARN required for every SAM package upload. |
| `AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN` | CloudFormation service execution role that the plan role passes. |
| `AWS_PLAN_ROLE_ARN` | OIDC role that can read/plan the application stack and write only its release prefix. |
| `AWS_EXECUTE_ROLE_ARN` | OIDC role that can execute and monitor an already-created change set. |
| `AWS_FRONTEND_ROLE_ARN` | OIDC role for non-deleting frontend writes and invalidation of the one distribution. |
| `AWS_AUDIT_ROLE_ARN` | Read-only OIDC role for the scheduled drift and configuration checks. |
| `FRONTEND_BUCKET` | Private/OAC frontend bucket. |
| `FRONTEND_DISTRIBUTION_ID` | Frontend distribution. |
| `SITE_URL` | Canonical HTTPS site URL. |
| `API_ORIGIN_URL` | Regional custom API origin including `/api`; used only for the expected anonymous 403 bypass test. |
| `EXECUTE_API_URL` | Default execute-api stage URL; used only to prove the endpoint is still disabled. |
| `VITE_API_BASE_URL` | Public production API base; use same-origin `/api` after front-door cutover. |
| `VITE_CLOUDFRONT_DOMAIN` | Public media CDN hostname. |
| `MEDIA_BUCKET_NAME` | Media bucket name; the smoke reuses one public CDN object's path to prove the matching direct regional S3 request is still denied. |
| `VITE_COGNITO_USER_POOL_ID` | Public Cognito pool identifier. |
| `VITE_COGNITO_CLIENT_ID` | Public Cognito app-client identifier. |
| `VITE_TURNSTILE_SITE_KEY` | Public Turnstile site key, never the Turnstile secret. |

None of these is a credential. Don't put AWS access keys, Cognito tokens,
Turnstile secrets, provider secrets, CloudFormation parameter values, or
application data in GitHub.

Catalog, album, photo, and video counts aren't repository variables or
deployment gates. The credential-free smoke test checks the live catalog
instead: it has to be nonempty, fully paginated, internally consistent, and
serving usable public media through the CDN. That way, adding or removing
content never means touching GitHub config.

Everything above is repository-scoped so the reusable quality, deployment, and
smoke jobs all read one configuration. The role ARNs still point at four
separate roles, each with only the permissions it needs, and dropping GitHub
Environment gates doesn't merge them. The fifth GitHub role,
`ian-website-release-storage-cleanup`, has a fixed name and is built from
`AWS_ACCOUNT_ID`, so it doesn't need a variable.

The reusable quality workflow always injects the tested `github.sha` as
`VITE_RELEASE_SHA`. Don't create a GitHub variable for the release SHA. A
variable is mutable and could drift from the commit that was tested.

### The public smoke test

`ops/ci/public_smoke.sh` wraps `ops/ci/public_posture_smoke.py`. It:

- pages through the whole anonymous catalog (with a hard page limit) and
  requires it to be nonempty and complete;
- validates DTO allowlists and CDN-only media URLs, samples album details and
  one ranged CDN object, and proves direct S3 access is still denied;
- proves, when a ready original-comparison preview is present, that its signed
  URL works and its unsigned URL is denied;
- requires the custom-origin and execute-api bypasses to stay closed, including
  API Gateway's specific JSON 404 response for its disabled default endpoint;
- checks hostile-origin CORS, the public stats response, and the 401 on
  protected user routes;
- checks sensitive SPA routes under DNT/GPC headers for security headers and
  cookies;
- requires the deployed release marker when `EXPECTED_RELEASE_SHA` is set.

The protected response must never show cache-hit evidence, and if it carries a
cache directive, that directive must be `private, no-store`. The script only
prints aggregate counts.

CI allows one retry after five seconds, and only for an allowlisted transport
error, HTTP 429/5xx, a content-type/status failure, or a CDN availability
failure. It logs the safe failure reason. Failures in CORS, bypass, caching,
headers, cookies, catalog integrity, the release marker, or direct-storage
checks are never retried.

## OIDC trust and permissions

The album-continuation workers loop on purpose, so CloudFormation's execution
policy has to read and set Lambda recursion configuration. The
`ManageContinuationWorkerRecursion` statement grants those two actions only for
`${ApplicationStackName}-CacheInvalidationWorkerFunction-*` and
`${ApplicationStackName}-AlbumWorkWorkerFunction-*`. The GitHub plan, execute,
frontend, audit, and cleanup sessions don't get them.

Before releasing a new function with `RecursiveLoop: Allow`, update the
bootstrap first with a non-executing change set that keeps all live parameters.
The only change you should see is to
`CloudFormationExecutionIdentityAndComputePolicy`, with no replacement. That
prerequisite needs its own approval, and it has to be applied before the
application release is merged. The application release intent only allows
`RecursiveLoop` on `CacheInvalidationWorkerFunction` and
`AlbumWorkWorkerFunction`.

The bootstrap template is `ops/ci_bootstrap_template.yaml`, and its stack is
retained. It creates or references the GitHub OIDC provider with audience
`sts.amazonaws.com`. Every role's trust policy has to match this repository and
the `main` ref subject:

```text
repo:iant4093/photographywebsite:ref:refs/heads/main
```

Never use a wildcard for the repository, organization, branch, or tag. The
production execution role must not be able to create arbitrary change sets, and
the plan role must not be able to execute one. The frontend role must not have
`s3:DeleteObject`, bucket-policy, public-access, distribution-update,
application-data, or secret-value permissions. The audit role has no
`secretsmanager:GetSecretValue`, `s3:GetObject`, `s3:GetObjectAcl`,
`dynamodb:GetItem`, `kms:Decrypt`, log-event, Cognito-user, or detailed drift
property permission.

The catch with drift detection is that AWS requires it to have each selected
resource provider's read-handler permissions. Those metadata-only provider calls
are allowed only when `aws:CalledVia=cloudformation.amazonaws.com`, so the
GitHub session can't make them directly, and the scheduled script only reports
aggregate detection status.

Two resources need small additions to that called-via list. The notification
stack's unencrypted-filter `AWS::Lambda::EventSourceMapping` adds only
`lambda:GetEventSourceMapping` and `lambda:ListTags`. Its source sets neither
`KmsKeyArn` nor `FilterCriteria`, so the generic provider's `kms:Decrypt` stays
denied. The backup freshness `AWS::Lambda::Permission` adds only called-via
`lambda:GetPolicy`. Tests tie these exceptions to the specific source
properties and still forbid direct Lambda invocation, reading queue messages,
and KMS decryption.

The observability stack only has a free-metric dashboard, so the scheduled audit
can run plain whole-stack drift detection on it with no service-specific
exclusion or skipped check. The edge alarms belong to the us-east-1 WAF stack.
Browser telemetry and synthetic probes aren't part of the release.

### GuardDuty and Security Hub

GuardDuty is awkward. Its CloudFormation provider reports the six
service-managed detector features as additions, even though CloudFormation can
only configure the other six. So `GuardDutyDetector` is the one configuration
exception left out of the managed-security provider drift request. Three other
logical resources (the Config bucket policy, the custom delivery channel, and
the configuration recorder) are counted as provider-unsupported, because
CloudFormation's resource-level drift API can't evaluate them. The inventory
requires that four-item set and nothing else, proves at runtime that every
other live stack resource gets checked, and fails if a new exclusion shows up.
Source tests still tie the unsupported resources to their least-privilege
checks.

The scheduled audit doesn't skip the detector, though. `home_security_posture.py`
requires one enabled detector in the home Region and no more, the full combined
12-feature map, 15-minute publishing, and the required application/stage tags.
It also requires the home Security Hub default hub, the `SECURITY_CONTROL`
finding generator, the required application/stage tags, and zero enabled
standards (`EXPECTED_SECURITY_HUB_STANDARDS` is empty). If I ever add a
standard to that list, each one must be `READY`, or `PENDING` while the provider
reconciles, with controls still `READY_FOR_UPDATES` and no status reason.

Extra tags managed by AWS or CloudFormation are fine. Missing required tags, or
any difference in detector, features, hub, generator, standards, or
updatability, fails the audit. Output is aggregate counts only, including how
many provider transitions it saw. The audit role's direct GuardDuty and Security
Hub permissions only work in the home Region, and the audit doesn't inventory or
claim managed coverage anywhere else.

### Which stacks the audit covers

The CloudFormation stacks it audits are the entries in
`ops/ci/audit_stacks.json`. The cross-region entries are the CloudFront WAF
stack in `us-east-1` and the retained backup replica in `us-east-2`, and
drift-status polling is conditioned on region so it only reaches those three
regions. Change the inventory and the audit role's list of stack ARNs together,
and deploy both before the scheduled job is enabled.

If a stack gains a new CloudFormation resource type, compare that type's current
registry read-handler permissions with `CloudFormationForwardAccessReads`,
validate the rendered identity policy with IAM Access Analyzer, and add only the
missing metadata called-via actions. If a provider needs a data-plane
permission, filter that logical resource out and add a configuration-only check
scoped to that resource. Don't widen the audit role.

I worked out the initial permissions from the live stack resource types and
their current CloudFormation registry `read` handlers. The application stack
already has its own CloudFormation execution role, so application-only reads
(API Gateway, Cognito, DynamoDB, SSM parameter, and edge providers) don't belong
on the GitHub audit role. In the retained stacks that have no service role, a
few handler permissions turned out to be unnecessary:

- The generic Lambda handler's `kms:Decrypt`, because the configuration-delivery
  function has no `KmsKeyArn`.
- The EventBridge handler's `iam:PassRole`, because neither target has a
  `RoleArn`.
- `s3:GetBucketAcl`, because the current S3 bucket handler doesn't declare it
  and none of the buckets defines `AccessControl`.

After those removals, the called-via list matches the union of the metadata
handlers.

### The frontend edge hashes

The frontend edge isn't managed by CloudFormation, so it has its own file,
`ops/ci/frontend_edge_contract.json`. Its hashes cover the full distribution
configuration and the bucket's public-access, encryption, ownership,
versioning, and policy-status documents. The only thing swapped out before
hashing is the origin-verification header value, which is replaced with a fixed
presence marker.

The weekly audit waits up to an hour for any running production release to
finish, and checks the public site against the commit of the latest successful
release. It only reads the distribution after CloudFront reports it `Deployed`.
Without that wait, a deploy in progress looks like drift: CloudFormation won't
start drift detection on a stack that's updating, and the site is still serving
the previous commit.

When the edge doesn't match, the failure names which documents drifted
(`distribution`, `publicAccessBlock`, `encryption`, `ownership`, `versioning`,
`policyStatus`), never their values. Any edge change I make needs its new hashes
recorded in that file, or every weekly run after it fails. When the stack
inventory grows, execute the bootstrap UPDATE change set before the next
scheduled or manual audit. The audit role doesn't get the new stack ARN until
that update runs.

### The CloudFormation execution role

The CloudFormation execution role is scoped to resources the application stack
owns. It denies deleting protected tables, buckets, Cognito resources,
distributions, KMS keys, and secrets. Its permissions are split across four
attached `AWS::IAM::ManagedPolicy` resources, and each compact policy document
has to stay under IAM's 6,144-character managed-policy limit. Don't move these
statements back into inline role policies. Their 10,240-character aggregate
quota is what made the original bootstrap create roll back.

The current SAM template doesn't attach an IAM permissions boundary to the roles
it generates, so the bootstrap limits role management and `iam:PassRole` to the
`ian-website-*` family instead. Adding a boundary later has to be coordinated
with `backend/template.yaml`, because requiring one only in the execution policy
would break the current deployment. EventBridge rule lifecycle access is limited
the same way, to the application stack's `ian-website-*` rule family and the
existing `ian-photography-waf-alarm-prod` notification rule, which carries the
website's CloudFront 5xx alarms. The execution role can't publish to any event
bus.

OIDC, the roles, and release storage all live in their own separate stack with
termination protection. The application stack must never create the role that
deploys it.

## Bootstrap preflight and deployment

The IAM OIDC provider is one per account. Check for it before creating a change
set, and pick a mode on purpose. Both commands below are read-only:

```bash
python3 ops/ci_bootstrap_preflight.py \
  --provider-mode create \
  --expected-account-id AWS_ACCOUNT_ID

python3 ops/ci_bootstrap_preflight.py \
  --provider-mode use-existing \
  --existing-provider-arn arn:aws:iam::AWS_ACCOUNT_ID:oidc-provider/token.actions.githubusercontent.com \
  --expected-account-id AWS_ACCOUNT_ID
```

`create` stops if the provider already exists. `use-existing` needs the
same-account ARN and checks the GitHub URL and the `sts.amazonaws.com` audience.
The preflight only calls STS and IAM read APIs. It doesn't retrieve, print, or
store credentials.

Validate the template locally, and with CloudFormation's read-only parser if
you're signed in:

```bash
cfn-lint ops/ci_bootstrap_template.yaml
aws cloudformation validate-template \
  --region us-west-2 \
  --template-body file://ops/ci_bootstrap_template.yaml
```

Deploying the bootstrap is a one-time operation with its own approval. Use a
dedicated stack, look over its change set, pass `CAPABILITY_NAMED_IAM`, use the
provider mode the preflight approved, and turn on termination protection right
after creation. Never run these commands from a commit nobody has looked at:

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

If the provider really doesn't exist yet, use `GitHubOidcProviderMode=create`
and leave out the existing ARN.

These resources all use `DeletionPolicy: RetainExceptOnCreate` with
`UpdateReplacePolicy: Retain`: the provider, the KMS key and alias, the
versioned artifact bucket and its policy, the five GitHub roles (plan, execute,
frontend, audit, and release-storage cleanup), the CloudFormation execution
role, and its four managed policies. That keeps established and replaced
resources recoverable, while still letting CloudFormation clean up whatever it
created during a failed first create. If a bootstrap create fails, confirm it
reaches `ROLLBACK_COMPLETE` without leaving new orphaned named roles, providers,
buckets, aliases, or policies before you retry.

The bucket has a full public-access block, bucket-owner-enforced ownership, a
rotating customer-managed KMS key, and incomplete multipart cleanup. Retiring
old versions is `release_storage_cleanup.py`'s job (see below). Retention is
there for recovery, so deleting the bootstrap stack is not a way to clean up.

The template pins the application identifiers (stack name, API domain, HTTP
API, hosted zone, frontend bucket, and distribution) as single-value parameter
defaults, which is why the deploy command only overrides the provider mode.

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

Set the rest of the repository variables from the current account, Region,
application stack, frontend bucket, and frontend distribution. Don't commit
their physical identifiers to this doc. There's no GitHub Environment to set
up. The OIDC subject alone limits AWS access to `refs/heads/main`, and the
scheduled and manual workflows also fail if their control revision isn't
running from that ref. No ref other than `main` can assume a production role.

### What the execution role is allowed to do

The execution identity policy has no `AdministratorAccess` and no wildcard
actions. The release KMS key policy uses the standard account-root `kms:*`
statement only so this account's IAM policies work. No outside principal gets
access.

The execution role uses `Resource: '*'` only for these, because the APIs don't
expose a usable resource ARN before creation, or don't support resource
authorization at all:

- Lambda event-source-mapping creation/listing
- Secrets Manager random-password generation
- ACM certificate requests
- tagged Cognito
- CloudFront creation and account inventory
- KMS creation
- global log/alarm inventory reads

The ACM certificate grant requires the API-origin domain, DNS validation, and
the deployment region. Its first tag call allows only the application, stage,
and CloudFormation tag-key families. After that, certificate access is scoped by
application tag. CloudFront cache-policy, response-header-policy, and
origin-access-control updates and rollback deletes are limited to those account
ARN families. Distribution deletion stays denied.

Creation is narrowed wherever the service allows it: by region/account
families, by request tags where the resource provider supplies them, by the
certificate domain and DNS validation method, or by the `ian-website-*`
function condition. The only CloudFormation macro the application execution
role may invoke is the regional `Serverless-2016-10-31` transform ARN, while it
creates the already-checked application change set.

CloudFormation drift detection also runs as the stack execution role. Its
read-only grants include account-level field-index metadata, because
`logs:DescribeIndexPolicies` can't be scoped to a resource in IAM. SNS topic-tag
reads are limited to the existing regional/account `ian-photography-*` family,
so the resource provider can compare the declared alarm-topic tags without
reporting a false removal. The inventory statement never grants
`logs:GetLogEvents`, and the deployment roles never see secure parameter values.

There's a separate `logs:PutMetricFilter` grant on the production security log
group for security event metric updates. It lets the notification stack stop
publishing continuous zeros while keeping its matching patterns, event metrics,
and alarms. It doesn't allow deleting the log group or filters, changing
retention, or changing notifications. Apply the bootstrap managed-policy change
before executing the notification filter change set; rolling back needs the
same permission. Check that the first change touches only that managed policy
and the second touches only the 13 metric transformations.

HTTP API access-log reconciliation uses CloudWatch Logs delivery metadata and
resource-policy APIs. AWS doesn't support resource-level IAM scoping for these,
so the execution role grants only their documented lifecycle set on
`Resource: '*'`, restricted to `us-west-2`. That statement can't read, filter,
write, or delete log events. Log-group creation and retention are still limited
separately to the application families.

Front-door updates are otherwise limited to
`origin-api.iantruongphotography.com`, the hosted zone from the stack
configuration, its API Gateway domain/mapping/tag paths, application-tagged
regional ACM certificates, and A/CNAME changes at that hostname or under its
validation records. The Route53 change-status ARN has to include a wildcard for
the change ID, but that's not a `Resource: '*'` grant. The origin-verification
value is an encrypted SSM parameter the stack never writes, and its read-only
IAM managed policy uses only the application stack's policy-name family. The
only Secrets Manager family the execution role can create or update is
`ian-photography/prod/fotomoto-print-session-*`. Retained resources are still
protected by deny statements on destructive actions.

When you change these policies, run IAM Access Analyzer validation and a
sandboxed change-set test against the current `backend/template.yaml`. Add only
the specific missing action or resource that CloudTrail reports. Never reach for
a managed administrator policy.

## Repository rules

`main` is the only deployment branch, and a normal push to it kicks off the full
production quality, security, deployment, and smoke workflow. Allow normal
pushes, but block force pushes and branch deletion. Turn on GitHub secret
scanning and push protection. Commits that touch workflows, infrastructure,
lockfiles, operations, or security boundaries effectively authorize a
deployment, so look them over before pushing.

Automatic production deployment stays on only while all of these hold:

1. Frontend, backend, ops, and the separately packaged Node preview worker each
   pass their line and branch gates at 80%.
2. A production drift audit reports `IN_SYNC`, and any direct changes have been
   brought back under infrastructure code.
3. IAM Access Analyzer validates all five OIDC role policies and the execution
   role's managed policies.
4. A plan-only test shows the roles can do only what they're meant to.
5. Frontend and backend rollback artifacts are kept, and a synthetic recovery
   drill has passed.

## Release archive retention

The `release-storage-cleanup` job runs after each successful production deploy,
inside the same concurrency lock as manual rollbacks. It uses its own main-only
OIDC role (`ian-website-release-storage-cleanup`). That role can read the
application and bootstrap stacks, and list and delete specific versions in the
release bucket's `releases/` prefix. It can't read application data, decrypt
secrets, upload artifacts, or change any stack. The job reruns
`ops.tests.test_release_storage_cleanup` first.

`ops/ci/release_storage_cleanup.py` keeps every artifact referenced by the live
processed stack template, the current release SHA, and the five most recent
distinct successful production release SHAs. Every other recognized backend
release attempt is kept for at least `ReleaseArtifactNoncurrentRetentionDays`
(60 days by default, and the parameter can't go below 30). If an attempt has any
recent or unknown object, the whole attempt is kept. Cleanup looks at both
current and noncurrent versions, which stops the endless pile-up that unique
release paths would otherwise cause. Unrecognized paths, website media, audit
evidence, and the frontend serving bucket aren't touched.

Cleanup only runs when the protected stacks are stable, bucket versioning is on,
the GitHub runs are verified as successful, and there's no pending application
change set. It rechecks the stack before each deletion batch, deletes by version
ID, and stops on partial failures. Each run handles at most 1,000 versions and
5 GiB, and anything more waits for later releases. If deployments stop, storage
stops growing too, and cleanup picks up again on the next release. Keep releases
and rollbacks inside the production lock. Manual stack deployments outside it
must not overlap cleanup.

There's no blanket noncurrent-version expiration on the bucket, because it could
delete a version that a retained release still points to. Multipart-upload
cleanup is still on. The Python command defaults to a dry run, and the workflow
passes `--apply`. Its logs only contain aggregate counts and bytes.

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

The browser journeys need `npx playwright install chromium` once, and they run
against the built `dist`. If a local `.env` sets an API base, it gets baked into
that build and `test:browser` stops matching CI's deterministic configuration.
Coverage output is temporary and ignored by git. Never commit reports that
contain test fixtures or runner paths.

## Release-intent maintenance

`ops/ci/release_intent.json` is part of what authorizes a production release.
It isn't generated evidence. Each rule names one logical ID, resource type,
action, and the property paths it may change (for example Lambda `Code` and
`Environment`, alarm `AlarmActions`, or the approved `Add` of a new function,
role, queue, or table). If a release is meant to change another unprotected
resource or property, add its logical ID, CloudFormation resource type, action,
and property paths in the same change. A new resource may set `allowNoDetails`
only when its `Action=Add` change set really has no property detail. Never use
that flag to let through a modification you can't explain. Protected resource
types, removals, replacements, and recreations stay blocked even if an intent
rule names them.

One specific case: don't add `RateLimitTable` PITR to the persistent release
intent. A `PointInTimeRecoverySpecification` update has to go through the
separate protected change-set workflow, and after that, ordinary CI plans
should see no DynamoDB table change.

CloudFormation only exposes Lambda environment changes at the top-level
`Environment`, so `ops/ci/template_environment_policy.json` also pins the
digests of the source and SAM-built Environment blocks. If you mean to change a
variable, update that policy in the same change.

CloudFormation also reports cautious dependency cascades when an unchanged
protected resource refers to a Lambda or bucket that's part of the release.
`ops/ci/release_dependencies.json` lists those relationships by logical ID,
resource type, property, and causing attribute. A dependency rule is accepted
only for a `Dynamic` `ResourceAttribute` detail. It can't authorize a direct
edit, replacement, recreation, removal, or a relationship that isn't listed.
Keep this file small. Only add a relationship after looking at a real
non-executing change set and confirming the protected resource's definition
hasn't changed.

## Artifact budget maintenance

`ops/ci/artifact_budgets.json` holds the performance limits. Only raise a limit
in the same change that explains the dependency or bundle growth behind it.
Don't derive limits from whatever artifact happens to be sitting in `.aws-sam`;
CI always does a clean SAM build first. The evidence files are for diagnosis and
never get deployed.

The frontend check measures every deployed file with deterministic per-file
gzip, all JavaScript and CSS referenced by `index.html`, and the largest
JavaScript/CSS chunk. The SAM check applies a default limit to every Lambda,
with larger (but still finite) overrides for the heavier functions in the
config's `sam.overrides`: Google Drive, the Sharp preview worker, hero reel,
original-comparison, and image-upload. Every allowlisted local source file must
be present, and any other module from `backend/functions` at the artifact root
is rejected. A new Lambda needs a `SOURCES_<LogicalId>` entry before the quality
gate will pass.

## Load-testing the public catalog outside production

`ops/public_catalog_load_test.py` is manual and runs as a dry run by default. No
workflow calls its CLI, so it can't load-test production on its own. The public
posture smoke only imports its small read-only catalog probe. A dry run makes no
AWS or HTTP calls:

```bash
python3 ops/public_catalog_load_test.py \
  --output evidence/public-catalog-load-dry-run.json
```

With the network on, it sends requests one at a time and stops at fixed limits.
It checks page completeness, cursor progress, no duplicate albums, list/detail
count consistency, public DTO allowlists, safe public media URLs, a narrow EXIF
allowlist, and public edge-cache headers. The JSON evidence only contains
counts. It never records the base URL, AWS account, album IDs, cursors, response
bodies, or media URLs.

Only run it against a separate nonproduction AWS account and endpoint. Every
guard is required:

- The active STS account must match both the expected and the repeated account
  ID.
- It must differ from the named production account.
- The environment and confirmation phrase must match.
- Production-labelled stages and `iantruongphotography.com` are refused.

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

The helper makes a read-only `sts:GetCallerIdentity` call before the first HTTP
request. It won't run against a staging stage in the same account, because that
would weaken the account guard. Create or use a dedicated nonproduction account
for this test.
