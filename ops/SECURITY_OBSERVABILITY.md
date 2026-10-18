# Application security logging and alarms

This covers the application-level security logging, metrics and alarms in
`backend/template.yaml`. There are no account IDs, credentials, user or album
identifiers, media keys or production log samples in here.

## Where the logs go

Every Lambda function writes JSON application logs to the retained
`/ian-photography/application/<stage>` log group. `ApplicationLogRetentionDays`
sets how long they're kept (30 days by default). I don't delete the old
per-function log groups, so a rollback never destroys earlier evidence.

Security-sensitive handlers write a versioned `security_audit` record through
`backend/functions/audit_helpers.py`. It only records:

- event, action and resource categories
- the outcome (success, denial or failure) and a stable reason code
- what kind of actor it was (anonymous, user, admin, service or CI), never who
- request, trace, environment and release correlation
- a short allowlist of aggregate counts and enumerated states

The helper rejects any other detail fields. It never serializes bodies, email
addresses, Cognito subjects, album or media identifiers, titles, object keys,
prefixes, URLs, credentials, sessions, passwords, MFA/CAPTCHA/share tokens,
provider errors or exception text. If the schema or logging itself errors, the
user's operation still goes through.

When CI/CD deploys a release, `ReleaseSha` must be the Git revision that was
tested. Use `unknown` only for a legacy or manual deploy I've identified as
such. Branch names, user input, workflow expressions, credentials and
timestamps don't belong in this parameter.

## Metrics and alarms

The stack publishes privacy-safe metrics under `IanTruongPhotography/Security`:

| Metric | Source | Alarm (route) | Meaning |
|---|---|---|---|
| `AuditDenied` | all application audit denials | none; dashboard/query only | Normal at low volume; look into it if the baseline shifts. |
| `AuditFailure` | audit records with failure outcome | `AuditFailureAlarm`, 1 in 5 minutes (record-only) | A security-sensitive operation or provider dispatch failed. |
| `LoginDenied` | denied `auth.login` records | `LoginDeniedAlarm`, 10 in 5 minutes (audit-only) | Possible credential attack, CAPTCHA problem or client regression. |
| `ApiAuthorizationDenied` | API 401, 403 and 429 access logs | `ApiAuthorizationDeniedAlarm`, 25 in 5 minutes (audit-only) | JWT, authorization or rate-limit failures, including denials before Lambda runs. |
| `FrontDoorDenied` | `front_door_request_denied` log records | `FrontDoorDeniedAlarm`, 10 in 5 minutes (record-only) | Requests reached the origin without a valid CloudFront origin header. |

None of these email me. Denials mean the checks are working, and an audit
failure never blocks the user. I only get email when the site is down, data is
at risk, the root account is used, or spend is over budget; the routing table
is in [`ALARM_REGISTRY.md`](ALARM_REGISTRY.md#email-routing-policy).

Alarms that do notify publish to the central `ian-photography-security-<stage>`
topic, which lives in the separate notification stack. Its policy only accepts
the names of alarms that are meant to email. Record-only alarms have no action
at all. The application stack doesn't create its own topic or subscription.
`alarm_registry.json` is the source of truth for each alarm's route.

One destination of mine is confirmed on that topic, which is all a personal
site needs. I record a delivery test every quarter. A topic ARN without a
confirmed subscription isn't an alert path.

Only change thresholds after watching at least two representative traffic
cycles. Write down the old and new value, the evidence, who changed it, a
review date and how to roll back. Don't make a signal quieter by logging user
identifiers, payloads, paths with identifiers or secret values.

## Triage without leaking data

1. Confirm the alarm's state, time and metric, and the current release output.
2. Query aggregate audit fields for that window. Don't export raw logs to local
   files or tickets.
3. Group by `event_name`, `outcome`, `reason_code` and `release_sha`. To look at
   a single request, correlate only by its generated request/trace ID.
4. Line up the alarm time with the CI release and the CloudTrail change set.
5. If the failure started with a release, use the tested rollback workflow. If
   it looks like abuse, keep the evidence and tune rate limits or WAF rules
   through IaC.
6. Write down what happened, who responded, start/acknowledgment/closure times,
   where the evidence is, and any follow-up, without copying user data.

A CloudWatch Logs Insights query that sticks to the schema fields and never
exports the raw message:

```text
fields @timestamp, event_name, outcome, reason_code, release_sha, request_id
| filter record_type = "security_audit"
| stats count() by event_name, outcome, reason_code, release_sha
| sort count() desc
| limit 50
```

Depending on Lambda's JSON envelope, the application record may be nested in
the `message` field. If so, parse out only the fixed schema fields. Never select
or show the full raw message in a shared screenshot or incident ticket.

## Responding to specific alarms

### Audit failure

- Find the event category and release, then check API and Lambda error and
  throttle metrics and the affected provider's status page.
- Don't retry deletions, invitations, email changes or media changes until I
  understand whether they're idempotent and what their preflight does.
- A provider dispatch can fail after the core album change has already
  committed. Check the actual state before retrying anything by hand.

### Login-denial surge

- Split the counts by `captcha_failed`, `rate_limited_ip`, `rate_limited_user`,
  `invalid_request` and `invalid_credentials`.
- See whether it started with a release or lines up with a CAPTCHA or Cognito
  outage.
- Don't enumerate accounts or weaken `PreventUserExistenceErrors`. Never copy
  credentials or tokens out of a browser or add them to logging.

### API authorization-denial surge

- Group API access logs by status and route template, not by the concrete path
  or query string.
- 401 usually means missing, invalid or expired authentication. 403 points at
  policy. 429 is rate limiting. Compare with `AuditDenied` to tell API Gateway
  denials apart from the application's own decisions.
- Keep CORS, the JWT issuer/audience check, the private-media deny and
  throttling in place while investigating. Roll back a bad release instead of
  opening up access.

### Administrator MFA enforcement

The API enforces admin TOTP itself. The React route guard isn't the only check.
The Cognito pre-token-generation trigger (`PreTokenGenerationFunction`) adds an
`admin_mfa` claim to every ID token issued to a member of the `Admins` group, at
sign-in and on each refresh. The value is `enabled` when TOTP is set up,
`missing` when it isn't, and `unverified` when the Cognito lookup failed.
Ordinary users pass through untouched, with no Cognito call.

Admin privilege (`auth_helpers.is_admin`) needs both the group and
`admin_mfa=enabled`. Group membership alone (`is_admin_group`) grants nothing.
An administrator without an `enabled` token is treated like an ordinary user
everywhere:

- `require_admin` returns 403 and audits `authorization.admin_access` denied
  with reason `admin_mfa_required` (non-admins get `admin_group_required`
  instead).
- Private-album reads fall back to owner and share checks.
- Catalog `visibility=all` and owner filters return 403.
- Album, ZIP, download and print access records label the actor `user`.

The shared `actor_context` classifier still reports group membership (`admin`),
so an `admin_mfa_required` denial shows which role was refused.

- The trigger fails open for login. An administrator without TOTP can still sign
  in and reach `/admin/security` to enroll, but gets no admin privilege until
  they're using a token issued after enrollment. Refresh tokens last 7 days and
  ID tokens last one hour.
- Enrolling TOTP signs the session out everywhere, so the next sign-in carries
  an `enabled` token.
- The stack creates `PreTokenGenerationInvokePermission` before the pool's
  `LambdaConfig` references the trigger. `UserPool` has a `DependsOn` on it, and
  the permission's `SourceArn` is the account/Region pool pattern instead of the
  pool ARN. That way Cognito never invokes the trigger without permission.
- A spike in `admin_mfa_required` together with `admin_mfa_lookup_failed
  error_type=...` warnings from the trigger means the lookup is failing
  (`unverified`). Check Cognito throttling and the trigger's role, not the admin.
- Never detach the trigger (remove `LambdaConfig`) without reverting the
  `is_admin` MFA requirement in the same release. A missing claim removes every
  administrator's privilege, and that's by design.

### Private-media signed cookies

When `PRIVATE_MEDIA_DELIVERY` is `true`, the album detail, shared album, admin
media, add-images and update-image handlers authorize the album and then attach
CloudFront signed cookies. There's one `CloudFront-Policy`/`-Signature`/`-Key-Pair-Id`
triple per approved album prefix, with `Path=/private-media/albums/<segment>`.
They also return protected media URLs under `/private-media/`. The cookie policy
expires on the same TTL as a presigned URL (`MEDIA_URL_TTL_SECONDS`), so
revoking a share or making an album private takes effect within one TTL. Covers
in list views, QR codes and downloads still use presigned URLs. Edge and key
setup is in [`PRIVATE_MEDIA.md`](PRIVATE_MEDIA.md).

- A signing failure never fails the request. That covers a missing or unreadable
  `/ian-website/<stage>/private-media-signing-key`, an SSM error or a bad key
  ID. The response falls back to presigned URLs without protected HLS and logs
  `private_media_signing_failed operation=... error_type=...` at WARNING. It
  logs neither the key nor the album.
- If those warnings keep coming, every viewer is on the fallback path. Check the
  SSM parameter and the function role's `ssm:GetParameter` grant. Don't paste
  the private key into an environment variable to get things working.
- 403s from `/private-media/*` with no signing warnings point at the edge: the
  behavior's trusted key group, an expired cookie the viewer didn't refresh, or
  a key ID that no longer matches `PrivateMediaPublicKey`.
- To roll back, set the literal to `'false'`. Responses go back to presigned
  URLs right away, and cookies already issued expire within one TTL.

## Deploying and rolling back

Normal releases go through the CI/CD plan in [`CI_CD.md`](CI_CD.md), which
already keeps every live parameter and rejects protected changes. For any
change set I review separately:

1. Run the full backend and infrastructure test suites.
2. Run `sam validate --lint` and `sam build`.
3. Create a change set without executing it, keeping the current SSM parameter
   names and the `AlbumIndexDeploymentPhase` and
   `EnforcePrivateMediaCloudFrontDeny` values.
4. Pass the tested `ReleaseSha` and the approved retention parameters.
5. Reject any replacement or removal of data, identity, API, bucket,
   distribution or retained log resources.
6. Confirm Lambda logging configuration changes in place and the retained
   `ApplicationLogGroup` doesn't change.

After it runs, send one synthetic safe audit success and one denial. Check both
land in the central group, the metrics move, and the alarm destination is
right. Then run the existing anonymous authorization and public-media smoke
tests. Synthetic events must not use a real email, album, share grant or media.

Set retention on the old per-function groups, including dormant authentication
groups from before central logging, through the stack inventory script. The
first command is a dry run; look only at its aggregate counts:

```bash
python3 ops/set_lambda_log_retention.py \
  --stack-name ian-website \
  --region us-west-2 \
  --days 30

python3 ops/set_lambda_log_retention.py \
  --stack-name ian-website \
  --region us-west-2 \
  --days 30 \
  --apply \
  --expected-account-id EXPECTED_ACCOUNT_ID \
  --confirm-stack-name ian-website
```

Don't delete a dormant group just because its function now logs to the central
group. Retention ages out old security metadata while keeping the rollback and
incident history intact.

Roll back the Lambda release or configuration through a stack change set I've
read through. Don't delete the central or legacy log groups, metric history, alarm state
or incident evidence. A rollback can stop new records from reaching the central
group, so put both group names in the incident record to make the time boundary
clear.

## How this fits with the account stacks

This application stack only owns application logging, its privacy-safe metrics
and its own alarms. CloudTrail, GuardDuty, AWS Config, Security Hub, WAF, AWS
Backup, IAM Access Analyzer, KMS and the budget all run in separate protected
stacks, so an application release can't weaken or replace them.

[`SECURITY_ACCOUNT_BASELINE.md`](SECURITY_ACCOUNT_BASELINE.md) is the source of
truth for those controls: how they deploy, how long evidence is kept, drift and
rollback. [`ALARM_REGISTRY.md`](ALARM_REGISTRY.md) maps their signals to what I
do about them and who gets notified. Don't change account-level controls by hand
during an application deploy. Rotating provider credentials is its own
authorized operation, unless an active incident calls for it.
