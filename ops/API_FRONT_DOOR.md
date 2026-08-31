# Single CloudFront API front door

The browser uses one origin: `https://iantruongphotography.com`. Static files
and `/api/*` share the frontend CloudFront distribution and its CloudFront-scope
WAF. The regional HTTP API remains the application and authentication boundary;
WAF is defense in depth.

## Current security contract

- The browser API base is `/api`.
- `/api/public/*` caches only anonymous `GET`/`HEAD` responses and varies only
  on the reviewed `cursor`, `limit`, `mode`, `seed`, `type`, and `value` query
  keys plus compression.
- `/api/*` otherwise has caching disabled and forwards only the reviewed
  methods, query strings, and API/auth/CORS headers. It forwards no cookies.
- CloudFront reaches the TLS 1.2 regional custom domain through the fixed `api`
  mapping and adds the secret `X-Origin-Verify` header. Every application route
  verifies that value before authentication, validation, or business work.
- The retained secret contains `current` and optional `previous` values so a
  rotation can overlap Lambda caching and CloudFront propagation safely. Secret
  values never belong in source, arguments, output, logs, fixtures, or release
  artifacts.
- The default execute-api endpoint is disabled. Direct custom-domain requests
  lack the CloudFront-only header and receive the fixed, no-store denial.
- The separate WAF stack remains in the CloudFront home Region. Sampling is
  disabled, sensitive fields are redacted, and every rule stays in its reviewed
  BLOCK mode. Managed rules block known-bad inputs and reputation-listed sources.
  A per-IP `/api/` rate rule limits single-source floods, and a separate constant-
  key `/api/` circuit breaker bounds distributed origin traffic. The circuit
  breaker intentionally favors bounded AWS origin spend over API availability;
  static pages remain outside both rate scopes. The Explore route has lower,
  dedicated per-IP and global limits so arbitrary filter values cannot turn
  repeated requests into unbounded DynamoDB usage.

## Validate and update

Normal `main` releases preserve the deployed front-door parameters. A front-
door change is a separate reviewed operation:

1. Run the complete repository tests and infrastructure validation.
2. Run `front_door_preflight.py` with the exact stack, account, certificate,
   secret, and WAF guards. It reads metadata only and never reads the secret
   value.
3. Run `cloudfront_frontend.py --include-api-front-door` without `--apply`.
   Supply the exact current resource guards and review the proposed distribution
   changes and current ETag.
4. Apply only the unchanged dry-run plan with the exact ETag, account, resource
   guards, and confirmation phrase. Wait for CloudFront to reach `Deployed`.
5. Verify public list/detail pagination, protected identity behavior, CORS,
   cache headers, origin verification, disabled execute-api access, and WAF
   redaction/count behavior through the canonical host.
6. Run the credential-free public-posture smoke and the scheduled edge/drift
   audit. Retain only aggregate, secret-redacted evidence.

The helper's `--help` output is the source of truth for required arguments. A
stale ETag, changed origin, mismatched certificate/secret/WAF resource, direct
endpoint re-enablement, or unexplained viewer-request association blocks apply.

## Zero-downtime origin-secret rotation

1. In a protected operator process, create a new random value and update the
   secret so `previous` is the old `current` and `current` is the new value.
2. Keep CloudFront on the old value for longer than the maximum Lambda secret
   cache TTL plus margin; keep canonical canaries running during this drain.
3. Apply the reviewed CloudFront plan so its origin header uses the new
   `current`, then wait for `Deployed` and run positive and negative canaries.
4. Keep both values for an additional propagation and rollback window. Then
   clear `previous`, wait another cache TTL, and rerun canaries.
5. Record only redacted version/timestamp and change evidence—never either
   secret value.

If rotation fails before CloudFront switches, restore the prior two-value JSON
contract. If it fails afterward, keep both values accepted while repairing the
distribution. Do not disable origin verification as a rollback shortcut.

## Rollback and review

- For a WAF false positive, return only the affected rule to COUNT; do not add a
  broad allow rule.
- Restore a reviewed prior CloudFront configuration with the current ETag for
  an origin or behavior regression.
- Re-enabling execute-api or disabling origin enforcement reopens the bypass and
  is an emergency, time-bounded, separately reviewed backend change.
- Never delete the retained certificate, custom domain, mapping, DNS record,
  secret, WAF ACL, or security logs as a rollback.

Review WAF metrics over representative traffic before promoting a rule. Record
every exclusion with an owner, reason, evidence, expiry, test, and rollback.
Treat IP addresses, paths, user agents, and request identifiers as restricted
security data.
