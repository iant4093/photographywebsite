# Upload performance and retry behavior

Measured 2026-09-17 against `72324da`, using 220 synthetic photos. This change
uses the existing API route, Lambdas, bucket, queues, and tables. It adds no
infrastructure, acceleration service, resource capacity, or dependency.

## Changes

- Coalesce permissions for ready files (up to eight objects) into one protected
  `POST /upload-url`. Original and thumbnail still go directly to S3. Single-file
  requests remain compatible with existing clients and thumbnail editing.
- Keep a rolling queue: one large file cannot hold up all subsequent files.
  Start with two files, probe four, and retain four only after a measured 15%
  aggregate-throughput gain. Known slow/save-data connections stay at two.
  Image/video decoding is separately limited to two files.
- Request permissions just before transfer and refresh the Cognito session for
  each authorization batch and the final save. Retry an S3 403 once with new
  permissions; never reuse an expired URL indefinitely.
- Retain each successful original and thumbnail for retries while the page
  stays open with the same selection. Wait for outstanding transfers before
  enabling retry. Resume does not depend on filenames, persist credentials, or
  falsely count previously uploaded bytes as current transfer speed.
- Keep the new album ID and original save payload across retries. The backend
  recognizes the same request and creator after a lost HTTP response without
  repeating publication, processing dispatch, or client email. Changed requests
  and other creators still conflict. Partial publication retains the existing
  privacy ordering and conditional writes.
- Dispatch before/after comparison jobs in at most eight parallel groups using
  shared low-level AWS clients, preserving conditional queue-marker updates.
  The Lambda waits for all work before returning. The number of service calls
  is unchanged. EXIF, Drive backup, preview jobs, and visibility tags retain
  their existing behavior.

Resume is in-memory, for this page and selection. Reloading/closing the page or
choosing different files starts a new upload. A save retry keeps the original
album details; edit the album after the retry succeeds if details need changing.

## Measured results

`benchmarks/upload.bench.js` runs the actual new scheduling code and the old
two-worker algorithm against a loopback HTTP service. Both send identical
synthetic bytes. The server applies request latency and, for the slow profiles,
one shared 1 MiB/s read budget across all connections. These are measured
controlled tests, not measurements of a customer's connection or AWS production.

| Profile (220 files) | Before | After | Authorization calls, before → after |
| --- | ---: | ---: | ---: |
| Request latency bound | 9.480 s | 4.691 s | 440 → 58 |
| Shared slow uplink, known slow connection | 10.149 s | 9.991 s | 440 → 110 |
| Shared slow uplink, no browser connection hint | 10.061 s | 10.045 s | 440 → 109 |
| Mixed sizes, including 1 MiB files | 7.069 s | 3.741 s | 440 → 113 |

An earlier repeat measured 9.083 → 4.590 s for the latency case and
10.168 → 10.210 s for the slow uplink. Thus the latency improvement is about
50%; the saturated-uplink result is effectively unchanged within timing noise.
Authorization coalescing varies with when preparation/transfers finish. This
cannot raise the user's internet upload bandwidth.

`benchmarks/finalization.py` executes the old and new comparison-job dispatch
functions with a controlled 20 ms delay per provider operation. Three-run
medians were **6.385 → 0.877 seconds (86.3% faster)**. Both performed exactly
22 SQS batches and 220 conditional DynamoDB updates. The new implementation
never exceeded eight outstanding calls. This measures that finalization stage,
not the entire album save, which also includes EXIF, tagging, and metadata.

Run manually from the repository root:

```bash
npm exec --yes --package=node@24 -- node node_modules/vitest/vitest.mjs run --config benchmarks/vitest.config.js
.venv-ci/bin/python benchmarks/finalization.py
```

Both benchmarks are offline from AWS and use only synthetic data. Timing checks
allow 5% local scheduler noise for HTTP transfers and require a substantial
improvement for comparison dispatch. They are separate from normal unit tests.

## Validation

- 1,149 frontend tests; line coverage 94.34%, branch coverage 84.39%.
- 644 backend tests; line coverage 89.82%, branch coverage 81.77%.
- 422 ops tests (three existing skips); line coverage 86.55%, branches 80.76%.
- Preview-worker coverage, RAW decoder checks, ESLint, production build,
  CloudFormation lint, all 47 SAM packages, and artifact budgets pass.
- New cases cover bounded 220-file work, partial-file recovery, expired URLs,
  cancellation, fresh authorization, unchanged save retries, private/public
  metadata boundaries, and server-selected pending-tagged keys. Append retries return canonical saved
  records, so the manager restores thumbnails without another request.

Deploy through the normal main-branch release workflow so the compatible
backend update precedes the frontend and the public security/media smoke gates
run before the release is considered complete.
