# Album hover-preview manifests

Album-card hover animation is backed by a versioned, immutable manifest. This
keeps ordinary hover traffic independent of album size while preserving the
existing album-detail path during rollout or a transient manifest failure.

## Contract

- Only active public photo albums are eligible.
- A manifest contains two to twelve unique landscape 640px V3 WebP previews.
- The current cover is excluded. Candidate ordering is deterministic; the
  browser shuffles up to five frames independently for each hover.
- Objects live under `albums/{albumId}/preview/v3/hover-{version}.json`, are
  tagged `visibility=public`, and are served only through the guarded
  `public-previews/{albumId}/v3/` CloudFront alias.
- The version is the first 24 hexadecimal characters of the manifest-content
  SHA-256. Objects use one-year immutable caching; the album catalog pointer
  remains on the existing short cache and is invalidated after a pointer change.
- The builder's conditional update rechecks visibility, status, type, cover,
  and image count before exposing a pointer. A stale invocation can publish an
  unreachable immutable object but cannot commit stale album state.

## Online maintenance and reconciliation

Ready preview-metadata writes invoke the builder through a `KEYS_ONLY` stream.
Cover and visibility mutations enqueue a coalescible targeted refresh. Both
event sources use partial-batch responses and the retained async-failure queue.
A reserved-concurrency builder also processes at most twenty public albums per
scheduled reconciliation page and stores only aggregate cursor/retry state in
`PreviewMetadataTable`. A completed cycle sleeps for one day.

After the first production deployment, invoke the function with an empty JSON
event until its aggregate response reports `status: complete`. Never record
album IDs, media keys, manifest URLs, table items, or queue messages in release
evidence. Then require all of the following:

1. the public album catalog returns `ready` or `unavailable` hover status for
   every eligible album;
2. one ready manifest returns JSON, the immutable cache header, the expected
   version, and two to twelve valid same-album 640px WebP URLs;
3. sampled referenced previews return successfully through CloudFront;
4. the targeted queue has no old messages, the async failure queue is empty,
   and the three hover-preview alarms are not in `ALARM`; and
5. opening an album, keyboard focus, pointer-down navigation prefetch, cover
   updates, private/public transitions, and albums with fewer than two eligible
   previews retain their established behavior.

## Failure and rollback

On systematic failures, disable the two builder event-source mappings and the
schedule before changing data. Do not purge either queue or delete immutable
manifests. The frontend safely falls back to the existing album-detail request
when a pointer is absent, malformed, or temporarily unavailable. A frontend
rollback therefore does not require deleting catalog pointers or S3 objects.

Repair the cause, test a single idempotent rebuild, restore event sources, and
rerun bounded reconciliation. Close the incident only after aggregate
reconciliation is complete, queue age is healthy, the async failure queue is
empty, and a public manifest plus its referenced previews pass the contract.
