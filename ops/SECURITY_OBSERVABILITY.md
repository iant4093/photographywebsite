# Application security logging and alarms

This page covers the application-level security logging, metrics and alarms in
`backend/template.yaml`. It contains no account IDs, credentials, user or album
identifiers, media keys or production log samples.

## Where the logs go

Every Lambda function writes JSON application logs to the retained
`/ian-photography/application/<stage>` log group (the `LoggingConfig` in the
function globals). `ApplicationLogRetentionDays` sets the retention (default
30 days). The older per-function log groups are not deleted, so a rollback
keeps earlier evidence.

Security-sensitive handlers write a versioned `security_audit` record through
`backend/functions/audit_helpers.py`. A record contains only:

- event, action and resource categories
- the outcome (`success`, `denied` or `failure`) and a stable reason code
- the actor type (`anonymous`, `user`, `admin`, `service` or `ci`), never the
  identity
- request, trace, environment and release correlation
- a short allowlist of aggregate counts and enumerated states

The helper rejects any other detail fields. It never serializes bodies, email
addresses, Cognito subjects, album or media identifiers, titles, object keys,
prefixes, URLs, credentials, sessions, passwords, MFA/CAPTCHA/share tokens,
provider errors or exception text. If the schema check or logging itself
fails, the user's operation still completes.

When CI/CD deploys a release, `ReleaseSha` must be the tested Git revision. The
parameter accepts `unknown` or a 7 to 64 character hex string. Use `unknown`
only for an identified legacy or manual deploy. Branch names, user input,
workflow expressions, credentials and timestamps do not belong in this
parameter.

## Metrics and alarms

The stack publishes these metrics under `IanTruongPhotography/Security`:

| Metric | Source | Alarm (route) | Meaning |
|---|---|---|---|
| `AuditDenied` | all application audit denials | none; dashboard/query only | Normal at low volume; investigate if the baseline shifts. |
| `AuditFailure` | audit records with failure outcome | `AuditFailureAlarm`, 1 in 5 minutes (record-only) | A security-sensitive operation or provider dispatch failed. |
| `LoginDenied` | denied `auth.login` records | `LoginDeniedAlarm`, 10 in 5 minutes (record-only) | Possible credential attack, CAPTCHA problem or client regression. |
| `ApiAuthorizationDenied` | API 401, 403 and 429 access logs | `ApiAuthorizationDeniedAlarm`, 25 in 5 minutes (record-only) | JWT, authorization or rate-limit failures, including denials before Lambda runs. |
| `FrontDoorDenied` | `front_door_request_denied` log records | `FrontDoorDeniedAlarm`, 10 in 5 minutes (record-only) | Requests reached the origin without a valid CloudFront origin header. |

None of these alarms send email. Email goes only to the signals listed in
[`ALARM_REGISTRY.md`](ALARM_REGISTRY.md#email-routing-policy): site down, data
at risk, root account use and budget overrun.

Alarms that notify publish to the `ian-photography-security-<stage>` topic,
which lives in the separate notification stack. Its policy accepts only the
names of alarms that are meant to email. Record-only alarms have no actions.
The application stack does not create its own topic or subscription.
`alarm_registry.json` is the source of truth for each alarm's route.

The topic has one confirmed subscription. The registry records the last
end-to-end delivery test and a 90-day test interval. A topic ARN without a
confirmed subscription is not an alert path.

Change thresholds only after watching at least two representative traffic
cycles. Record the old and new value, the evidence, who changed it, a review
date and how to roll back. Do not make a signal quieter by logging user
identifiers, payloads, paths with identifiers or secret values.

## Triage without leaking data

1. Confirm the alarm's state, time and metric, and the current release output.
2. Query aggregate audit fields for that window. Do not export raw logs to
   local files or tickets.
3. Group by `event_name`, `outcome`, `reason_code` and `release_sha`. To look at
   a single request, correlate only by its generated request or trace ID.
4. Compare the alarm time with the CI release and CloudTrail changes.
5. If the failure started with a release, use the tested rollback workflow. If
   it looks like abuse, keep the evidence and tune rate limits or WAF rules
   through IaC.
6. Record what happened, who responded, start, acknowledgment and closure
   times, where the evidence is, and any follow-up, without copying user data.

A CloudWatch Logs Insights query that uses only schema fields and does not
export the raw message:

```text
fields @timestamp, event_name, outcome, reason_code, release_sha, request_id
| filter record_type = "security_audit"
| stats count() by event_name, outcome, reason_code, release_sha
| sort count() desc
| limit 50
```

Depending on Lambda's JSON envelope, the application record may be nested in
the `message` field. If so, parse out only the fixed schema fields. Do not
select or show the full raw message in a shared screenshot or incident ticket.

## Responding to specific alarms

### Audit failure

- Find the event category and release, then check API and Lambda error and
  throttle metrics and the affected provider's status page.
- Do not retry deletions, invitations, email changes or media changes until
  their idempotency and preflight behavior are understood.
- A provider dispatch can fail after the core album change has committed.
  Check the actual state before retrying anything by hand.

### Login-denial surge

- Split the counts by `captcha_failed`, `rate_limited_ip`, `rate_limited_user`,
  `invalid_request` and `invalid_credentials`.
- Check whether it started with a release or matches a CAPTCHA or Cognito
  outage.
- Do not enumerate accounts or weaken `PreventUserExistenceErrors`. Never copy
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

The API enforces admin TOTP itself; the React route guard is not the only
check. The Cognito pre-token-generation trigger (`PreTokenGenerationFunction`)
adds an `admin_mfa` claim to every ID token issued to a member of the `Admins`
group, at sign-in and on each refresh. The value is `enabled` when TOTP is set
up, `missing` when it is not, and `unverified` when the Cognito lookup failed.
Other users pass through unchanged, with no Cognito call.

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

- The trigger does not block login. An administrator without TOTP can still
  sign in and reach `/admin/security` to enroll, but gets no admin privilege
  until using a token issued after enrollment. Refresh tokens last 7 days and
  ID and access tokens last one hour.
- Enrolling TOTP signs the session out everywhere, so the next sign-in carries
  an `enabled` token.
- The stack creates `PreTokenGenerationInvokePermission` before the pool's
  `LambdaConfig` references the trigger. `UserPool` has a `DependsOn` on it, and
  the permission's `SourceArn` is the account/Region user pool pattern instead
  of the pool ARN. Cognito therefore never invokes the trigger without
  permission.
- A spike in `admin_mfa_required` together with `admin_mfa_lookup_failed
  error_type=...` warnings from the trigger means the lookup is failing
  (`unverified`). Check Cognito throttling and the trigger's role, not the
  administrator.
- Do not detach the trigger (remove `LambdaConfig`) without reverting the
  `is_admin` MFA requirement in the same release. A missing claim removes every
  administrator's privilege.

### Private-media signed cookies

When `PRIVATE_MEDIA_DELIVERY` is `true`, the album detail, shared album, admin
media, add-images and update-image handlers authorize the album and then attach
CloudFront signed cookies. There is one `CloudFront-Policy`/`-Signature`/`-Key-Pair-Id`
triple per approved album prefix, with `Path=/private-media/albums/<segment>`.
They also return protected media URLs under `/private-media/`. The cookie policy
expires on the same TTL as a presigned URL (`MEDIA_URL_TTL_SECONDS`, default
600 seconds, clamped to 60 to 3600), so revoking a share or making an album
private takes effect within one TTL. Covers in list views, QR codes and
downloads still use presigned URLs. Edge and key setup is in
[`PRIVATE_MEDIA.md`](PRIVATE_MEDIA.md).

- A signing failure does not fail the request. That covers a missing or
  unreadable `/ian-website/<stage>/private-media-signing-key`, an SSM error or a
  bad key ID. The response falls back to presigned URLs without protected HLS
  and logs `private_media_signing_failed operation=... error_type=...` at
  WARNING. It logs neither the key nor the album.
- If those warnings continue, every viewer is on the fallback path. Check the
  SSM parameter and the function role's `ssm:GetParameter` grant. Do not paste
  the private key into an environment variable.
- 403s from `/private-media/*` with no signing warnings point at the edge: the
  behavior's trusted key group, an expired cookie the viewer did not refresh, or
  a key ID that no longer matches `PrivateMediaPublicKey`.
- To roll back, set the literal to `'false'`. Responses go back to presigned
  URLs at once, and cookies already issued expire within one TTL.

## Deploying and rolling back

Normal releases go through the CI/CD plan in [`CI_CD.md`](CI_CD.md), which
keeps live parameters and rejects protected changes. For a change set reviewed
outside that plan:

1. Run the full backend and infrastructure test suites.
2. Run `sam validate --lint` and `sam build`.
3. Create a change set without executing it, keeping the current SSM parameter
   names and the `AlbumIndexDeploymentPhase` and
   `EnforcePrivateMediaCloudFrontDeny` values.
4. Pass the tested `ReleaseSha` and the approved retention parameters.
5. Reject any replacement or removal of data, identity, API, bucket,
   distribution or retained log resources.
6. Confirm Lambda logging configuration changes in place and the retained
   `ApplicationLogGroup` does not change.

After it runs, send one synthetic audit success and one denial. Check that both
reach the central log group, the metrics move, and the alarm route is correct.
Then run the anonymous authorization and public-media smoke tests. Synthetic
events must not use a real email, album, share grant or media.

Set retention on the old per-function log groups, including dormant
authentication groups from before central logging, with
`ops/set_lambda_log_retention.py`. The first command is a dry run; review only
its aggregate counts:

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

Do not delete a dormant group because its function now logs to the central
group. Retention ages out old security metadata and keeps rollback and
incident history.

Roll back the Lambda release or configuration through a reviewed stack change
set. Do not delete the central or legacy log groups, metric history, alarm
state or incident evidence. A rollback can stop new records from reaching the
central group, so put both group names in the incident record to mark the time
boundary.

## How this fits with the account stacks

The application stack owns only application logging, its metrics and its own
alarms. CloudTrail, GuardDuty, AWS Config, Security Hub, the WAF web ACL, AWS
Backup, IAM Access Analyzer, the CloudTrail KMS key and the budget are managed
outside the application stack, so an application release does not change them.
The application stack does attach the web ACL to the media distribution
(`ImagesCloudFront` `WebACLId`).

[`SECURITY_ACCOUNT_BASELINE.md`](SECURITY_ACCOUNT_BASELINE.md) covers those
controls: deployment, evidence retention, drift and rollback.
[`ALARM_REGISTRY.md`](ALARM_REGISTRY.md) maps their signals to runbooks and
routes. Do not change account-level controls by hand during an application
deploy. Rotating provider credentials is a separate authorized operation unless
an active incident requires it.
