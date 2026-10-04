# Videos-page hero reel

The Videos page hero plays one of five silent, looping compilations of about
one minute, spliced from calm moments in the public video catalog; each page
load picks a cut at random. The still hero image
stays the LCP element and the fallback; the reel fades in over it once frames
are playing.

## Build

`HeroReelFunction` (`backend/functions/hero_reel.py`, pure planning in
`hero_reel_plan.py`) runs a static ffmpeg 7.0.2 with libx264. The binary comes
from the `imageio-ffmpeg==0.6.0` manylinux wheel on PyPI; `backend/Makefile`
pins both the wheel's published SHA-256 and the extracted binary's SHA-256 and
copies only the binary into the artifact (about 80 MB unzipped, budgeted in
`ops/ci/artifact_budgets.json`).

1. Inventory: active public video albums from `VisibilityCreatedAtIndex`, every
   item with an `hlsUrl` inside the album's media namespace.
2. Analysis: for each video (newest first, at most 40), one bounded window of
   whole HLS segments (10 to 30 seconds, 600 seconds of footage overall) from
   the smallest rendition of at least 360p. ffmpeg's `scdet` and `signalstats`
   mark cuts (score ≥ 6) and flashes (luma jump ≥ 24); fast-cut edits produce
   no long shots and are skipped.
3. Selection: calm, well-lit shots of at least 3 seconds give 3 to 5 second
   clips, away from each video's first and last 1.5 seconds. Long takes give
   several spaced clips. One analysis plans five cuts: each takes clips
   round-robin across videos until it reaches 60 seconds, ordered so
   neighbours come from different videos, and prefers clips the earlier cuts
   did not use (with per-cut ranking noise), so the cuts differ. If the
   catalog is mostly fast cuts, shorter or busier stretches are allowed rather
   than failing; a small catalog may yield fewer than five cuts.
4. Encode: each clip is trimmed and normalized to 1080p (frame-accurate trims
   inside the filter graph, because demuxer seeks are unreliable across the
   discontinuities of concatenated HLS segments). One pass then joins the
   clips with hard cuts (the loop point is just another cut, from the last
   clip back to the first) and writes `reel-{cut}-1920x1080.mp4`,
   `reel-{cut}-1280x720.mp4`, the center-cropped portrait
   `reel-{cut}-608x1080.mp4` (H.264 high, no audio, faststart, x264 `slow`;
   CRF 21/22 capped at 5, 2.8 and 2.4 Mbit/s, close to the 5 Mbit/s 1080p
   sources so the second generation stays clean) and the first frame as
   `poster-{cut}.jpg`.

Five cuts do not fit one 15-minute invocation, so a build is a chained batch:
the first invocation analyses and plans every cut (each planned clip records
the exact HLS segments that cover it) and stores the plan in the `build` state
record; each following invocation (`action: build-cut`) encodes one cut,
appends its result with a conditional write, and asynchronously invokes the
function for the next cut. A retried invocation finds its cut already appended
and only advances; a newer batch supersedes an older one. Expect roughly 20 to
30 minutes per batch at 10 GB / 6 vCPU (4 GB of `/tmp`, reserved concurrency
1; the next link waits a moment in Lambda's async retry until the previous one
returns).

## Publish

- Files: `site/hero/versions/video/reel/v1/{version}/…`, tagged
  `visibility=public`, one-year immutable caching (the `site/hero/versions/*`
  behaviour has no edge TTL, so deleted versions disappear immediately).
- Pointer: `site/hero/video/reel.json` (short cache, invalidated on publish),
  schema 2, lists only each cut's renditions. An empty pointer
  (`"version": null`) removes the reel. The frontend accepts only the exact
  keys the worker writes and still reads the older single-reel schema 1.
- Poster: the first cut's first frame is handed to the existing still-hero
  pipeline (`temp-zips/video-hero-pending` plus a `kind: hero` PreviewQueue
  job); the reel's fade-in covers the other cuts' different first frames. The
  still-hero worker publishes every advertised `hero-{width}` alias (640 to
  2560) even for a smaller source, reusing the closest variant, so a 1920-wide
  poster never leaves a `srcset` candidate missing.
- Cleanup keeps the published version, the previous one (for open pages) and
  the current draft, unless any of them contains a video that is no longer
  public.
- State lives in `GallerySettingsTable` under `settingId = hero-reel`:
  `published`, `previous`, `draft`, the in-flight `build` batch, the admin
  `job` (with cut progress), and the last `auto` run.

## Triggers

- Once a day the schedule runs `reconcile`. It exits while a batch is in
  flight; otherwise it hashes the eligible inputs and exits unless they changed or a still-transcoding video's playlist has
  appeared. New uploads therefore get a fresh reel within about a day; uploads
  are infrequent, so the cheaper cadence is preferred over speed. If a reel
  uses a video that stopped being public, the pointer is cleared before
  rebuilding. To refresh sooner (including right after deleting or hiding a
  video), use Regenerate and Publish in the admin.
- `/admin/hero` → Video Page → **Regenerate videos** queues a draft batch
  (`POST /admin/hero/reel-generate`, async Lambda invoke) and shows which cut
  is encoding. The admin previews every cut on desktop and phone, then
  **Publish** (`reel-publish`) makes that exact draft live after re-checking that its sources are still public. Only one job
  runs at a time; an unclaimed job stops blocking after 20 minutes.

## Frontend

`src/components/HeroReel.jsx` loads the pointer only after the page `load`
event and idle time and picks one cut at random. It skips reduced-motion, Save-Data and 2G visitors,
picks the portrait cut for tall heroes and otherwise the smallest landscape
file that covers the hero at up to 2× density. It plays muted and inline while
the hero is on screen, pauses off screen or in background tabs, and releases
the decoder after 15 seconds away. Two stacked video layers handle rotation
and resizes: the new rendition of the same cut loads hidden behind the playing
one, seeks to the same moment (aiming ahead by the seek's own delay), and is
revealed once it plays, so the reel continues instead of restarting. A
rendition that fails to load is not retried; the working one keeps playing. If autoplay is refused (for example iOS Low
Power Mode) or the file fails, the still image stays.

## Operations

- Logs carry reason codes and counts only (`hero_reel_published`,
  `hero_reel_draft_failed reason=…`, `hero_reel_stopped …`).
- To pause automatic rebuilds, disable the `HeroReelFunctionReconcile` rule;
  the published reel stays. To remove the reel, publish an empty pointer by
  making no videos eligible or write `{"schemaVersion":2,"version":null,"cuts":[]}`
  to the pointer key and invalidate `/site/hero/video/reel.json`.
- Cost: an unchanged reconcile is a short daily GSI query (well under a cent a
  month); a five-cut batch is about 15,000 GB-seconds (~$0.25) plus one
  pointer invalidation and the still-hero invalidations.
