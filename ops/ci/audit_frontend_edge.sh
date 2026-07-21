#!/usr/bin/env bash
set -euo pipefail

contract="${FRONTEND_EDGE_CONTRACT_PATH:-ops/ci/frontend_edge_contract.json}"
workspace="${RUNNER_TEMP:?RUNNER_TEMP is required}/frontend-edge-audit"
mkdir -p "$workspace"
distribution_id="$(jq -er '.distributionId' "$contract")"
bucket="$(jq -er '.bucketName' "$contract")"
region="$(jq -er '.region' "$contract")"

aws cloudfront get-distribution --id "$distribution_id" --output json > "$workspace/distribution.json"
aws s3api get-public-access-block --region "$region" --bucket "$bucket" --output json > "$workspace/public-access-block.json"
aws s3api get-bucket-encryption --region "$region" --bucket "$bucket" --output json > "$workspace/encryption.json"
aws s3api get-bucket-ownership-controls --region "$region" --bucket "$bucket" --output json > "$workspace/ownership.json"
aws s3api get-bucket-versioning --region "$region" --bucket "$bucket" --output json > "$workspace/versioning.json"
[[ -s "$workspace/versioning.json" ]] || printf '{}\n' > "$workspace/versioning.json"
aws s3api get-bucket-policy-status --region "$region" --bucket "$bucket" --output json > "$workspace/policy-status.json"

python3 ops/ci/frontend_edge_posture.py \
  --contract "$contract" \
  --distribution "$workspace/distribution.json" \
  --public-access-block "$workspace/public-access-block.json" \
  --encryption "$workspace/encryption.json" \
  --ownership "$workspace/ownership.json" \
  --versioning "$workspace/versioning.json" \
  --policy-status "$workspace/policy-status.json"
