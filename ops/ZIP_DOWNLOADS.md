# Prepared album ZIP downloads

Photo and video albums use the same prepared-archive pipeline. An existing current ZIP can be returned on the first authorized API request. A newly uploaded or edited album can still show preparation until its replacement archive finishes. Original file bytes are preserved.

## Freshness and naming

`zip_helpers.zip_version` hashes the archive format, album ID, title, type, visibility, and ordered pairs of source key and archive filename. Renaming an album, changing a stored original filename, adding/removing/replacing media, or changing file order selects a different archive. Description, thumbnail, and cover changes do not invalidate identical download contents. In-app uploads allocate new UUID source keys.

ZIP members use the stored original filename when available, with a numbered prefix to distinguish duplicates. Legacy media without that metadata retain the source-key filename. The download's filename comes from the current album title. Shared-link lookups re-read the base table consistently after resolving the share index; authorization always uses the current record.

## Preparation and retention

- `ZipArchiveRefreshFunction` consumes the existing AlbumsTable keys-only stream. A ten-second batching window groups changes; each album is looked up once per successful batch. Initial uploads remain ineligible while pending or carrying `createdBySub`.
- `ZipPreparationQueue` is encrypted FIFO, delayed five seconds, with one message group per album. The worker consumes one message at a time, with at most two albums processing concurrently. Stream sequence IDs distinguish later edits that restore an earlier title or manifest; repeated download polls deduplicate by album/version.
- Queue messages are wakeups. The worker reads the latest committed album, so queued superseded versions coalesce. It checks for further edits at most once every five seconds while copying, and checks again before and after multipart completion. Superseded output is aborted or deleted rather than offered as the current archive.
- File sizes are checked with up to eight concurrent S3 requests. Two ZIP parts can upload concurrently, overlapping source reads with uploads. Each part is eight MiB; the entire archive is never buffered. Source VersionIds from HEAD are used when reading. Already compressed photo/video formats use ZIP_STORED.
- Current archives live at `album-zips/<albumId>/<version>.zip` without a current-object expiry. Once a replacement finishes, older current objects are deleted; noncurrent bytes and incomplete multipart uploads expire after one day. Album/user erasure explicitly deletes every archive version as part of its existing bounded deletion flow.
- Archives are tagged private, direct public S3 access remains blocked, and CloudFront is explicitly denied access to `album-zips/*`. Download URLs are minted only after existing public/private/shared authorization checks, with a ten-minute lifetime. Previously issued capabilities follow the existing signed-URL lifetime contract; deleting superseded archive objects can invalidate them sooner.
- Old `temp-zips/` ZIPs and locks are no longer used and expire under their existing lifecycle. New failure records and the reconciliation cursor also use that temporary namespace.

## Existing albums and recovery

A scheduled reconciliation runs every fifteen minutes, checks up to 100 existing album IDs, and persists its scan cursor only after dispatch succeeds. This automatically prepares existing albums after deployment and repairs missed dispatches. A manual invocation of `ZipArchiveRefreshFunction` with `{}` advances one page through the same path. No new archive generation is required on album-view navigation.

Source failures abort the multipart upload, publish a generic failure state, and retry via FIFO. Explicit failures shorten message visibility to thirty seconds; the normal 5,400-second visibility timeout protects a 900-second worker invocation. Five exhausted deliveries go to `ZipPreparationDeadLetterQueue`, monitored by `ZipPreparationFailureAlarm`. Quota failures are terminal for that attempt and do not repeatedly run an impossible build. Existing bounds remain 1,000 files and 10 GiB by default.

The status endpoint allows 120 requests per IP/album per five minutes. The client starts with short waits, then backs off to fifteen seconds even when the server supplies a short retry hint. Failed jobs surface an error instead of presenting a perpetual preparation spinner. Scheduled reconciliation retries missing archives, including failures; inspect the failure queue before any manual redrive.

## Release and validation

Deploy the backend/template, source allowlists, environment policy, release intent, artifact count, and alarm registry together, then deploy the frontend. The new stream consumer and schedule start preparing archives automatically. A warm-download performance claim requires production measurement; local tests verify behavior and bytes, not AWS throughput.

Validate with:

1. A photo album and a video album: wait for preparation, then verify the first ZIP API response is `ready`, the download filename matches the title, and extracted bytes match originals.
2. Rename the album and stored filenames; add/remove media; restore an earlier name. The next request must select the current version and never fall back to an older archive while preparation runs.
3. Edit or delete an album during a large build. Verify no obsolete output is served, replacement work runs, and stale/multipart objects are cleaned up.
4. Check private albums and revoked shared links still reject unauthorized requests. Confirm persistent ZIP keys cannot be fetched anonymously through S3 or CloudFront.
5. Check album and user deletion remove persistent archives along with originals, thumbnails, and temporary files. Monitor the ZIP failure queue and the existing stream-failure destination.

Automated coverage includes original-byte round trips, safe/duplicate filenames, photo/video preparation, renamed and superseded jobs, deletion, byte/object quotas, multipart failure cleanup, FIFO retries, stream coalescing, reconciliation pagination, signed download naming, and long-running polling.

AWS references: [FIFO delivery ordering](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/FIFO-queues-understanding-logic.html), [Lambda SQS configuration](https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-configure.html), [FIFO deduplication](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/using-messagededuplicationid-property.html).
