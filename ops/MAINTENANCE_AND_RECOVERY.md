# Maintenance and recovery

## Dependency updates

I go through dependency PRs once a week, and keep at most two open updates per
main ecosystem. Version-update PRs wait seven days after a release is published,
which cuts down supply-chain risk. Only development-tool patch releases get
grouped. Runtime, image decoder, auth, major-version and workflow changes each
get their own PR and their own look.

Dependabot opens PRs. It doesn't merge or deploy anything. Keep the pinned
lockfiles, pinned action SHAs, artifact budgets, the four coverage gates and the
full release workflow as they are. Read the upstream release notes and rerun a
few representative browser journeys. Fix known exploitable high or critical
issues quickly. If an advisory doesn't apply, work out why and say so instead
of quietly waiving the audit gate. The weekly scheduled audits stay on, and I
don't want a second update bot.

## Durable work recovery

### Video conversion and timeline frames

Album work runs on the shared `CacheInvalidationWorkerFunction` while the
`AlbumWorkRouting` parameter is `legacy` (the default). After a planned
`separated` cutover it runs on the dedicated
`AlbumWorkWorkerFunction`/`AlbumWorkQueue` instead. Both workers hand album work
back to SQS between small steps. They're set to `RecursiveLoop: Allow` so Lambda
doesn't drop those legitimate long polling chains. Every other function keeps
the default recursion protection. Reserved concurrency stays at two, and saved
video receipts still stop automatic retries after 24 hours.

Every three hours `VideoUpgradeFunction` also wakes active, idle video albums
that have `prepared`, `submitting` or `transcoding` receipts due, even when all
the upgrade slots are taken. This picks up a lost continuation without
resetting timestamps, tokens, accepted job IDs or `unresolved` receipts. Albums
that are busy, being deleted or in the trash are left alone, and so are checks
scheduled for later. Its aggregate `resumed` count is the number of albums it
woke for existing work. After a deploy, the next scheduled run recovers stuck
jobs inside their existing retry window.

Frame capture needs a regular audio/video output in the same MediaConvert job.
So frame backfills write one small H.264/AAC MP4 next to the JPEGs in the
existing frames folder, and the published HLS stream isn't touched. That
companion file shares the folder's privacy tags and deletion lifecycle. New
full conversions already include HLS and don't need it.

### Repairing a stuck operation

`unresolved` receipts still need me to look at each one. Never reset every video
timestamp, and never repeat a paid submission when you can't tell whether the
first one went through. Check that aggregate due-receipt counts go down and
provider rejections stop. An empty SQS queue on its own doesn't mean all album
work finished.

The 24-hour retry ceiling is there to cap cost. If something fails after that
window, find the cause, confirm it's fixed, and inspect that one operation.
These tools don't permit a bulk timestamp reset or a DLQ redrive.

Inventory reads one consistent table page (100 evaluated rows) and gives you
the next cursor. Save the JSON output with restricted incident evidence. It
contains internal IDs, not user emails.

```
python ops/reconcile_durable_work.py --table EXISTING_ALBUMS_TABLE
python ops/reconcile_durable_work.py --table EXISTING_ALBUMS_TABLE --cursor NEXT_ALBUM_ID
```

Feed the returned key, operation and snapshot into a second dry run. Account
operations also need the existing Cognito pool. A repaired operation keeps its
original scope, ownership, privacy and checkpoints. The compare-and-swap
rejects records that changed and live leases, and account identities and
protected groups are checked again. You can grant at most three extra 24-hour
windows to any one operation.

```
python ops/reconcile_durable_work.py --table EXISTING_ALBUMS_TABLE --key EXACT_KEY --operation EXACT_OPERATION --expected-snapshot REVIEWED_SHA --pool EXISTING_POOL
```

Once that result looks right, add `--apply --queue-url EXISTING_QUEUE_URL`
(the queue the active album-work consumer polls). `--region` defaults to
`us-west-2`.

Save both the dry-run and apply output along with who ran it, the root cause,
the time and the outcome. Use whatever CloudTrail records exist as extra
evidence, but keep the operator JSON separately. Confirm the receipt completes
and the existing alarms clear. If the enqueue succeeds but the CAS fails, the
original stop is still in place, so inspect it again. Unknown or legacy
operations, identities that are unexpectedly missing, changed owners and
operations that have used up their repair windows all need manual analysis.
This command never recreates Cognito users or unblocks deletion fences.

### Deletion counts

Deletion count responses now keep confirmed totals across retries.
`deletedObjectVersionsExact=false` means the count is a lower bound, either
after an unclear provider response or from a legacy receipt. Counts are
versions and delete markers in the main gallery bucket. Generated comparisons
are cleaned up separately. Don't present a lower bound as the full erasure
total. Completion receipts hold suppression IDs and aggregate counts, not
original files or deleted email addresses.

## Generated original-comparison cleanup

Normal album and media deletion now removes private website comparison previews
and their metadata once any active comparison worker finishes. It never writes
to Google Drive.

`sweep_comparison_previews.py` cleans up older leftovers for one album/media
prefix at a time, and it's a dry run by default. Pass the existing album table,
comparison table, preview bucket, album UUID and 24-character media ID. Apply
needs the `--expected-snapshot` the dry run returned. It refuses live images,
recent outputs, active leases, and missing albums that have no proof of
deletion. Each call handles at most 100 generated objects, so repeat only after
another dry run you've checked. The `index/` snapshot namespace and the
original archive are outside its scope. It errs on the side of keeping
comparisons for live images, including older revisions.

## Recovery targets and evidence

These are targets, not something I've measured recently:

- public read access restored within 4 hours of starting an approved recovery;
- protected administration back within 8 hours;
- no more than 24 hours of metadata lost under the scheduled-backup fallback.
  Point-in-time recovery, where it's available, shortens that.

Archive and media recovery depend on the separately protected object and Drive
copies. I'd need to measure them in a real drill before promising these targets
to anyone else.

Read-only evidence from 2026-09-23 at 18:30 UTC: Albums and PreviewMetadata each
had 35 completed recovery points, the newest completed backups were about 10.5
hours old, and DynamoDB PITR was on. The primary backup stack was
UPDATE_COMPLETE. A 90-day AWS Backup query found no restore jobs referencing
those current recovery points. It can't tell whether an older drill, a native
DynamoDB drill or one recorded elsewhere exists. Keep using the existing
backup-freshness verifier and alerts.

### Offline reconstruction

Local reconstruction tests cover current deletion fences, completed album/media
suppression, legacy ownership, incomplete work, and candidates that default to
private. They prove the filtering works. They don't prove anything about AWS
restore time or whether backups are complete.

`recovery_reconstruction.py backup.json current-receipts.json new-output.json`
reads plain decoded DynamoDB item lists offline. It only writes a new file
(it won't overwrite one) and never connects to AWS. Export the latest
deletion/suppression receipts before any restore. If the live table is gone,
use other operational evidence. An old snapshot with no deletion receipt is
never permission to restore someone's personal data. Quarantined records need a
look before they go back in. Don't import them blindly.

### Running a real drill

1. Get separate approval for the temporary resources and metered usage.
2. Note the start time and the recovery point.
3. Restore into an isolated table with no streams, triggers or public routes.
4. Apply the current erasure and suppression records.
5. Validate schema, counts, representative media, ownership, private/unlisted
   access, shared-link revocation and Cognito identity mapping.
6. Rebuild derived indexes with publishing turned off.
7. Test application reads against the isolated copy.
8. Record the actual RTO/RPO and the cleanup evidence.

Never replay pending jobs or old authorization state automatically. Current
privacy decisions and deletion fences carry across the cutover. The restore
gate in [`SECURITY_ACCOUNT_BASELINE.md`](SECURITY_ACCOUNT_BASELINE.md) covers the
existing controls. This release doesn't include a live AWS restore drill.
