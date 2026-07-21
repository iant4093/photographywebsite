#!/usr/bin/env bash
set -euo pipefail

: "${AWS_REGION:?AWS_REGION is required}"
: "${STACK_NAME:?STACK_NAME is required}"
: "${CHANGE_SET_NAME:?CHANGE_SET_NAME is required}"
: "${EXPECTED_RELEASE_SHA:?EXPECTED_RELEASE_SHA is required}"
: "${EXPECTED_TEMPLATE_SHA256:?EXPECTED_TEMPLATE_SHA256 is required}"

workspace="${RUNNER_TEMP:?RUNNER_TEMP is required}/backend-execute"
mkdir -p "$workspace"
aws cloudformation describe-stacks \
  --region "$AWS_REGION" \
  --stack-name "$STACK_NAME" \
  --query 'Stacks[0]' \
  --output json > "$workspace/stack.json"
python3 ops/ci/release_guard.py stack-invariants "$workspace/stack.json"
EXPECTED_STACK_NAME="$STACK_NAME" \
EXPECTED_STACK_PARAMETERS_PATH="$workspace/stack.json" \
CHANGE_PAGES_PATH="$workspace/change-pages.json" \
  ./ops/ci/collect_change_set.sh

aws cloudformation execute-change-set \
  --region "$AWS_REGION" \
  --stack-name "$STACK_NAME" \
  --change-set-name "$CHANGE_SET_NAME"
aws cloudformation wait stack-update-complete \
  --region "$AWS_REGION" \
  --stack-name "$STACK_NAME"
aws cloudformation describe-stacks \
  --region "$AWS_REGION" \
  --stack-name "$STACK_NAME" \
  --query 'Stacks[0]' \
  --output json > "$workspace/updated-stack.json"
python3 ops/ci/release_guard.py stack-invariants "$workspace/updated-stack.json"
status="$(jq -er '.StackStatus' "$workspace/updated-stack.json")"
if [[ "$status" != "UPDATE_COMPLETE" ]]; then
  echo "Stack did not reach UPDATE_COMPLETE." >&2
  exit 2
fi
release_sha="$(jq -er '.Outputs[] | select(.OutputKey == "ReleaseSha") | .OutputValue' "$workspace/updated-stack.json")"
if [[ "$release_sha" != "$EXPECTED_RELEASE_SHA" ]]; then
  echo "Stack release revision does not match the tested artifact." >&2
  exit 2
fi
