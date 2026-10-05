# Website architecture atlas

Source-backed views of Ian Truong Photography. Start with 00, then use the numbered views to follow a specific journey. The [editable Miro board](https://miro.com/app/board/uXjVHsf6LH0=/) uses the same nodes and relationships. [Complete source inventory](ARCHITECTURE_INVENTORY.md) lists every route, application function, data store and explicit infrastructure resource.

## How to read the atlas

Each horizontal lane is one request, data or control flow, read left to right. Solid arrows represent requests or data movement; dashed arrows represent scheduled/control/operational work. A label states what crosses the boundary. Unconnected cards are separate controls or conditional resources, not implied data flows. Repeated names refer to the same component across views; numbered references avoid long arrows across unrelated sections.

Colors: blue = people/browser entry; teal = edge/delivery; lavender = app logic; amber = data; peach = workers; rose = access/security; purple = external provider; gray = operations. Labels carry the meaning without relying on color.

**Scope:** current checked-in source and documented production intent. Deployment switches and optional resources are identified explicitly. This work does not claim a fresh live AWS inventory or provider configuration audit.

## Views

| View | Question answered |
|---|---|
| [00 · System overview](#00-system) | Start here. Follow a lane left to right; open its numbered detail view. |
| [01 · Pages and visitor journeys](#01-experience) | The public experience, its shared components, and the services each journey uses. |
| [02 · Edge, identity and authorization](#02-edge-access) | Request boundaries are explicit: edge controls, verified identity, then resource access. |
| [03 · Catalog, indexes and data ownership](#03-catalog-data) | Authoritative album state decides access; derivative indexes accelerate discovery. |
| [04 · Uploads, previews, video and heroes](#04-media-ingestion) | Large bytes go directly to S3; protected API commits start processing. |
| [05 · Mutation consistency and background work](#05-consistency-workers) | Separate lanes explain invalidation, materialized views, reconciliation and failures. |
| [06 · Sharing, downloads and print orders](#06-sharing-delivery) | Public CDN access and short-lived capabilities have different privacy boundaries. |
| [07 · Browser-only photo editor](#07-local-editor) | The /editor workspace processes local files independently of the gallery backend. |
| [08 · Gallery camera-original comparisons](#08-original-comparisons) | Read-only Drive matching produces private Before previews; edited galleries stay authoritative. |
| [09 · Administration and integrations](#09-admin-integrations) | Admin reads and mutations connect to distinct data stores and provider responsibilities. |
| [10 · Build, release, rollback and ownership](#10-release-ownership) | The same tested artifacts move through separated roles and explicit deployment boundaries. |
| [11 · Observability, security and recovery](#11-operations-recovery) | Website incident delivery, account audit evidence and data recovery are separate paths. |

<a id="00-system"></a>

## 00 · System overview

Start here. Follow a lane left to right; open its numbered detail view. [Open this view in Miro](https://miro.com/app/board/uXjVHsf6LH0=/?moveToWidget=3458764682780829950).

```mermaid
flowchart TB
  classDef actor fill:#EAF2FF,stroke:#3864A3,color:#172B3A,stroke-width:1.5px
  classDef edge fill:#E8F6F6,stroke:#287C83,color:#172B3A,stroke-width:1.5px
  classDef app fill:#EFF1FC,stroke:#606AAF,color:#172B3A,stroke-width:1.5px
  classDef data fill:#FFF3DB,stroke:#A7792B,color:#172B3A,stroke-width:1.5px
  classDef job fill:#FCEEE5,stroke:#AF704A,color:#172B3A,stroke-width:1.5px
  classDef security fill:#F9EAF0,stroke:#A65774,color:#172B3A,stroke-width:1.5px
  classDef provider fill:#F1EBF8,stroke:#86639D,color:#172B3A,stroke-width:1.5px
  classDef ops fill:#EDF2F5,stroke:#62798A,color:#172B3A,stroke-width:1.5px
  subgraph lane0["WEBSITE DELIVERY · 01–02"]
    direction LR
    n00["Visitors, clients, admin<br/>Browser and installed PWA"]:::actor
    n01["Frontend CloudFront<br/>Route 53 + ACM + WAF"]:::edge
    n02["Private frontend S3<br/>HTML, versioned JS/CSS, assets"]:::data
    n03["React application<br/>Public pages + protected portal"]:::app
    n00 -->|"HTTPS"| n01
    n01 -->|"OAC origin read"| n02
    n02 -->|"serves app"| n03
  end
  style lane0 fill:#FAFBFD,stroke:#DCE3EB,color:#526578
  subgraph lane1["APPLICATION REQUESTS · 02–03, 06, 09"]
    direction LR
    n10["React API client<br/>Same-origin /api"]:::app
    n11["CloudFront API behavior<br/>Public cache / protected no-store"]:::edge
    n12["API Gateway + Lambda<br/>Origin check + route/album auth"]:::app
    n13["Application state<br/>DynamoDB + Cognito + providers"]:::data
    n10 -->|"JSON requests"| n11
    n11 -->|"verified origin"| n12
    n12 -->|"authorized work"| n13
  end
  style lane1 fill:#FAFBFD,stroke:#DCE3EB,color:#526578
  subgraph lane2["MEDIA LIFECYCLE · 04–06, 08"]
    direction LR
    n20["Admin upload + commit<br/>Presigned S3 transfer; API metadata"]:::actor
    n21["Private media S3<br/>Original uploads + JPEG fallback"]:::data
    n22["Background processing<br/>SQS / Lambda / MediaConvert"]:::job
    n23["Viewer media<br/>Public CDN; private signed S3"]:::edge
    n20 -->|"direct bytes"| n21
    n21 -->|"derive / index"| n22
    n22 -->|"publish outputs"| n23
  end
  style lane2 fill:#FAFBFD,stroke:#DCE3EB,color:#526578
  subgraph lane3["CHANGE AND OPERATE · 10–11"]
    direction LR
    n30["GitHub Actions<br/>PR checks; main release; audits"]:::ops
    n31["AWS OIDC roles<br/>Plan / execute / frontend / audit"]:::security
    n32["Application + ops<br/>SAM app; separately guarded ops"]:::ops
    n33["Observe and recover<br/>Logs, alarms, PITR, backups"]:::ops
    n30 -. "short-lived identity" .-> n31
    n31 -. "scoped control" .-> n32
    n32 -. "operational signals" .-> n33
  end
  style lane3 fill:#FAFBFD,stroke:#DCE3EB,color:#526578
  %% Invisible links only stack lanes; they do not represent system relationships.
  lane0 ~~~ lane1
  lane1 ~~~ lane2
  lane2 ~~~ lane3
```

The browser-only editor (07) uses local files, Web Workers, WebGL and IndexedDB. It has no media-upload API. This atlas describes checked-in implementation and documented topology, not a fresh AWS deployment audit.

Sources: [src/App.jsx](../src/App.jsx), [backend/template.yaml](../backend/template.yaml), [ops/API_FRONT_DOOR.md](../ops/API_FRONT_DOOR.md), [ops/CI_CD.md](../ops/CI_CD.md).

<a id="01-experience"></a>

## 01 · Pages and visitor journeys

The public experience, its shared components, and the services each journey uses. [Open this view in Miro](https://miro.com/app/board/uXjVHsf6LH0=/?moveToWidget=3458764682780830052).

```mermaid
flowchart TB
  classDef actor fill:#EAF2FF,stroke:#3864A3,color:#172B3A,stroke-width:1.5px
  classDef edge fill:#E8F6F6,stroke:#287C83,color:#172B3A,stroke-width:1.5px
  classDef app fill:#EFF1FC,stroke:#606AAF,color:#172B3A,stroke-width:1.5px
  classDef data fill:#FFF3DB,stroke:#A7792B,color:#172B3A,stroke-width:1.5px
  classDef job fill:#FCEEE5,stroke:#AF704A,color:#172B3A,stroke-width:1.5px
  classDef security fill:#F9EAF0,stroke:#A65774,color:#172B3A,stroke-width:1.5px
  classDef provider fill:#F1EBF8,stroke:#86639D,color:#172B3A,stroke-width:1.5px
  classDef ops fill:#EDF2F5,stroke:#62798A,color:#172B3A,stroke-width:1.5px
  subgraph lane0["PHOTO BROWSING"]
    direction LR
    n00["Home + Search<br/>/ and /search; filter album catalog"]:::actor
    n01["Photo album<br/>/album/:albumId; cards + hover"]:::app
    n02["Photo lightbox<br/>Responsive image + Before/After"]:::app
    n03["Photo actions · 06 / 08<br/>Share, QR, download, ZIP, print"]:::app
    n00 -->|"open album"| n01
    n01 -->|"select photo"| n02
    n02 -->|"authorized action"| n03
  end
  style lane0 fill:#FAFBFD,stroke:#DCE3EB,color:#526578
  subgraph lane1["VIDEO BROWSING"]
    direction LR
    n10["Videos<br/>/videos; category sections"]:::actor
    n11["Video album<br/>/video/:albumId; hover previews"]:::app
    n12["VideoPlayer<br/>Native HLS / hls.js + fallback"]:::app
    n13["Media delivery · 04 / 06<br/>HLS segments, MP4, thumbnails"]:::edge
    n10 -->|"open album"| n11
    n11 -->|"play video"| n12
    n12 -->|"fetch media"| n13
  end
  style lane1 fill:#FAFBFD,stroke:#DCE3EB,color:#526578
  subgraph lane2["DISCOVERY"]
    direction LR
    n20["Explore + Stats<br/>/explore/* and /stats"]:::actor
    n21["Browse or play<br/>Color, lens, exposure, time, season;<br/>shuffle, guess settings, 3D gallery"]:::app
    n22["Public read APIs · 03<br/>Explore, random, stats, albums"]:::app
    n23["Verified public photos<br/>Current visibility + membership;<br/>lightbox and album links"]:::app
    n20 -->|"choose experience"| n21
    n21 -->|"fetch data"| n22
    n22 -->|"resolve references"| n23
  end
  style lane2 fill:#FAFBFD,stroke:#DCE3EB,color:#526578
  subgraph lane3["CONTACT AND SHARED APP SHELL"]
    direction LR
    n30["Contact form<br/>/contact + Turnstile"]:::actor
    n31["Contact handler<br/>Validate + rate limit"]:::app
    n32["Resend<br/>Transactional contact email"]:::provider
    n30 -->|"POST /api/contact"| n31
    n31 -->|"send message"| n32
  end
  style lane3 fill:#FAFBFD,stroke:#DCE3EB,color:#526578
  %% Invisible links only stack lanes; they do not represent system relationships.
  lane0 ~~~ lane1
  lane1 ~~~ lane2
  lane2 ~~~ lane3
```

Shared shell: lazy routes/Suspense, AuthProvider, navigation, theme, accessibility, metadata/social links, analytics and PWA registration. /privacy explains data use; unmatched routes show NotFound. The immersive Three.js / React Three Fiber gallery uses streamed media and a WebGL capability fallback. Accounts are in 02, the local editor in 07, and admin tools in 09. The route inventory lists every URL.

Sources: [src/App.jsx](../src/App.jsx), [src/main.jsx](../src/main.jsx), [src/pages/Explore.jsx](../src/pages/Explore.jsx), [src/pages/ImmersiveGallery.jsx](../src/pages/ImmersiveGallery.jsx), [src/components/PhotoLightbox.jsx](../src/components/PhotoLightbox.jsx), [src/components/VideoPlayer.jsx](../src/components/VideoPlayer.jsx), [src/components/DocumentMetadata.jsx](../src/components/DocumentMetadata.jsx).

<a id="02-edge-access"></a>

## 02 · Edge, identity and authorization

Request boundaries are explicit: edge controls, verified identity, then resource access. [Open this view in Miro](https://miro.com/app/board/uXjVHsf6LH0=/?moveToWidget=3458764682780830094).

```mermaid
flowchart TB
  classDef actor fill:#EAF2FF,stroke:#3864A3,color:#172B3A,stroke-width:1.5px
  classDef edge fill:#E8F6F6,stroke:#287C83,color:#172B3A,stroke-width:1.5px
  classDef app fill:#EFF1FC,stroke:#606AAF,color:#172B3A,stroke-width:1.5px
  classDef data fill:#FFF3DB,stroke:#A7792B,color:#172B3A,stroke-width:1.5px
  classDef job fill:#FCEEE5,stroke:#AF704A,color:#172B3A,stroke-width:1.5px
  classDef security fill:#F9EAF0,stroke:#A65774,color:#172B3A,stroke-width:1.5px
  classDef provider fill:#F1EBF8,stroke:#86639D,color:#172B3A,stroke-width:1.5px
  classDef ops fill:#EDF2F5,stroke:#62798A,color:#172B3A,stroke-width:1.5px
  subgraph lane0["API FRONT DOOR"]
    direction LR
    n00["Browser HTTPS /api<br/>Canonical website origin"]:::actor
    n01["Frontend CloudFront + WAF<br/>Managed rules; API / Explore limits"]:::edge
    n02["Regional HTTP API<br/>origin-api custom domain; JWT<br/>authorizer on protected routes"]:::edge
    n03["Lambda request boundary<br/>Verify X-Origin-Verify first;<br/>then validation + authorization"]:::security
    n00 -->|"edge inspection"| n01
    n01 -->|"origin secret header"| n02
    n02 -->|"dispatch handler"| n03
  end
  style lane0 fill:#FAFBFD,stroke:#DCE3EB,color:#526578
  subgraph lane1["SIGN IN AND SESSION"]
    direction LR
    n10["Login / challenge UI<br/>/login; password + bot check"]:::actor
    n11["Login + challenge handlers<br/>Turnstile + RateLimitTable"]:::app
    n12["Cognito user pool<br/>Password / new-password / TOTP;<br/>Admins group"]:::security
    n13["AuthProvider session<br/>Token refresh; sign-out cleanup;<br/>/dashboard or /admin"]:::app
    n10 -->|"same-origin POST"| n11
    n11 -->|"authenticate"| n12
    n12 -->|"verified tokens"| n13
  end
  style lane1 fill:#FAFBFD,stroke:#DCE3EB,color:#526578
  subgraph lane2["RESOURCE ACCESS POLICY"]
    direction LR
    n20["Requested album or media<br/>Public, private, or unlisted"]:::app
    n21["Shared auth helpers<br/>Gateway claims or optional JWT;<br/>active album + valid visibility"]:::security
    n22["Grant decision<br/>Public / exact owner sub / Admins;<br/>unlisted: active exact share code"]:::security
    n23["Scoped response<br/>Allowlisted metadata / short-lived<br/>capability; otherwise 401/403/404"]:::app
    n20 -->|"load current state"| n21
    n21 -->|"verify grant"| n22
    n22 -->|"authorize resource"| n23
  end
  style lane2 fill:#FAFBFD,stroke:#DCE3EB,color:#526578
  subgraph lane3["STATIC DELIVERY AND SOCIAL ENTRY"]
    direction LR
    n30["Route 53 + ACM<br/>Canonical, www, prints, API;<br/>global + regional certificates"]:::edge
    n31["CloudFront Functions<br/>www redirect + social routing"]:::edge
    n32["Selected destination<br/>SPA from private S3, or<br/>/public/social HTML for crawlers"]:::edge
    n33["Browser shell + policies<br/>CSP, CORS, HSTS; PWA shell/assets;<br/>API responses outside SW cache"]:::app
    n30 -->|"DNS + TLS"| n31
    n31 -->|"choose route"| n32
    n32 -->|"deliver response"| n33
  end
  style lane3 fill:#FAFBFD,stroke:#DCE3EB,color:#526578
  %% Invisible links only stack lanes; they do not represent system relationships.
  lane0 ~~~ lane1
  lane1 ~~~ lane2
  lane2 ~~~ lane3
```

The normal browser API base is /api. The documented production contract disables execute-api and rejects direct regional-origin calls without the edge secret. Client ProtectedRoute checks Admins and MFA setup; backend admin handlers enforce verified Admins claims. Do not mistake a UI MFA gate for a per-request backend MFA claim check. Protected catalog snapshots are process-memory only; logout clears them. Resend/Turnstile/Google credentials are server-side SSM parameters; IAM scopes access and KMS decrypt where configured.

Sources: [ops/API_FRONT_DOOR.md](../ops/API_FRONT_DOOR.md), [ops/cloudfront_frontend.py](../ops/cloudfront_frontend.py), [ops/cloudfront_social_router.js](../ops/cloudfront_social_router.js), [backend/functions/front_door.py](../backend/functions/front_door.py), [backend/functions/auth_helpers.py](../backend/functions/auth_helpers.py), [backend/functions/album_access.py](../backend/functions/album_access.py), [src/context/authContext.jsx](../src/context/authContext.jsx), [src/components/ProtectedRoute.jsx](../src/components/ProtectedRoute.jsx), [public/service-worker.js](../public/service-worker.js).

<a id="03-catalog-data"></a>

## 03 · Catalog, indexes and data ownership

Authoritative album state decides access; derivative indexes accelerate discovery. [Open this view in Miro](https://miro.com/app/board/uXjVHsf6LH0=/?moveToWidget=3458764682780830147).

```mermaid
flowchart TB
  classDef actor fill:#EAF2FF,stroke:#3864A3,color:#172B3A,stroke-width:1.5px
  classDef edge fill:#E8F6F6,stroke:#287C83,color:#172B3A,stroke-width:1.5px
  classDef app fill:#EFF1FC,stroke:#606AAF,color:#172B3A,stroke-width:1.5px
  classDef data fill:#FFF3DB,stroke:#A7792B,color:#172B3A,stroke-width:1.5px
  classDef job fill:#FCEEE5,stroke:#AF704A,color:#172B3A,stroke-width:1.5px
  classDef security fill:#F9EAF0,stroke:#A65774,color:#172B3A,stroke-width:1.5px
  classDef provider fill:#F1EBF8,stroke:#86639D,color:#172B3A,stroke-width:1.5px
  classDef ops fill:#EDF2F5,stroke:#62798A,color:#172B3A,stroke-width:1.5px
  subgraph lane0["CATALOG AND PRESENTATION"]
    direction LR
    n00["Home / Videos / Search<br/>Public catalogs; owner/admin lists"]:::app
    n01["Catalog handlers<br/>get_public_albums / get_albums"]:::app
    n02["AlbumsTable<br/>Album identity, visibility, owner,<br/>share, status + legacy manifest"]:::data
    n03["GallerySettingsTable<br/>Read order/section settings;<br/>merge into catalog response"]:::data
    n00 -->|"paged requests"| n01
    n01 -->|"query selected GSI"| n02
    n02 -->|"combine settings"| n03
  end
  style lane0 fill:#FAFBFD,stroke:#DCE3EB,color:#526578
  subgraph lane1["ALBUM DETAIL AND ADMIN PAGINATION"]
    direction LR
    n10["Album/detail readers<br/>Public, client, shared, admin"]:::app
    n11["Album access + media store<br/>Check album; normalized rows<br/>with legacy migration fallback"]:::security
    n12["AlbumMediaTable<br/>albumId + mediaId;<br/>AlbumOrderIndex for paging"]:::data
    n13["PreviewMetadataTable<br/>Join ready variants and metadata<br/>for selected media IDs"]:::data
    n10 -->|"request detail"| n11
    n11 -->|"read media"| n12
    n12 -->|"enrich response"| n13
  end
  style lane1 fill:#FAFBFD,stroke:#DCE3EB,color:#526578
  subgraph lane2["EXPLORE AND RANDOM PHOTOS"]
    direction LR
    n20["Explore / random endpoints<br/>Filters, samples, shuffle decks"]:::app
    n21["PreviewMetadataTable<br/>Sparse Explore refs, readiness<br/>markers, sharded random pools"]:::data
    n22["Authoritative recheck<br/>Join current AlbumsTable +<br/>media/preview membership"]:::security
    n23["Public discovery DTO<br/>Responsive URLs + coarse EXIF;<br/>stale references cannot grant access"]:::app
    n20 -->|"read indexed refs"| n21
    n21 -->|"resolve candidates"| n22
    n22 -->|"serialize allowed"| n23
  end
  style lane2 fill:#FAFBFD,stroke:#DCE3EB,color:#526578
  subgraph lane3["SUMMARY AND AUXILIARY STATE"]
    direction LR
    n30["Stats + admin readers<br/>Public stats; reports in 09"]:::app
    n31["Authoritative / cached reads<br/>Public albums for photo stats;<br/>report caches for admin metrics"]:::app
    n32["Other DynamoDB tables<br/>RateLimit + Analytics + cost,<br/>Drive, GitHub report caches"]:::data
    n33["OriginalComparisonTable · 08<br/>Separate private matching state;<br/>album/media keyed comparison DTO"]:::data
    n30 -->|"request summaries"| n31
    n31 -->|"read by purpose"| n32
    n32 ~~~ n33
  end
  style lane3 fill:#FAFBFD,stroke:#DCE3EB,color:#526578
  %% Invisible links only stack lanes; they do not represent system relationships.
  lane0 ~~~ lane1
  lane1 ~~~ lane2
  lane2 ~~~ lane3
```

AlbumsTable GSIs: ShareCodeIndex, VisibilityCreatedAtIndex, VisibilityCreatedAtSummaryIndex and OwnerSubCreatedAtIndex (deployment-phase gated). Public queries never trust an index alone. Explore temporal readiness fails closed; color/lens and random decks retain bounded/legacy fallbacks. PreviewMetadataTable also stores hover pointers and random-pool generations. Each table's keys, TTL and infrastructure identity are listed in the inventory.

Sources: [backend/template.yaml](../backend/template.yaml), [backend/functions/get_public_albums.py](../backend/functions/get_public_albums.py), [backend/functions/get_public_album.py](../backend/functions/get_public_album.py), [backend/functions/album_media_store.py](../backend/functions/album_media_store.py), [backend/functions/media_access.py](../backend/functions/media_access.py), [backend/functions/explore_index.py](../backend/functions/explore_index.py), [backend/functions/random_photo_pools.py](../backend/functions/random_photo_pools.py), [backend/functions/photography_stats.py](../backend/functions/photography_stats.py).

<a id="04-media-ingestion"></a>

## 04 · Uploads, previews, video and heroes

Large bytes go directly to S3; protected API commits start processing. [Open this view in Miro](https://miro.com/app/board/uXjVHsf6LH0=/?moveToWidget=3458764682780830586).

```mermaid
flowchart TB
  classDef actor fill:#EAF2FF,stroke:#3864A3,color:#172B3A,stroke-width:1.5px
  classDef edge fill:#E8F6F6,stroke:#287C83,color:#172B3A,stroke-width:1.5px
  classDef app fill:#EFF1FC,stroke:#606AAF,color:#172B3A,stroke-width:1.5px
  classDef data fill:#FFF3DB,stroke:#A7792B,color:#172B3A,stroke-width:1.5px
  classDef job fill:#FCEEE5,stroke:#AF704A,color:#172B3A,stroke-width:1.5px
  classDef security fill:#F9EAF0,stroke:#A65774,color:#172B3A,stroke-width:1.5px
  classDef provider fill:#F1EBF8,stroke:#86639D,color:#172B3A,stroke-width:1.5px
  classDef ops fill:#EDF2F5,stroke:#62798A,color:#172B3A,stroke-width:1.5px
  subgraph lane0["UPLOAD AND COMMIT"]
    direction LR
    n00["Admin upload UI<br/>Photo/video files + local previews"]:::actor
    n01["get_upload_url<br/>Admin-only presigned upload;<br/>key, type, size and pending tag"]:::security
    n02["Browser → ImagesBucket<br/>Direct PUT of source + fallback;<br/>API does not carry large bytes"]:::data
    n03["create_album / add_images<br/>Validate owned keys; EXIF;<br/>commit media rows + visibility tags"]:::app
    n00 -->|"request capability"| n01
    n01 -->|"upload bytes"| n02
    n02 -->|"commit metadata"| n03
  end
  style lane0 fill:#FAFBFD,stroke:#DCE3EB,color:#526578
  subgraph lane1["RESPONSIVE PHOTO DERIVATIVES"]
    direction LR
    n10["Committed photos<br/>Keep JPEG fallback available"]:::app
    n11["PreviewQueue<br/>Bounded jobs + partial retries"]:::job
    n12["PreviewWorker<br/>Node.js 22 + Sharp; V3 WebP<br/>variants, blurhash, Explore metadata"]:::job
    n13["S3 + PreviewMetadataTable<br/>Versioned variants + ready record;<br/>visibility checks and invalidation"]:::data
    n10 -->|"enqueue"| n11
    n11 -->|"consume"| n12
    n12 -->|"publish ready"| n13
  end
  style lane1 fill:#FAFBFD,stroke:#DCE3EB,color:#526578
  subgraph lane2["VIDEO TRANSCODING"]
    direction LR
    n20["Committed video album<br/>create_album records source/job"]:::app
    n21["AWS MediaConvert<br/>Assumed media service role"]:::job
    n22["ImagesBucket HLS output (_hls/v2/)<br/>Master + up to 6 single-file renditions;<br/>source MP4 remains available"]:::data
    n23["Media CDN → VideoPlayer<br/>Public HLS when accessible;<br/>protected/fallback signed source"]:::edge
    n20 -->|"submit job"| n21
    n21 -->|"read source / write HLS"| n22
    n22 -->|"play media"| n23
  end
  style lane2 fill:#FAFBFD,stroke:#DCE3EB,color:#526578
  subgraph lane3["MANAGED HOMEPAGE AND VIDEO HERO"]
    direction LR
    n30["ManageHero<br/>/admin/hero; image covers for<br/>photo + video landing pages"]:::actor
    n31["hero_cover + PreviewQueue<br/>Presign image PUT; validate complete;<br/>queue hero publication job"]:::app
    n32["Sharp hero worker<br/>Write ImagesBucket hero variants<br/>and manifest; invalidate cache"]:::job
    n33["Home + Videos hero<br/>Managed CDN images; bundled<br/>frontend image fallback"]:::edge
    n30 -->|"upload + complete"| n31
    n31 -->|"queue publication"| n32
    n32 -->|"serve cover"| n33
  end
  style lane3 fill:#FAFBFD,stroke:#DCE3EB,color:#526578
  %% Invisible links only stack lanes; they do not represent system relationships.
  lane0 ~~~ lane1
  lane1 ~~~ lane2
  lane2 ~~~ lane3
```

Videos are converted into an adaptive HLS ladder in `<source>_hls/v2/`: 2160p (16 Mbit/s peak), 1440p (10), 1080p (6.5), 720p (3.5), 540p (1.8) and 360p (0.8), H.264 QVBR with muxed AAC. Boxes follow the source orientation (a portrait video's "1080p" is 1080 wide), rungs that would only repeat a larger one for a smaller source are dropped, and every rendition is one TS file addressed by byte ranges, so a video is about a dozen objects whatever its length. The player picks a level from bandwidth and player size; the custom controls also offer a fixed quality (hls.js levels, or the variant playlist itself on Safari's native HLS). `VideoUpgradeFunction` (every 3 hours) gives converted videos still on the older two-rendition ladder an upgrade receipt, at most 8 new and 12 in flight; the album's durable video worker re-converts each from its original into the new folder and switches `hlsUrl` only once the new master playlist exists, then invalidates the public API cache. An upgrade that never completes within a day keeps the old stream.

Timeline previews: every conversion and upgrade also writes a 320-pixel JPEG frame every 2 seconds to `<source>_hls/frames/v1/<name>.NNNNNNN.jpg` (MediaConvert frame capture). The frames sit inside the stream's folder, so they share its visibility tags, cookies, retagging and deletion. Videos already on the current ladder get a cheap frame-only job from the same scan (up to 20 per run, as `frames` receipts). An image's `scrubFrames` is set once its job is accepted, and the API then returns a frame URL prefix wherever it returns the stream. The custom seek bar shows the frame and time under the pointer, or only the time when a frame is missing.

After commit, auxiliary jobs also refresh catalog caches, random pools, hover manifests, optional edited-file Drive backups (09), and original comparisons (08). Preview generation is additive: failure keeps source and JPEG fallback intact. Source media, previews, HLS, QR assets and temporary ZIPs share ImagesBucket but use separate prefixes and policies. No S3-upload event is assumed to dispatch these jobs; the implemented upload-completion path does.

Sources: [src/pages/Admin.jsx](../src/pages/Admin.jsx), [src/pages/UploadVideo.jsx](../src/pages/UploadVideo.jsx), [src/pages/ManageHero.jsx](../src/pages/ManageHero.jsx), [backend/functions/get_upload_url.py](../backend/functions/get_upload_url.py), [backend/functions/create_album.py](../backend/functions/create_album.py), [backend/functions/add_images.py](../backend/functions/add_images.py), [backend/functions/hero_cover.py](../backend/functions/hero_cover.py), [backend/functions/media_helpers.py](../backend/functions/media_helpers.py), [backend/functions/video_jobs.py](../backend/functions/video_jobs.py), [backend/functions/video_upgrade.py](../backend/functions/video_upgrade.py), [backend/preview_worker/index.mjs](../backend/preview_worker/index.mjs), [backend/preview_worker/hero.mjs](../backend/preview_worker/hero.mjs).

<a id="05-consistency-workers"></a>

## 05 · Mutation consistency and background work

Separate lanes explain invalidation, materialized views, reconciliation and failures. [Open this view in Miro](https://miro.com/app/board/uXjVHsf6LH0=/?moveToWidget=3458764682780830632).

```mermaid
flowchart TB
  classDef actor fill:#EAF2FF,stroke:#3864A3,color:#172B3A,stroke-width:1.5px
  classDef edge fill:#E8F6F6,stroke:#287C83,color:#172B3A,stroke-width:1.5px
  classDef app fill:#EFF1FC,stroke:#606AAF,color:#172B3A,stroke-width:1.5px
  classDef data fill:#FFF3DB,stroke:#A7792B,color:#172B3A,stroke-width:1.5px
  classDef job fill:#FCEEE5,stroke:#AF704A,color:#172B3A,stroke-width:1.5px
  classDef security fill:#F9EAF0,stroke:#A65774,color:#172B3A,stroke-width:1.5px
  classDef provider fill:#F1EBF8,stroke:#86639D,color:#172B3A,stroke-width:1.5px
  classDef ops fill:#EDF2F5,stroke:#62798A,color:#172B3A,stroke-width:1.5px
  subgraph lane0["VISIBILITY, DELETION AND CACHES"]
    direction LR
    n00["Album / image mutations<br/>Update, delete, reorder, share;<br/>source-of-truth authorization"]:::app
    n01["Retag / remove / reconcile<br/>Restrict tags before private change;<br/>update media, preview, QR state"]:::app
    n02["CacheInvalidationQueue<br/>Coalesce narrow paths;<br/>CacheInvalidationWorker"]:::job
    n03["Frontend + media CDN<br/>Invalidate affected catalog,<br/>album and public-preview paths"]:::edge
    n00 -. "apply transition" .-> n01
    n01 -. "enqueue paths" .-> n02
    n02 -. "invalidate" .-> n03
  end
  style lane0 fill:#FAFBFD,stroke:#DCE3EB,color:#526578
  subgraph lane1["ALBUM CARD HOVER MANIFESTS"]
    direction LR
    n10["Preview stream + refresh<br/>PreviewMetadata stream; targeted<br/>HoverPreviewRefreshQueue; 15 min"]:::job
    n11["HoverPreviewManifestBuilder<br/>Recheck public album + cover;<br/>select ready landscape previews"]:::job
    n12["Manifest + pointer<br/>Immutable S3 hover JSON +<br/>PreviewMetadataTable pointer"]:::data
    n13["AlbumCard<br/>Fetch small manifest via CDN;<br/>shuffle five frames locally"]:::app
    n10 -->|"trigger"| n11
    n11 -->|"publish conditionally"| n12
    n12 -->|"hover playback"| n13
  end
  style lane1 fill:#FAFBFD,stroke:#DCE3EB,color:#526578
  subgraph lane2["RANDOM DECKS AND NORMALIZED MEDIA"]
    direction LR
    n20["Targeted random refresh<br/>RandomPhotoRefreshQueue;<br/>hourly reconciliation"]:::job
    n21["RandomPhotoPoolBuilder<br/>Query current public albums;<br/>immutable shards + pointer swap"]:::job
    n22["PreviewMetadataTable<br/>Materialized global/category decks;<br/>public readers recheck every ref"]:::data
    n20 -->|"trigger"| n21
    n21 -->|"publish generation"| n22
  end
  style lane2 fill:#FAFBFD,stroke:#DCE3EB,color:#526578
  subgraph lane3["LEGACY MIGRATION REPAIR"]
    direction LR
    n30["EventBridge · 15 minutes<br/>Bounded media reconciliation"]:::job
    n31["AlbumMediaBackfill<br/>AlbumsTable legacy manifests"]:::job
    n32["AlbumMediaTable<br/>Repair normalized rows;<br/>admin media paging"]:::data
    n30 -->|"invoke"| n31
    n31 -->|"backfill"| n32
  end
  style lane3 fill:#FAFBFD,stroke:#DCE3EB,color:#526578
  %% Invisible links only stack lanes; they do not represent system relationships.
  lane0 ~~~ lane1
  lane1 ~~~ lane2
  lane2 ~~~ lane3
```

AlbumsTable → RandomPhotoPoolBuilder stream mapping is retained but disabled; the queue and hourly schedule are active. Preview and original-comparison queues have dedicated DLQs. Cache/random/hover queue redrive, failed hover stream batches, and async ZIP/Drive/tag invocations use AsyncFailureQueue where configured. Scheduled functions have bounded retries; do not assume every worker has a Lambda DLQ. TagMediaObject is the separate asynchronous tagging worker. Queue age, depth, worker errors/throttles and failures feed 11.

Scheduled publishing: an upload or edit can give a link-only album (sharing off) a `publishAt` time. The time is written first to the `scheduled-publishing` item in GallerySettingsTable, then to the album, which stays authoritative. Every 5 minutes EventBridge invokes UpdateAlbumFunction with `{"source": "scheduled-publish"}`. That run reads the one index item and moves up to 5 due albums to public through the normal visibility transition, which ends their schedule. It also repairs or drops index entries that disagree with their album, and leaves busy or still-uploading albums for the next run.

Recently Deleted: deleting an album in Manage Albums sends `{"trash": true}` to UpdateAlbumFunction. That is an ordinary visibility transition to link-only with sharing off, plus `trashedAt` and `trashedFrom` (the previous visibility, owner and share link). Public, client and shared-link access are revoked right away, and every admin list leaves the album out. The Recently Deleted page lists binned albums with `trashed=1`. `{"restore": true}` reverses the transition. Both requests are idempotent. The bin is indexed in the `recently-deleted` GallerySettingsTable item. A daily EventBridge input `{"source": "trash-purge"}` to DeleteAlbumFunction permanently deletes up to 3 albums binned 30 or more days ago through the normal deletion workflow. Account deletion also matches `trashedFrom.ownerSub`, so a client's binned albums are deleted with their account.

Sources: [backend/template.yaml](../backend/template.yaml), [backend/functions/update_album.py](../backend/functions/update_album.py), [backend/functions/delete_album.py](../backend/functions/delete_album.py), [backend/functions/delete_images.py](../backend/functions/delete_images.py), [backend/functions/cache_invalidation_worker.py](../backend/functions/cache_invalidation_worker.py), [backend/functions/hover_preview_manifest_builder.py](../backend/functions/hover_preview_manifest_builder.py), [backend/functions/random_photo_pool_builder.py](../backend/functions/random_photo_pool_builder.py), [backend/functions/backfill_album_media.py](../backend/functions/backfill_album_media.py), [backend/functions/tag_media_object.py](../backend/functions/tag_media_object.py).

<a id="06-sharing-delivery"></a>

## 06 · Sharing, downloads and print orders

Public CDN access and short-lived capabilities have different privacy boundaries. [Open this view in Miro](https://miro.com/app/board/uXjVHsf6LH0=/?moveToWidget=3458764682780830671).

```mermaid
flowchart TB
  classDef actor fill:#EAF2FF,stroke:#3864A3,color:#172B3A,stroke-width:1.5px
  classDef edge fill:#E8F6F6,stroke:#287C83,color:#172B3A,stroke-width:1.5px
  classDef app fill:#EFF1FC,stroke:#606AAF,color:#172B3A,stroke-width:1.5px
  classDef data fill:#FFF3DB,stroke:#A7792B,color:#172B3A,stroke-width:1.5px
  classDef job fill:#FCEEE5,stroke:#AF704A,color:#172B3A,stroke-width:1.5px
  classDef security fill:#F9EAF0,stroke:#A65774,color:#172B3A,stroke-width:1.5px
  classDef provider fill:#F1EBF8,stroke:#86639D,color:#172B3A,stroke-width:1.5px
  classDef ops fill:#EDF2F5,stroke:#62798A,color:#172B3A,stroke-width:1.5px
  subgraph lane0["VIEW PUBLIC OR PROTECTED MEDIA"]
    direction LR
    n00["Public / client / shared viewer<br/>SharedAlbum checks Turnstile;<br/>owner/admin JWT where applicable"]:::actor
    n01["Album authorization<br/>Current visibility + membership;<br/>active exact unlisted share grant"]:::security
    n02["Media URLs<br/>Public: CloudFront OAC + tags;<br/>protected: presigned S3 GET"]:::edge
    n03["Progressive image / video<br/>Blurhash → responsive preview;<br/>expiry-aware refresh + fallback"]:::app
    n00 -->|"open album"| n01
    n01 -->|"serialize allowed"| n02
    n02 -->|"fetch bytes"| n03
  end
  style lane0 fill:#FAFBFD,stroke:#DCE3EB,color:#526578
  subgraph lane1["SINGLE FILE AND ALBUM ZIP"]
    direction LR
    n10["Download or ZIP action<br/>Album route or exact share route"]:::actor
    n11["Download / create_zip API<br/>Authorize media; rate limit;<br/>return URL or async ZIP job"]:::security
    n12["WorkerZip → ImagesBucket<br/>Read selected sources; write<br/>temp-zips job/status + archive"]:::job
    n13["Browser download<br/>Poll job; signed archive URL;<br/>temp-zips expire after one day"]:::app
    n10 -->|"POST request"| n11
    n11 -->|"ZIP only: invoke"| n12
    n12 -->|"download ready ZIP"| n13
  end
  style lane1 fill:#FAFBFD,stroke:#DCE3EB,color:#526578
  subgraph lane2["PRINT CAPABILITY AND ISOLATED STORE"]
    direction LR
    n20["Photo → Order a Print<br/>prepare_print authorizes access"]:::actor
    n21["Five-minute capability<br/>One photo; signed opaque token;<br/>print/session rechecks grant"]:::security
    n22["Opaque reference preview<br/>Copy JPEG to fotomoto/references;<br/>public CDN; 30-day lifecycle"]:::data
    n23["Isolated print.html<br/>prints subdomain iframe; clears<br/>its storage before vendor script"]:::edge
    n20 -->|"issue capability"| n21
    n21 -->|"redeem + copy"| n22
    n22 -->|"preview for widget"| n23
  end
  style lane2 fill:#FAFBFD,stroke:#DCE3EB,color:#526578
  subgraph lane3["ORDER FULFILLMENT"]
    direction LR
    n30["Fotomoto<br/>Products, crop, checkout;<br/>Stripe payment integration"]:::provider
    n31["Photographer<br/>Receive paid order; identify photo"]:::actor
    n32["Manual print-ready upload<br/>Upload matching high-resolution<br/>JPEG to the vendor order"]:::actor
    n33["Fotomoto lab<br/>Produce, pack, ship;<br/>customer order updates"]:::provider
    n30 -->|"paid order"| n31
    n31 -->|"supply original"| n32
    n32 -->|"fulfill order"| n33
  end
  style lane3 fill:#FAFBFD,stroke:#DCE3EB,color:#526578
  %% Invisible links only stack lanes; they do not represent system relationships.
  lane0 ~~~ lane1
  lane1 ~~~ lane2
  lane2 ~~~ lane3
```

Public preview aliases rewrite to canonical tagged objects; direct public S3 access is denied. Original-comparison previews use the separate private bucket in 08. Share/QR URLs navigate back through access checks. Single-file downloads return a capability directly and do not use WorkerZip. Revocation blocks new capabilities; existing signed URLs remain valid until expiry, and redeemed Fotomoto references survive until lifecycle expiry. Fotomoto never receives AWS credentials or automatic access to print-resolution originals.

Sources: [backend/functions/get_shared_album.py](../backend/functions/get_shared_album.py), [backend/functions/media_access.py](../backend/functions/media_access.py), [backend/functions/get_download_url.py](../backend/functions/get_download_url.py), [backend/functions/create_zip.py](../backend/functions/create_zip.py), [backend/functions/worker_zip.py](../backend/functions/worker_zip.py), [backend/functions/prepare_print.py](../backend/functions/prepare_print.py), [src/utils/zipDownload.js](../src/utils/zipDownload.js), [src/print-main.js](../src/print-main.js), [ops/FOTOMOTO_PRINTS.md](../ops/FOTOMOTO_PRINTS.md).

<a id="07-local-editor"></a>

## 07 · Browser-only photo editor

The /editor workspace processes local files independently of the gallery backend. [Open this view in Miro](https://miro.com/app/board/uXjVHsf6LH0=/?moveToWidget=3458764682780830717).

```mermaid
flowchart TB
  classDef actor fill:#EAF2FF,stroke:#3864A3,color:#172B3A,stroke-width:1.5px
  classDef edge fill:#E8F6F6,stroke:#287C83,color:#172B3A,stroke-width:1.5px
  classDef app fill:#EFF1FC,stroke:#606AAF,color:#172B3A,stroke-width:1.5px
  classDef data fill:#FFF3DB,stroke:#A7792B,color:#172B3A,stroke-width:1.5px
  classDef job fill:#FCEEE5,stroke:#AF704A,color:#172B3A,stroke-width:1.5px
  classDef security fill:#F9EAF0,stroke:#A65774,color:#172B3A,stroke-width:1.5px
  classDef provider fill:#F1EBF8,stroke:#86639D,color:#172B3A,stroke-width:1.5px
  classDef ops fill:#EDF2F5,stroke:#62798A,color:#172B3A,stroke-width:1.5px
  subgraph lane0["OPEN AND DECODE"]
    direction LR
    n00["Local photo file<br/>User file picker or drag/drop"]:::actor
    n01["Standard / RAW decoders<br/>Browser image decode or<br/>rawconvert-wasm RAW conversion"]:::app
    n02["Editor source + previews<br/>Orientation, working buffers;<br/>fast and full preview sizes"]:::app
    n03["Local editing session<br/>Geometry, adjustments, presets;<br/>undo/redo, comparison, clipping"]:::app
    n00 -->|"open"| n01
    n01 -->|"decode"| n02
    n02 -->|"edit"| n03
  end
  style lane0 fill:#FAFBFD,stroke:#DCE3EB,color:#526578
  subgraph lane1["INTERACTIVE PREVIEW"]
    direction LR
    n10["Direct controls<br/>Exposure, color, crop/rotate;<br/>zoom and pan"]:::actor
    n11["WebGL live renderer<br/>Responsive GPU preview;<br/>worker fallback when needed"]:::app
    n12["Web Worker + canvas<br/>Exact queued processing;<br/>cancel stale work"]:::job
    n13["Before/After canvas<br/>Local source vs current edit;<br/>keeps UI responsive"]:::app
    n10 -->|"adjust"| n11
    n11 -->|"settle / fallback"| n12
    n12 -->|"render"| n13
  end
  style lane1 fill:#FAFBFD,stroke:#DCE3EB,color:#526578
  subgraph lane2["SAVE AND RESTORE LOCALLY"]
    direction LR
    n20["Source + editor state<br/>History, geometry, adjustments"]:::app
    n21["IndexedDB sessionStore<br/>Persist local source and session;<br/>localStorage holds preferences"]:::data
    n22["Reopened /editor<br/>Restore prior session;<br/>clear session on request"]:::app
    n20 -->|"save"| n21
    n21 -->|"restore"| n22
  end
  style lane2 fill:#FAFBFD,stroke:#DCE3EB,color:#526578
  subgraph lane3["EXPORT"]
    direction LR
    n30["Export settings<br/>JPEG / PNG / WebP;<br/>quality, dimensions, filename"]:::actor
    n31["Dedicated export worker<br/>Full-resolution adjustments;<br/>progress, timeout, cancellation"]:::job
    n32["Canvas → Blob<br/>sRGB; metadata removed<br/>from exported image"]:::app
    n33["Local browser download<br/>User saves edited output"]:::actor
    n30 -->|"start"| n31
    n31 -->|"encode"| n32
    n32 -->|"save file"| n33
  end
  style lane3 fill:#FAFBFD,stroke:#DCE3EB,color:#526578
  %% Invisible links only stack lanes; they do not represent system relationships.
  lane0 ~~~ lane1
  lane1 ~~~ lane2
  lane2 ~~~ lane3
```

Local editor files and adjustments are not sent to an application media endpoint. Normal page-shell delivery and permitted page analytics still apply. The editor's local Before/After canvas is distinct from the gallery's server-generated camera-original comparisons in 08. RAW WASM has a build-time CSP compatibility patch in scripts/patch-rawconvert-csp.mjs.

Sources: [src/pages/Editor.jsx](../src/pages/Editor.jsx), [src/editor/rawDecoder.js](../src/editor/rawDecoder.js), [src/editor/standardDecoder.js](../src/editor/standardDecoder.js), [src/editor/livePreviewRenderer.js](../src/editor/livePreviewRenderer.js), [src/editor/editorWorker.js](../src/editor/editorWorker.js), [src/editor/sessionStore.js](../src/editor/sessionStore.js), [scripts/patch-rawconvert-csp.mjs](../scripts/patch-rawconvert-csp.mjs).

<a id="08-original-comparisons"></a>

## 08 · Gallery camera-original comparisons

Read-only Drive matching produces private Before previews; edited galleries stay authoritative. [Open this view in Miro](https://miro.com/app/board/uXjVHsf6LH0=/?moveToWidget=3458764682780830888).

```mermaid
flowchart TB
  classDef actor fill:#EAF2FF,stroke:#3864A3,color:#172B3A,stroke-width:1.5px
  classDef edge fill:#E8F6F6,stroke:#287C83,color:#172B3A,stroke-width:1.5px
  classDef app fill:#EFF1FC,stroke:#606AAF,color:#172B3A,stroke-width:1.5px
  classDef data fill:#FFF3DB,stroke:#A7792B,color:#172B3A,stroke-width:1.5px
  classDef job fill:#FCEEE5,stroke:#AF704A,color:#172B3A,stroke-width:1.5px
  classDef security fill:#F9EAF0,stroke:#A65774,color:#172B3A,stroke-width:1.5px
  classDef provider fill:#F1EBF8,stroke:#86639D,color:#172B3A,stroke-width:1.5px
  classDef ops fill:#EDF2F5,stroke:#62798A,color:#172B3A,stroke-width:1.5px
  subgraph lane0["PRIVATE ARCHIVE INDEX"]
    direction LR
    n00["EventBridge · 15 minutes<br/>Enabled flag + Google credential<br/>parameter required"]:::job
    n01["OriginalIndexRefresh<br/>Read-only service account;<br/>full inventory + Drive changes"]:::job
    n02["Raw-archive Drive JPGs<br/>Exact configured root descendants;<br/>exclude RAW / edited backup"]:::provider
    n03["Private index + system row<br/>OriginalPreviewBucket index/;<br/>OriginalComparisonTable pointer"]:::data
    n00 -->|"invoke"| n01
    n01 -->|"read inventory"| n02
    n02 -->|"publish complete index"| n03
  end
  style lane0 fill:#FAFBFD,stroke:#DCE3EB,color:#526578
  subgraph lane1["MATCH AND GENERATE"]
    direction LR
    n10["Commit + reconciliation<br/>New committed photos +<br/>missing/retryable comparisons"]:::app
    n11["OriginalComparisonQueue<br/>At most two workers;<br/>five attempts → dedicated DLQ"]:::job
    n12["OriginalComparisonWorker<br/>Recheck membership; filename +<br/>capture time + camera + checksum"]:::job
    n13["Private Before variants<br/>Read verified Drive JPG; write<br/>640 / 960 / 1440 / 1920 WebP"]:::data
    n10 -->|"enqueue"| n11
    n11 -->|"consume / lease"| n12
    n12 -->|"render full framing"| n13
  end
  style lane1 fill:#FAFBFD,stroke:#DCE3EB,color:#526578
  subgraph lane2["AUTHORIZED DELIVERY"]
    direction LR
    n20["Album / comparison API<br/>Public, owner/admin, share policy"]:::security
    n21["OriginalComparisonTable<br/>pending / ready / unavailable /<br/>ambiguous / failed; private evidence"]:::data
    n22["Signed before/ URLs<br/>Separate private S3 bucket;<br/>30-minute expiry + private cache"]:::security
    n23["Photo lightbox Before toggle<br/>Lazy load fitted variant;<br/>reuse while authorized and valid"]:::app
    n20 -->|"read comparison"| n21
    n21 -->|"sign allowed output"| n22
    n22 -->|"fetch on demand"| n23
  end
  style lane2 fill:#FAFBFD,stroke:#DCE3EB,color:#526578
  subgraph lane3["PENDING WORK AND FAILURE"]
    direction LR
    n30["Pending / failed photo<br/>Edited image remains visible"]:::app
    n31["Visible-view refresh<br/>Backoff; cancel on navigation;<br/>share viewer retains security check"]:::app
    n32["Reconciliation + alarms<br/>Retry missing work; DLQ and<br/>index-refresh error signals → 11"]:::job
    n30 -. "refresh status" .-> n31
    n31 -. "repair / observe" .-> n32
  end
  style lane3 fill:#FAFBFD,stroke:#DCE3EB,color:#526578
  %% Invisible links only stack lanes; they do not represent system relationships.
  lane0 ~~~ lane1
  lane1 ~~~ lane2
  lane2 ~~~ lane3
```

The read-only archive reader does not use the edited-backup OAuth writer. It never modifies Drive or publishes a partial index. The worker strips EXIF/GPS/XMP/ICC, preserves full framing, and stores derivatives rather than source camera JPGs. Even public-album Before previews have no public CDN alias. API DTOs exclude Drive IDs, source names and matching evidence. This feature is parameter-gated; source configuration alone does not establish live activation or backfill completion.

Sources: [ops/PHOTO_ORIGINAL_COMPARISONS.md](../ops/PHOTO_ORIGINAL_COMPARISONS.md), [backend/functions/original_index_refresh.py](../backend/functions/original_index_refresh.py), [backend/functions/original_drive.py](../backend/functions/original_drive.py), [backend/functions/original_match.py](../backend/functions/original_match.py), [backend/functions/original_comparison_worker.py](../backend/functions/original_comparison_worker.py), [backend/functions/original_comparison_access.py](../backend/functions/original_comparison_access.py), [src/hooks/usePhotoOriginalRefresh.js](../src/hooks/usePhotoOriginalRefresh.js).

<a id="09-admin-integrations"></a>

## 09 · Administration and integrations

Admin reads and mutations connect to distinct data stores and provider responsibilities. [Open this view in Miro](https://miro.com/app/board/uXjVHsf6LH0=/?moveToWidget=3458764682780888933).

```mermaid
flowchart TB
  classDef actor fill:#EAF2FF,stroke:#3864A3,color:#172B3A,stroke-width:1.5px
  classDef edge fill:#E8F6F6,stroke:#287C83,color:#172B3A,stroke-width:1.5px
  classDef app fill:#EFF1FC,stroke:#606AAF,color:#172B3A,stroke-width:1.5px
  classDef data fill:#FFF3DB,stroke:#A7792B,color:#172B3A,stroke-width:1.5px
  classDef job fill:#FCEEE5,stroke:#AF704A,color:#172B3A,stroke-width:1.5px
  classDef security fill:#F9EAF0,stroke:#A65774,color:#172B3A,stroke-width:1.5px
  classDef provider fill:#F1EBF8,stroke:#86639D,color:#172B3A,stroke-width:1.5px
  classDef ops fill:#EDF2F5,stroke:#62798A,color:#172B3A,stroke-width:1.5px
  subgraph lane0["CONTENT AND ACCOUNT MANAGEMENT"]
    direction LR
    n00["Protected admin portal<br/>Dashboard; uploads; albums/media;<br/>hero; users; security / TOTP"]:::actor
    n01["Admin API handlers<br/>Verified Admins claims;<br/>validated, bounded mutations"]:::security
    n02["Cognito + application data<br/>Users, owner assignment, media,<br/>visibility, order, hero assets"]:::data
    n03["Follow-up work · 04–06<br/>Retag, delete, derive, refresh;<br/>Resend invitations / notices"]:::job
    n00 -->|"same-origin API"| n01
    n01 -->|"read / mutate"| n02
    n02 -->|"dispatch"| n03
  end
  style lane0 fill:#FAFBFD,stroke:#DCE3EB,color:#526578
  subgraph lane1["WEBSITE USAGE AND OPERATIONS REPORTS"]
    direction LR
    n10["AnalyticsTracker<br/>Page/media events + web vitals;<br/>DNT/GPC and route exclusions"]:::app
    n11["analytics ingest<br/>Validate + rate limit;<br/>privacy-safe aggregate counters"]:::app
    n12["AnalyticsTable<br/>TTL-bounded anonymous aggregates"]:::data
    n13["Admin analytics<br/>/admin/analytics;<br/>get_analytics_report"]:::app
    n10 -->|"POST events"| n11
    n11 -->|"aggregate"| n12
    n12 -->|"read report"| n13
  end
  style lane1 fill:#FAFBFD,stroke:#DCE3EB,color:#526578
  subgraph lane2["EDITED MEDIA BACKUP AND DRIVE USAGE"]
    direction LR
    n20["Content mutation / daily job<br/>Optional backup; 09:15 UTC refresh"]:::job
    n21["Drive workers<br/>google_drive_sync writes edited<br/>backup; usage refresher reads"]:::job
    n22["Google Drive + cache<br/>Edited website uploads backup;<br/>DriveUsageCacheTable"]:::provider
    n23["Admin Drive usage<br/>/admin/drive-usage; cached report<br/>and bounded on-demand refresh"]:::app
    n20 -->|"invoke"| n21
    n21 -->|"sync / measure"| n22
    n22 -->|"serve summary"| n23
  end
  style lane2 fill:#FAFBFD,stroke:#DCE3EB,color:#526578
  subgraph lane3["BILLING, REPOSITORY AND HEALTH"]
    direction LR
    n30["Admin report APIs<br/>Costs; GitHub; site health; audit"]:::app
    n31["Purpose-specific sources<br/>Cost Explorer; GitHub API;<br/>CloudWatch alarms / Logs Insights"]:::provider
    n32["Caches / safe projection<br/>CostReportCache, GitHub cache;<br/>allowlisted health + audit DTOs"]:::data
    n33["Admin report pages<br/>/costs, /github-analytics,<br/>/site-health, /audit-log under /admin"]:::app
    n30 -->|"query source"| n31
    n31 -->|"cache / filter"| n32
    n32 -->|"display"| n33
  end
  style lane3 fill:#FAFBFD,stroke:#DCE3EB,color:#526578
  %% Invisible links only stack lanes; they do not represent system relationships.
  lane0 ~~~ lane1
  lane1 ~~~ lane2
  lane2 ~~~ lane3
```

GitHub analytics refresh runs hourly at :20 UTC; Drive usage refresh runs daily at 09:15 UTC. Report APIs can use bounded refresh/cache paths. Google Drive's edited backup writer is distinct from the read-only raw archive matcher (08). Resend also handles contact (01); Turnstile protects login/contact/shared entry (02/06); Fotomoto handles commerce (06). Secrets stay in scoped server-side SSM parameters (with optional KMS), not Vite public configuration.

Sources: [src/pages/AdminDashboard.jsx](../src/pages/AdminDashboard.jsx), [src/pages/AdminSecurity.jsx](../src/pages/AdminSecurity.jsx), [src/utils/analytics.js](../src/utils/analytics.js), [backend/functions/analytics.py](../backend/functions/analytics.py), [backend/functions/google_drive_sync.py](../backend/functions/google_drive_sync.py), [backend/functions/get_google_drive_usage.py](../backend/functions/get_google_drive_usage.py), [backend/functions/get_cost_report.py](../backend/functions/get_cost_report.py), [backend/functions/github_analytics.py](../backend/functions/github_analytics.py), [backend/functions/get_site_health.py](../backend/functions/get_site_health.py), [backend/functions/get_audit_log.py](../backend/functions/get_audit_log.py).

<a id="10-release-ownership"></a>

## 10 · Build, release, rollback and ownership

The same tested artifacts move through separated roles and explicit deployment boundaries. [Open this view in Miro](https://miro.com/app/board/uXjVHsf6LH0=/?moveToWidget=3458764682780889000).

```mermaid
flowchart TB
  classDef actor fill:#EAF2FF,stroke:#3864A3,color:#172B3A,stroke-width:1.5px
  classDef edge fill:#E8F6F6,stroke:#287C83,color:#172B3A,stroke-width:1.5px
  classDef app fill:#EFF1FC,stroke:#606AAF,color:#172B3A,stroke-width:1.5px
  classDef data fill:#FFF3DB,stroke:#A7792B,color:#172B3A,stroke-width:1.5px
  classDef job fill:#FCEEE5,stroke:#AF704A,color:#172B3A,stroke-width:1.5px
  classDef security fill:#F9EAF0,stroke:#A65774,color:#172B3A,stroke-width:1.5px
  classDef provider fill:#F1EBF8,stroke:#86639D,color:#172B3A,stroke-width:1.5px
  classDef ops fill:#EDF2F5,stroke:#62798A,color:#172B3A,stroke-width:1.5px
  subgraph lane0["PULL REQUEST QUALITY"]
    direction LR
    n00["Pull request<br/>Source + dependency + IaC changes"]:::actor
    n01["Reusable quality workflow<br/>Frontend / Python / ops / Sharp;<br/>coverage, SAM + infrastructure lint"]:::ops
    n02["Security + artifact gates<br/>CodeQL, dependency/history scans;<br/>source allowlists + byte budgets"]:::security
    n03["Reviewable result<br/>No AWS identity in PR checks"]:::ops
    n00 -->|"run checks"| n01
    n01 -->|"verify"| n02
    n02 -->|"report"| n03
  end
  style lane0 fill:#FAFBFD,stroke:#DCE3EB,color:#526578
  subgraph lane1["MAIN RELEASE"]
    direction LR
    n10["Push to main<br/>Repeat quality gate; build once"]:::actor
    n11["Attested immutable artifacts<br/>Checksums; versioned S3 release<br/>objects encrypted with bootstrap KMS"]:::data
    n12["Plan → execute OIDC roles<br/>Drift + intent + parameters;<br/>reviewed non-replacing change set"]:::security
    n13["SAM application stack<br/>Backend UPDATE_COMPLETE;<br/>backend/template.yaml ownership"]:::ops
    n10 -. "package tested bytes" .-> n11
    n11 -. "plan guarded update" .-> n12
    n12 -. "execute approved intent" .-> n13
  end
  style lane1 fill:#FAFBFD,stroke:#DCE3EB,color:#526578
  subgraph lane2["FRONTEND RELEASE AND RECOVERY"]
    direction LR
    n20["Backend release complete<br/>Exact attested release SHA"]:::ops
    n21["Frontend OIDC role<br/>Upload assets, index last;<br/>non-deleting S3 writes"]:::security
    n22["Frontend CloudFront<br/>Await exact invalidation;<br/>credential-free public posture smoke"]:::edge
    n23["Manual recovery workflow<br/>Select attested successful main SHA;<br/>current trusted control scripts"]:::ops
    n20 -. "permit frontend stage" .-> n21
    n21 -. "publish / verify" .-> n22
    n22 -. "recover if needed" .-> n23
  end
  style lane2 fill:#FAFBFD,stroke:#DCE3EB,color:#526578
  subgraph lane3["SEPARATE OPERATIONS OWNERSHIP"]
    direction LR
    n30["ops templates + tools<br/>Frontend edge / WAF / DNS /<br/>security / backups / observability"]:::ops
    n31["Inventory + guarded changes<br/>Exact account/resource scope;<br/>dry-run tooling + change-set review"]:::security
    n32["Independent ops stacks<br/>us-west-2 home; us-east-1 edge;<br/>us-east-2 recovery vault"]:::ops
    n33["Weekly audit OIDC role<br/>Quality + history + drift/posture;<br/>read-only, no auto-remediation"]:::ops
    n30 -. "prepare" .-> n31
    n31 -. "apply scoped change" .-> n32
    n32 -. "inspect" .-> n33
  end
  style lane3 fill:#FAFBFD,stroke:#DCE3EB,color:#526578
  %% Invisible links only stack lanes; they do not represent system relationships.
  lane0 ~~~ lane1
  lane1 ~~~ lane2
  lane2 ~~~ lane3
```

Normal main releases deploy the application stack and frontend artifacts; they do not automatically deploy every ops stack. Four OIDC roles separate plan, execute, frontend and audit authority; CloudFormation has its own execution role. Existing parameters and protected resources are preserved by exact release contracts. bootstrap owns roles, release artifacts and KMS. See CI_CD.md for authoritative deployment guards and recovery procedure.

Sources: [.github/workflows/_quality.yml](../.github/workflows/_quality.yml), [.github/workflows/pull-request.yml](../.github/workflows/pull-request.yml), [.github/workflows/release-production.yml](../.github/workflows/release-production.yml), [.github/workflows/manual-release.yml](../.github/workflows/manual-release.yml), [.github/workflows/scheduled-security.yml](../.github/workflows/scheduled-security.yml), [backend/Makefile](../backend/Makefile), [ops/CI_CD.md](../ops/CI_CD.md), [ops/ci_bootstrap_template.yaml](../ops/ci_bootstrap_template.yaml).

<a id="11-operations-recovery"></a>

## 11 · Observability, security and recovery

Website incident delivery, account audit evidence and data recovery are separate paths. [Open this view in Miro](https://miro.com/app/board/uXjVHsf6LH0=/?moveToWidget=3458764682780889047).

```mermaid
flowchart TB
  classDef actor fill:#EAF2FF,stroke:#3864A3,color:#172B3A,stroke-width:1.5px
  classDef edge fill:#E8F6F6,stroke:#287C83,color:#172B3A,stroke-width:1.5px
  classDef app fill:#EFF1FC,stroke:#606AAF,color:#172B3A,stroke-width:1.5px
  classDef data fill:#FFF3DB,stroke:#A7792B,color:#172B3A,stroke-width:1.5px
  classDef job fill:#FCEEE5,stroke:#AF704A,color:#172B3A,stroke-width:1.5px
  classDef security fill:#F9EAF0,stroke:#A65774,color:#172B3A,stroke-width:1.5px
  classDef provider fill:#F1EBF8,stroke:#86639D,color:#172B3A,stroke-width:1.5px
  classDef ops fill:#EDF2F5,stroke:#62798A,color:#172B3A,stroke-width:1.5px
  subgraph lane0["WEBSITE HEALTH AND INCIDENT DELIVERY"]
    direction LR
    n00["API / Lambda / SQS / edge<br/>Access + JSON audit logs, X-Ray;<br/>latency, errors, queue and WAF metrics"]:::ops
    n01["CloudWatch + registry<br/>Dashboards, alarms, runbooks;<br/>app alarms → central SNS"]:::ops
    n02["Validated signal routing<br/>Edge/WAF + backup events → SQS<br/>→ signal Lambda → same SNS topic"]:::security
    n03["Website responder<br/>Owner-approved monitored subscriber;<br/>delivery DLQ + triage runbooks"]:::actor
    n00 -. "emit signals" .-> n01
    n01 -. "event route where needed" .-> n02
    n02 -. "notify" .-> n03
  end
  style lane0 fill:#FAFBFD,stroke:#DCE3EB,color:#526578
  subgraph lane1["ACCOUNT EVIDENCE AND POSTURE"]
    direction LR
    n10["AWS management events<br/>Global + multi-Region API activity"]:::ops
    n11["CloudTrail audit foundation<br/>Retained Object-Locked S3 evidence;<br/>CloudWatch logs + metric filters"]:::data
    n12["Home-Region posture<br/>Targeted Config; GuardDuty;<br/>standards-free Security Hub; Analyzer"]:::security
    n13["Read-only account audit<br/>Queryable findings + drift checks;<br/>account signals are audit-only"]:::ops
    n10 -. "record" .-> n11
    n11 ~~~ n12
    n12 -. "review findings" .-> n13
  end
  style lane1 fill:#FAFBFD,stroke:#DCE3EB,color:#526578
  subgraph lane2["METADATA BACKUP AND RESTORE"]
    direction LR
    n20["Application DynamoDB<br/>Retained + deletion-protected;<br/>PITR across application tables"]:::data
    n21["Daily AWS Backup selection<br/>AlbumsTable + PreviewMetadataTable;<br/>08:00 UTC; 35-day recovery points"]:::job
    n22["Primary metadata vault<br/>us-west-2; freshness + failure<br/>signals; guarded restore tests"]:::data
    n23["Recovery destination vault<br/>us-east-2; separate KMS key;<br/>no automatic CopyActions in plan"]:::data
    n20 -. "two selected tables" .-> n21
    n21 -. "store recovery point" .-> n22
    n22 ~~~ n23
  end
  style lane2 fill:#FAFBFD,stroke:#DCE3EB,color:#526578
  subgraph lane3["MEDIA, COST AND CONTROL SAFEGUARDS"]
    direction LR
    n30["ImagesBucket versioning<br/>30-day noncurrent media;<br/>pending/ZIP/reference lifecycles"]:::data
    n31["Edited Drive backup · 09<br/>Optional external media copy;<br/>restore via reviewed tooling"]:::provider
    n32["Guarded security controls<br/>IAM + SSM/KMS; optional DNSSEC;<br/>WAF + bounded concurrency"]:::security
    n33["Cost governance<br/>Optional console-only budget;<br/>no website notification route"]:::ops
    n30 -. "optional backup" .-> n31
    n31 ~~~ n32
    n32 ~~~ n33
  end
  style lane3 fill:#FAFBFD,stroke:#DCE3EB,color:#526578
  %% Invisible links only stack lanes; they do not represent system relationships.
  lane0 ~~~ lane1
  lane1 ~~~ lane2
  lane2 ~~~ lane3
```

No deployed cross-Region copy schedule is inferred from a destination vault: the checked-in primary plan has no CopyActions. AWS Backup selects only AlbumsTable and PreviewMetadataTable; other application tables rely on their PITR/retention unless separately configured. OriginalPreviewBucket holds private derived Before assets and expiring index snapshots; it does not inherit ImagesBucket versioning. Account posture services are home-Region-only and do not forward account-wide findings to website email. Ops creation modes, DNSSEC, Vault Lock and budget remain explicitly conditional. Complete resources and alarm ownership are in the inventories.

Sources: [ops/SECURITY_OBSERVABILITY.md](../ops/SECURITY_OBSERVABILITY.md), [ops/OBSERVABILITY.md](../ops/OBSERVABILITY.md), [ops/ALARM_REGISTRY.md](../ops/ALARM_REGISTRY.md), [ops/security_notifications_template.yaml](../ops/security_notifications_template.yaml), [ops/security_audit_foundation_template.yaml](../ops/security_audit_foundation_template.yaml), [ops/security_managed_services_template.yaml](../ops/security_managed_services_template.yaml), [ops/security_backup_template.yaml](../ops/security_backup_template.yaml), [ops/security_backup_replica_template.yaml](../ops/security_backup_replica_template.yaml), [ops/security_budget_template.yaml](../ops/security_budget_template.yaml), [ops/dnssec-key-template.yaml](../ops/dnssec-key-template.yaml).

## Maintenance

Edit [architecture/model.py](architecture/model.py), then run `python3 ops/architecture/build.py`. This regenerates all Mermaid files, this atlas, the README overview and the source inventory. Add `--miro-dir /tmp/photography-atlas` to generate matching native-shape Miro DSL for an authorized board update. The command itself never modifies Miro or AWS.

Route/function/resource coverage is checked against source during generation. Update the data-responsibility mapping whenever a table or bucket is added. Each view lists the implementation and runbooks used to verify its relationships.
