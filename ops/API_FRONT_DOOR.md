# Single CloudFront API front door

This design gives the browser one origin: `https://iantruongphotography.com`. Static files and `/api/*` share the frontend CloudFront distribution and its CloudFront-scope WAF. The regional HTTP API remains the application/auth boundary; WAF is defense in depth.

No script in this repository deploys this architecture by default. `cloudfront_frontend.py` is dry-run-first, and the SAM switches that change reachability or enforcement default to `false`.

## Security contract

- Browser API base: `/api`.
- CloudFront public cache behavior: `/api/public/*`; GET/HEAD cache only, query keys `cursor`, `limit`, and `type`, no cookies, no `Authorization`, Brotli/Gzip cache variants, 60-second default and 300-second maximum edge TTL.
- CloudFront non-public behavior: `/api/*`; caching disabled, all required methods, all query strings, no cookies, and an allowlist of API/CORS/auth headers.
- Regional origin: `origin-api.iantruongphotography.com`, API mapping key `api`, TLS 1.2, regional ACM certificate validated through the exact Route53 public zone.
- Origin verification: CloudFront adds `X-Origin-Verify`. Every one of the 21 Lambda HTTP handlers (23 routes) checks it before auth, validation, database, provider, or other business work.
- Secret contract: a retained Secrets Manager JSON document with `current` and optional `previous` strings. Lambda accepts either value during rotation and caches only in memory for a bounded TTL. No value belongs in source, a shell argument, output, log, test fixture, or deployment artifact.
- Final bypass closure: `FrontDoorEnforcementEnabled=true` and `DisableExecuteApiEndpoint=true`. The custom domain remains reachable as DNS, but direct requests lack the CloudFront-only header and receive a fixed no-store 403. The default execute-api hostname is disabled.
- WAF: the separate `waf_front_door_template.yaml` stack must be deployed in `us-east-1`. Common, known-bad-input, IP reputation, and per-IP rate rules all begin in COUNT. Request sampling is disabled; authorization, cookie, origin-verification, and query fields are redacted; only COUNT/BLOCK records are retained.

## Staged deployment order

Use protected environments, non-executing change sets, exact existing parameter values, drift checks, and the repository release guard. Never deploy from an unreviewed local template.

1. Validate source:

   ```sh
   ./ops/validate_infrastructure.sh --build
   python3 -m unittest discover -s backend/tests -p 'test_*.py' -v
   ```

2. Plan the backend with defaults retained:

   - `ProvisionApiFrontDoor=false`
   - `FrontDoorEnforcementEnabled=false`
   - `DisableExecuteApiEndpoint=false`

   This can create the retained generated secret and ship the dormant verifier without changing request reachability.

3. Plan/deploy the WAF stack in `us-east-1`. Confirm every rule action/override is COUNT, the log group is retained, filters/redaction are present, and any alarm topic/key policy is already correct. Do not associate it yet.

4. Plan the backend custom domain with `ProvisionApiFrontDoor=true` and the exact Route53 hosted-zone ID. Keep enforcement and endpoint disabling false. Certificate DNS validation can take time; do not execute unrelated application changes while waiting.

5. Confirm the regional certificate is `ISSUED`, the API mapping key is `api`, and the Route53 alias resolves. Direct custom-domain calls still work during this compatibility stage.

6. Run a CloudFront dry run with `--include-api-front-door`, the exact certificate/secret/WAF ARNs, and no `--apply`. It validates ownership, regionality, domain/certificate binding, count-only WAF state, and existing frontend origin shape without reading the secret value.

7. Review the dry-run actions and current ETag. Apply only with all guards:

   ```text
   --apply
   --expected-etag <exact-current-etag>
   --expected-account-id <exact-account>
   --expected-frontend-origin-id <exact-current-id>
   --expected-frontend-origin-domain <exact-current-domain>
   --expected-api-origin-domain origin-api.iantruongphotography.com
   --expected-api-certificate-arn <exact-regional-cert-arn>
   --expected-origin-secret-arn <exact-secret-arn>
   --expected-web-acl-arn <exact-global-web-acl-arn>
   --confirm-front-door ADD-SINGLE-API-FRONT-DOOR
   ```

   The tool reads only `current` during an approved apply and never prints it. Wait for CloudFront `Deployed` before testing.

8. Build the frontend with `VITE_API_BASE_URL=/api`. Test public list/detail pagination, login/new-password/MFA, contact, owner/admin lists, photo/video upload, thumbnail updates, downloads, ZIP polling, sharing, and CORS/preflight through the canonical host. Confirm mutation/auth responses are `no-store` and public cache keys vary only on the documented query allowlist and compression.

9. Run `front_door_preflight.py`. It must report the WAF, API behaviors, mapping, and custom header present while reporting `originSecretValueRead: false`.

10. Enable `FrontDoorEnforcementEnabled=true` and `DisableExecuteApiEndpoint=true` together in a separately reviewed backend change set. The template rule rejects enforcement without both the provisioned domain and disabled default endpoint.

11. Repeat all canaries. Required negative checks:

    - canonical `/api/public/albums` succeeds;
    - canonical protected/admin routes retain their normal identity behavior;
    - direct `execute-api` request cannot invoke a route;
    - direct API custom-domain request without the origin header receives the fixed 403;
    - a random/empty origin header receives the same fixed 403;
    - hostile browser Origin receives no readable CORS grant;
    - WAF COUNT metrics/logs contain no authorization, cookie, query, secret, body, or sampled-request payload.

## Zero-downtime origin-secret rotation

Rotation is an explicit security operation, separate from provider credential rotation.

1. Generate a new random value in a protected operator process. Update the secret JSON so `previous` is the old `current` and `current` is the new value. Never display either.
2. Keep CloudFront sending the old value for longer than the maximum configured Lambda cache TTL plus operational margin. Warm processes then refresh to the two-value contract; an idle process will refresh before comparison because its cache has expired. Keep canaries running through the canonical host during this drain window.
3. Run a guarded CloudFront apply. It reads the new `current` into the custom origin header and never prints it.
4. Wait for CloudFront `Deployed`, run positive/negative canaries, and keep both values accepted for an additional propagation and rollback window.
5. Update the secret so `previous` is empty without changing `current`, wait another cache TTL before considering the old value retired everywhere, and re-run canaries.
6. Preserve only redacted change evidence (ARN, version IDs/timestamps, change-set/distribution IDs), never values.

If rotation fails before CloudFront switches, restore the prior JSON contract. If it fails after CloudFront switches, keep both values accepted while investigating. Do not disable verification as a convenience rollback.

## Availability rollback

- WAF false positive: return the individual rule to COUNT. Never add a broad allow rule.
- CloudFront behavior/origin regression before enforcement: restore the reviewed prior distribution config using its current ETag and keep the direct endpoint available temporarily.
- Regression after final enforcement: first repair or roll back the CloudFront behavior while the verifier accepts current/previous. Re-enabling the execute-api endpoint or disabling enforcement is an emergency, reviewed change-set action and reopens the bypass; time-bound it, alert on it, and close it immediately after recovery.
- Never delete the retained certificate, custom domain, mapping, DNS record, secret, WAF ACL, or security log group as rollback. Removal is a separate decommission project with dependency and evidence review.

## Operational review

- Review WAF COUNT metrics through at least two representative normal traffic cycles before changing any single rule to BLOCK.
- Record every exclusion with owner, reason, evidence, expiry, test, and per-rule rollback.
- Alert on origin-verification denials, WAF count/block surges, direct-endpoint re-enablement, secret reads outside deployment/runtime roles, WAF/logging changes, and CloudFront distribution drift.
- Treat IP addresses, URI paths, user agents, and request identifiers as personal/security data. Retain only for the approved period and restrict access.
