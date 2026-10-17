<div align="center">

# Ian Truong Photography

**A serverless photography platform on AWS: public portfolio, private client galleries, an in-browser RAW editor, and a full admin portal.**

[**iantruongphotography.com**](https://iantruongphotography.com) · [Architecture board](https://miro.com/app/board/uXjVEYlOMic=/) · [Operations docs](ops/README.md)

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

## Overview

This repository is the complete production source for a working photography business site. It runs entirely on managed AWS services, with no servers to patch and no long-lived credentials. Every change ships through a gated CI/CD pipeline that tests, scans, signs and verifies the release before and after it reaches production.

| | |
|---|---|
| **52** Lambda functions | Python 3.12 handlers plus a Node.js/Sharp image worker |
| **11** DynamoDB tables | Point-in-time recovery, deletion protection, streams |
| **12** SQS queues | Every background workload is buffered, with dead-letter queues |
| **2** CloudFront distributions | One for the app and `/api`, one for media, both behind private S3 origins |
| **~290** test files | 80% line and branch coverage enforced on frontend, backend, worker and ops code |

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

## Features

### For visitors
- **Photo and video albums** with blurhash placeholders, responsive WebP previews from 640 to 1920 px, and adaptive HLS video streaming.
- **Explore hub**: a 3D "living museum" gallery built with react-three-fiber, color, lens, exposure, time-of-day and season explorers, and a *Guess the Settings* game.
- **Discovery tools**: search, a stats page with a shooting calendar, random and featured photos, and a TV slideshow mode with Chromecast support.
- **Print store** delivered on an isolated `prints.` origin, plus a Turnstile-protected contact form.
- **Installable PWA** with a service worker, and social-preview routing so shared album links unfurl with the right image.

### For clients
- Cognito sign-in with optional **TOTP multi-factor authentication** and a personal dashboard of owned galleries.
- **Unlisted share links** for albums, with rate limiting and responses that reveal nothing about whether an album exists.
- Full-resolution downloads through **CloudFront signed cookies** and short-lived presigned URLs, plus one-click full-album ZIP archives.
- Before-and-after comparisons against the original files.

### For the admin
- Direct-to-S3 uploads, album management, custom gallery ordering, **scheduled publishing**, and a Recently Deleted bin with automatic purge.
- An auto-generated hero reel for the Videos page, built server-side with ffmpeg.
- User management, Google Drive backups, and dashboards for AWS cost (Cost Explorer plus per-album storage and bandwidth), first-party analytics with Core Web Vitals, GitHub activity, site health, and the audit log.

### Creative tooling
- **In-browser RAW editor**: LibRaw compiled to WebAssembly with Emscripten, decoding camera RAW files locally in Web Workers, with presets, adjustments and IndexedDB session recovery.
- A **Utilities hub** that hosts the editor and upcoming tools.

## Architecture

> **[Open the interactive architecture board on Miro](https://miro.com/app/board/uXjVEYlOMic=/)**

The board reads left to right in three frames. Numbered circles follow the steps listed beside each diagram.

| Frame | What it shows |
|---|---|
| **1. Request path** | Browser → CloudFront (behind AWS WAF) → API Gateway (Cognito sign-in) → Lambda → DynamoDB and third-party APIs. Photos and video take a separate path from S3 through a dedicated media CDN. |
| **2. Background jobs** | One row per job: what triggers it, its SQS queue, the worker, and the stored result. Covers previews, ZIPs, video transcoding, visibility tagging, cache refresh, Drive backup, original comparisons and failure alerts. |
| **3. Delivery and operations** | The seven-step release pipeline from push to production smoke test, plus the always-on security, monitoring, backup and budget services and what sends an email. |

### Design principles

- **Edge-first.** Browsers only ever talk to CloudFront. The SPA calls the same-origin `/api` path, CloudFront adds a secret origin header, and every Lambda rejects requests that don't carry it. The default `execute-api` endpoint is disabled.
- **Media never passes through Lambda.** Admins upload straight to S3 with presigned URLs. Visitors load previews and video from a dedicated media CDN, and protected originals use signed cookies or short-lived URLs.
- **Asynchronous by default.** Preview generation, video transcoding (MediaConvert), ZIP building, cache invalidation, hover manifests, Drive backup and original-file comparisons all run on queues or streams with bounded concurrency, dead-letter queues and alarms.
- **Defense in depth.** Authorization is enforced at the API (Cognito JWT), again in each handler (owner and `Admins` checks), at S3 (Block Public Access, origin access control only, visibility tags), and at the CDN (non-public objects denied).
- **Bounded cost.** Per-route API throttles, per-IP WAF rate limits on the API and media CDN, reserved Lambda concurrency, object-size limits and an AWS Budgets guard keep a personal project's bill predictable under abuse.

## Tech stack

| Layer | Technologies |
|---|---|
| **Frontend** | React 19, React Router 8, Vite 7, Tailwind CSS 4, Three.js with react-three-fiber and drei, Framer Motion, hls.js, blurhash, exifr, web-vitals |
| **In-browser imaging** | LibRaw → WebAssembly (Emscripten), Web Workers, IndexedDB |
| **Backend** | Python 3.12 on AWS Lambda via AWS SAM, boto3, PyJWT, Pillow, Google API client; Node.js 22 with Sharp for image previews; ffmpeg for the hero reel |
| **AWS** | API Gateway (HTTP API), Lambda, Cognito, DynamoDB, S3, CloudFront and CloudFront Functions, WAF, Route 53 with DNSSEC, ACM, SQS, EventBridge, MediaConvert, SSM Parameter Store, Secrets Manager, KMS |
| **Observability and security** | CloudWatch alarms and dashboards, X-Ray, SNS, CloudTrail, AWS Config, GuardDuty, Security Hub, IAM Access Analyzer, AWS Backup with freshness alarms, AWS Budgets |
| **Integrations** | Cloudflare Turnstile, Resend, Google Drive API, GitHub REST API, Fotomoto, Google Cast |
| **Quality and delivery** | Vitest, Testing Library, Playwright, Python `unittest` with moto and coverage.py, ESLint, cfn-lint, actionlint, zizmor, CodeQL, pip-audit, npm audit, CycloneDX SBOMs, GitHub artifact attestations |

## Engineering highlights

- **Zero-trust origin.** A rotating `X-Origin-Verify` secret, checked in [`front_door.py`](backend/functions/front_door.py), means the regional API is unusable without passing the WAF and CloudFront first. The release guard refuses to deploy unless the front door, the disabled `execute-api` endpoint and the private-media deny are all enforced.
- **Least-privilege packaging.** Each Lambda is built from an explicit per-function source allowlist ([`backend/Makefile`](backend/Makefile)), and the built artifact is scanned for credentials before it can ship.
- **Guarded deployments.** CloudFormation change sets are planned by one OIDC role and executed by another. The plan rejects unexplained replacements, removals or protected-resource changes. Every artifact is checksummed, gets an SBOM, and carries signed build provenance.
- **Supply-chain hygiene.** GitHub Actions are pinned to commit SHAs, workflows are linted against a custom policy, and pull requests run dependency review, CodeQL and a full git-history secret scan.
- **Performance.** Every route is lazy-loaded, vendor bundles are split (Three.js, HLS, auth, motion, imaging), and public catalog responses are cached at the edge. Hover-preview manifests and versioned WebP derivatives keep galleries fast, and real-user Core Web Vitals are reported back.
- **Operability.** Weekly read-only drift and posture audits cover all nine CloudFormation stacks. The release pipeline ends with a production smoke test, and the [runbooks](ops/README.md) cover every alarm, recovery path and maintenance task.

## Repository layout

```text
.
├── src/                 React app: pages, components (incl. 3D museum), RAW editor, hooks, utils, tests
├── public/              Service worker, web manifest, security.txt, open-source license bundle
├── backend/
│   ├── functions/       Python Lambda handlers and shared security/business helpers
│   ├── preview_worker/  Node.js + Sharp image-preview worker
│   ├── tests/           Backend unit and integration-style tests
│   ├── Makefile         Per-function build allowlists
│   └── template.yaml    AWS SAM application stack
├── ops/
│   ├── ci/              Release guard, deploy, drift-audit and posture tooling
│   ├── tests/           Infrastructure and operations tests
│   ├── *.yaml           Security, WAF, backup, observability, DNSSEC and CI-bootstrap stacks
│   └── *.md             Production runbooks (start at ops/README.md)
├── scripts/             RAW decoder build, license generator and bootstrap-asset tooling
├── tests/browser/       Playwright release and visitor checks
├── legal/               Third-party license texts bundled into the build
├── .github/workflows/   Pull-request, release, manual-release and scheduled-audit pipelines
├── index.html           Main app entry
└── print.html           Isolated print-store entry
```

## Getting started

**Prerequisites:** Node.js 24 (see [`.node-version`](.node-version)) and Python 3.12.

```bash
npm ci
cp .env.example .env   # fill in public, non-secret values only
npm run dev
```

By default, the dev server does not proxy `/api`, so UI work never touches live data. Set `VITE_DEV_PROXY_PROD=1` in `.env` to proxy `/api` and `/private-media` to production. Admin actions taken with it enabled change real data.

Never commit `.env`, provider credential files, media, build output or local evidence. The [`.gitignore`](.gitignore) blocks all of these.

## Testing

The commands below run the same gates CI runs before every release:

```bash
# Frontend: lint, tests with coverage thresholds, production build
npm run verify:ci

# Backend (Python 3.12)
python3 -m pip install -r backend/requirements-dev.txt
(cd backend && PYTHONPATH=functions python3 -m coverage run --rcfile=.coveragerc -m unittest discover -s tests -p 'test_*.py')

# Image-preview worker
npm --prefix backend/preview_worker ci
npm --prefix backend/preview_worker run test:coverage

# Infrastructure and operations tooling
python3 -m coverage run --rcfile=ops/.coveragerc -m unittest discover -s ops/tests -p 'test_*.py'

# CloudFormation lint and SAM build
bash ops/validate_infrastructure.sh --build
```

Other checks: `npm run test:browser` and `npm run test:browser:visitors` (Playwright), and `npm run test:raw-decoder` (WASM decoder).

## Deployment

`main` is the only deployment branch. Every push to `main`:

1. runs the full quality and security gate
2. builds immutable frontend and backend artifacts, with checksums, SBOMs and provenance attestations
3. assumes short-lived AWS roles through GitHub OIDC, scoped to this repository and `main`
4. plans the backend change set, checks it against the release guard, then executes it
5. deploys the frontend to S3 and invalidates CloudFront
6. runs a public posture smoke test against production

The supporting ops stacks (WAF, security services, backups, observability, DNSSEC) are deployed separately and drift-audited weekly. The full pipeline is documented in [`ops/CI_CD.md`](ops/CI_CD.md).

## Documentation

| Topic | Document |
|---|---|
| Operations index and maintenance scripts | [`ops/README.md`](ops/README.md) |
| CI/CD pipeline and release guard | [`ops/CI_CD.md`](ops/CI_CD.md) |
| API front door (origin verification) | [`ops/API_FRONT_DOOR.md`](ops/API_FRONT_DOOR.md) |
| Private media and signed access | [`ops/PRIVATE_MEDIA.md`](ops/PRIVATE_MEDIA.md) |
| Observability and alarms | [`ops/OBSERVABILITY.md`](ops/OBSERVABILITY.md), [`ops/ALARM_REGISTRY.md`](ops/ALARM_REGISTRY.md) |
| Account security baseline | [`ops/SECURITY_ACCOUNT_BASELINE.md`](ops/SECURITY_ACCOUNT_BASELINE.md), [`ops/SECURITY_OBSERVABILITY.md`](ops/SECURITY_OBSERVABILITY.md) |
| Maintenance and recovery | [`ops/MAINTENANCE_AND_RECOVERY.md`](ops/MAINTENANCE_AND_RECOVERY.md) |
| Feature deep dives | [`ops/PHOTO_ORIGINAL_COMPARISONS.md`](ops/PHOTO_ORIGINAL_COMPARISONS.md), [`ops/HOVER_PREVIEW_MANIFESTS.md`](ops/HOVER_PREVIEW_MANIFESTS.md), [`ops/FOTOMOTO_PRINTS.md`](ops/FOTOMOTO_PRINTS.md) |
| Privacy requests | [`ops/PRIVACY_REQUESTS.md`](ops/PRIVACY_REQUESTS.md) |
| Third-party notices | [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) |

## Security

To report a vulnerability, use the contact in [`/.well-known/security.txt`](public/.well-known/security.txt). Please don't open a public issue.

---

<div align="center">

Designed, built and operated by **Ian Truong**.

</div>
