#!/usr/bin/env bash
set -euo pipefail

: "${AWS_REGION:?AWS_REGION is required}"
: "${FRONTEND_BUCKET:?FRONTEND_BUCKET is required}"
: "${FRONTEND_DISTRIBUTION_ID:?FRONTEND_DISTRIBUTION_ID is required}"

root="release/frontend/dist"
python3 ops/ci/release_guard.py verify-manifest "$root" release/frontend/manifest.json
python3 ops/ci/release_guard.py frontend-plan "$root" "${RUNNER_TEMP:?}/frontend-upload-plan.json"

public_block="$(aws s3api get-public-access-block \
  --region "$AWS_REGION" \
  --bucket "$FRONTEND_BUCKET" \
  --query 'PublicAccessBlockConfiguration.[BlockPublicAcls,IgnorePublicAcls,BlockPublicPolicy,RestrictPublicBuckets]' \
  --output text)"
if [[ "$public_block" != $'True\tTrue\tTrue\tTrue' ]]; then
  echo "Frontend bucket public-access block is not fully enabled." >&2
  exit 2
fi
distribution_state="$(aws cloudfront get-distribution \
  --id "$FRONTEND_DISTRIBUTION_ID" \
  --query '[Distribution.Status,Distribution.DistributionConfig.Enabled,length(Distribution.DistributionConfig.Origins.Items[?OriginAccessControlId!=`null` && OriginAccessControlId!=``])]' \
  --output text)"
if [[ "$distribution_state" != $'Deployed\tTrue\t1' ]]; then
  echo "Frontend distribution is not deployed, enabled, and OAC-backed." >&2
  exit 2
fi

while IFS= read -r -d '' file; do
  relative="${file#${root}/}"
  [[ "$relative" != "index.html" ]] || continue
  if [[ "$relative" == assets/* ]]; then
    cache_control='public,max-age=31536000,immutable'
  else
    cache_control='public,max-age=300,must-revalidate'
  fi
  aws s3 cp "$file" "s3://${FRONTEND_BUCKET}/${relative}" \
    --region "$AWS_REGION" \
    --cache-control "$cache_control" \
    --only-show-errors
done < <(find "$root" -type f -print0)

aws s3 cp "$root/index.html" "s3://${FRONTEND_BUCKET}/index.html" \
  --region "$AWS_REGION" \
  --cache-control 'no-cache,max-age=0,must-revalidate' \
  --content-type 'text/html; charset=utf-8' \
  --only-show-errors

invalidation_id="$(aws cloudfront create-invalidation \
  --distribution-id "$FRONTEND_DISTRIBUTION_ID" \
  --paths '/' '/index.html' '/images/heroes/*' '/favicon.svg' \
  --query 'Invalidation.Id' \
  --output text)"
aws cloudfront wait invalidation-completed \
  --distribution-id "$FRONTEND_DISTRIBUTION_ID" \
  --id "$invalidation_id"

cache_control="$(aws s3api head-object \
  --region "$AWS_REGION" \
  --bucket "$FRONTEND_BUCKET" \
  --key index.html \
  --query CacheControl \
  --output text)"
if [[ "$cache_control" != 'no-cache,max-age=0,must-revalidate' ]]; then
  echo "Deployed index.html has unexpected cache metadata." >&2
  exit 2
fi
