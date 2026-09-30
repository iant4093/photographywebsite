"""Architecture atlas: one authored model for Mermaid and editable Miro shapes.

Each lane is a specific request, data, or control flow. Repeated service names
refer to the same resource; view numbers connect detail without crossing frames.
"""

def node(title, detail, kind="app"):
    return {"title": title, "detail": detail, "kind": kind}


def lane(title, nodes, labels, dashed=False):
    assert len(labels) == len(nodes) - 1
    return {"title": title, "nodes": nodes, "labels": labels, "dashed": dashed}


def view(slug, title, subtitle, lanes, notes, sources):
    return dict(slug=slug, title=title, subtitle=subtitle, lanes=lanes, notes=notes, sources=sources)


VIEWS = [
    view("00-system", "00 · System overview", "Start here. Follow a lane left to right; open its numbered detail view.", [
        lane("WEBSITE DELIVERY · 01–02", [
            node("Visitors, clients, admin", "Browser and installed PWA", "actor"),
            node("Frontend CloudFront", "Route 53 + ACM + WAF", "edge"),
            node("Private frontend S3", "HTML, versioned JS/CSS, assets", "data"),
            node("React application", "Public pages + protected portal"),
        ], ["HTTPS", "OAC origin read", "serves app"]),
        lane("APPLICATION REQUESTS · 02–03, 06, 09", [
            node("React API client", "Same-origin /api"),
            node("CloudFront API behavior", "Public cache / protected no-store", "edge"),
            node("API Gateway + Lambda", "Origin check + route/album auth"),
            node("Application state", "DynamoDB + Cognito + providers", "data"),
        ], ["JSON requests", "verified origin", "authorized work"]),
        lane("MEDIA LIFECYCLE · 04–06, 08", [
            node("Admin upload + commit", "Presigned S3 transfer; API metadata", "actor"),
            node("Private media S3", "Original uploads + JPEG fallback", "data"),
            node("Background processing", "SQS / Lambda / MediaConvert", "job"),
            node("Viewer media", "Public CDN; private signed S3", "edge"),
        ], ["direct bytes", "derive / index", "publish outputs"]),
        lane("CHANGE AND OPERATE · 10–11", [
            node("GitHub Actions", "PR checks; main release; audits", "ops"),
            node("AWS OIDC roles", "Plan / execute / frontend / audit", "security"),
            node("Application + ops", "SAM app; separately guarded ops", "ops"),
            node("Observe and recover", "Logs, alarms, PITR, backups", "ops"),
        ], ["short-lived identity", "scoped control", "operational signals"], True),
    ], "The browser-only editor (07) uses local files, Web Workers, WebGL and IndexedDB. It has no media-upload API. This atlas describes checked-in implementation and documented topology, not a fresh AWS deployment audit.", ["src/App.jsx", "backend/template.yaml", "ops/API_FRONT_DOOR.md", "ops/CI_CD.md"]),

    view("01-experience", "01 · Pages and visitor journeys", "The public experience, its shared components, and the services each journey uses.", [
        lane("PHOTO BROWSING", [
            node("Home + Search", "/ and /search; filter album catalog", "actor"),
            node("Photo album", "/album/:albumId; cards + hover"),
            node("Photo lightbox", "Responsive image + Before/After"),
            node("Photo actions · 06 / 08", "Share, QR, download, ZIP, print"),
        ], ["open album", "select photo", "authorized action"]),
        lane("VIDEO BROWSING", [
            node("Videos", "/videos; category sections", "actor"),
            node("Video album", "/video/:albumId; hover previews"),
            node("VideoPlayer", "Native HLS / hls.js + fallback"),
            node("Media delivery · 04 / 06", "HLS segments, MP4, thumbnails", "edge"),
        ], ["open album", "play video", "fetch media"]),
        lane("DISCOVERY", [
            node("Explore + Stats", "/explore/* and /stats", "actor"),
            node("Browse or play", "Color, lens, exposure, time, season;\nshuffle, guess settings, 3D gallery"),
            node("Public read APIs · 03", "Explore, random, stats, albums"),
            node("Verified public photos", "Current visibility + membership;\nlightbox and album links"),
        ], ["choose experience", "fetch data", "resolve references"]),
        lane("CONTACT AND SHARED APP SHELL", [
            node("Contact form", "/contact + Turnstile", "actor"),
            node("Contact handler", "Validate + rate limit"),
            node("Resend", "Transactional contact email", "provider"),
        ], ["POST /api/contact", "send message"]),
    ], "Shared shell: lazy routes/Suspense, AuthProvider, navigation, theme, accessibility, metadata/social links, analytics and PWA registration. /privacy explains data use; unmatched routes show NotFound. The immersive Three.js / React Three Fiber gallery uses streamed media and a WebGL capability fallback. Accounts are in 02, the local editor in 07, and admin tools in 09. The route inventory lists every URL.", ["src/App.jsx", "src/main.jsx", "src/pages/Explore.jsx", "src/pages/ImmersiveGallery.jsx", "src/components/PhotoLightbox.jsx", "src/components/VideoPlayer.jsx", "src/components/DocumentMetadata.jsx"]),

    view("02-edge-access", "02 · Edge, identity and authorization", "Request boundaries are explicit: edge controls, verified identity, then resource access.", [
        lane("API FRONT DOOR", [
            node("Browser HTTPS /api", "Canonical website origin", "actor"),
            node("Frontend CloudFront + WAF", "Managed rules; API / Explore limits", "edge"),
            node("Regional HTTP API", "origin-api custom domain; JWT\nauthorizer on protected routes", "edge"),
            node("Lambda request boundary", "Verify X-Origin-Verify first;\nthen validation + authorization", "security"),
        ], ["edge inspection", "origin secret header", "dispatch handler"]),
        lane("SIGN IN AND SESSION", [
            node("Login / challenge UI", "/login; password + bot check", "actor"),
            node("Login + challenge handlers", "Turnstile + RateLimitTable"),
            node("Cognito user pool", "Password / new-password / TOTP;\nAdmins group", "security"),
            node("AuthProvider session", "Token refresh; sign-out cleanup;\n/dashboard or /admin"),
        ], ["same-origin POST", "authenticate", "verified tokens"]),
        lane("RESOURCE ACCESS POLICY", [
            node("Requested album or media", "Public, private, or unlisted"),
            node("Shared auth helpers", "Gateway claims or optional JWT;\nactive album + valid visibility", "security"),
            node("Grant decision", "Public / exact owner sub / Admins;\nunlisted: active exact share code", "security"),
            node("Scoped response", "Allowlisted metadata / short-lived\ncapability; otherwise 401/403/404"),
        ], ["load current state", "verify grant", "authorize resource"]),
        lane("STATIC DELIVERY AND SOCIAL ENTRY", [
            node("Route 53 + ACM", "Canonical, www, prints, API;\nglobal + regional certificates", "edge"),
            node("CloudFront Functions", "www redirect + social routing", "edge"),
            node("Selected destination", "SPA from private S3, or\n/public/social HTML for crawlers", "edge"),
            node("Browser shell + policies", "CSP, CORS, HSTS; PWA shell/assets;\nAPI responses outside SW cache"),
        ], ["DNS + TLS", "choose route", "deliver response"]),
    ], "The normal browser API base is /api. The documented production contract disables execute-api and rejects direct regional-origin calls without the edge secret. Client ProtectedRoute checks Admins and MFA setup; backend admin handlers enforce verified Admins claims. Do not mistake a UI MFA gate for a per-request backend MFA claim check. Protected catalog snapshots are process-memory only; logout clears them. Resend/Turnstile/Google credentials are server-side SSM parameters; IAM scopes access and KMS decrypt where configured.", ["ops/API_FRONT_DOOR.md", "ops/cloudfront_frontend.py", "ops/cloudfront_social_router.js", "backend/functions/front_door.py", "backend/functions/auth_helpers.py", "backend/functions/album_access.py", "src/context/authContext.jsx", "src/components/ProtectedRoute.jsx", "public/service-worker.js"]),

    view("03-catalog-data", "03 · Catalog, indexes and data ownership", "Authoritative album state decides access; derivative indexes accelerate discovery.", [
        lane("CATALOG AND PRESENTATION", [
            node("Home / Videos / Search", "Public catalogs; owner/admin lists"),
            node("Catalog handlers", "get_public_albums / get_albums"),
            node("AlbumsTable", "Album identity, visibility, owner,\nshare, status + legacy manifest", "data"),
            node("GallerySettingsTable", "Read order/section settings;\nmerge into catalog response", "data"),
        ], ["paged requests", "query selected GSI", "combine settings"]),
        lane("ALBUM DETAIL AND ADMIN PAGINATION", [
            node("Album/detail readers", "Public, client, shared, admin"),
            node("Album access + media store", "Check album; normalized rows\nwith legacy migration fallback", "security"),
            node("AlbumMediaTable", "albumId + mediaId;\nAlbumOrderIndex for paging", "data"),
            node("PreviewMetadataTable", "Join ready variants and metadata\nfor selected media IDs", "data"),
        ], ["request detail", "read media", "enrich response"]),
        lane("EXPLORE AND RANDOM PHOTOS", [
            node("Explore / random endpoints", "Filters, samples, shuffle decks"),
            node("PreviewMetadataTable", "Sparse Explore refs, readiness\nmarkers, sharded random pools", "data"),
            node("Authoritative recheck", "Join current AlbumsTable +\nmedia/preview membership", "security"),
            node("Public discovery DTO", "Responsive URLs + coarse EXIF;\nstale references cannot grant access"),
        ], ["read indexed refs", "resolve candidates", "serialize allowed"]),
        lane("SUMMARY AND AUXILIARY STATE", [
            node("Stats + admin readers", "Public stats; reports in 09"),
            node("Authoritative / cached reads", "Public albums for photo stats;\nreport caches for admin metrics"),
            node("Other DynamoDB tables", "RateLimit + Analytics + cost,\nDrive, GitHub report caches", "data"),
            node("OriginalComparisonTable · 08", "Separate private matching state;\nalbum/media keyed comparison DTO", "data"),
        ], ["request summaries", "read by purpose", None]),
    ], "AlbumsTable GSIs: ShareCodeIndex, VisibilityCreatedAtIndex, VisibilityCreatedAtSummaryIndex and OwnerSubCreatedAtIndex (deployment-phase gated). Public queries never trust an index alone. Explore temporal readiness fails closed; color/lens and random decks retain bounded/legacy fallbacks. PreviewMetadataTable also stores hover pointers and random-pool generations. Each table's keys, TTL and infrastructure identity are listed in the inventory.", ["backend/template.yaml", "backend/functions/get_public_albums.py", "backend/functions/get_public_album.py", "backend/functions/album_media_store.py", "backend/functions/media_access.py", "backend/functions/explore_index.py", "backend/functions/random_photo_pools.py", "backend/functions/photography_stats.py"]),

    view("04-media-ingestion", "04 · Uploads, previews, video and heroes", "Large bytes go directly to S3; protected API commits start processing.", [
        lane("UPLOAD AND COMMIT", [
            node("Admin upload UI", "Photo/video files + local previews", "actor"),
            node("get_upload_url", "Admin-only presigned upload;\nkey, type, size and pending tag", "security"),
            node("Browser → ImagesBucket", "Direct PUT of source + fallback;\nAPI does not carry large bytes", "data"),
            node("create_album / add_images", "Validate owned keys; EXIF;\ncommit media rows + visibility tags"),
        ], ["request capability", "upload bytes", "commit metadata"]),
        lane("RESPONSIVE PHOTO DERIVATIVES", [
            node("Committed photos", "Keep JPEG fallback available"),
            node("PreviewQueue", "Bounded jobs + partial retries", "job"),
            node("PreviewWorker", "Node.js 22 + Sharp; V3 WebP\nvariants, blurhash, Explore metadata", "job"),
            node("S3 + PreviewMetadataTable", "Versioned variants + ready record;\nvisibility checks and invalidation", "data"),
        ], ["enqueue", "consume", "publish ready"]),
        lane("VIDEO TRANSCODING", [
            node("Committed video album", "create_album records source/job"),
            node("AWS MediaConvert", "Assumed media service role", "job"),
            node("ImagesBucket HLS output", "Master playlist + renditions;\nsource MP4 remains available", "data"),
            node("Media CDN → VideoPlayer", "Public HLS when accessible;\nprotected/fallback signed source", "edge"),
        ], ["submit job", "read source / write HLS", "play media"]),
        lane("MANAGED HOMEPAGE AND VIDEO HERO", [
            node("ManageHero", "/admin/hero; image covers for\nphoto + video landing pages", "actor"),
            node("hero_cover + PreviewQueue", "Presign image PUT; validate complete;\nqueue hero publication job"),
            node("Sharp hero worker", "Write ImagesBucket hero variants\nand manifest; invalidate cache", "job"),
            node("Home + Videos hero", "Managed CDN images; bundled\nfrontend image fallback", "edge"),
        ], ["upload + complete", "queue publication", "serve cover"]),
    ], "After commit, auxiliary jobs also refresh catalog caches, random pools, hover manifests, optional edited-file Drive backups (09), and original comparisons (08). Preview generation is additive: failure keeps source and JPEG fallback intact. Source media, previews, HLS, QR assets and temporary ZIPs share ImagesBucket but use separate prefixes and policies. No S3-upload event is assumed to dispatch these jobs; the implemented upload-completion path does.", ["src/pages/Admin.jsx", "src/pages/UploadVideo.jsx", "src/pages/ManageHero.jsx", "backend/functions/get_upload_url.py", "backend/functions/create_album.py", "backend/functions/add_images.py", "backend/functions/hero_cover.py", "backend/functions/media_helpers.py", "backend/preview_worker/index.mjs", "backend/preview_worker/hero.mjs"]),

    view("05-consistency-workers", "05 · Mutation consistency and background work", "Separate lanes explain invalidation, materialized views, reconciliation and failures.", [
        lane("VISIBILITY, DELETION AND CACHES", [
            node("Album / image mutations", "Update, delete, reorder, share;\nsource-of-truth authorization"),
            node("Retag / remove / reconcile", "Restrict tags before private change;\nupdate media, preview, QR state"),
            node("CacheInvalidationQueue", "Coalesce narrow paths;\nCacheInvalidationWorker", "job"),
            node("Frontend + media CDN", "Invalidate affected catalog,\nalbum and public-preview paths", "edge"),
        ], ["apply transition", "enqueue paths", "invalidate"], True),
        lane("ALBUM CARD HOVER MANIFESTS", [
            node("Preview stream + refresh", "PreviewMetadata stream; targeted\nHoverPreviewRefreshQueue; 15 min", "job"),
            node("HoverPreviewManifestBuilder", "Recheck public album + cover;\nselect ready landscape previews", "job"),
            node("Manifest + pointer", "Immutable S3 hover JSON +\nPreviewMetadataTable pointer", "data"),
            node("AlbumCard", "Fetch small manifest via CDN;\nshuffle five frames locally"),
        ], ["trigger", "publish conditionally", "hover playback"]),
        lane("RANDOM DECKS AND NORMALIZED MEDIA", [
            node("Targeted random refresh", "RandomPhotoRefreshQueue;\nhourly reconciliation", "job"),
            node("RandomPhotoPoolBuilder", "Query current public albums;\nimmutable shards + pointer swap", "job"),
            node("PreviewMetadataTable", "Materialized global/category decks;\npublic readers recheck every ref", "data"),
        ], ["trigger", "publish generation"]),
        lane("LEGACY MIGRATION REPAIR", [
            node("EventBridge · 15 minutes", "Bounded media reconciliation", "job"),
            node("AlbumMediaBackfill", "AlbumsTable legacy manifests", "job"),
            node("AlbumMediaTable", "Repair normalized rows;\nadmin media paging", "data"),
        ], ["invoke", "backfill"]),
    ], "AlbumsTable → RandomPhotoPoolBuilder stream mapping is retained but disabled; the queue and hourly schedule are active. Preview and original-comparison queues have dedicated DLQs. Cache/random/hover queue redrive, failed hover stream batches, and async ZIP/Drive/tag invocations use AsyncFailureQueue where configured. Scheduled functions have bounded retries; do not assume every worker has a Lambda DLQ. TagMediaObject is the separate asynchronous tagging worker. Queue age, depth, worker errors/throttles and failures feed 11.", ["backend/template.yaml", "backend/functions/update_album.py", "backend/functions/delete_album.py", "backend/functions/delete_images.py", "backend/functions/cache_invalidation_worker.py", "backend/functions/hover_preview_manifest_builder.py", "backend/functions/random_photo_pool_builder.py", "backend/functions/backfill_album_media.py", "backend/functions/tag_media_object.py"]),

    view("06-sharing-delivery", "06 · Sharing, downloads and print orders", "Public CDN access and short-lived capabilities have different privacy boundaries.", [
        lane("VIEW PUBLIC OR PROTECTED MEDIA", [
            node("Public / client / shared viewer", "SharedAlbum checks Turnstile;\nowner/admin JWT where applicable", "actor"),
            node("Album authorization", "Current visibility + membership;\nactive exact unlisted share grant", "security"),
            node("Media URLs", "Public: CloudFront OAC + tags;\nprotected: presigned S3 GET", "edge"),
            node("Progressive image / video", "Blurhash → responsive preview;\nexpiry-aware refresh + fallback"),
        ], ["open album", "serialize allowed", "fetch bytes"]),
        lane("SINGLE FILE AND ALBUM ZIP", [
            node("Download or ZIP action", "Album route or exact share route", "actor"),
            node("Download / create_zip API", "Authorize media; rate limit;\nreturn URL or async ZIP job", "security"),
            node("WorkerZip → ImagesBucket", "Read selected sources; write\ntemp-zips job/status + archive", "job"),
            node("Browser download", "Poll job; signed archive URL;\ntemp-zips expire after one day"),
        ], ["POST request", "ZIP only: invoke", "download ready ZIP"]),
        lane("PRINT CAPABILITY AND ISOLATED STORE", [
            node("Photo → Order a Print", "prepare_print authorizes access", "actor"),
            node("Five-minute capability", "One photo; signed opaque token;\nprint/session rechecks grant", "security"),
            node("Opaque reference preview", "Copy JPEG to fotomoto/references;\npublic CDN; 30-day lifecycle", "data"),
            node("Isolated print.html", "prints subdomain iframe; clears\nits storage before vendor script", "edge"),
        ], ["issue capability", "redeem + copy", "preview for widget"]),
        lane("ORDER FULFILLMENT", [
            node("Fotomoto", "Products, crop, checkout;\nStripe payment integration", "provider"),
            node("Photographer", "Receive paid order; identify photo", "actor"),
            node("Manual print-ready upload", "Upload matching high-resolution\nJPEG to the vendor order", "actor"),
            node("Fotomoto lab", "Produce, pack, ship;\ncustomer order updates", "provider"),
        ], ["paid order", "supply original", "fulfill order"]),
    ], "Public preview aliases rewrite to canonical tagged objects; direct public S3 access is denied. Original-comparison previews use the separate private bucket in 08. Share/QR URLs navigate back through access checks. Single-file downloads return a capability directly and do not use WorkerZip. Revocation blocks new capabilities; existing signed URLs remain valid until expiry, and redeemed Fotomoto references survive until lifecycle expiry. Fotomoto never receives AWS credentials or automatic access to print-resolution originals.", ["backend/functions/get_shared_album.py", "backend/functions/media_access.py", "backend/functions/get_download_url.py", "backend/functions/create_zip.py", "backend/functions/worker_zip.py", "backend/functions/prepare_print.py", "src/utils/zipDownload.js", "src/print-main.js", "ops/FOTOMOTO_PRINTS.md"]),

    view("07-local-editor", "07 · Browser-only photo editor", "The /editor workspace processes local files independently of the gallery backend.", [
        lane("OPEN AND DECODE", [
            node("Local photo file", "User file picker or drag/drop", "actor"),
            node("Standard / RAW decoders", "Browser image decode or\nrawconvert-wasm RAW conversion"),
            node("Editor source + previews", "Orientation, working buffers;\nfast and full preview sizes"),
            node("Local editing session", "Geometry, adjustments, presets;\nundo/redo, comparison, clipping"),
        ], ["open", "decode", "edit"]),
        lane("INTERACTIVE PREVIEW", [
            node("Direct controls", "Exposure, color, crop/rotate;\nzoom and pan", "actor"),
            node("WebGL live renderer", "Responsive GPU preview;\nworker fallback when needed"),
            node("Web Worker + canvas", "Exact queued processing;\ncancel stale work", "job"),
            node("Before/After canvas", "Local source vs current edit;\nkeeps UI responsive"),
        ], ["adjust", "settle / fallback", "render"]),
        lane("SAVE AND RESTORE LOCALLY", [
            node("Source + editor state", "History, geometry, adjustments"),
            node("IndexedDB sessionStore", "Persist local source and session;\nlocalStorage holds preferences", "data"),
            node("Reopened /editor", "Restore prior session;\nclear session on request"),
        ], ["save", "restore"]),
        lane("EXPORT", [
            node("Export settings", "JPEG / PNG / WebP;\nquality, dimensions, filename", "actor"),
            node("Dedicated export worker", "Full-resolution adjustments;\nprogress, timeout, cancellation", "job"),
            node("Canvas → Blob", "sRGB; metadata removed\nfrom exported image"),
            node("Local browser download", "User saves edited output", "actor"),
        ], ["start", "encode", "save file"]),
    ], "Local editor files and adjustments are not sent to an application media endpoint. Normal page-shell delivery and permitted page analytics still apply. The editor's local Before/After canvas is distinct from the gallery's server-generated camera-original comparisons in 08. RAW WASM has a build-time CSP compatibility patch in scripts/patch-rawconvert-csp.mjs.", ["src/pages/Editor.jsx", "src/editor/rawDecoder.js", "src/editor/standardDecoder.js", "src/editor/livePreviewRenderer.js", "src/editor/editorWorker.js", "src/editor/sessionStore.js", "scripts/patch-rawconvert-csp.mjs"]),

    view("08-original-comparisons", "08 · Gallery camera-original comparisons", "Read-only Drive matching produces private Before previews; edited galleries stay authoritative.", [
        lane("PRIVATE ARCHIVE INDEX", [
            node("EventBridge · 15 minutes", "Enabled flag + Google credential\nparameter required", "job"),
            node("OriginalIndexRefresh", "Read-only service account;\nfull inventory + Drive changes", "job"),
            node("Raw-archive Drive JPGs", "Exact configured root descendants;\nexclude RAW / edited backup", "provider"),
            node("Private index + system row", "OriginalPreviewBucket index/;\nOriginalComparisonTable pointer", "data"),
        ], ["invoke", "read inventory", "publish complete index"]),
        lane("MATCH AND GENERATE", [
            node("Commit + reconciliation", "New committed photos +\nmissing/retryable comparisons"),
            node("OriginalComparisonQueue", "At most two workers;\nfive attempts → dedicated DLQ", "job"),
            node("OriginalComparisonWorker", "Recheck membership; filename +\ncapture time + camera + checksum", "job"),
            node("Private Before variants", "Read verified Drive JPG; write\n640 / 960 / 1440 / 1920 WebP", "data"),
        ], ["enqueue", "consume / lease", "render full framing"]),
        lane("AUTHORIZED DELIVERY", [
            node("Album / comparison API", "Public, owner/admin, share policy", "security"),
            node("OriginalComparisonTable", "pending / ready / unavailable /\nambiguous / failed; private evidence", "data"),
            node("Signed before/ URLs", "Separate private S3 bucket;\n30-minute expiry + private cache", "security"),
            node("Photo lightbox Before toggle", "Lazy load fitted variant;\nreuse while authorized and valid"),
        ], ["read comparison", "sign allowed output", "fetch on demand"]),
        lane("PENDING WORK AND FAILURE", [
            node("Pending / failed photo", "Edited image remains visible"),
            node("Visible-view refresh", "Backoff; cancel on navigation;\nshare viewer retains security check"),
            node("Reconciliation + alarms", "Retry missing work; DLQ and\nindex-refresh error signals → 11", "job"),
        ], ["refresh status", "repair / observe"], True),
    ], "The read-only archive reader does not use the edited-backup OAuth writer. It never modifies Drive or publishes a partial index. The worker strips EXIF/GPS/XMP/ICC, preserves full framing, and stores derivatives rather than source camera JPGs. Even public-album Before previews have no public CDN alias. API DTOs exclude Drive IDs, source names and matching evidence. This feature is parameter-gated; source configuration alone does not establish live activation or backfill completion.", ["ops/PHOTO_ORIGINAL_COMPARISONS.md", "backend/functions/original_index_refresh.py", "backend/functions/original_drive.py", "backend/functions/original_match.py", "backend/functions/original_comparison_worker.py", "backend/functions/original_comparison_access.py", "src/hooks/usePhotoOriginalRefresh.js"]),

    view("09-admin-integrations", "09 · Administration and integrations", "Admin reads and mutations connect to distinct data stores and provider responsibilities.", [
        lane("CONTENT AND ACCOUNT MANAGEMENT", [
            node("Protected admin portal", "Dashboard; uploads; albums/media;\nhero; users; security / TOTP", "actor"),
            node("Admin API handlers", "Verified Admins claims;\nvalidated, bounded mutations", "security"),
            node("Cognito + application data", "Users, owner assignment, media,\nvisibility, order, hero assets", "data"),
            node("Follow-up work · 04–06", "Retag, delete, derive, refresh;\nResend invitations / notices", "job"),
        ], ["same-origin API", "read / mutate", "dispatch"]),
        lane("WEBSITE USAGE AND OPERATIONS REPORTS", [
            node("AnalyticsTracker", "Page/media events + web vitals;\nDNT/GPC and route exclusions"),
            node("analytics ingest", "Validate + rate limit;\nprivacy-safe aggregate counters"),
            node("AnalyticsTable", "TTL-bounded anonymous aggregates", "data"),
            node("Admin analytics", "/admin/analytics;\nget_analytics_report"),
        ], ["POST events", "aggregate", "read report"]),
        lane("EDITED MEDIA BACKUP AND DRIVE USAGE", [
            node("Content mutation / daily job", "Optional backup; 09:15 UTC refresh", "job"),
            node("Drive workers", "google_drive_sync writes edited\nbackup; usage refresher reads", "job"),
            node("Google Drive + cache", "Edited website uploads backup;\nDriveUsageCacheTable", "provider"),
            node("Admin Drive usage", "/admin/drive-usage; cached report\nand bounded on-demand refresh"),
        ], ["invoke", "sync / measure", "serve summary"]),
        lane("BILLING, REPOSITORY AND HEALTH", [
            node("Admin report APIs", "Costs; GitHub; site health; audit"),
            node("Purpose-specific sources", "Cost Explorer; GitHub API;\nCloudWatch alarms / Logs Insights", "provider"),
            node("Caches / safe projection", "CostReportCache, GitHub cache;\nallowlisted health + audit DTOs", "data"),
            node("Admin report pages", "/costs, /github-analytics,\n/site-health, /audit-log under /admin"),
        ], ["query source", "cache / filter", "display"]),
    ], "GitHub analytics refresh runs hourly at :20 UTC; Drive usage refresh runs daily at 09:15 UTC. Report APIs can use bounded refresh/cache paths. Google Drive's edited backup writer is distinct from the read-only raw archive matcher (08). Resend also handles contact (01); Turnstile protects login/contact/shared entry (02/06); Fotomoto handles commerce (06). Secrets stay in scoped server-side SSM parameters (with optional KMS), not Vite public configuration.", ["src/pages/AdminDashboard.jsx", "src/pages/AdminSecurity.jsx", "src/utils/analytics.js", "backend/functions/analytics.py", "backend/functions/google_drive_sync.py", "backend/functions/get_google_drive_usage.py", "backend/functions/get_cost_report.py", "backend/functions/github_analytics.py", "backend/functions/get_site_health.py", "backend/functions/get_audit_log.py"]),

    view("10-release-ownership", "10 · Build, release, rollback and ownership", "The same tested artifacts move through separated roles and explicit deployment boundaries.", [
        lane("PULL REQUEST QUALITY", [
            node("Pull request", "Source + dependency + IaC changes", "actor"),
            node("Reusable quality workflow", "Frontend / Python / ops / Sharp;\ncoverage, SAM + infrastructure lint", "ops"),
            node("Security + artifact gates", "CodeQL, dependency/history scans;\nsource allowlists + byte budgets", "security"),
            node("Reviewable result", "No AWS identity in PR checks", "ops"),
        ], ["run checks", "verify", "report"]),
        lane("MAIN RELEASE", [
            node("Push to main", "Repeat quality gate; build once", "actor"),
            node("Attested immutable artifacts", "Checksums; versioned S3 release\nobjects encrypted with bootstrap KMS", "data"),
            node("Plan → execute OIDC roles", "Drift + intent + parameters;\nreviewed non-replacing change set", "security"),
            node("SAM application stack", "Backend UPDATE_COMPLETE;\nbackend/template.yaml ownership", "ops"),
        ], ["package tested bytes", "plan guarded update", "execute approved intent"], True),
        lane("FRONTEND RELEASE AND RECOVERY", [
            node("Backend release complete", "Exact attested release SHA", "ops"),
            node("Frontend OIDC role", "Upload assets, index last;\nnon-deleting S3 writes", "security"),
            node("Frontend CloudFront", "Await exact invalidation;\ncredential-free public posture smoke", "edge"),
            node("Manual recovery workflow", "Select attested successful main SHA;\ncurrent trusted control scripts", "ops"),
        ], ["permit frontend stage", "publish / verify", "recover if needed"], True),
        lane("SEPARATE OPERATIONS OWNERSHIP", [
            node("ops templates + tools", "Frontend edge / WAF / DNS /\nsecurity / backups / observability", "ops"),
            node("Inventory + guarded changes", "Exact account/resource scope;\ndry-run tooling + change-set review", "security"),
            node("Independent ops stacks", "us-west-2 home; us-east-1 edge;\nus-east-2 recovery vault", "ops"),
            node("Weekly audit OIDC role", "Quality + history + drift/posture;\nread-only, no auto-remediation", "ops"),
        ], ["prepare", "apply scoped change", "inspect"] , True),
    ], "Normal main releases deploy the application stack and frontend artifacts; they do not automatically deploy every ops stack. Four OIDC roles separate plan, execute, frontend and audit authority; CloudFormation has its own execution role. Existing parameters and protected resources are preserved by exact release contracts. bootstrap owns roles, release artifacts and KMS. See CI_CD.md for authoritative deployment guards and recovery procedure.", [".github/workflows/_quality.yml", ".github/workflows/pull-request.yml", ".github/workflows/release-production.yml", ".github/workflows/manual-release.yml", ".github/workflows/scheduled-security.yml", "backend/Makefile", "ops/CI_CD.md", "ops/ci_bootstrap_template.yaml"]),

    view("11-operations-recovery", "11 · Observability, security and recovery", "Website incident delivery, account audit evidence and data recovery are separate paths.", [
        lane("WEBSITE HEALTH AND INCIDENT DELIVERY", [
            node("API / Lambda / SQS / edge", "Access + JSON audit logs, X-Ray;\nlatency, errors, queue and WAF metrics", "ops"),
            node("CloudWatch + registry", "Dashboards, alarms, runbooks;\napp alarms → central SNS", "ops"),
            node("Validated signal routing", "Edge/WAF + backup events → SQS\n→ signal Lambda → same SNS topic", "security"),
            node("Website responder", "Owner-approved monitored subscriber;\ndelivery DLQ + triage runbooks", "actor"),
        ], ["emit signals", "event route where needed", "notify"] , True),
        lane("ACCOUNT EVIDENCE AND POSTURE", [
            node("AWS management events", "Global + multi-Region API activity", "ops"),
            node("CloudTrail audit foundation", "Retained Object-Locked S3 evidence;\nCloudWatch logs + metric filters", "data"),
            node("Home-Region posture", "Targeted Config; GuardDuty;\nstandards-free Security Hub; Analyzer", "security"),
            node("Read-only account audit", "Queryable findings + drift checks;\naccount signals are audit-only", "ops"),
        ], ["record", None, "review findings"], True),
        lane("METADATA BACKUP AND RESTORE", [
            node("Application DynamoDB", "Retained + deletion-protected;\nPITR across application tables", "data"),
            node("Daily AWS Backup selection", "AlbumsTable + PreviewMetadataTable;\n08:00 UTC; 35-day recovery points", "job"),
            node("Primary metadata vault", "us-west-2; freshness + failure\nsignals; guarded restore tests", "data"),
            node("Recovery destination vault", "us-east-2; separate KMS key;\nno automatic CopyActions in plan", "data"),
        ], ["two selected tables", "store recovery point", None], True),
        lane("MEDIA, COST AND CONTROL SAFEGUARDS", [
            node("ImagesBucket versioning", "30-day noncurrent media;\npending/ZIP/reference lifecycles", "data"),
            node("Edited Drive backup · 09", "Optional external media copy;\nrestore via reviewed tooling", "provider"),
            node("Guarded security controls", "IAM + SSM/KMS; optional DNSSEC;\nWAF + bounded concurrency", "security"),
            node("Cost governance", "Optional console-only budget;\nno website notification route", "ops"),
        ], ["optional backup", None, None], True),
    ], "No deployed cross-Region copy schedule is inferred from a destination vault: the checked-in primary plan has no CopyActions. AWS Backup selects only AlbumsTable and PreviewMetadataTable; other application tables rely on their PITR/retention unless separately configured. OriginalPreviewBucket holds private derived Before assets and expiring index snapshots; it does not inherit ImagesBucket versioning. Account posture services are home-Region-only and do not forward account-wide findings to website email. Ops creation modes, DNSSEC, Vault Lock and budget remain explicitly conditional. Complete resources and alarm ownership are in the inventories.", ["ops/SECURITY_OBSERVABILITY.md", "ops/OBSERVABILITY.md", "ops/ALARM_REGISTRY.md", "ops/security_notifications_template.yaml", "ops/security_audit_foundation_template.yaml", "ops/security_managed_services_template.yaml", "ops/security_backup_template.yaml", "ops/security_backup_replica_template.yaml", "ops/security_budget_template.yaml", "ops/dnssec-key-template.yaml"]),
]
