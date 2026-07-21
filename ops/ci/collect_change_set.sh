#!/usr/bin/env bash
set -euo pipefail

: "${AWS_REGION:?AWS_REGION is required}"
: "${CHANGE_SET_ID:?CHANGE_SET_ID is required}"
: "${EXPECTED_STACK_NAME:?EXPECTED_STACK_NAME is required}"
: "${EXPECTED_RELEASE_SHA:?EXPECTED_RELEASE_SHA is required}"
: "${EXPECTED_TEMPLATE_SHA256:?EXPECTED_TEMPLATE_SHA256 is required}"
: "${EXPECTED_STACK_PARAMETERS_PATH:?EXPECTED_STACK_PARAMETERS_PATH is required}"
: "${CHANGE_PAGES_PATH:?CHANGE_PAGES_PATH is required}"
: "${RELEASE_INTENT_PATH:=ops/ci/release_intent.json}"
: "${RELEASE_DEPENDENCIES_PATH:=ops/ci/release_dependencies.json}"

status="$(aws cloudformation describe-change-set \
  --region "$AWS_REGION" --change-set-name "$CHANGE_SET_ID" \
  --query Status --output text)"
execution_status="$(aws cloudformation describe-change-set \
  --region "$AWS_REGION" --change-set-name "$CHANGE_SET_ID" \
  --query ExecutionStatus --output text)"
actual_id="$(aws cloudformation describe-change-set \
  --region "$AWS_REGION" --change-set-name "$CHANGE_SET_ID" \
  --query ChangeSetId --output text)"
actual_stack="$(aws cloudformation describe-change-set \
  --region "$AWS_REGION" --change-set-name "$CHANGE_SET_ID" \
  --query StackName --output text)"
description="$(aws cloudformation describe-change-set \
  --region "$AWS_REGION" --change-set-name "$CHANGE_SET_ID" \
  --query Description --output text)"
release_sha="$(aws cloudformation describe-change-set \
  --region "$AWS_REGION" --change-set-name "$CHANGE_SET_ID" \
  --query 'Parameters[?ParameterKey==`ReleaseSha`].ParameterValue | [0]' --output text)"

if [[ "$status" != "CREATE_COMPLETE" || "$execution_status" != "AVAILABLE" ]]; then
  echo "Change set is not complete and available." >&2
  exit 2
fi
if [[ "$actual_id" != "$CHANGE_SET_ID" || "$actual_stack" != "$EXPECTED_STACK_NAME" ]]; then
  echo "Change set identity does not match the guarded release." >&2
  exit 2
fi
if [[ ! "$EXPECTED_TEMPLATE_SHA256" =~ ^[0-9a-f]{64}$ \
  || "$description" != "Attested GitHub release ${EXPECTED_RELEASE_SHA} template ${EXPECTED_TEMPLATE_SHA256}" \
  || "$release_sha" != "$EXPECTED_RELEASE_SHA" ]]; then
  echo "Change set revision does not match the tested artifact." >&2
  exit 2
fi

parameters_path="$(dirname "$CHANGE_PAGES_PATH")/change-set-parameters.json"
aws cloudformation describe-change-set \
  --region "$AWS_REGION" --change-set-name "$CHANGE_SET_ID" \
  --query Parameters --output json > "$parameters_path"
if [[ -n "${EXPECTED_REQUESTED_PARAMETERS_PATH:-}" ]]; then
  python3 ops/ci/release_guard.py preserved-parameters \
    "$EXPECTED_STACK_PARAMETERS_PATH" "$EXPECTED_REQUESTED_PARAMETERS_PATH" \
    --release-sha "$EXPECTED_RELEASE_SHA"
fi
python3 ops/ci/release_guard.py preserved-parameters \
  "$EXPECTED_STACK_PARAMETERS_PATH" "$parameters_path" \
  --release-sha "$EXPECTED_RELEASE_SHA" --resolved-values

mkdir -p "$(dirname "$CHANGE_PAGES_PATH")"
echo '[]' > "$CHANGE_PAGES_PATH"
token=""
while true; do
  args=(cloudformation describe-change-set --region "$AWS_REGION" --change-set-name "$CHANGE_SET_ID" --no-paginate)
  if [[ -n "$token" ]]; then
    args+=(--next-token "$token")
  fi
  page="$(aws "${args[@]}" --query '{Changes:Changes,NextToken:NextToken}' --output json)"
  jq --argjson page "$page" '. + [{Changes: ($page.Changes // [])}]' \
    "$CHANGE_PAGES_PATH" > "$CHANGE_PAGES_PATH.next"
  mv "$CHANGE_PAGES_PATH.next" "$CHANGE_PAGES_PATH"
  token="$(jq -r '.NextToken // empty' <<< "$page")"
  [[ -n "$token" ]] || break
done
python3 ops/ci/release_guard.py gate-change-set \
  "$CHANGE_PAGES_PATH" \
  --intent "$RELEASE_INTENT_PATH" \
  --dependencies "$RELEASE_DEPENDENCIES_PATH"
