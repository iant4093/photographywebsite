#!/usr/bin/env bash
set -euo pipefail

: "${EXPECTED_AWS_ACCOUNT_ID:?EXPECTED_AWS_ACCOUNT_ID is required}"
[[ "$EXPECTED_AWS_ACCOUNT_ID" =~ ^[0-9]{12}$ ]] || {
  echo 'Expected AWS account identity is invalid.' >&2
  exit 2
}

actual_account_id="$(aws sts get-caller-identity --query Account --output text)"
[[ "$actual_account_id" == "$EXPECTED_AWS_ACCOUNT_ID" ]] || {
  echo 'The active AWS identity is outside the expected account.' >&2
  exit 2
}

echo 'AWS account identity verified.'
