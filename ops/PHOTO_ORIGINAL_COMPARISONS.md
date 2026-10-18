# Photo-original comparisons

The photo lightbox has a Before/After toggle placed before Share. It starts on
the edited photo; toggling it shows a preview of the matched camera JPG with its
full framing. The button marks the side that is showing without adding a
visible status row. Loading and failure indicators stay inside the button. The
longer status text is in the button's title, an error tooltip, and a
screen-reader-only live region. Moving to another photo resets the view to the
edit. Only photo albums get the toggle; video albums do not, and the admin
lightbox shows its own controls instead.

## How a Before request works

Album, shared-album and Explore responses carry only an `unresolved`
comparison hint. Edited-photo responses never contain original URLs. The first
Before request resolves one photo through
`POST /albums/{albumId}/original-comparison` or
`POST /shared/{shareCode}/original-comparison`. The endpoint reruns the album's
owner/admin/public/share authorization (a share code is rechecked against the
current album record), is rate limited per IP and album, and responds with
`Cache-Control: no-store`. The API never contacts Google Drive.

If the original is still pending, the lightbox checks again only while the page
is visible: every 20 seconds for the first three checks, then once a minute,
for up to 15 minutes. Checks stop on navigation, cancel, or completion.

The browser picks a WebP variant from the image's fitted display width and the
screen's pixel density. Preview objects are stored with
`Cache-Control: private, max-age=1800`, and the signed URLs expire after
30 minutes. After the current original loads once, it stays mounted so toggling
back and forth needs no new request. Navigating or a changed preview source
releases it. Other originals are not prefetched.

## How a photo gets matched to its original

`original_match.py` requires three things to agree: a filename candidate, the
same capture timestamp, and the same camera model. A filename alone never
counts as a match, because camera numbering rolls over. Filename candidates
come from the preserved upload basename and from Lightroom's `crs:RawFileName`
or `xmpMM:PreservedFileName`. Extensions and case are normalized, and a
`YYYYMMDD-` / `YYYYMMDD_` export prefix with a valid date is also stripped. The
matcher does not strip other suffixes or pick files that only look similar.

Capture timestamps are compared as camera wall time to the second, with no
timezone conversion. If both sides have subseconds, they must agree. A single
complete match is accepted. Several matching copies are accepted only when
their MD5 checksums are identical. Otherwise the result is `ambiguous`.

### Which part of Drive it reads

The archive root is `raw_photo_backup_folder_id` in the existing encrypted
Google credential parameter. Indexing follows actual parent IDs, not
folder-name conventions. Only JPG descendants of that root become candidates.
Files outside the root, non-JPEG files such as RAW files, trashed items and
Drive shortcuts are excluded. An incomplete search, an ancestry cycle, a
repeated page token or an invalid root stops the refresh, so a partial index is
never published.

`original_drive.py` uses only `service_account` from the SSM payload. The
account may hold broader Drive permissions, but this reader requests only the
`https://www.googleapis.com/auth/drive.readonly` scope. It does not use the
OAuth writer credential in the same payload. Every Drive resource request is a
GET to a fixed Google API URL, with redirects disabled. Google token refresh is
separate from Drive resource access. The code has no upload, rename, edit,
move, trash, delete or permission-change operation.

## Processing and delivery

1. `OriginalIndexRefreshFunction` runs every 15 minutes with reserved
   concurrency of one. It takes a full inventory on the first scan, when the
   root changes, and at least every 24 hours, and applies Drive change cursors
   in between. A cursor taken before a full scan is replayed afterward, so
   changes made during the scan are not missed. An expired cursor triggers a
   full rebuild. Any other provider failure leaves the last published index in
   place.
2. The index snapshot is gzip-compressed and stored privately under
   `index/<random-id>.json.gz` in the preview bucket. An unchanged snapshot is
   rewritten at least once a day, ahead of the seven-day expiry. The comparison
   table's system row holds the current snapshot pointer, root, cursor,
   generation and JPG count. Archive names and matching evidence stay on the
   server.
3. After each refresh, the same function scans active photo albums and
   comparison records and queues photos that need work. Upload-completion
   handlers also queue committed photos in photo albums. Generating an upload
   URL does not queue anything. The scheduled reconciliation fills in missed
   dispatches and retries photos whose Drive backup arrived after their website
   upload.
4. `OriginalComparisonWorkerFunction` takes one SQS message per invocation,
   with at most two invocations running. It checks album membership again,
   reads the first 1 MiB of the edited photo, extracts matching evidence,
   checks live Drive ancestry and download permission, and verifies source size
   and MD5 checksum. Source downloads are capped at 100 MiB and images at
   100 million pixels. It accepts JPEGs, plus Canon JPGs that Pillow identifies
   as MPO, and uses only their primary image.
5. The worker applies EXIF orientation, converts embedded color profiles to
   sRGB, keeps the whole frame, and creates WebPs at widths 640, 960, 1440 and
   1920 without upscaling. EXIF, XMP and ICC metadata (including GPS) are
   stripped from the served files. The source JPG bytes are not stored in the
   website bucket.
6. Previews are written under
   `before/<album>/<media>/<source-checksum>/w<width>.webp` in a separate
   private bucket with `If-None-Match: *`, so existing files are never
   overwritten. The ready record is published only while the worker holds its
   lease, the image still belongs to the active photo album, and the edited S3
   object's ETag is unchanged.
7. Comparison DTOs are served by the download-URL function through the
   `original-comparison` endpoints above, after the existing album
   authorization. The API, upload and deletion functions that touch this
   feature are granted access only to the comparison table and the `before/`
   prefix of the preview bucket. They have no access to the Drive credentials
   or the private index. URLs expire after 1,800 seconds. A ready
   DTO holds only status, dimensions, responsive URLs and expiry. Drive IDs,
   camera filenames and evidence are never returned.

Public and protected photos both use private S3 objects and short-lived signed
URLs. Changing album access stops new URLs right away, but a URL that was
already issued keeps working until it expires. The preview bucket has no public
bucket policy and no CloudFront distribution in front of it.

| Internal state | API/lightbox behavior | Subsequent work |
| --- | --- | --- |
| `pending` or no record | “Preparing original…”; edited photo remains visible | Queued processing or later reconciliation |
| `ready` | Before/After toggle loads the original preview | Reuses existing output when the source checksum, file ID and edited-photo ETag are unchanged |
| `unavailable` | “Unable to locate original” | Rechecked daily, on a new index generation, or when the photo record changes |
| `ambiguous` | “Unable to locate original” | Same recheck schedule as `unavailable`; evidence is stored privately and no guess is served |
| `failed` | “Original could not be loaded.”; retry is available | Retried after a cooldown that starts at 15 minutes and doubles up to 24 hours |

Dispatched jobs get a 24-hour queue marker so a large backfill is not
dispatched again every 15 minutes. Active worker leases also keep
reconciliation from queueing the same photo twice. SQS visibility is
30 minutes, with five receives before the dead-letter queue. Worker failures
are returned as partial batch failures. A missing original is a matching
result, not a provider failure.

## Deployment and activation

Ship application artifacts and the SAM stack through the normal
[CI/CD release](CI_CD.md). In the release intent, review the retained table and
bucket, the capped workers, the queue, the alarms and the IAM changes.
Physical resource names use the release role's existing `GoldenHour-`,
`goldenhour-` and `ian-photography-` prefixes.

The `OriginalComparisonsEnabled` stack parameter defaults to `true`. The
feature is active only when it is `true` and `GoogleOAuthSecretArn` is
nonempty. When active, the scheduled indexer and SQS worker run, upload
completion dispatches jobs, and APIs include comparison state. Existing photos
are backfilled by reconciliation, with no separate raw-file upload or data
migration. The first backfill can take several schedule runs. The release's
parameter-addition rules (`ops/ci/release_parameter_additions.json`) add this
parameter as `true` only when the stack does not already have it.

To stage or roll back the feature, change `OriginalComparisonsEnabled` through
a reviewed stack-parameter change. Setting it to `false` disables the schedule
and the SQS event mapping and removes the feature's API and upload environment
variables. The comparison table, bucket, existing previews and queue contents
are kept. Normal releases reuse previous values for existing stack parameters,
so editing the template default does not toggle a feature that is already
deployed. To deploy the resources before delivery is ready, keep the flag
`false`.

### Separate CloudFront CSP update

The private bucket's global and regional S3 origins must be in the frontend
CSP's `img-src` and `connect-src`. Other CSP directives are unchanged. The
frontend deploy role (`ian-photography-github-production-frontend`) can upload
and invalidate but cannot update the distribution, so deploying the JavaScript
does not update these headers.

Run the [front-door workflow](API_FRONT_DOOR.md#validate-and-update) after
`OriginalPreviewBucket` exists in the application stack. The helper looks up
the bucket by logical ID. This is a separate control-plane change and needs an
operator identity that is allowed to make it. First run
`front_door_preflight.py` with the current account, certificate,
origin-parameter name and WAF metadata guards. Do not put secret values in
commands, reports or this runbook.

Fill in the shell variables below from current, checked metadata, including
the frontend origin and distribution ETag. The example keeps the `www`,
print-store, API, social-router and signed-cookie private-media features. See
[`PRIVATE_MEDIA.md`](PRIVATE_MEDIA.md): once the private-media viewer-request
function is attached, the helper refuses a run that leaves out
`--include-private-media`. Confirm the live aliases and feature set before
running anything. If a named AWS profile is needed, pass the same `--profile`
to both commands.

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
  --include-private-media
)

.venv-ci/bin/python ops/cloudfront_frontend.py "${originals_edge_args[@]}"
```

Check the dry run's account, distribution ETag and proposed policy actions.
After reviewing the plan, apply it with the same arguments and current guards:

```bash
.venv-ci/bin/python ops/cloudfront_frontend.py "${originals_edge_args[@]}" --apply
aws cloudfront wait distribution-deployed --id "$originals_distribution_id"
```

If the ETag or any resource guard changed, run a fresh dry run and review it
again. Do not shorten this to a bare or partial `--apply`. The helper rebuilds
aliases and viewer-request associations from its feature flags, and only the
full set of arguments keeps the current front-door and social behaviors. This
section describes the required change; it is not a record that the change has
been applied.

## Checks after deploying

- Run `src/components/PhotoLightbox.test.jsx`, the backend
  `test_original_*.py` suites, `backend/tests/test_build_source_allowlists.py`
  and `ops/tests/test_original_comparison_infrastructure.py`, plus the normal
  release gates.
- Confirm the private bucket has all four public-access blocks, default
  encryption, TLS-only access and no public read policy. An anonymous request
  for a known preview should fail. An authorized comparison response should
  return a working URL with the documented expiry.
- Check aggregate index freshness, JPG count, ready/unavailable/failed counts,
  queue age and DLQ depth, and compare against a fresh gallery inventory. Do not
  export per-photo records or Drive metadata into logs or notifications.
- Open a matched public photo and a cropped photo. Check that the edit shows
  first, Before shows the whole original frame, Share comes after the toggle,
  and navigating or reopening returns to the edit. Try a portrait photo and a
  Canon MPO-backed JPG. Edited-photo download and print behavior should be
  unchanged.
- Check that an unmatched photo shows “Unable to locate original.” A missing
  source must never fall back to another image with the same camera number.
- Upload a new photo the normal way. Check that its original filename is kept,
  matching starts after the upload completes, and a Drive backup that arrives
  later is picked up by reconciliation. If a real photo with a duplicate name
  but a different capture time exists, check it too. Do not add test fixtures
  to the archive.
- Check private and unlisted access through the same owner/admin/share rules.
  Unauthorized API requests must not receive an original URL. Test a
  comparison URL expiring or refreshing, including navigation after a
  lightbox has been open for a long time.
- Check that video albums show no Before/After action and queue no original
  work. After the edge update, check CSP, canonical and `www` redirects, the
  print-store entry, public social metadata, sign-in and direct-origin denial.

## Failure recovery and retention

`OriginalComparisonFailureAlarm` fires when the comparison DLQ has a visible
message and notifies the `ian-photography-security-<stage>` SNS topic.
`OriginalIndexRefreshErrorsAlarm` reports indexer errors and is record-only,
since existing comparisons keep working. Review aggregate errors, durations,
throttles, queue age and index freshness before changing any configuration.

If indexing fails, check access to the SSM parameter, the optional KMS decrypt
permission, the service account's read access to the configured root, Drive
quota, and whether pagination completed. An expired cursor rebuilds
automatically. Provider failures leave the previous index in place, so do not
delete that pointer to force a rebuild during an outage.

If workers fail, separate source download or decode problems from matching
results. Fix the cause, then let scheduled reconciliation pick the photos up,
or retry a small, checked set of jobs. Do not purge or bulk-redrive the queue.
An unmatched photo does not mean the archive needs editing. If the problem is
systematic, turn the feature off through its parameter; the edited gallery is
unaffected.

The table and bucket are retained, and the table has deletion protection and
point-in-time recovery. Private index snapshots expire after seven days.
Before-preview objects have no lifecycle expiration. Album and media deletion
removes the matching `before/<album>/<media>/` previews and comparison records
once no worker holds a lease. A replaced source gets a new checksum prefix.
Older orphans are cleaned up one prefix at a time with
`ops/sweep_comparison_previews.py` (see
[`MAINTENANCE_AND_RECOVERY.md`](MAINTENANCE_AND_RECOVERY.md#generated-original-comparison-cleanup)).
Recovery and cleanup never touch the Drive archive.
