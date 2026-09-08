# Random-photo startup

The viewer requests `/api/public/random-photos?limit=6` on hover, focus, or
click. Once opened, it requests `limit=80` at low fetch priority and appends
unique photos without replacing the starter or resetting the current index.
Only complete decks enter the five-minute shared browser memory cache.
Closing cancels a pending expansion; reopening retries a failed expansion.
Categories retain the existing `mode=category&value=...` parameters. The
CloudFront query allowlist already includes `limit`, so starter and full
responses have separate cache entries. Omitting `limit` still returns up to 80.

The existing pool builder now batch-loads edited-preview metadata and stores
validated `previewVersion` / `previewKeys` fields alongside references in the
immutable shards. Preview entries are keyed by shard offset so the reader can
project only the requested entries from DynamoDB. Optional preview payloads are
bounded below the item-size limit. No original-comparison capabilities or cached
access decisions are materialized. Requests still read authoritative albums,
check public/active/photo status, category and photo membership, and validate
each preview path against the current image. Missing, old-version or malformed
previews use a batched metadata read for only the affected photos. Legacy pools
and the existing catalog-scan fallback both support the new limit.

## Memory benchmark — 2026-09-08

[Aggregate results and individual observations](random-photo-startup-2026-09-08.json)
contain 36 invocations: 256 / 512 / 1024 MB, six / 80 photos, three cold starts
and three paired warm invocations per combination. A temporary Python 3.12
x86_64 Lambda used the candidate handler, the production reader's existing role
and environment, and the same DynamoDB/SSM reads. It had no event sources or
public URL and was deleted after the run. The production function was unchanged.
Changing a benchmark-only environment marker between pairs forced fresh
execution environments; every cold observation included Lambda's initialization
duration in its report. The wrapper returned aggregate counts and timing only.

Median Lambda duration plus initialization, in milliseconds:

| Memory | Six photos, cold | Six photos, warm | 80 photos, cold | 80 photos, warm |
| --- | ---: | ---: | ---: | ---: |
| 256 MB | 1685 | 383 | 3436 | 1760 |
| 512 MB | 1141 | 155 | 2087 | 876 |
| 1024 MB | 916 | 76 | 1387 | 461 |

The selected 1024 MB setting and six-photo starter reduced measured cold server
time by 73% relative to the 256 MB / 80-photo path. These are small-sample server
measurements, excluding browser/CDN latency and image transfer/decoding. All
observations used existing pools without the new preview entries (`precomputed`
was zero), so they do not establish the additional benefit of precomputation.
The final selective shard projection was added after the memory benchmark;
its query was verified against the live legacy pool with a read-only request.

Higher memory trades faster processing for more billed compute on cold starts:
the six-photo cold median was 0.917 GB-seconds at 1024 MB, versus 0.4213 at
256 MB. Warm six-photo compute decreased from 0.0958 to 0.076 GB-seconds.
A fully opened viewer also performs the background deck request. The JSON
report includes billed compute for each combination; this is not a total AWS
cost estimate and excludes DynamoDB reads and request charges.

## Rollout and verification

Deploy the backend before the frontend through the normal release pipeline.
The template grants the builder `BatchGetItem` on the existing preview table
and sets only `GetPublicAlbumFunction` to 1024 MB. The release-intent contract
allows that specific memory change. Existing shards keep working immediately;
the next mutation-triggered or hourly rebuild populates preview entries.

Check `random_photos_served` logs after rebuild. They expose aggregate source,
photo/precomputed counts and sample/total handler time, without album IDs or
object keys. Confirm `limit=6` returns at most six photos, `limit=80` remains
independently cacheable, and the viewer stays on the same photo as it expands.
Recheck cold and warm requests after precomputed pools are deployed; the
benchmark above does not replace an end-to-end production measurement.

Regression coverage includes starter-before-expansion rendering, deduplication,
pool rotation, cache reuse, background failure/retry, aborts, category changes,
old shard compatibility, selective preview hydration, and current access checks.
