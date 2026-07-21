#!/usr/bin/env bash
set -euo pipefail

: "${AWS_REGION:?AWS_REGION is required}"
: "${DRIFT_DETECTION_ID:?DRIFT_DETECTION_ID is required}"
max_polls="${DRIFT_MAX_POLLS:-60}"
poll_seconds="${DRIFT_POLL_SECONDS:-10}"
[[ "$max_polls" =~ ^[1-9][0-9]{0,2}$ ]] || { echo 'Invalid drift polling limit.' >&2; exit 2; }
[[ "$poll_seconds" =~ ^[1-9][0-9]?$ ]] || { echo 'Invalid drift polling interval.' >&2; exit 2; }

for ((attempt = 1; attempt <= max_polls; attempt += 1)); do
  state="$(aws cloudformation describe-stack-drift-detection-status \
    --region "$AWS_REGION" \
    --stack-drift-detection-id "$DRIFT_DETECTION_ID" \
    --query '[DetectionStatus,StackDriftStatus]' \
    --output text)"
  IFS=$'\t' read -r detection_status stack_drift_status <<< "$state"
  case "$detection_status" in
    DETECTION_IN_PROGRESS)
      if ((attempt == max_polls)); then
        echo 'Stack drift detection timed out.' >&2
        exit 2
      fi
      sleep "$poll_seconds"
      ;;
    DETECTION_COMPLETE)
      if [[ "$stack_drift_status" != "IN_SYNC" ]]; then
        echo 'Production stack drift must be reviewed before deployment.' >&2
        exit 2
      fi
      exit 0
      ;;
    DETECTION_FAILED)
      echo 'Stack drift detection failed closed.' >&2
      exit 2
      ;;
    *)
      echo 'Stack drift detection returned an unknown state.' >&2
      exit 2
      ;;
  esac
done
