# Photo-original comparisons

This adds a Before/After toggle to the photo lightbox, right before Share. It
starts on the edited photo, and toggling it shows the full original framing.
The button highlights whichever side is showing, without adding a status row or
changing the toolbar's size. Loading and failure indicators stay inside the
button, and the longer status text is in its tooltip and available to
assistive technology. Moving to another photo resets to the edit. Video
lightboxes and video album files don't get the toggle.

## How a Before request works

Album, shared-album and Explore responses only carry a light `unresolved`
comparison hint, and cached edited-photo DTOs never contain original URLs. The
first Before request resolves one photo through
`POST /albums/{albumId}/original-comparison` or
`POST /shared/{shareCode}/original-comparison`. That endpoint runs the album's
current owner/admin/public/share authorization again (a share code is checked
against the current album record), is rate limited per IP and album, and
responds `no-store`. Once a toggle is ready it doesn't contact Google Drive.

If the original is still pending, the lightbox checks again only while the page
is visible: every 20 seconds for the first three checks, then once a minute,
for up to 15 minutes. Checks stop when you navigate away, cancel, or it
finishes.

The browser picks a WebP variant from the image's fitted display width and the
screen's pixel density. Preview responses use
`Cache-Control: private, max-age=1800`, and the signed URLs also expire after
30 minutes. After the current original loads once, it stays mounted so toggling
back and forth is instant. Navigating or a changed preview source releases it.
Other originals aren't prefetched.

## What I've validated so far

I validated this locally before deploying. The counts below come from the
read-only audit, not from live backfill progress. Use the rollout checks further
down to verify production and current processing.

The read-only audit found 3,112 verified original JPG matches among 3,113
gallery photos: all 3,019 public photos, all 84 unlisted photos, and 9 of 10
private photos. The one private test image left over has no identifying camera
metadata. The audit skipped 34 videos.

The new matcher reproduced those results against the saved private audit
inventory of 32,861 archive JPGs. That replay checks the metadata matching. It
isn't a visual comparison or a fresh reread of every photo.

A few more checks:

- A live S3 header read confirmed that the real EXIF/XMP extractor recovers a
  camera filename from a randomized website filename.
- One verified Drive JPG was read with the production reader and rendered
  locally into all four preview sizes. I checked orientation, framing, color,
  checksum and metadata removal.

None of these checks changed anything in S3, DynamoDB or Drive. Audit rows,
camera filenames, Drive IDs and downloaded source images aren't committed to
Git.

## How a photo gets matched to its original

`original_match.py` needs three things to agree: a filename candidate, the same
capture timestamp, and the same camera model. Filename alone never counts as a
match, because camera numbering rolls over. Filename candidates come from the
preserved upload basename and from Lightroom's `crs:RawFileName` or
`xmpMM:PreservedFileName`. Camera extensions and case are normalized, and so is
the recognized `YYYYMMDD-` / `YYYYMMDD_` export prefix. It doesn't strip
arbitrary suffixes or pick files that just look similar.

Capture timestamps are compared as camera wall time to the second, with no
timezone conversion assumed. If both sides have subseconds, they have to agree.
The audited Drive timestamps had no fractional seconds. A single complete match
is accepted. Several matching copies are accepted only when their MD5 checksums
are identical. Otherwise the result stays ambiguous.

### Which part of Drive it reads

The raw archive is the `raw_photo_backup_folder_id` in the existing encrypted
Google credential parameter. From the audit, it's roughly year → category/shoot
→ JPEG/RAW, with some variation in older folders. Indexing follows actual
parent IDs, not folder-name conventions. Only JPG descendants of that one root
become candidates. The separate edited Website Uploads backup, folders outside
the root, RAW camera files and Drive shortcuts are all left out. An incomplete
scan, an ancestry cycle, repeated pages or an invalid root can't publish a
partial index.

`original_drive.py` only uses `service_account` from the SSM payload. The
account may still have its existing full Drive permissions, but this reader
only requests `https://www.googleapis.com/auth/drive.readonly`. It doesn't use
the OAuth writer credential in the same payload. Every Drive resource request
is a GET to a fixed Google API URL, with redirects off. Google token refresh is
separate from Drive resource access. Nothing in the code uploads, renames,
edits, moves, trashes, deletes or changes permissions on the archive.

## Processing and delivery

1. `OriginalIndexRefreshFunction` runs every 15 minutes with concurrency one.
   It takes a full visible-file inventory on the first scan and at least every
   24 hours, and uses Drive change cursors in between. A cursor taken before a
   full scan is replayed afterward, so changes made during the scan aren't
   missed. An expired cursor triggers a rebuild. A provider outage leaves the
   last published index in place.
2. The index snapshot is compressed and stored privately under
   `index/<generation>.json.gz`. The comparison table's system row holds the
   current snapshot pointer, root, cursor and generation. Archive names and
   matching evidence stay on the server.
3. The coordinator scans active photo albums and comparison records and queues
   whatever is missing. Upload-completion handlers also queue committed photos.
   Just generating an upload URL doesn't queue anything. The scheduled
   reconciliation fills in missed dispatches and retries photos whose Drive
   backup showed up after their website upload.
4. `OriginalComparisonWorkerFunction` handles one SQS message at a time, with at
   most two workers running. It checks album membership again, reads a capped
   chunk of the edited photo's header, matches evidence, checks live Drive
   ancestry and download permission, and checks source size and checksum.
   Source reads are capped at 100 MiB and images at 100 million pixels. It
   accepts JPEGs, plus Canon JPGs that Pillow identifies as MPO, and only uses
   their primary image.
5. The worker applies EXIF orientation, converts embedded color profiles to
   sRGB, keeps the whole frame, and creates WebPs at widths 640, 960, 1440 and
   1920 without upscaling. EXIF, GPS, XMP and ICC metadata are stripped from
   the served files. The camera's source JPG bytes aren't stored in the website
   bucket.
6. Previews are written conditionally under
   `before/<album>/<media>/<source-checksum>/w<width>.webp` in a separate
   private bucket, and existing files are never overwritten. The ready record
   is only published while the worker holds its lease, the image still belongs
   to the active photo album, and the edited S3 object hasn't changed.
7. The existing album authorization controls access to comparison DTOs through
   the `original-comparison` endpoints above (served by the download-URL
   function). APIs can read comparison records and sign only the `before/`
   prefix. They can't read the Drive credentials or the private index. URLs
   expire after 1,800 seconds. A ready DTO holds only status, dimensions,
   responsive URLs and expiry. Drive IDs, camera filenames and evidence are
   never exposed.

Public and protected photos both use private S3 files and short-lived signed
URLs. Changing album access stops new URLs from the protected API right away,
but a URL that was already issued can keep working until it expires. There's
no public bucket policy or CloudFront public alias for originals.

| Internal state | API/lightbox behavior | Subsequent work |
| --- | --- | --- |
| `pending` or no record | Checking/preparing original; edited photo remains visible | Queued processing or later reconciliation |
| `ready` | Before/After toggle loads the original preview | Reuses immutable output when the verified source is unchanged |
| `unavailable` | “Unable to locate original” | Retried on later index generations |
| `ambiguous` | “Unable to locate original” | Conflicting evidence is retained privately; no guess is served |
| `failed` | Original could not be loaded; retry is available | Provider/processing failures remain retryable |

Accepted initial jobs get a 24-hour queue marker so a big backfill doesn't get
dispatched again every 15 minutes. Live worker leases also stop reconciliation
from doubling up. SQS visibility is 30 minutes, with five delivery attempts
before the DLQ. Worker failures come back as partial batch failures. A missing
original is a matching result, not a provider failure.

## Deployment and activation

Ship application artifacts and the SAM stack through the normal
[CI/CD release](CI_CD.md). In the release intent, look over the new retained
table and bucket, the capped workers, the queue, the alarms and the narrow IAM
changes. Physical resource names stay inside the release role's existing
`GoldenHour-`, `goldenhour-` and `ian-photography-` namespaces.

The `OriginalComparisonsEnabled` stack parameter defaults to `true`. It also
needs a nonempty `GoogleOAuthSecretArn` to actually turn on. When it's on, the
scheduled indexer and SQS worker run, upload completion dispatches jobs, and
APIs include comparison state. Existing photos get backfilled automatically by
reconciliation, with no separate raw-file upload or destructive migration. The
first backfill runs in the background and can take several schedule runs. The
release's parameter-addition rules add this flag as `true` the first time it's
deployed, and they don't override an existing value.

To stage the rollout or roll it back, change `OriginalComparisonsEnabled`
through a stack-parameter change you've checked. Setting it to `false` turns
off the schedule and event mapping and removes the feature's API/upload
environment wiring. The comparison table, bucket, existing previews and queue
contents are kept. Normal releases reuse previous values for existing stack
parameters, so editing the template default alone won't toggle a feature that's
already deployed. If you deploy the resources first, keep the flag `false` until
delivery is ready.

### Separate CloudFront CSP update

The new private bucket's global and regional S3 origins have to be added to
`img-src` and `connect-src`. Video, script and other CSP sources stay the same.
The normal frontend upload/invalidation role can't change CloudFront security
policies, so deploying the JavaScript alone won't update these headers.

Run the existing [front-door workflow](API_FRONT_DOOR.md#validate-and-update)
**after `OriginalPreviewBucket` exists in the application stack**. The helper
finds the bucket by logical ID. This is a separate control-plane change, so use
an operator identity that's allowed to make it. First run
`front_door_preflight.py` with the current account, certificate,
origin-parameter name and WAF metadata guards. Never put secret values in
commands, reports or this runbook.

Fill in the shell variables below from current metadata you've checked,
including the current frontend origin and distribution ETag. The example keeps
the existing `www`, print-store, API, social-router and signed-cookie
private-media features. See [`PRIVATE_MEDIA.md`](PRIVATE_MEDIA.md): once that
behavior is live, the helper refuses an `--include-www` run that leaves out
`--include-private-media`. Confirm the live aliases and feature set before you
run anything. If you need a named AWS profile, pass the same `--profile` to both
commands.

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
Once you're happy with that plan, apply it with the same arguments and current
guards:

```bash
.venv-ci/bin/python ops/cloudfront_frontend.py "${originals_edge_args[@]}" --apply
aws cloudfront wait distribution-deployed --id "$originals_distribution_id"
```

If the ETag or any resource guard changed, get a fresh dry run and check it
again. Don't cut this down to a bare or partial `--apply`. The helper rebuilds
aliases and viewer-request associations from its feature flags, and only the
full set of arguments keeps the current front-door and social behaviors. This
runbook describes the change that's needed. It doesn't claim I've run it.

## Checks after deploying

- Run the photo-lightbox tests, the backend `test_original_*.py` suites, the
  build allowlist tests and `ops/tests/test_original_comparison_infrastructure.py`,
  plus the normal full release gates.
- Confirm the private bucket has all four public-access blocks, encryption,
  TLS-only access and no public read policy. An anonymous request for a known
  preview should fail. An authorized album response should hand out a working
  URL with the documented expiry.
- Check aggregate index freshness, JPG count, ready/unavailable/failed counts,
  queue age and DLQ depth. Compare against a fresh gallery inventory. The audit
  counts above are a starting point, not a gallery total that should never
  change. Don't export per-photo records or Drive metadata into logs or
  notifications.
- Open a matched public photo and a cropped photo. Check that the edit shows
  first, Before shows the whole original frame, Share comes after the new
  button, and navigating or reopening goes back to the edit. Try a portrait
  photo and a Canon MPO-backed JPG. The normal edited-photo download and print
  behavior should be unchanged.
- Check that the unmatched test image says “Unable to locate original.” A
  missing source must never fall back to another image with the same camera
  number.
- Upload a new photo the normal way. Check that its original filename is kept,
  matching starts after the upload completes, and a Drive backup that arrives
  later gets picked up by reconciliation. If you have a real photo with a
  duplicate name but a different time, check it too. Compare the evidence; don't
  make up a test fixture inside the archive.
- Check private and unlisted access through the same owner/admin/share rules.
  Unauthorized API requests must not get an original URL. Test a comparison URL
  expiring or refreshing, including navigating after a lightbox has been open
  for a long time.
- Check that video lightboxes show no Before/After action and queue no original
  work. After the edge update, check CSP, canonical and `www` redirects, the
  print-store entry, public social metadata, sign-in and direct-origin denial.

## Failure recovery and retention

`OriginalComparisonFailureAlarm` fires when the comparison DLQ isn't empty and
emails me through the existing website security-notification route.
`OriginalIndexRefreshErrorsAlarm` reports indexer errors and is record-only,
since existing comparisons keep working. Look at aggregate errors, durations,
throttles, queue age and index freshness before changing any configuration.

If indexing fails, check access to the SSM parameter, the optional KMS decrypt
permission, the service account's read access to the configured root, Drive
quota, and whether pagination completed. An expired cursor rebuilds on its own.
Provider failures have to leave the previous index in place, so don't delete
that pointer to force a rebuild during an outage.

If workers fail, separate source download or decode problems from matching
results. Fix the cause, then let scheduled reconciliation pick it up or retry a
small, checked set of jobs you know are idempotent. Don't purge or bulk-redrive
the queue. A missing test source doesn't mean the archive needs editing. If the
problem is systematic, turn the feature off through its parameter and keep the
edited gallery up.

The table and bucket are retained, and the table has deletion protection and
point-in-time recovery. Old private index snapshots expire after seven days.
Before-preview objects have no lifecycle expiration. Normal album and media
deletion removes the matching `before/<album>/<media>/` previews and comparison
records once no worker holds a lease. A replaced source gets a new checksum
namespace. Older orphans are cleaned up one prefix at a time with
`ops/sweep_comparison_previews.py` (see
[`MAINTENANCE_AND_RECOVERY.md`](MAINTENANCE_AND_RECOVERY.md#generated-original-comparison-cleanup)).
Recovery and cleanup never touch the raw Drive archive.
