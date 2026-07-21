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

artifact_versioning="$(aws s3api get-bucket-versioning \
  --region "$AWS_REGION" --bucket "$ARTIFACT_BUCKET" --query Status --output text)"
[[ "$artifact_versioning" == "Enabled" ]] || {
  echo 'Release artifact bucket versioning must remain enabled.' >&2
  exit 2
}

aws cloudformation describe-stacks \
  --region "$AWS_REGION" \
  --stack-name "$STACK_NAME" \
  --query 'Stacks[0]' \
  --output json > "$workspace/stack.json"
python3 ops/ci/release_guard.py stack-invariants "$workspace/stack.json"
python3 ops/ci/release_guard.py previous-parameters \
  "$workspace/stack.json" "$workspace/parameters.json" \
  --release-sha "${GITHUB_SHA:?GITHUB_SHA is required}"
python3 ops/ci/release_guard.py template-environment-policy \
  backend/template.yaml ops/ci/template_environment_policy.json --template-kind source
python3 ops/ci/release_guard.py template-environment-policy \
  release/backend/.aws-sam/build/template.yaml ops/ci/template_environment_policy.json --template-kind built

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
  --s3-prefix "releases/${GITHUB_SHA:?GITHUB_SHA is required}/${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}/backend" \
  --output-template-file "$workspace/packaged-unbound.yaml"

expected_object_count="$(jq -er '
  if .version == 1
    and (.codeUriCount | type) == "number"
    and .codeUriCount >= 1
    and .codeUriCount <= 500
  then .codeUriCount
  else error("invalid release artifact contract")
  end
' ops/ci/release_artifact_contract.json)"
python3 ops/ci/bind_s3_versions.py \
  "$workspace/packaged-unbound.yaml" "$workspace/packaged.yaml" \
  --bucket "$ARTIFACT_BUCKET" --region "$AWS_REGION" \
  --expected-object-count "$expected_object_count" > "$workspace/package-binding.json"
packaged_template_sha="$(jq -er '.templateSha256' "$workspace/package-binding.json")"
[[ "$packaged_template_sha" =~ ^[0-9a-f]{64}$ ]] || { echo 'Packaged template digest is invalid.' >&2; exit 2; }

packaged_template_key="releases/${GITHUB_SHA}/${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}/backend/packaged.yaml"
packaged_template_version="$(aws s3api put-object \
  --bucket "$ARTIFACT_BUCKET" \
  --key "$packaged_template_key" \
  --body "$workspace/packaged.yaml" \
  --region "$AWS_REGION" \
  --server-side-encryption aws:kms \
  --ssekms-key-id "$ARTIFACT_KMS_KEY_ARN" \
  --content-type 'application/x-yaml' \
  --if-none-match '*' \
  --query VersionId --output text)"
[[ "$packaged_template_version" != "None" && -n "$packaged_template_version" ]] || {
  echo 'Packaged template upload did not return an exact object version.' >&2
  exit 2
}
encoded_template_version="$(jq -rn --arg value "$packaged_template_version" '$value | @uri')"
packaged_template_url="https://${ARTIFACT_BUCKET}.s3.${AWS_REGION}.amazonaws.com/${packaged_template_key}?versionId=${encoded_template_version}"

change_set_name="gha-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
change_set_id="$(aws cloudformation create-change-set \
  --region "$AWS_REGION" \
  --stack-name "$STACK_NAME" \
  --change-set-name "$change_set_name" \
  --change-set-type UPDATE \
  --template-url "$packaged_template_url" \
  --parameters "file://$workspace/parameters.json" \
  --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM CAPABILITY_AUTO_EXPAND \
  --role-arn "$CLOUDFORMATION_EXECUTION_ROLE_ARN" \
  --description "Attested GitHub release ${GITHUB_SHA} template ${packaged_template_sha}" \
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

CHANGE_SET_NAME="$change_set_name" \
EXPECTED_STACK_NAME="$STACK_NAME" \
EXPECTED_RELEASE_SHA="$GITHUB_SHA" \
EXPECTED_TEMPLATE_SHA256="$packaged_template_sha" \
EXPECTED_STACK_PARAMETERS_PATH="$workspace/stack.json" \
EXPECTED_REQUESTED_PARAMETERS_PATH="$workspace/parameters.json" \
CHANGE_PAGES_PATH="$workspace/change-pages.json" \
  ./ops/ci/collect_change_set.sh

echo "noop=false" >> "$GITHUB_OUTPUT"
echo "change_set_name=$change_set_name" >> "$GITHUB_OUTPUT"
echo "template_sha256=$packaged_template_sha" >> "$GITHUB_OUTPUT"
