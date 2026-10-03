# Videos-page hero reel

The Videos page hero plays a silent, looping compilation of about one minute,
spliced from calm moments in the public video catalog. The still hero image
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
   several spaced clips. Clips are taken round-robin across videos until the
   loop reaches 60 seconds, ordered so neighbours come from different videos.
   If the catalog is mostly fast cuts, shorter or busier stretches are allowed
   rather than failing.
4. Encode: each clip is trimmed and normalized to 1080p (frame-accurate trims
   inside the filter graph, because demuxer seeks are unreliable across the
   discontinuities of concatenated HLS segments). One pass then crossfades the
   clips (0.75 s), loops the last clip back into the first so the loop point is
   seamless, and writes `reel-1920x1080.mp4`, `reel-1280x720.mp4`, the
   center-cropped portrait `reel-608x1080.mp4` (H.264 high, no audio,
   faststart) and the first frame as `poster.jpg`.

Expect roughly 8 to 10 minutes per build at 10 GB / 6 vCPU; the function has a
15-minute timeout, 4 GB of `/tmp` and reserved concurrency 1.

## Publish

- Files: `site/hero/versions/video/reel/v1/{version}/…`, tagged
  `visibility=public`, one-year immutable caching (the `site/hero/versions/*`
  behaviour has no edge TTL, so deleted versions disappear immediately).
- Pointer: `site/hero/video/reel.json` (short cache, invalidated on publish)
  lists only the renditions. An empty pointer (`"version": null`) removes the
  reel. The frontend accepts only the exact keys the worker writes.
- Poster: the reel's first frame is handed to the existing still-hero pipeline
  (`temp-zips/video-hero-pending` plus a `kind: hero` PreviewQueue job), so the
  still image and the video's first frame match.
- Cleanup keeps the published version, the previous one (for open pages) and
  the current draft, unless any of them contains a video that is no longer
  public.
- State lives in `GallerySettingsTable` under `settingId = hero-reel`:
  `published`, `previous`, `draft`, the admin `job`, and the last `auto` run.

## Triggers

- Once a day the schedule runs `reconcile`. It hashes the eligible inputs and
  exits unless they changed or a still-transcoding video's playlist has
  appeared. New uploads therefore get a fresh reel within about a day; uploads
  are infrequent, so the cheaper cadence is preferred over speed. If a reel
  uses a video that stopped being public, the pointer is cleared before
  rebuilding. To refresh sooner (including right after deleting or hiding a
  video), use Regenerate and Publish in the admin.
- `/admin/hero` → Video Page → **Regenerate video** queues a draft
  (`POST /admin/hero/reel-generate`, async Lambda invoke). The admin previews
  desktop and phone cuts, then **Publish** (`reel-publish`) makes that exact
  draft live after re-checking that its sources are still public. Only one job
  runs at a time; an unclaimed job stops blocking after 20 minutes.

## Frontend

`src/components/HeroReel.jsx` loads the pointer only after the page `load`
event and idle time. It skips reduced-motion, Save-Data and 2G visitors,
picks the portrait cut for tall heroes and otherwise the smallest landscape
file that covers the hero at up to 2× density. It plays muted and inline while
the hero is on screen, pauses off screen or in background tabs, and releases
the decoder after 15 seconds away. If autoplay is refused (for example iOS Low
Power Mode) or the file fails, the still image stays.

## Operations

- Logs carry reason codes and counts only (`hero_reel_published`,
  `hero_reel_draft_failed reason=…`, `hero_reel_stopped …`).
- To pause automatic rebuilds, disable the `HeroReelFunctionReconcile` rule;
  the published reel stays. To remove the reel, publish an empty pointer by
  making no videos eligible or write `{"schemaVersion":1,"version":null,"renditions":[]}`
  to the pointer key and invalidate `/site/hero/video/reel.json`.
- Cost: an unchanged reconcile is a short daily GSI query (well under a cent a
  month); a build is about 5,000 GB-seconds (~$0.08) plus one
  pointer invalidation and the still-hero invalidations.
