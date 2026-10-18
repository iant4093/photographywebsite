# Album hover-preview manifests

When you hover an album card, the little animation comes from a versioned,
immutable manifest. I built it this way so hover traffic stays the same size no
matter how big the album is. The old album-detail path is still there as a
fallback during rollout or if a manifest briefly fails.

## What a manifest holds

- Only active public photo albums get one.
- A manifest lists two to twelve unique landscape 640px V3 WebP previews.
- The current cover is left out. Candidates come out in a fixed order, and the
  browser shuffles up to five frames on its own for each hover.
- Larger photo-section cards pick the smallest of the existing 640, 960, 1440
  and 1920px V3 variants that covers their rendered width at the device's pixel
  density. After it validates a manifest's 640px URL, the browser works out the
  sibling URLs for the same media. The builder already requires the full set of
  ready variants, so this doesn't change the manifest format or its cache, and
  it needs no backfill or extra album-detail request. Each frame loads when
  it's needed and drops back to its 640px sibling if the larger file fails.
  Cards elsewhere keep 640px frames. Reduced-motion and data-saver settings and
  the three-frame mobile limit still apply.
- Objects live under `albums/{albumId}/preview/v3/hover-{version}.json`, are
  tagged `visibility=public`, and are only served through the
  `public-previews/{albumId}/v3/` CloudFront alias.
- The version is the first 24 hex characters of the SHA-256 of the manifest
  content. Objects get one-year immutable caching. The album catalog pointer
  keeps its existing short cache and gets invalidated when the pointer changes.
- Before it exposes a pointer, the builder's conditional update checks
  visibility, status, type, cover and image count again. A stale invocation can
  publish an immutable object nobody points to, but it can't commit stale album
  state.

## Keeping manifests current

Ready preview-metadata writes invoke the builder through a `KEYS_ONLY` stream.
Cover and visibility changes queue a targeted refresh that can be coalesced.
Both event sources use partial-batch responses and the retained async-failure
queue.

The builder runs with reserved concurrency. On a schedule it also works through
at most twenty public albums per reconciliation page, and it keeps only
aggregate cursor and retry state in `PreviewMetadataTable`. Once it finishes a
full cycle it sleeps for a day.

## First deploy

After the first production deploy, invoke the function with an empty JSON event
until its aggregate response says `status: complete`. Don't put album IDs, media
keys, manifest URLs, table items or queue messages in release evidence. Then
check all of these:

1. The public album catalog returns a `ready` or `unavailable` hover status for
   every eligible album.
2. One ready manifest returns JSON, the immutable cache header, the expected
   version, and two to twelve valid 640px WebP URLs from the same album.
3. A sample of the referenced previews load through CloudFront.
4. The targeted queue has no old messages, the async failure queue is empty,
   and none of the three hover-preview alarms is in `ALARM`.
5. Opening an album, keyboard focus, pointer-down navigation prefetch, cover
   updates, private/public switches, and albums with fewer than two eligible
   previews all behave the way they did before.

## If it breaks

If failures look systematic, turn off the two builder event-source mappings and
the schedule before you touch any data. Don't purge either queue or delete
immutable manifests. When a pointer is missing, malformed or briefly
unavailable, the frontend falls back to the existing album-detail request on
its own. So a frontend rollback doesn't need you to delete catalog pointers or
S3 objects.

Fix the cause, test a single idempotent rebuild, turn the event sources back
on, and rerun reconciliation. Close the incident only once aggregate
reconciliation is complete, queue age looks healthy, the async failure queue is
empty, and a public manifest and the previews it points to pass every check in
[What a manifest holds](#what-a-manifest-holds).
