# Responsive preview V2 guarded rollout

This runbook is the production procedure for the 640w/1280w WebP preview
worker and historical backfill. It is intentionally fail closed. The current
800-pixel JPEG thumbnail remains the fallback and is never overwritten or
deleted by this workflow.

The commands below are examples with placeholders. Do not paste identifiers,
object keys, table items, URLs, titles, owners, or share codes into tickets,
chat, CI logs, or committed files. Both scripts emit aggregate counts and
digests only.

## Safety contract

- `ops/backfill_preview_v2.py` is dry-run by default. Only `--apply` can send
  queue messages. It cannot update DynamoDB, write media, or delete anything.
- `ops/reconcile_preview_v2.py` has no apply mode and uses only read/list/HEAD,
  a 64-byte S3 ranged read, object-tag reads, and CloudFront HEAD requests.
- The representative canary contains five distinct items: public, private,
  unlisted/share-gated (`protected`), portrait, and a source of at least 25 MiB
  by default. The tool fails if all five distinct cases cannot be satisfied.
- Canary selection is deterministic from the complete currently pending plan.
  Its digest binds that pending-plan digest, category-to-item assignment,
  selected jobs, algorithm version, and large-source threshold. No selected
  identifier or per-item hash is printed. A rerun after some items become ready
  selects only from the new pending set and therefore produces new digests.
- A representative apply is rejected unless all selected items are still
  pending, every source HEAD passes, and the selected plan, eligible inventory,
  and canary digests match the reviewed dry run.
- Reconciliation requires the pre-backfill eligible inventory count and digest.
  It rejects a changed album inventory before inspecting derivative objects.
- Never use `--max-jobs` for the production canary. It remains available only
  for backward compatibility and selects the first sorted jobs, not a coverage
  proof.

## 1. Preconditions

Before dispatching anything:

1. Finish the normal local test/infrastructure validation and deploy the exact
   reviewed worker artifact.
2. Verify the application stack is `UPDATE_COMPLETE`, termination protection is
   enabled, DynamoDB PITR/deletion protection and S3 versioning/encryption are
   enabled, and stack drift is `IN_SYNC`.
3. Verify PreviewQueue and its DLQ have zero visible/in-flight messages and all
   preview alarms are `OK`.
4. Record a recovery point. Do not begin during another application deployment,
   album migration, or bulk admin upload.
5. Use an operator identity scoped to the named stack resources. Queue send is
   needed only for the apply command. Reconciliation needs DynamoDB scan, S3
   bucket-control/head/get-object/get-object-tagging, CloudFormation resource
   discovery, CloudFront distribution describe, and STS identity reads.

## 2. Capture the complete pending plan and stable eligible inventory

Run the default aggregate dry run:

```bash
python3 ops/backfill_preview_v2.py \
  --stack-name STACK_NAME \
  --region us-west-2
```

Save the aggregate output in protected release evidence. In particular retain:

- `account`, `albumRecordCount`, and `previewMetadataRecordCount`;
- `totalEligiblePlannedJobCount` and `planDigest` for the current pending plan;
- `eligibleInventoryCount` and `eligibleInventoryDigest`, which remain stable
  as preview metadata moves from pending to ready; and
- every malformed, conflict, skip, and source-validation count.

Stop if any malformed/conflict/source-validation count is nonzero. A count
change requires a new dry run; never waive it or copy guards from an older run.

## 3. Select and review the representative canary

The following command HEAD-validates the complete eligible source inventory,
then selects five distinct cases without printing their identifiers:

```bash
python3 ops/backfill_preview_v2.py \
  --stack-name STACK_NAME \
  --region us-west-2 \
  --representative-canary \
  --canary-large-source-bytes 26214400
```

Require all five `representativeCanary.coverage` values to equal `1`,
`caseCount` and `plannedJobCount` to equal `5`, and
`sourceValidationFailureCount` to equal `0`. Retain these three independent
digests:

- `planDigest`: the exact five queue messages;
- `representativeCanary.fullPlanDigest`: the complete currently pending plan
  from which the deterministic selection was made; and
- `representativeCanary.selectionDigest`: the category-bound canary selection.

Do not change the large-source threshold between dry run, apply, and canary
reconciliation.

## 4. Dispatch exactly the reviewed canary

Rerun the same selection with every independent guard copied from that dry run:

```bash
python3 ops/backfill_preview_v2.py \
  --stack-name STACK_NAME \
  --region us-west-2 \
  --representative-canary \
  --canary-large-source-bytes 26214400 \
  --expected-account-id AWS_ACCOUNT_ID \
  --expected-record-count ALBUM_RECORD_COUNT \
  --expected-preview-record-count PREVIEW_METADATA_RECORD_COUNT \
  --expected-job-count 5 \
  --expected-plan-digest SELECTED_PLAN_DIGEST \
  --expected-full-plan-digest FULL_PLAN_DIGEST \
  --expected-canary-digest CANARY_SELECTION_DIGEST \
  --confirm-stack-name STACK_NAME \
  --confirm backfill-preview-v2 \
  --apply
```

Do not rerun immediately after a partial SQS batch acknowledgement. Stop,
inspect aggregate queue/DLQ/alarm state, and produce a new dry run. Pause if any
worker error, throttle, DLQ message, metadata system error, or unexpected API/S3
latency alarm occurs.

Worker failures log only an allowlisted `reasonCode` such as
`source_read_failed`, `source_transform_failed`,
`preview_object_write_failed`, `visibility_tag_failed`, or
`metadata_commit_failed`. Triage aggregate counts by that field. The worker
never logs exception text, album/media identifiers, or object keys; do not add
those fields as a diagnostic shortcut.

## 5. Verify the canary before expanding

After the queue and in-flight count return to zero, require exactly five new
ready metadata records, ten successful object writes, no pending records, no
DLQ message, and no worker/error/throttle alarm. Review these only through
aggregate metrics or a protected operator session; do not export the selected
identifiers. For all five selected cases verify:

- exact ready/version/key metadata and absence of a pending job ID;
- source SHA-256 consistency across the ready record and both S3 objects;
- exact 640/1280 dimensions in metadata and actual WebP headers;
- valid object checksum/ETag evidence, size bounds, content type, immutable
  cache policy, generator/version/width metadata, and bucket-default encryption;
- exact public/private/unlisted visibility tags;
- public preview HTTP 200 with WebP/immutable headers; and
- private and unlisted preview HTTP 403 through CloudFront.

The aggregate-only reconciler intentionally verifies the complete stable
eligible inventory, not a guessed subset of a now-changed pending plan. Do not
claim its success until the complete backfill has drained. This prevents an
already-complete canary from being silently replaced by five different pending
items during verification.

Also complete the approved visual/device matrix and performance budget review
through authenticated application flows. Keep any operational mapping needed
for that review in an access-controlled process; these tools deliberately do
not disclose which media was selected.

## 6. Dispatch the remaining complete plan

Run a new default dry run after the canary. The eligible inventory count/digest
must still match the original guards; the pending plan will be smaller because
the five canary records are ready. Review its fresh record counts, job count,
and plan digest, then apply the complete pending plan without `--max-jobs` or
`--representative-canary`:

```bash
python3 ops/backfill_preview_v2.py \
  --stack-name STACK_NAME \
  --region us-west-2 \
  --expected-account-id AWS_ACCOUNT_ID \
  --expected-record-count ALBUM_RECORD_COUNT \
  --expected-preview-record-count PREVIEW_METADATA_RECORD_COUNT \
  --expected-job-count REMAINING_PLANNED_JOB_COUNT \
  --expected-plan-digest REMAINING_PLAN_DIGEST \
  --confirm-stack-name STACK_NAME \
  --confirm backfill-preview-v2 \
  --apply
```

Leave worker concurrency at two during the initial rollout. Do not raise it
unless Lambda duration/memory/errors/throttles, SQS age/depth/DLQ, S3 errors,
DynamoDB throttles, API latency, and preview transfer budgets remain healthy.

## 7. Full post-backfill reconciliation

After all queue and in-flight counts are zero, run full reconciliation using
the original stable inventory guards:

```bash
python3 ops/reconcile_preview_v2.py \
  --stack-name STACK_NAME \
  --region us-west-2 \
  --expected-account-id AWS_ACCOUNT_ID \
  --expected-inventory-count ELIGIBLE_INVENTORY_COUNT \
  --expected-inventory-digest ELIGIBLE_INVENTORY_DIGEST
```

Completion requires exit code zero, `status: pass`, `reconciliationScope: full`,
`entryValidatedCount == eligibleInventoryCount`, `objectValidatedCount ==
expectedObjectCount`, and no failure counts. Full scope additionally rejects
duplicate or orphaned preview metadata records.

Any failure means the backfill is incomplete. Do not delete V1 thumbnails,
enable cleanup, or call the migration complete. Keep aggregate output as release
evidence, triage through protected logs/metrics without printing identifiers,
and produce a fresh digest-bound retry plan only after the cause is fixed.

## 8. Stop and rollback

On an alarm or access regression, stop queue consumption and producer dispatch,
then revert frontend preference to the existing `thumbnailUrl`. Do not delete
raw media, V1 thumbnails, preview objects, metadata rows, queues, DLQ messages,
or KMS keys. The data path is additive, so rollback is a reader/deployment
change, not destructive cleanup.
