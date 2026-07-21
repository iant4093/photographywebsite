#!/usr/bin/env bash
set -euo pipefail

required=(AWS_REGION STACK_NAME ARTIFACT_BUCKET ARTIFACT_KMS_KEY_ARN CLOUDFORMATION_EXECUTION_ROLE_ARN GITHUB_RUN_ID GITHUB_RUN_ATTEMPT GITHUB_OUTPUT)
for name in "${required[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    echo "Required release configuration is missing: ${name}" >&2
    exit 2
  fi
done

workspace="${RUNNER_TEMP:?RUNNER_TEMP is required}/backend-plan"
mkdir -p "$workspace"

aws cloudformation describe-stacks \
  --region "$AWS_REGION" \
  --stack-name "$STACK_NAME" \
  --query 'Stacks[0]' \
  --output json > "$workspace/stack.json"
python3 ops/ci/release_guard.py stack-invariants "$workspace/stack.json"
python3 ops/ci/release_guard.py previous-parameters \
  "$workspace/stack.json" "$workspace/parameters.json" \
  --release-sha "${GITHUB_SHA:?GITHUB_SHA is required}"

detection_id="$(aws cloudformation detect-stack-drift \
  --region "$AWS_REGION" \
  --stack-name "$STACK_NAME" \
  --query StackDriftDetectionId \
  --output text)"
DRIFT_DETECTION_ID="$detection_id" ./ops/ci/wait_for_drift.sh

sam package \
  --region "$AWS_REGION" \
  --template-file release/backend/.aws-sam/build/template.yaml \
  --s3-bucket "$ARTIFACT_BUCKET" \
  --kms-key-id "$ARTIFACT_KMS_KEY_ARN" \
  --s3-prefix "releases/${GITHUB_SHA:?GITHUB_SHA is required}/backend" \
  --output-template-file "$workspace/packaged.yaml"

change_set_name="gha-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
change_set_id="$(aws cloudformation create-change-set \
  --region "$AWS_REGION" \
  --stack-name "$STACK_NAME" \
  --change-set-name "$change_set_name" \
  --change-set-type UPDATE \
  --template-body "file://$workspace/packaged.yaml" \
  --parameters "file://$workspace/parameters.json" \
  --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM CAPABILITY_AUTO_EXPAND \
  --role-arn "$CLOUDFORMATION_EXECUTION_ROLE_ARN" \
  --description "Attested GitHub release ${GITHUB_SHA}" \
  --query Id \
  --output text)"

if ! aws cloudformation wait change-set-create-complete \
  --region "$AWS_REGION" \
  --change-set-name "$change_set_id"; then
  status="$(aws cloudformation describe-change-set \
    --region "$AWS_REGION" \
    --change-set-name "$change_set_id" \
    --query Status \
    --output text)"
  reason="$(aws cloudformation describe-change-set \
    --region "$AWS_REGION" \
    --change-set-name "$change_set_id" \
    --query StatusReason \
    --output text)"
  if [[ "$status" == "FAILED" && "$reason" == *"didn't contain changes"* ]]; then
    aws cloudformation delete-change-set --region "$AWS_REGION" --change-set-name "$change_set_id"
    echo "noop=true" >> "$GITHUB_OUTPUT"
    exit 0
  fi
  echo "CloudFormation could not create the guarded change set." >&2
  exit 2
fi

CHANGE_SET_ID="$change_set_id" \
EXPECTED_STACK_NAME="$STACK_NAME" \
EXPECTED_RELEASE_SHA="$GITHUB_SHA" \
CHANGE_PAGES_PATH="$workspace/change-pages.json" \
  ./ops/ci/collect_change_set.sh

echo "noop=false" >> "$GITHUB_OUTPUT"
echo "change_set_id=$change_set_id" >> "$GITHUB_OUTPUT"
