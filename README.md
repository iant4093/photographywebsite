# Ian Truong Photography

Production source for [iantruongphotography.com](https://iantruongphotography.com): a public photography portfolio, private client galleries, and an administration portal. The frontend is React and Vite; the serverless backend and operational controls run on AWS.

## What the site provides

- Responsive public photo and video albums with progressive previews.
- Private client accounts and shared albums with authorization enforced by the API.
- Administrative album, media, and user management, with daily AWS cost and Google Drive storage reporting.
- Direct media uploads, preview generation, EXIF extraction, ZIP downloads, and HLS video processing.
- Contact protection, rate limiting, structured audit logging, backups, drift audits, and edge security controls.

## Repository layout

```text
├── .github/                 # Main-branch release, pull-request, rollback, and audit workflows
├── backend/
│   ├── functions/           # Python Lambda handlers and shared security/business helpers
│   ├── preview_worker/      # Node preview-generation worker and contract tests
│   ├── tests/               # Backend unit and integration-style tests
│   └── template.yaml        # AWS SAM application infrastructure
├── ops/
│   ├── ci/                  # Guarded deployment, audit, and release-policy tooling
│   ├── tests/               # Infrastructure and operations tests
│   ├── *.yaml               # Reviewed supporting CloudFormation templates
│   └── README.md            # Production operations entry point
├── public/                  # Static public assets and security contact metadata
├── src/                     # React components, pages, contexts, utilities, and tests
├── .env.example             # Public configuration contract; real .env files stay local
└── package.json             # Frontend development and verification commands
```

Local security and performance review evidence lives in the ignored `website_review/` directory and is intentionally not committed.

## Technology

- React 19, React Router 7, Vite 7, Tailwind CSS 4, and Vitest.
- Python 3.12 Lambda functions managed with AWS SAM.
- API Gateway, Cognito, DynamoDB, S3, CloudFront, MediaConvert, Route 53, WAF, AWS Backup, Config, GuardDuty, Security Hub, CloudWatch, KMS, and SSM Parameter Store.
- Resend for transactional email and Cloudflare Turnstile for bot protection.

## Local development

Use the Node version declared in `.node-version` and copy only public development values from `.env.example` into a local `.env`.

```bash
npm ci
npm run dev
```

Never commit `.env`, provider credential JSON, media, build output, or locally generated evidence.

## Verification

The same core checks run before a production release:

```bash
npm run verify:ci
python3 -m pip install -r backend/requirements-dev.txt
(cd backend && PYTHONPATH=functions python3 -m coverage run --rcfile=.coveragerc -m unittest discover -s tests -p 'test_*.py' -v)
(cd backend && python3 -m coverage json --rcfile=.coveragerc && python3 ../ops/ci/coverage_gate.py coverage/backend/coverage.json)
npm --prefix backend/preview_worker ci
npm --prefix backend/preview_worker run test:coverage
python3 -m coverage run --rcfile=ops/.coveragerc -m unittest discover -s ops/tests -p 'test_*.py' -v
python3 -m coverage json --rcfile=ops/.coveragerc
python3 ops/ci/coverage_gate.py coverage/ops/coverage.json
bash ops/validate_infrastructure.sh --build
```

Additional workflow policy, credential-history, dependency, drift, public-posture, and deployment guards are documented in [`ops/CI_CD.md`](ops/CI_CD.md).

## Deployment model

`main` is the only deployment branch. Every push to `main` runs the full quality and security gate, builds immutable artifacts, plans the backend change set, deploys it only when the guarded plan is valid, deploys the frontend, and verifies public health. AWS access uses short-lived GitHub OIDC sessions restricted to the exact repository and `main` ref; no long-lived AWS credentials belong in GitHub.

Manual release recovery and the scheduled read-only security audit remain available without introducing additional branches or environments. Operational runbooks begin at [`ops/README.md`](ops/README.md).

## Security boundary

Private APIs validate Cognito JWTs and ownership or administrator authorization server-side. Public and shared routes apply bounded input validation, abuse controls, and least-privilege media access. Secrets are loaded from managed AWS storage, client data remains in private storage, and deployment permissions are separated by function.

For changes to authentication, storage, logging, backups, edge controls, or deployment policy, update the corresponding tests and runbooks in the same commit.
