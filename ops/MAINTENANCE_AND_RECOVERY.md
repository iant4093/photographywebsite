# Maintenance and recovery

## Dependency updates

Dependabot (`.github/dependabot.yml`) checks the root npm package, the preview
worker npm package and the backend pip requirements weekly, and GitHub Actions
monthly. It keeps at most two open PRs for the root npm package and for pip,
and one for the preview worker and for Actions. Version-update PRs wait seven
days after a release is published (`cooldown`). Only development-dependency
patch updates in the root npm package are grouped; every other update gets its
own PR.

Dependabot opens PRs. It doesn't merge or deploy anything. Keep the pinned
lockfiles, pinned action SHAs, artifact budgets, the four coverage gates
(frontend, preview worker, backend, ops) and the full release workflow
unchanged. Read the upstream release notes and rerun representative browser
journeys. Fix known exploitable high or critical issues promptly. If an
advisory doesn't apply, record the reason instead of waiving the audit gate.
Keep the weekly scheduled security audit enabled, and don't add a second
update bot.

## Durable work recovery

### Video conversion and timeline frames

The `AlbumWorkRouting` parameter selects the album-work consumer. With
`legacy` (the template default), album work runs on the shared
`CacheInvalidationWorkerFunction`. With `separated` (the current production
value), it runs on `AlbumWorkWorkerFunction` and `AlbumWorkQueue`. Both workers
hand album work back to SQS between small steps and set `RecursiveLoop: Allow`
so Lambda doesn't stop those continuation chains. Every other function keeps
the default recursion protection. Both workers have reserved concurrency of
two. Video receipts stop automatic retries after 24 hours and move to
`unresolved`.

Every three hours `VideoUpgradeFunction` also resumes active, idle video albums
that have `prepared`, `submitting` or `transcoding` receipts due, even when all
upgrade slots are in use. This recovers a lost continuation without resetting
timestamps, tokens, accepted job IDs or `unresolved` receipts. Albums that are
busy, being deleted or in the trash are skipped, as are checks scheduled for
later. Its aggregate `resumed` count is the number of albums resumed for
existing work. After a deploy, the next scheduled run recovers stuck jobs
inside their existing retry window.

MediaConvert frame capture needs a regular audio/video output in the same job.
Frame backfills therefore write one small H.264/AAC MP4 next to the JPEGs in
the existing frames folder, and the published HLS stream isn't changed. That
companion file shares the folder's visibility tags and deletion lifecycle. Full
conversions already include HLS and don't need it.

### Repairing a stuck operation

`unresolved` receipts need individual review. Never reset every video
timestamp, and never repeat a paid submission when it is unclear whether the
first one succeeded. Check that aggregate due-receipt counts go down and
provider rejections stop. An empty SQS queue alone doesn't mean all album work
finished.

The 24-hour retry limit caps cost. If an operation fails after that window,
find and fix the cause, then inspect that one operation.
`reconcile_durable_work.py` repairs one operation at a time; it has no bulk
timestamp reset or DLQ redrive.

Inventory reads one consistent table page (100 evaluated rows) and returns the
next cursor. Save the JSON output with restricted incident evidence. It
contains internal keys and operation IDs, not user emails.

```bash
python3 ops/reconcile_durable_work.py --table EXISTING_ALBUMS_TABLE
python3 ops/reconcile_durable_work.py --table EXISTING_ALBUMS_TABLE --cursor NEXT_ALBUM_ID
```

Pass the returned key, operation and snapshot to a second dry run. Account
operations (`user-deletion`, `user-email-update`) also need the Cognito user
pool ID. A repaired operation keeps its original scope, ownership, privacy and
checkpoints. The compare-and-swap rejects records that changed and records with
a live lease, and account identities and protected groups are checked again.
Each operation can be repaired at most three times, and each repair grants one
new 24-hour window.

```bash
python3 ops/reconcile_durable_work.py --table EXISTING_ALBUMS_TABLE --key KEY --operation OPERATION --expected-snapshot REVIEWED_SHA --pool EXISTING_POOL
```

Once that result is correct, add `--apply --queue-url EXISTING_QUEUE_URL` (the
queue polled by the active album-work consumer). `--region` defaults to
`us-west-2`.

Save both the dry-run and apply output with the operator, root cause, time and
outcome. CloudTrail records are supplementary evidence; keep the operator JSON
separately. Confirm the receipt completes and the related alarms clear. Apply
enqueues before the compare-and-swap; if the enqueue succeeds but the
compare-and-swap fails, the original receipt is unchanged, so inspect it again.
Unknown or legacy operations, unexpectedly missing identities, changed owners
and operations with no repairs left need manual analysis. The command never
recreates Cognito users or removes deletion fences.

### Deletion counts

Deletion count responses keep confirmed totals across retries.
`deletedObjectVersionsExact=false` means the count is a lower bound, either
after an unclear provider response or from a legacy receipt. Counts cover
object versions and delete markers in the main gallery bucket. Generated
comparisons are cleaned up separately. Don't report a lower bound as the full
erasure total. Completion receipts hold suppression IDs and aggregate counts,
not original files or deleted email addresses.

## Generated original-comparison cleanup

Album and media deletion removes the private comparison previews and their
metadata after any active comparison worker finishes. It never writes to Google
Drive.

`sweep_comparison_previews.py` removes older leftovers for one album and media
ID at a time, and it is a dry run by default. Pass `--albums-table`,
`--comparison-table`, `--preview-bucket`, `--album-id` (a UUID) and
`--media-id` (24 hex characters). Apply needs `--expected-snapshot` from the
dry run. The script refuses media that still belongs to a live image, outputs
written in the last six minutes, active leases, busy albums, and missing albums
without a deletion receipt. Each call handles at most 100 generated objects
under `before/<albumId>/<mediaId>/`, so repeat only after another reviewed dry
run. The `index/` snapshot namespace and the original archive are outside its
scope.

## Recovery targets and evidence

Recovery targets, not yet measured in a drill:

- public read access restored within 4 hours of starting an approved recovery;
- protected administration restored within 8 hours;
- at most 24 hours of metadata lost when restoring from the daily scheduled
  backup. Point-in-time recovery, where available, reduces that.

Archive and media recovery depend on the separately protected object and Drive
copies. Measure them in a drill before relying on these targets.

The backup plan in `security_backup_template.yaml` backs up the Albums and
PreviewMetadata tables daily at 08:00 UTC and keeps recovery points for 35
days. `BackupFreshnessAlarm` reports a missing fresh recovery point. Read-only
state on 2026-10-18: each table had 35 completed recovery points in the
`ian-photography-metadata-prod` vault, the newest from 2026-10-17 08:00 UTC,
PITR was enabled on both, and the `ian-photography-backup-primary` stack was
`UPDATE_COMPLETE`. AWS Backup lists two completed DynamoDB restore jobs from
2026-07-21 into temporary drill tables that no longer exist. Their validation
results are not recorded in this repository.

### Offline reconstruction

The reconstruction tests in `ops/tests/test_recovery_operations.py` cover
deletion fences, completed
album and media suppression, legacy ownership, incomplete work, and candidates
that default to private. They test the filtering logic. They don't measure AWS
restore time or backup completeness.

`recovery_reconstruction.py backup.json current-receipts.json new-output.json`
reads plain decoded DynamoDB item lists offline. It creates a new output file
(it refuses to overwrite one) and never connects to AWS. Export the latest
deletion and suppression receipts before any restore. If the live table is
gone, use other operational evidence. An old snapshot with no deletion receipt
is never permission to restore someone's personal data. Review quarantined
records before importing them.

### Running a real drill

1. Get separate approval for the temporary resources and metered usage.
2. Record the start time and the recovery point.
3. Restore into an isolated table with no streams, triggers or public routes.
4. Apply the current erasure and suppression records.
5. Validate schema, counts, representative media, ownership, private and
   unlisted access, shared-link revocation and Cognito identity mapping.
6. Rebuild derived indexes with publishing turned off.
7. Test application reads against the isolated copy.
8. Record the measured RTO and RPO and the cleanup evidence.

Never replay pending jobs or old authorization state automatically. Current
privacy decisions and deletion fences carry across the cutover. The restore
gate in [`SECURITY_ACCOUNT_BASELINE.md`](SECURITY_ACCOUNT_BASELINE.md) covers the
existing controls.
