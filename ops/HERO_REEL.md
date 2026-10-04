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
   the smallest rendition of at least 360p. Segments are separate files (the
   older ladder) or byte ranges of one single-file rendition (the current
   ladder); each range is fetched with an S3 range read. ffmpeg's `scdet` and `signalstats`
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
4. Encode: clips are cut from the **original uploads** (typically 4K), not
   from the 1080p HLS renditions, so the reel is a single generation from
   the camera-quality source. The bundled ffmpeg is a static build whose own
   DNS resolution crashes, so it never contacts S3: the worker runs a loopback
   HTTP server (`SourceServer`, 127.0.0.1, random per-object tokens) that
   answers ffmpeg's byte-range requests with bounded 8 MB S3 range reads under
   the worker role. Each original is probed once; HDR (PQ/HLG) originals are
   tone-mapped to SDR BT.709 (zscale + hable). An original that cannot be read
   or decoded falls back to the clip's planned 1080p HLS segments (frame-
   accurate trims inside the filter graph, because demuxer seeks are
   unreliable across concatenated HLS segments). Each clip is normalized to
   the orientation's master frame (landscape 2560x1440, portrait 1080x1920
   centre crop), then one pass joins the clips with hard cuts (the loop point
   is just another cut back to the first clip) and encodes that orientation's
   adaptive ladder:

   | Orientation | Rungs (peak Mbit/s) |
   | --- | --- |
   | landscape | 2560x1440 (12), 1920x1080 (8), 1280x720 (4), 960x540 (1.6) |
   | portrait | 1080x1920 (8), 720x1280 (4), 540x960 (1.6) |

   x264 `medium`, CRF 19-22 under those caps, keyframes every 4 s with no
   scene-cut keyframes so every rung switches at the same segment
   boundaries. Each rung is one fragmented MP4 addressed by byte ranges
   (`reel-{cut}-{w}x{h}.mp4` plus its `.m3u8`); the worker writes the master
   playlist `reel-{cut}-{orientation}.m3u8` itself (peak `BANDWIDTH`, measured
   `AVERAGE-BANDWIDTH`, the 720p rung first because Safari starts on the first
   variant). The landscape pass also writes the first frame as
   `poster-{cut}.jpg` (2560 wide).

Five cuts in two orientations do not fit one 15-minute invocation, so a build
is a chained batch: the first invocation analyses and plans every cut (each
planned clip records its original and the exact HLS segments that cover it)
and stores the plan in the `build` state record; each following invocation
(`action: build-cut`, `step` n) encodes one orientation of one cut (step
2c = landscape of cut c, 2c+1 = portrait), uploads it (rungs first, master
last), appends its result with a conditional write, and asynchronously invokes
the function for the next step. A retried invocation finds its step already
appended and only advances; a newer batch supersedes an older one, and a batch
planned by an older worker version is abandoned. Expect roughly 40 to 60
minutes per batch at 10 GB / 6 vCPU (4 GB of `/tmp`, reserved concurrency 1;
the next link waits a moment in Lambda's async retry until the previous one
returns).

## Publish

- Files: `site/hero/versions/video/reel/v1/{version}/…`, tagged
  `visibility=public`, one-year immutable caching (the `site/hero/versions/*`
  behaviour has no edge TTL, so deleted versions disappear immediately).
- Pointer: `site/hero/video/reel.json` (short cache, invalidated on publish),
  schema 3: each cut lists its landscape and portrait master playlists
  (`streams`), or MP4 `renditions` for a reel published before adaptive
  streams. An empty pointer (`"version": null`) removes the reel. The frontend
  accepts only the exact keys the worker writes and still reads schemas 1-2.
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
event and idle time and picks one cut at random. It skips reduced-motion,
Save-Data and 2G visitors and picks the portrait stream for tall heroes,
otherwise the landscape one. Safari plays the stream natively; elsewhere
hls.js (lazy `vendor-hls` chunk) does, capped to the hero's on-screen size,
seeded with the reported downlink (or 5 Mbit/s) and then adapting to measured
bandwidth, so slow connections stay on a low rung instead of stalling and
fast ones climb to 1440p within a few segments. Older MP4 cuts still play as
files. It plays muted and inline while
the hero is on screen, pauses off screen or in background tabs, and releases
the decoder after 15 seconds away. Two stacked video layers handle rotation:
the other orientation's stream of the same cut loads hidden behind the playing
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
  month); a five-cut batch is about 30,000 GB-seconds (~$0.50) plus one
  pointer invalidation and the still-hero invalidations.
