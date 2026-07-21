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
- A push to `main` repeats that exact reusable quality gate, builds the SAM and
  frontend artifacts once, checksums them, attests them, and deploys those same
  bytes. Deployment never rebuilds source.
- Backend planning detects CloudFormation drift, retains every current stack
  parameter through `UsePreviousValue`, creates a non-executing change set, and
  rejects removals, replacements, recreation, protected-resource changes, and
  migration/security invariant changes.
- Backend execution uses a separate role and must reach `UPDATE_COMPLETE` before
  frontend deployment. Empty backend changes are an explicit safe no-op.
- Frontend deployment never deletes S3 objects. Fingerprinted assets receive
  immutable caching, other static files receive short caching, `index.html` is
  uploaded last with no-cache metadata, and the CloudFront invalidation is
  awaited.
- A manual workflow can only redeploy artifacts from a successful `main`
  production run whose exact SHA remains in `main` history. It cannot build or
  deploy arbitrary workflow-dispatch code.
- The weekly workflow runs the complete quality suite and detects production
  drift using a read-only audit role. It never remediates drift.

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
| `VITE_API_BASE_URL` | Public production API base URL. |
| `VITE_CLOUDFRONT_DOMAIN` | Public media CDN hostname. |
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

The four RUM variables are an all-or-none optional set until the separately
reviewed observability stack is deployed. Test and pre-deployment builds do not
require them. The reusable quality workflow always injects the exact tested
`github.sha` as `VITE_RELEASE_SHA`; do not create a mutable GitHub variable for
the release SHA. See [`OBSERVABILITY.md`](OBSERVABILITY.md) for privacy, cost,
activation, and rollback controls.

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
role must not read log events, S3 object bodies, DynamoDB items, Cognito users,
or secrets.

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

The execution identity policy deliberately has no `AdministratorAccess` and no
wildcard actions. The release KMS key policy uses the standard account-root
`kms:*` statement solely to enable this account's IAM policies; it grants no
external principal access. The execution role's allow statements use
`Resource: '*'` only for Lambda event-source-mapping creation/listing, Secrets
Manager random-password generation, ACM certificate requests, tagged Cognito,
CloudFront and KMS creation, and global log/alarm inventory reads. Those APIs do
not expose a usable resource ARN before creation (or do not support resource
authorization). Creation is narrowed with exact region/account families,
request tags, the exact certificate domain and DNS validation method, or the
exact `ian-website-*` function condition where the service supports it.

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

1. Frontend, backend, and ops line and branch gates independently pass at 80%.
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
```

Coverage output is transient and ignored. Never commit reports containing test
fixtures or runner paths.

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
