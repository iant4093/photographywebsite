<div align="center">

# Ian Truong Photography

The code behind [iantruongphotography.com](https://iantruongphotography.com), my photography site.

[Live site](https://iantruongphotography.com) · [Architecture board](https://miro.com/app/board/uXjVEYlOMic=/) · [Ops docs](ops/README.md)

![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-7-646CFF?logo=vite&logoColor=white)
![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-4-06B6D4?logo=tailwindcss&logoColor=white)
![Three.js](https://img.shields.io/badge/Three.js-r185-000000?logo=threedotjs&logoColor=white)
![Python](https://img.shields.io/badge/Python-3.12-3776AB?logo=python&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-24_%7C_22-5FA04E?logo=nodedotjs&logoColor=white)
![AWS SAM](https://img.shields.io/badge/AWS-SAM_%7C_Lambda_%7C_CloudFront-FF9900?logo=amazonwebservices&logoColor=white)
![GitHub Actions](https://img.shields.io/badge/CI%2FCD-GitHub_Actions_%2B_OIDC-2088FF?logo=githubactions&logoColor=white)
![Coverage](https://img.shields.io/badge/coverage_gate-80%25-success)

</div>

---

This is where I publish my work, deliver private galleries to clients, and try out ideas that don't fit on a normal portfolio site, like a walkable 3D gallery and a RAW photo editor that runs entirely in the browser.

Everything runs on AWS without a server to look after. The frontend is React, the API is about fifty small Python functions on Lambda, and anything slow (image resizing, video transcoding, ZIP downloads, backups) happens in the background on queues. Every push to `main` goes through tests and security checks before it deploys, and gets smoke-tested against the live site afterward.

A few numbers to give a sense of size:

| | |
|---|---|
| 52 | Lambda functions, mostly Python, plus a Node.js worker that makes image previews |
| 11 | DynamoDB tables |
| 12 | SQS queues for background work |
| 2 | CloudFront distributions, one for the app and API and one for media |
| ~290 | test files, with an 80% coverage floor on every part of the codebase |

## Screenshots

<p align="center">
  <img src="docs/screenshots/home.webp" width="100%" alt="Home page with a full-bleed hero photo of a hiker on a snowy summit and the Ian Truong Photography title">
  <br>
  <sub><b>Home</b> · full-bleed hero with quick links into photos, videos, featured and random picks</sub>
</p>

<table>
  <tr>
    <td width="50%" valign="top">
      <img src="docs/screenshots/album.webp" width="100%" alt="Smith Rock album page showing album details, share, QR code and download buttons above a grid of landscape photos">
      <p align="center"><sub><b>Album with progressive previews</b></sub></p>
    </td>
    <td width="50%" valign="top">
      <img src="docs/screenshots/immersive-gallery.webp" width="100%" alt="3D museum hallway with a reception desk, chandeliers, framed album doorways and a red carpet">
      <p align="center"><sub><b>3D living museum</b> (react-three-fiber)</sub></p>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <img src="docs/screenshots/explore-colors.webp" width="100%" alt="Color Explorer with color swatches and photo counts above a grid of blue-toned photographs">
      <p align="center"><sub><b>Explore by color</b></sub></p>
    </td>
    <td width="50%" valign="top">
      <img src="docs/screenshots/stats-calendar.webp" width="100%" alt="Stats page shooting calendar heatmap for 2026 with days shooting, longest streak and published totals">
      <p align="center"><sub><b>Stats</b> · shooting calendar heatmap</sub></p>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <img src="docs/screenshots/editor.webp" width="100%" alt="In-browser photo editor with a drop zone for photos and RAW files and a panel of film presets">
      <p align="center"><sub><b>In-browser RAW editor</b> (LibRaw → WebAssembly)</sub></p>
    </td>
    <td width="50%" valign="top">
      <img src="docs/screenshots/mobile.webp" width="100%" alt="Three mobile screens side by side: home page, an album page and the Color Explorer">
      <p align="center"><sub><b>Mobile</b> · home, album and color explorer</sub></p>
    </td>
  </tr>
</table>


## What it does

**For visitors**

- Photo and video albums. Images show a blurred placeholder right away, then load sized WebP previews (640 to 1920 px wide). Video streams over HLS and adjusts to the connection.
- An Explore section: a 3D museum you can walk through (built with react-three-fiber), ways to browse by color, lens, exposure, time of day and season, and a game where you guess the camera settings.
- Search, a stats page with a calendar of shooting days, random and featured photos, and a TV slideshow mode that can cast to a Chromecast.
- A print store and a contact form.
- It installs as an app on phones, and album links show a proper preview image when shared in messages or on social media.

**For clients**

- Sign-in with optional two-factor authentication, and a dashboard of the galleries that belong to them.
- Private share links for an album. A wrong or expired link looks exactly like an album that doesn't exist.
- Full-resolution downloads, either one photo at a time or the whole album as a ZIP.
- A before-and-after view that compares my edit with the original file.

**For me, as the admin**

- Uploads go straight from the browser to S3. From there I can organize albums, set the gallery order, schedule an album to publish later, and restore things from a Recently Deleted bin.
- The Videos page has a hero reel that the server assembles with ffmpeg.
- Dashboards for AWS costs (down to storage and bandwidth per album), site analytics including Core Web Vitals, GitHub activity, site health and an audit log.

**Creative tools**

- A RAW editor that runs in the browser. I compiled LibRaw to WebAssembly, so camera RAW files are decoded on your own machine in a Web Worker and never uploaded. It has presets, adjustments, and recovers your session if the tab closes.

## How it's put together

The [architecture board on Miro](https://miro.com/app/board/uXjVEYlOMic=/) has the full picture, read left to right:

1. **Request path.** How a page or API call gets from the browser to the data, and how photos and video take their own shorter path.
2. **Background jobs.** One row per job, showing what starts it, its queue, the worker, and what it produces.
3. **Delivery and operations.** The release pipeline, plus the monitoring, backups and alerts that run all the time.

### Why I built it this way

Traffic to a photography site is spiky. It's quiet most days, then busy when I share an album. Serverless fits that well: I pay for what's used, and there's no server to patch.

The browser only ever talks to CloudFront. API calls go to `/api` on the same domain, and CloudFront adds a secret header before passing them on. Every Lambda checks that header ([`front_door.py`](backend/functions/front_door.py)), so the API simply doesn't respond to anyone who tries to skip the CDN and its firewall.

Big files never go through Lambda. Uploads use presigned URLs straight to S3, public images come from a separate media CDN, and private originals are served with CloudFront signed cookies. That keeps functions small and fast, and avoids Lambda's payload limits.

Anything slow goes on a queue. Generating previews, transcoding video and building ZIPs all run in the background with retries. If a job keeps failing it lands in a dead-letter queue and I get an email.

Access is checked in more than one place. The API checks the sign-in token, each function checks that you own the album (or are an admin), and the S3 bucket and CDN refuse to hand out private files directly.

And because this is a personal project, I care about the bill. Per-route API rate limits, a per-IP firewall on the API and media CDN, caps on how many copies of a function can run at once, and a monthly budget alert keep an abuse spike from turning into a surprise invoice.

## Tech stack

| Area | What I used |
|---|---|
| Frontend | React 19, React Router 8, Vite 7, Tailwind CSS 4, Three.js with react-three-fiber and drei, Framer Motion, hls.js, blurhash, exifr, web-vitals |
| In-browser imaging | LibRaw compiled to WebAssembly with Emscripten, Web Workers, IndexedDB |
| Backend | Python 3.12 on Lambda (AWS SAM), boto3, PyJWT, Pillow, Google API client; Node.js 22 and Sharp for previews; ffmpeg for the hero reel |
| AWS | API Gateway, Lambda, Cognito, DynamoDB, S3, CloudFront and CloudFront Functions, WAF, Route 53, ACM, SQS, EventBridge, MediaConvert, SSM Parameter Store, Secrets Manager, KMS |
| Monitoring and security | CloudWatch, X-Ray, SNS, CloudTrail, AWS Config, GuardDuty, Security Hub, IAM Access Analyzer, AWS Backup, AWS Budgets |
| Third-party services | Cloudflare Turnstile, Resend, Google Drive, GitHub API, Fotomoto, Google Cast |
| Testing and CI | Vitest, Testing Library, Playwright, Python `unittest` with moto and coverage.py, ESLint, cfn-lint, actionlint, zizmor, CodeQL, pip-audit, npm audit, CycloneDX SBOMs, GitHub artifact attestations |

## Parts I'm happy with

- Deploys are careful without being slow. GitHub Actions gets short-lived AWS credentials through OIDC, so there are no stored keys. One role plans the CloudFormation change and a different one applies it, and the plan is checked first: the release stops if it would delete or replace something important that I didn't say should change.
- Each Lambda is built from a list of exactly the source files it needs ([`backend/Makefile`](backend/Makefile)), and the build output is scanned for credentials, so a stray secret file can't end up in a deploy.
- GitHub Actions are pinned to commit hashes, and pull requests get CodeQL, dependency review and a scan of the whole git history for secrets.
- Pages load fast. Routes are lazy-loaded, heavy libraries like Three.js and hls.js are split into their own bundles, public API responses are cached at the edge, and real-user performance numbers get reported back so I can see regressions.
- Ops are written down. The [ops docs](ops/README.md) cover every alarm, how to recover from failures, and the maintenance scripts. A weekly job also checks that all nine CloudFormation stacks still match their templates.

## Things I learned along the way

- Too many alerts is the same as none. I had 18 alarms set up to email me, and most of the emails came from my own uploads making a queue back up for a few minutes. I started ignoring them. Now only things that need action send an email (the site returning errors, jobs that failed for good, stale backups, root account activity, the budget), and everything else stays on the dashboards.
- Check that your alarms can actually reach you. While cleaning that up I found six alarms that had been quietly failing to send, because the SNS topic's access policy didn't list them. There's now a test that fails if any alarm meant to email me isn't allowed to.
- CloudFormation compares templates very literally. A stack that was last deployed from JSON showed changes to resources I hadn't touched when I updated it from the YAML in the repo. Deploying the live template with only the real edits applied gave a clean, minimal change set.

## Running it locally

You'll need Node.js 24 (see [`.node-version`](.node-version)) and Python 3.12.

```bash
npm ci
cp .env.example .env   # only public, non-secret values go here
npm run dev
```

By default the dev server doesn't connect to the real API, so you can work on the UI without touching live data. If you set `VITE_DEV_PROXY_PROD=1` in `.env`, `/api` and private media are proxied to production. Be careful with that one: admin actions will change real data.

`.env`, credential files, media and build output are all git-ignored and should stay that way.

## Tests

These are the same checks CI runs before a release:

```bash
# Frontend: lint, tests with coverage, production build
npm run verify:ci

# Backend (Python 3.12)
python3 -m pip install -r backend/requirements-dev.txt
(cd backend && PYTHONPATH=functions python3 -m coverage run --rcfile=.coveragerc -m unittest discover -s tests -p 'test_*.py')

# Image preview worker
npm --prefix backend/preview_worker ci
npm --prefix backend/preview_worker run test:coverage

# Infrastructure and ops tooling
python3 -m coverage run --rcfile=ops/.coveragerc -m unittest discover -s ops/tests -p 'test_*.py'

# CloudFormation lint and SAM build
bash ops/validate_infrastructure.sh --build
```

There are also Playwright browser checks (`npm run test:browser` and `npm run test:browser:visitors`) and a test for the WebAssembly RAW decoder (`npm run test:raw-decoder`).

## Deploying

There's one branch, `main`, and every push to it deploys. The pipeline:

1. Runs the full test and security suite.
2. Builds the frontend and backend once, then records checksums, a software bill of materials and signed build provenance for them.
3. Gets temporary AWS credentials through GitHub OIDC. Only this repo's `main` branch can assume the roles.
4. Plans the backend change, checks the plan, then applies it.
5. Uploads the frontend to S3 and clears the CloudFront cache.
6. Runs a smoke test against the live site.

The supporting stacks (firewall, security services, backups, monitoring) change rarely, so I deploy those by hand. A weekly job checks them for drift. [`ops/CI_CD.md`](ops/CI_CD.md) has the details.

## Repo layout

```text
.
├── src/                 React app: pages, components (including the 3D museum), RAW editor, hooks, utils, tests
├── public/              Service worker, web manifest, security.txt, open-source license files
├── backend/
│   ├── functions/       Python Lambda handlers and shared helpers
│   ├── preview_worker/  Node.js + Sharp image preview worker
│   ├── tests/           Backend tests
│   ├── Makefile         Which files go into each Lambda build
│   └── template.yaml    The main AWS SAM stack
├── ops/
│   ├── ci/              Release checks, deploy and drift-audit scripts
│   ├── tests/           Tests for the infrastructure and ops tooling
│   ├── *.yaml           Firewall, security, backup, monitoring, DNSSEC and CI stacks
│   └── *.md             Ops docs (start with ops/README.md)
├── scripts/             RAW decoder build, license generator, small build helpers
├── tests/browser/       Playwright checks
├── legal/               Third-party license texts bundled into the build
├── .github/workflows/   Pull request, release, manual release and weekly audit workflows
├── index.html           Main app entry
└── print.html           Print store entry
```

## More docs

| If you want to know about... | Read |
|---|---|
| The ops docs in general, and the maintenance scripts | [`ops/README.md`](ops/README.md) |
| The deploy pipeline | [`ops/CI_CD.md`](ops/CI_CD.md) |
| How the API rejects traffic that skips CloudFront | [`ops/API_FRONT_DOOR.md`](ops/API_FRONT_DOOR.md) |
| Private photos and signed downloads | [`ops/PRIVATE_MEDIA.md`](ops/PRIVATE_MEDIA.md) |
| Monitoring and what each alarm means | [`ops/OBSERVABILITY.md`](ops/OBSERVABILITY.md), [`ops/ALARM_REGISTRY.md`](ops/ALARM_REGISTRY.md) |
| AWS account security setup | [`ops/SECURITY_ACCOUNT_BASELINE.md`](ops/SECURITY_ACCOUNT_BASELINE.md), [`ops/SECURITY_OBSERVABILITY.md`](ops/SECURITY_OBSERVABILITY.md) |
| Recovering from problems | [`ops/MAINTENANCE_AND_RECOVERY.md`](ops/MAINTENANCE_AND_RECOVERY.md) |
| Specific features | [`ops/PHOTO_ORIGINAL_COMPARISONS.md`](ops/PHOTO_ORIGINAL_COMPARISONS.md), [`ops/HOVER_PREVIEW_MANIFESTS.md`](ops/HOVER_PREVIEW_MANIFESTS.md), [`ops/FOTOMOTO_PRINTS.md`](ops/FOTOMOTO_PRINTS.md) |
| Handling privacy requests | [`ops/PRIVACY_REQUESTS.md`](ops/PRIVACY_REQUESTS.md) |
| Open-source licenses | [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) |

## Security

If you find a vulnerability, please email the address in [`security.txt`](public/.well-known/security.txt) rather than opening a public issue.
