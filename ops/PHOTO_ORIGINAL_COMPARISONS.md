# Photo-original comparisons

This feature adds a Before/After toggle immediately before Share in the photo
lightbox. It starts on the edited photo and shows the full original framing when
toggled. The button emphasizes the displayed side without adding a status row
or changing the toolbar size. Loading and failure indicators stay within the
button; descriptive status is available to assistive technology and in its
tooltip. Navigation resets to the edit. Video lightboxes and video album files
are excluded.

While a requested original is still pending, viewers with a status-refresh
callback check again automatically while visible, backing off for longer waits.
Checks stop on navigation, cancellation, or completion. A verified share-code
viewer retains its existing access boundary: it needs a fresh security check to
reread that protected album, so a pending status never triggers its media-error
or re-verification flow automatically.

Forced album refreshes bypass the browser cache. Public photo details containing
pending or failed originals are served with `private, no-store` so processing
updates are visible on the next check; completed details retain normal caching.

Ready previews load only when Before is first requested. The browser chooses a
WebP variant using the image's fitted display width and its pixel density. A
ready toggle does not fetch album metadata or contact Google Drive. Preview
responses use `Cache-Control: private, max-age=1800`; the signed URLs also expire
after 30 minutes. The current original remains mounted after its first successful
load so repeated toggles can reuse it immediately. Navigation or a changed
preview source releases that retained image. Other originals are not prefetched.

Background album refreshes can preserve an existing preview URL only when the
fresh authorized response confirms the same album, photo, dimensions, variants,
and storage assets. Reuse requires at least one minute of remaining validity,
keeps the earlier expiry, and never extends access. An actual image-load error
forces fresh URLs. Discovery views apply one album response to every matching
photo already in their deck, reducing repeated status lookups while preserving
the current selection and ignoring results for replaced source data.

## Implementation and validation status

Pre-deployment validation was performed locally. The counts below describe the
read-only audit, not live backfill progress. Verify production deployment and
current processing with the rollout checks below.
The earlier read-only audit found 3,112 verified original JPG matches among
3,113 gallery photos: all 3,019 public photos, all 84 unlisted photos, and 9 of
10 private photos. The remaining private test image lacks identifying camera
metadata. The audit excluded 34 videos.

The new matcher reproduced those results against the saved private audit
inventory of 32,861 archive JPGs. That replay verifies metadata matching; it is
not a visual comparison or a fresh reread of every photo. An additional live
S3 header read confirmed that the actual EXIF/XMP extractor recovers a camera
filename from a randomized website filename. One verified Drive JPG was read
with the production reader and rendered locally into all four preview sizes;
orientation, framing, color, checksum, and metadata removal were checked. These
checks made no S3, DynamoDB, or Drive changes. Audit rows, camera filenames,
Drive identifiers, and downloaded source images are not committed to Git.

## Matching and archive boundary

`original_match.py` requires a filename candidate, the same capture timestamp,
and the same camera model. Filename alone never establishes a match because
camera numbering rolls over. Filename candidates come from the preserved
upload basename and Lightroom's `crs:RawFileName` or
`xmpMM:PreservedFileName`. Camera extensions and case are normalized, along with
the recognized `YYYYMMDD-` / `YYYYMMDD_` export prefix. It does not strip arbitrary
suffixes or choose visually similar files.

Capture timestamps are compared as camera wall time to the second, without an
assumed timezone conversion. Subseconds must agree when both sides supply them.
The audited Drive timestamps contained no fractional seconds. A unique complete
match is accepted. Multiple matching copies are accepted only when their MD5
checksums are identical; conflicting candidates remain ambiguous.

The configured raw archive is the `raw_photo_backup_folder_id` in the existing
encrypted Google credential parameter. Its audited structure generally follows
year → category/shoot → JPEG/RAW, with older folder variations. Indexing follows
actual parent IDs instead of folder-name conventions. Only JPG descendants of
that exact root become candidates. The separate edited Website Uploads backup,
outside folders, RAW camera files, and Drive shortcuts are excluded. Incomplete
scans, ancestry cycles, repeated pages, or invalid roots cannot publish a partial
index.

`original_drive.py` uses only `service_account` from the SSM payload. The account
may retain its existing full Drive permissions, but this reader requests only
`https://www.googleapis.com/auth/drive.readonly`. It does not use the OAuth writer
credential in the same payload. Every Drive resource request is GET against a
fixed Google API URL, with redirects disabled. Google authorization token
refresh is separate from Drive resource access. No implementation path uploads,
renames, edits, moves, trashes, deletes, or changes permissions on the archive.

## Processing and delivery

1. `OriginalIndexRefreshFunction` runs every 15 minutes with concurrency one.
   It uses a complete visible-file inventory for the initial scan and at least
   every 24 hours, then uses Drive change cursors between full scans. A cursor
   taken before a full scan is replayed afterward so changes during the scan
   are included. An expired cursor triggers a rebuild; a provider outage leaves
   the previous published index intact.
2. The index snapshot is compressed and stored under private
   `index/<generation>.json.gz`. The comparison table's system row holds the
   current snapshot pointer, root, cursor, and generation. Archive names and
   matching evidence remain server-side.
3. The coordinator scans active photo albums and comparison records to enqueue
   missing work. Upload-completion handlers also enqueue committed photos.
   Generating an upload URL alone does not enqueue a comparison. The scheduled
   reconciliation repairs missed dispatches and retries photos whose Drive
   backup arrived after their website upload.
4. `OriginalComparisonWorkerFunction` processes one SQS message at a time, with
   at most two concurrent workers. It rechecks album membership, reads a bounded
   edited-photo header, matches evidence, verifies live Drive ancestry and
   download permission, and checks source size and checksum. Source reads are
   limited to 100 MiB and images to 100 million pixels. JPEG and Canon JPGs
   identified by Pillow as MPO are accepted; only their primary image is used.
5. The worker applies EXIF orientation, converts embedded color profiles to
   sRGB, preserves the complete frame, and creates WebPs at widths 640, 960,
   1440, and 1920 without upscaling. EXIF, GPS, XMP, and ICC metadata are removed
   from the served derivatives. Source camera JPG bytes are not stored in the
   website bucket.
6. Previews are written conditionally under
   `before/<album>/<media>/<source-checksum>/w<width>.webp` in the separate private
   bucket. Existing derivatives are not overwritten. The ready record is
   published only while the worker owns its lease and the image still belongs
   to the active photo album. The edited S3 object must also be unchanged.
7. Existing album authorization controls access to comparison DTOs. APIs may
   read comparison records and sign only the `before/` prefix; they cannot read
   the Drive credentials or private index. URLs expire after 1,800 seconds.
   A ready DTO contains only status, dimensions, responsive URLs, and expiry.
   Drive IDs, camera filenames, and evidence are not exposed.

Public and protected photos both use private S3 derivatives and short-lived
signed URLs. Changing album access stops issuance through the protected API
boundary; an already issued URL can remain usable until its expiry. There is
no public bucket policy or CloudFront public alias for originals.

| Internal state | API/lightbox behavior | Subsequent work |
| --- | --- | --- |
| `pending` or no record | Checking/preparing original; edited photo remains visible | Queued processing or later reconciliation |
| `ready` | Before/After toggle loads the original preview | Reuses immutable output when the verified source is unchanged |
| `unavailable` | “Unable to locate original” | Retried on later index generations |
| `ambiguous` | “Unable to locate original” | Conflicting evidence is retained privately; no guess is served |
| `failed` | Original could not be loaded; retry is available | Provider/processing failures remain retryable |

Accepted initial jobs receive a 24-hour queue marker so a large backfill is not
dispatched again every 15 minutes. Live worker leases also suppress duplicate
reconciliation work. SQS visibility is 30 minutes, with five delivery attempts
before the DLQ. Worker failures are returned as partial batch failures. A missing
original is a matching result, not a provider-failure exception.

## Deployment and activation

Use the normal reviewed [CI/CD release](CI_CD.md) for application artifacts and
the SAM stack. Review the new retained table/bucket, bounded workers, queue,
alarms, and narrow IAM changes in the release intent. Physical resource names
remain within the release role's existing `GoldenHour-`, `goldenhour-`, and
`ian-photography-` namespaces.

The `OriginalComparisonsEnabled` stack parameter defaults to `true`. Effective
activation also requires a nonempty `GoogleOAuthSecretArn`. When enabled, the
scheduled indexer and SQS worker activate, upload completion dispatches jobs,
and APIs include comparison state. Existing photos are backfilled automatically
by reconciliation; no separate raw-file upload or destructive migration is
required. The initial backfill is asynchronous and may span multiple schedules.
The release's exact parameter-addition contract explicitly introduces this flag
as `true` on its first deployment; it does not override an existing value.

For staged activation or rollback, change `OriginalComparisonsEnabled` through
a reviewed stack-parameter change. `false` disables the schedule and event
mapping and removes the feature's API/upload environment wiring. It preserves
the comparison table, bucket, existing previews, and queue contents. Normal
releases use previous values for existing stack parameters, so editing a
template default alone does not toggle an already deployed feature. A staged
resource-only deployment should keep the flag false until delivery is ready.

### Separate CloudFront CSP update

The new private bucket's exact global and regional S3 origins must be added to
`img-src` and `connect-src`. Video, script, and other CSP sources stay unchanged.
The normal frontend upload/invalidation role cannot modify CloudFront security
policies; deploying JavaScript alone does not update these headers.

Run the existing guarded [front-door workflow](API_FRONT_DOOR.md#validate-and-update)
**after `OriginalPreviewBucket` exists in the application stack**. The helper
discovers the bucket by logical ID. Use an authorized operator identity for this
separate control-plane operation. First run `front_door_preflight.py` with the
current account, certificate, origin-parameter name, and WAF metadata guards.
Never place secret values in commands, reports, or this runbook.

Populate the task-specific shell variables below from the reviewed current
metadata, including the current frontend origin and distribution ETag. The
examples preserve the existing `www`, print-store, API, and social-router
features. Confirm the live aliases and feature set before running them. If a
named AWS profile is needed, supply the same `--profile` on both invocations.

```bash
originals_edge_args=(
  --stack-name ian-website
  --region us-west-2
  --include-www
  --include-fotomoto-print
  --include-api-front-door
  --api-certificate-arn "$originals_api_certificate_arn"
  --origin-parameter-name "$originals_origin_parameter_name"
  --web-acl-arn "$originals_web_acl_arn"
  --expected-etag "$originals_distribution_etag"
  --expected-account-id "$originals_account_id"
  --expected-frontend-origin-id "$originals_frontend_origin_id"
  --expected-frontend-origin-domain "$originals_frontend_origin_domain"
  --expected-api-origin-domain "$originals_api_origin_domain"
  --expected-api-certificate-arn "$originals_api_certificate_arn"
  --expected-origin-parameter-name "$originals_origin_parameter_name"
  --expected-web-acl-arn "$originals_web_acl_arn"
  --confirm-front-door ADD-SINGLE-API-FRONT-DOOR
)

.venv-ci/bin/python ops/cloudfront_frontend.py "${originals_edge_args[@]}"
```

Review the dry-run's current account, distribution ETag, and proposed policy
actions. After approval of that concrete plan, apply with the same reviewed
arguments and exact current guards:

```bash
.venv-ci/bin/python ops/cloudfront_frontend.py "${originals_edge_args[@]}" --apply
aws cloudfront wait distribution-deployed --id "$originals_distribution_id"
```

If the ETag or any resource guard changed, obtain a fresh dry-run and review it.
Do not shorten this to a bare or partial `--apply`: the existing helper rebuilds
aliases and viewer-request associations according to its feature flags. The
full guarded workflow preserves the current front-door and social behaviors.
This runbook records the required operation; it does not claim it was executed.

## Validation after deployment

- Run the photo-lightbox tests, backend `test_original_*.py` suites, build
  allowlist tests, and `ops/tests/test_original_comparison_infrastructure.py`.
  Run the normal complete release gates as well.
- Confirm the private bucket has all four public-access blocks, encryption,
  TLS-only access, and no public read policy. Anonymous requests to a known
  preview must fail; an authorized album response should issue a working URL
  with the documented expiry.
- Check aggregate index freshness, JPG count, ready/unavailable/failed counts,
  queue age, and DLQ depth. Compare against a fresh gallery inventory; the audit
  counts above are a baseline, not a permanent expected gallery total. Do not
  export per-photo records or Drive metadata into logs or notifications.
- Open an existing matched public photo and a cropped photo. Confirm the edit
  is the default, Before shows the complete original frame, Share follows the
  new control, and navigating/reopening resets to the edit. Check both portrait
  orientation and a Canon MPO-backed JPG. Preserve the normal edited-photo
  download and print behavior.
- Confirm the unmatched test image reports “Unable to locate original.” An
  unavailable source must not choose another image with the same camera number.
- Upload a new photo through the normal flow. Verify its original filename is
  retained, matching starts after completion, and a later-arriving Drive backup
  is picked up by reconciliation. Check a valid duplicate-name/different-time
  photo when one is available; compare evidence rather than inventing a fixture
  inside the archive.
- Verify private/unlisted access through the same existing owner/admin/share
  rules. Unauthorized API requests must not issue an original URL. Test expiry
  or refresh of a comparison URL, including when navigating after a long-open
  lightbox session.
- Confirm video lightboxes expose no Before/After action and enqueue no original
  work. Check CSP, canonical and `www` redirects, print-store entry, public social
  metadata, authentication, and direct-origin denial after the edge update.

## Failure recovery and retention

`OriginalComparisonFailureAlarm` reports a nonempty comparison DLQ.
`OriginalIndexRefreshErrorsAlarm` reports indexer errors. Both use the existing
website security-notification route. Investigate aggregate errors, durations,
throttles, queue age, and index freshness before changing configuration.

For indexing failure, check access to the exact SSM parameter, optional KMS
decrypt permission, service-account read access to the configured root, Drive
quota, and pagination completeness. An expired cursor rebuilds automatically.
Provider failures must preserve the prior index; do not delete that pointer to
force a rebuild during an outage.

For worker failures, distinguish source download/decode problems from matching
results. Repair the identified cause, then use scheduled reconciliation or a
reviewed, bounded retry of proven idempotent jobs. Do not purge or bulk-redrive
the queue. A missing test source does not require editing the archive. If a
problem is systematic, disable the feature through its reviewed parameter path
while keeping the edited gallery available.

The table and bucket are retained and the table has deletion protection and
point-in-time recovery. Old private index snapshots expire after seven days;
before-preview objects have no automatic expiration or deletion path. Removing
a gallery photo stops its authorization/membership path but does not delete its
retained private derivative. Source replacements use a new checksum namespace.
Any future derivative cleanup must be a separately reviewed website-storage
operation. Recovery and cleanup never modify the Drive raw archive.
