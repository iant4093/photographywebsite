# Maintenance and recovery

## Dependency changes

Review dependency PRs weekly, with at most two open updates per main ecosystem.
Version-update PRs wait seven days after publication to reduce supply-chain risk.
Only development-tool patch releases are grouped. Runtime, image decoder, auth,
major-version and workflow changes get individual review. Dependabot opens PRs;
it does not merge or deploy. Preserve exact lockfiles, pinned action SHAs, artifact
budgets, four coverage gates and the full release workflow. Review upstream release
notes and rerun representative browser journeys. Fix known exploitable high/critical
issues promptly; assess applicability rather than silently waiving the audit gate.
Weekly scheduled audits remain enabled. Do not introduce a second update bot.

## Durable work recovery

The existing 24-hour retry ceiling remains cost protection. A failure after that
window needs an operator to identify the cause, verify it is resolved, and inspect
one exact operation. No bulk timestamp reset or DLQ redrive is authorized by these
tools. Inventory reads one consistent table page (100 evaluated rows), with an
explicit next cursor. Save the JSON output in restricted incident evidence; it
contains internal identifiers, not user emails.

```
python ops/reconcile_durable_work.py --table EXISTING_ALBUMS_TABLE
python ops/reconcile_durable_work.py --table EXISTING_ALBUMS_TABLE --cursor NEXT_ALBUM_ID
```

Use the returned key, operation and snapshot in a second dry run. Account operations
also require the existing Cognito pool. A repaired operation retains its original
scope, ownership, privacy and checkpoints. The compare-and-swap rejects changed
records and live leases; account identities and protected groups are rechecked.
An operator can allow at most three additional 24-hour windows for one operation.

```
python ops/reconcile_durable_work.py --table EXISTING_ALBUMS_TABLE --key EXACT_KEY --operation EXACT_OPERATION --expected-snapshot REVIEWED_SHA --pool EXISTING_POOL
```

After reviewing that exact result, add `--apply --queue-url EXISTING_QUEUE_URL`.
Save both dry-run and apply output with operator identity, root cause, time and
outcome. Use available CloudTrail records as additional evidence; retain the operator JSON independently. Confirm the receipt reaches
completion and existing alarms clear. If enqueue succeeds but CAS fails, the
original stop remains intact; inspect again. Unknown/legacy operations, unexpectedly missing
identities, changed owners, and exhausted repair budgets require manual analysis.
This command never recreates Cognito users or unblocks deletion fences.

Deletion count responses now retain confirmed totals across retries. `deletedObjectVersionsExact=false`
means the count is a lower bound after an ambiguous provider response or a legacy
receipt. Counts refer to versions/delete markers in the main gallery bucket;
generated comparisons are separate cleanup. Do not present a lower bound as an
exact erasure total. Completion receipts contain suppression IDs and aggregate
counts, not original files or deleted email addresses.

## Generated original-comparison cleanup

Normal album/media deletion now removes private website comparison previews and
metadata, after any active comparison worker settles. It never writes to Google
Drive. `sweep_comparison_previews.py` provides a bounded historical cleanup of one
explicit album/media prefix, default dry run. Pass the existing album table,
comparison table, preview bucket, album UUID and 24-character media ID. Apply needs
the exact returned `--expected-snapshot`. Live images, recent outputs, active leases
and missing albums without deletion proof are refused. Each call handles at most
100 generated objects; repeat only after another reviewed dry run. The `index/`
snapshot namespace and original archive are outside the deletion scope. Retained
live-image comparisons, including older revisions, are intentionally conservative.

## Recovery objectives and evidence

Targets, not a newly measured guarantee: restore public read access within 4 hours
of an operator beginning an approved recovery; recover protected administration
within 8 hours; lose no more than 24 hours of metadata under the scheduled-backup
fallback. Use point-in-time recovery where available to reduce that interval.
Archive/media recovery depends on the separately protected object/Drive copies and
must be measured in a real drill before committing these targets externally.

Read-only evidence on 2026-09-23 at 18:30 UTC: Albums and PreviewMetadata each had
35 completed recovery points; newest completed backups were about 10.5 hours old;
DynamoDB PITR was enabled. The primary backup stack was UPDATE_COMPLETE. The bounded
90-day AWS Backup query did not find restore jobs referencing those current recovery
points; it cannot establish whether an older, native DynamoDB, or externally
recorded drill exists. Keep using the existing backup-freshness verifier and alerts.

Local reconstruction tests cover current deletion fences, completed album/media
suppression, legacy ownership, incomplete work and private-by-default candidates.
They prove filtering behavior, not AWS restoration time or backup completeness.
`recovery_reconstruction.py backup.json current-receipts.json new-output.json`
reads plain decoded DynamoDB item lists offline, writes a new file exclusively,
and never connects to AWS. Export the latest deletion/suppression receipts before
any restore; use independent operational evidence when the live table is lost.
Never use an old snapshot's absence of a deletion receipt as permission to restore
personal data. Quarantined records require review; do not import them blindly.

For a real drill: separately authorize temporary resources and metered usage; note
start time and recovery point; restore into an isolated table without streams,
triggers or public routes; apply current erasure/suppression records; validate
schema, counts, representative media, ownership, private/unlisted access, shared
link revocation, and Cognito identity mapping; reconstruct derived indexes with
publication disabled; test application reads against the isolated copy; record
actual RTO/RPO and cleanup evidence. Never replay pending jobs or old authorization
state automatically. Retain current privacy decisions and deletion fences across
cutover. Consult SECURITY_ACCOUNT_BASELINE.md's restore gate for existing controls.
No live AWS restore drill is included in this release.
