#!/usr/bin/env bash
set -euo pipefail

: "${SITE_URL:?SITE_URL is required}"
: "${API_BASE_URL:?API_BASE_URL is required}"
: "${API_ORIGIN_URL:?API_ORIGIN_URL is required}"
: "${EXECUTE_API_URL:?EXECUTE_API_URL is required}"
: "${MEDIA_DOMAIN:?MEDIA_DOMAIN is required}"
: "${MEDIA_BUCKET_NAME:?MEDIA_BUCKET_NAME is required}"
: "${AWS_REGION:?AWS_REGION is required}"

site="${SITE_URL%/}"
api="${API_BASE_URL%/}"
if [[ "$api" == "/api" ]]; then
  api="${site}${api}"
elif [[ "$api" != https://* ]]; then
  echo "API base must be same-origin /api or an HTTPS URL." >&2
  exit 2
fi

arguments=(
  --site-url "$site"
  --api-base-url "$api"
  --api-origin-url "$API_ORIGIN_URL"
  --execute-api-url "$EXECUTE_API_URL"
  --media-domain "$MEDIA_DOMAIN"
  --media-bucket-name "$MEDIA_BUCKET_NAME"
  --aws-region "$AWS_REGION"
  --attempts "${PUBLIC_SMOKE_ATTEMPTS:-2}"
  --retry-delay "${PUBLIC_SMOKE_RETRY_DELAY_SECONDS:-5}"
)
if [[ -n "${EXPECTED_RELEASE_SHA:-}" ]]; then
  arguments+=(--expected-release-sha "$EXPECTED_RELEASE_SHA")
fi
if [[ -n "${ORIGINAL_PREVIEW_BUCKET_NAME:-}" ]]; then
  arguments+=(--original-preview-bucket-name "$ORIGINAL_PREVIEW_BUCKET_NAME")
elif [[ "$MEDIA_BUCKET_NAME" =~ ^goldenhour-images-([0-9]{12})-([a-z0-9-]+)$ ]]; then
  arguments+=(--original-preview-bucket-name "goldenhour-originals-${BASH_REMATCH[1]}-${BASH_REMATCH[2]}")
fi
python3 ops/ci/public_posture_smoke.py "${arguments[@]}"
