# Album hover-preview manifests

The hover animation on a public photo album card is driven by a versioned,
immutable manifest, so the hover request stays the same size regardless of
album size. If a manifest is missing or fails to load, desktop hover falls back
to the album-detail request.

## What a manifest holds

- Only active public photo albums get one.
- A manifest lists two to twelve unique landscape 640px V3 WebP previews.
- The current cover is excluded. Candidates are ordered by a hash of album and
  media ID, and the browser shuffles them and shows up to five frames per
  hover (three on mobile).
- Frames use at least the preview width the static cover loaded. Cards on
  section pages also pick the smallest of the 640, 960, 1440 and 1920px V3
  variants that covers their rendered width at the device's pixel density.
  After validating a manifest's 640px URL, the browser derives the sibling URLs
  for the same media. The builder only includes media with all four ready
  variants, so this needs no change to the manifest format, no backfill and no
  album-detail request. A frame wider than 640px falls back to its 640px
  sibling if it fails to load. Reduced-motion and data-saver settings disable
  the animation.
- Objects are stored at `albums/{albumId}/preview/v3/hover-{version}.json`,
  tagged `visibility=public`, and served through the
  `public-previews/{albumId}/v3/` CloudFront path.
- The version is the first 24 hex characters of the SHA-256 of the manifest
  content. Objects use `Cache-Control: public, max-age=31536000, immutable`.
  The album catalog response keeps its existing short cache and is invalidated
  when the pointer changes.
- Before it sets a pointer, the builder's conditional update rechecks
  visibility, status, type, cover and image count. A stale invocation can
  publish an unreferenced immutable object, but it cannot commit stale album
  state.

## Keeping manifests current

Writes to `PreviewMetadataTable` invoke the builder through the table's
`KEYS_ONLY` stream. Cover and visibility changes on photo albums send a
targeted refresh message to the hover-preview refresh queue, and messages for
the same album in one batch are handled with a single rebuild. Both event
sources report partial batch failures, and failed records go to the
async-failure queue.

The builder has reserved concurrency of two. Every 15 minutes a scheduled run
also processes up to twenty public albums per reconciliation page, keeping
only aggregate cursor and retry state in `PreviewMetadataTable`. After a full
cycle completes, the schedule idles for a day.

## First deploy

After the first production deploy, invoke the function with an empty JSON event
until its aggregate response reports `status: complete`. Do not put album IDs,
media keys, manifest URLs, table items or queue messages in release evidence.
Then check all of these:

1. The public album catalog returns a `ready` or `unavailable` hover status for
   every eligible album.
2. One ready manifest returns JSON, the immutable cache header, the expected
   version, and two to twelve valid 640px WebP URLs from the same album.
3. A sample of the referenced previews load through CloudFront.
4. The refresh queue has no old messages, the async-failure queue is empty,
   and none of the three hover-preview alarms is in `ALARM`.
5. Opening an album, keyboard focus, pointer-down navigation prefetch, cover
   updates, private/public switches, and albums with fewer than two eligible
   previews all behave as before.

## If it breaks

If failures look systematic, disable the builder's two event-source mappings
and its schedule before touching any data. Do not purge either queue or delete
immutable manifests. When a pointer is missing, malformed or briefly
unavailable, desktop hover falls back to the album-detail request; automatic
mobile previews skip the animation instead. A frontend rollback therefore does
not require deleting catalog pointers or S3 objects.

Fix the cause, test a single rebuild, re-enable the event sources, and rerun
reconciliation. Close the incident only once aggregate reconciliation is
complete, queue age is normal, the async-failure queue is empty, and a public
manifest and the previews it references pass every check in
[What a manifest holds](#what-a-manifest-holds).
