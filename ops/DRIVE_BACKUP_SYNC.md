# Album backup synchronization

Album summaries load completely in the manager; media remains paginated. Fixed
notifications report gallery saves independently of Drive completion. The
admin-only `/admin/drive-backups` POST route supports batched status and a
single-album `action: retry` request.

The upload opt-in or a verified `driveFolderId` authorizes synchronization.
`migrate_drive_backup_links.py` inventories the configured website backup root,
links existing folders, and tags identifiable original files. Run its dry run
first and pass the exact digest/account when applying. It preserves archived
folders, manual extras, and unrelated roots. Byte-identical legacy duplicate
copies are linked together so a later explicit removal trashes every known
copy. No files are uploaded, moved, or trashed by the linking migration.

Album writes and backup intents commit in one DynamoDB transaction. A retained,
PITR-protected `DriveBackupStateTable` holds state and job records; its filtered
stream delivers job inserts directly to the existing serialized Drive worker.
This uses durable stream delivery without adding an extra queue relay. Exhausted
stream deliveries go to the existing monitored failure queue. Failed jobs do not
expire and admin retry inserts a fresh delivery referencing the original job,
including its removal intent. Completed jobs expire after seven days.

Each worker checks the current active album, validates folder identity and root
ancestry, renames/reparents that same folder, uploads missing tagged originals,
and trashes only explicitly removed originals. It checkpoints by Drive file ID
and stable media hash. Gallery metadata and Drive credentials/IDs remain private.
The independent read-only original-comparison archive is not a sync destination.

Deleting an entire album preserves its Drive folder. Deletion first acquires
retention state; an active worker produces a retryable 409 before gallery media
is deleted. Pending jobs become no-ops once deletion finishes. Failed deletion
releases retention state so future edits remain possible. Removing individual
items, including the last item, sends those originals to Drive Trash; the empty
album folder remains. Drive's normal Trash retention applies.

Rollout: inventory and link existing backups before enabling the new worker and
mutation environment; review the exact additive CloudFormation change set;
verify admin authorization and a photo/video canary before completing release.
Rollback pauses the stream mapping and preserves the state table for retry.
Do not restore the old upload dispatcher while the new worker is still running.
Use per-album Retry backup to repair missed historical additions; do not bulk
trash unmatched files. Provider errors are logged by type only.

Backend-only environment: `DRIVE_BACKUP_STATE_TABLE` is supplied by SAM to the
worker, relevant album mutations, and admin status handler. It is not a Vite
variable and does not belong in browser configuration.
