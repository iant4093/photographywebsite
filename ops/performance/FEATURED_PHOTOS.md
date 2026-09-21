# Featured-photo exploration

The home hero's **Explore Featured Photos** button opens a shuffled selection
of manually favorited public photos. The heart beside each photo section opens
the same viewer restricted to that category, across every year. Only the strict
boolean `isFavorite: true` in the album image manifest qualifies. Private,
unlisted, inactive, video, and legacy images without a favorite flag are excluded.
The existing random explorer continues sampling all public photos, including
favorites.

## Loading and storage

- `GET /api/public/featured-photos?limit=6` is requested only on pointer intent,
  keyboard focus, or click. The viewer warms the first two responsive previews.
- Opening the viewer expands incomplete sessions with a low-priority `limit=80`
  request. It preserves the current photo and deduplicates by album and media ID.
  A collection of twelve favorites loads as six then twelve; a collection of
  six or fewer needs one request. Empty sections display a retryable empty state.
- Category requests use `mode=category&value=...`, within the existing public
  CloudFront query allowlist. Both starter and full responses have a five-minute
  edge TTL and ten-minute stale-while-revalidate window, matching random photos.
- The featured viewer uses its own five-minute in-memory session cache. Neither
  the API nor browser borrows images from random-photo sessions to fill a deck.
- Featured decks occupy `__featured_photo_pools_v1__` in `PreviewMetadataTable`.
  The shared storage helpers retain the existing random partition by default.
  Decks use 256-reference shards, bounded preview payloads, immutable generations,
  a metadata pointer switch, and cleanup confined to their own partition.
- Requests read only the shards needed for a rotating five-minute sample, batch
  hydrate the selected albums, and validate current public/photo/active state,
  category, image membership, and favorite status. Valid precomputed previews
  avoid metadata lookups; missing previews use the normal batched metadata read.
  Missing, corrupt, or stale decks fall back to reservoir sampling strict
  favorites from public album manifests. Legacy S3 listings are never needed.

## Refresh and rollout

The existing single-concurrency `RandomPhotoPoolBuilderFunction` builds both
independent deck sets from one public-album query and one batch of preview reads.
Each set has its own content digest. Unchanged sets do not write generations or
invalidate their endpoint. Favorite writes enqueue the existing delayed refresh
queue; album creation, media removal, category and visibility changes retain
their existing refresh triggers. Hourly reconciliation repairs missed refreshes.

Catalog invalidations now also cover `/api/public/featured-photos*`, including
visibility revocations. Changed featured generations request only that wildcard;
random-only refresh invalidations remain scoped to random photos. Admin edits
are asynchronous, so existing browser/edge sessions can retain their cached
selection until it expires. An already-open viewer keeps its selection stable.

Deploy the SAM changes before the frontend. The new route shares the existing
public handler, front-door validation, and read permissions. `UpdateImageFunction`
gains only send permission for the existing refresh queue. No new table, queue,
schedule, or distribution is required. After deployment, invoke the builder once
to seed favorites that already exist; check its aggregate `featured.poolCount`,
`featured.totalPhotos`, and `featured.changed` fields. The favorite-only scan
fallback supports requests before seeding. Repeat reconciliation without content
changes to confirm both deck sets report `changed: false`.

Verification covers separate partitions/cache namespaces, sparse and empty
collections, starter/full loading, canceled requests, stale/unfavorited records,
public visibility, category scoping, preview reuse, and random-photo regressions.
Local tests establish bounded request behavior; production latency should be
measured after the initial featured decks have been seeded.
