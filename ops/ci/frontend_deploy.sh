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

# The marker is committed only after the invalidation waiter succeeds.
plan="${RUNNER_TEMP}/frontend-changes.json"
python3 ops/ci/frontend_changes.py prepare --root "$root" \
  --bucket "$FRONTEND_BUCKET" --region "$AWS_REGION" --plan "$plan"
path_count="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["invalidation"]["Paths"]["Quantity"])' "$plan")"
if [[ "$path_count" != '0' ]]; then
  invalidation_id="$(aws cloudfront create-invalidation \
    --distribution-id "$FRONTEND_DISTRIBUTION_ID" \
    --invalidation-batch "file://${RUNNER_TEMP}/frontend-changes.invalidation.json" \
    --query 'Invalidation.Id' --output text)"
  aws cloudfront wait invalidation-completed \
    --distribution-id "$FRONTEND_DISTRIBUTION_ID" --id "$invalidation_id"
fi

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

python3 ops/ci/frontend_changes.py publish \
  --bucket "$FRONTEND_BUCKET" --region "$AWS_REGION" --plan "$plan"
