# Security observability operations

This runbook covers the application-level controls in `backend/template.yaml`.
It contains no account IDs, credentials, user identifiers, album identifiers,
media keys, or production log samples.

## Deployed shape

All Lambda functions write JSON application logs to the retained
`/ian-photography/application/<stage>` log group. `ApplicationLogRetentionDays`
controls its lifecycle and defaults to 30 days. Existing per-function log groups
are deliberately not deleted, so rollback does not destroy earlier evidence.

Security-sensitive handlers emit a versioned `security_audit` record through
`backend/functions/audit_helpers.py`. The schema records only:

- event/action/resource categories;
- success, denial, or failure outcome and a stable reason code;
- anonymous/user/admin/service/CI actor classification, never identity;
- request, trace, environment, and immutable release correlation;
- a small allowlist of aggregate counts and enumerated states.

The helper rejects arbitrary detail fields and never serializes bodies, email
addresses, Cognito subjects, album/media identifiers, titles, object keys,
prefixes, URLs, credentials, sessions, passwords, MFA/CAPTCHA/share tokens,
provider errors, or exception text. Schema/logging errors do not fail the user
operation.

`ReleaseSha` must be the exact tested Git revision when CI/CD deploys a release.
Use `unknown` only for an explicitly identified legacy/manual deployment. Do not
put branch names, user input, workflow expressions, credentials, or timestamps
in this parameter.

## Metrics and alarms

The stack owns privacy-safe metrics in `IanTruongPhotography/Security`:

| Metric | Source | Initial alarm | Meaning |
|---|---|---:|---|
| `AuditDenied` | all application audit denials | dashboard/query only | Normal at low volume; investigate changes in baseline. |
| `AuditFailure` | audit records with failure outcome | 1 in 5 minutes | A security-sensitive operation or provider dispatch failed. |
| `LoginDenied` | denied `auth.login` records | 10 in 5 minutes | Possible credential attack, CAPTCHA issue, or client regression. |
| `ApiAuthorizationDenied` | API 401, 403, and 429 access logs | 25 in 5 minutes | JWT/authorization/rate-limit failures, including denials before Lambda. |

All application alarms publish to the encrypted central
`ian-photography-security-<stage>` topic owned by the separate notification
stack. The application stack does not create a second topic or subscription.
One site-owner destination is confirmed; add a separately monitored backup
destination and record quarterly delivery tests. A topic ARN without a confirmed
subscription is not an operational alert path.

Tune thresholds only from at least two representative traffic cycles. Record
the old/new value, evidence, owner, review date, and rollback. Do not lower a
signal by logging user identifiers, payloads, paths with identifiers, or secret
values.

## Safe triage

1. Confirm the alarm state/time/metric and current release output.
2. Query aggregate audit fields for that window. Do not export raw logs to local
   files or tickets.
3. Group by `event_name`, `outcome`, `reason_code`, and `release_sha`; correlate
   an individual request only by its generated request/trace ID.
4. Compare the alarm time to the exact CI release and CloudTrail change set.
5. If failure began with a release, use the tested rollback workflow. If it is an
   abuse pattern, preserve evidence and tune rate/WAF controls through IaC.
6. Record disposition, responder, start/acknowledgment/closure time, evidence
   location, and any follow-up without copying user data.

Example CloudWatch Logs Insights query (fields only; no raw message export):

```text
fields @timestamp, event_name, outcome, reason_code, release_sha, request_id
| filter record_type = "security_audit"
| stats count() by event_name, outcome, reason_code, release_sha
| sort count() desc
| limit 50
```

Depending on Lambda's JSON envelope, the application record can be inside the
`message` field. Parse only the fixed schema fields if required; never select or
display the full raw message in shared screenshots or incident tickets.

## Alert-specific response

### Audit failure

- Identify the event category and release, then check API/Lambda error and
  throttle metrics plus the affected provider's status.
- Do not retry deletions, invitations, email changes, or media mutations until
  their idempotency/preflight behavior is understood.
- Provider dispatch failures can be auxiliary while the core album mutation is
  already committed. Verify state before any manual retry.

### Login-denial surge

- Separate `captcha_failed`, `rate_limited_ip`, `rate_limited_user`,
  `invalid_request`, and `invalid_credentials` counts.
- Check whether the surge starts at one release or coincides with a CAPTCHA or
  Cognito outage.
- Do not enumerate accounts or weaken `PreventUserExistenceErrors`. Never copy
  credentials/tokens from a browser or add them to logging.

### API authorization-denial surge

- Group API access logs by status and route template, not concrete path/query.
- 401 suggests missing/invalid/expired authentication; 403 suggests policy;
  429 suggests rate limiting. Compare with `AuditDenied` to distinguish API
  Gateway denials from application decisions.
- Preserve CORS, JWT issuer/audience, private-media deny, and throttling while
  investigating. Roll back a bad release instead of broadening access.

## Deployment and rollback checks

Before execution:

1. run the complete backend and infrastructure test suites;
2. run `sam validate --lint` and `sam build`;
3. create a non-executing change set using the current secret ARNs,
   `AlbumIndexDeploymentPhase`, and `EnforcePrivateMediaCloudFrontDeny` values;
4. pass the exact tested `ReleaseSha` and approved retention parameters;
5. reject replacements/removals of data, identity, API, bucket, distribution,
   or retained log resources;
6. confirm `ApplicationLogGroup` is an additive resource and Lambda logging
   configuration changes in place.

After execution, create one synthetic safe audit success and denial, verify both
reach the centralized group, verify the metrics advance, and confirm the alarm
destination. Then run the existing anonymous authorization/public-media smoke
tests. Synthetic events must use no real email, album, share grant, or media.

Reconcile retained legacy per-function groups, including dormant authentication
groups that predate centralized logging, through the guarded stack inventory.
Run the first command as a dry run and review only its aggregate counts:

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

Do not delete a dormant group merely because its function now uses the central
group. Retention limits old security metadata while preserving the rollback and
incident boundary.

Rollback the Lambda release/configuration through the reviewed stack change set.
Do not delete the centralized or legacy log groups, metric history, alarm state,
or incident evidence. A rollback may stop new records from reaching the central
group; retain both group names in the incident record so the time boundary is
clear.

## Account-level integration

This application stack owns application logging, privacy-safe metrics, and its
application alarms only. The account-level CloudTrail, GuardDuty, AWS Config,
Security Hub, Inspector, WAF, AWS Backup, IAM Access Analyzer, KMS, and budget
controls are active in separate protected stacks so an application release
cannot weaken or replace them.

[`SECURITY_ACCOUNT_BASELINE.md`](SECURITY_ACCOUNT_BASELINE.md) is the source of
truth for those controls, deployment boundaries, evidence retention, drift,
and rollback. [`ALARM_REGISTRY.md`](ALARM_REGISTRY.md) maps their signals to
response procedures and notification requirements. Do not mutate account-level
controls manually during an application deployment. Provider credential
rotation remains a separate authorized operation unless an active incident
requires it.
