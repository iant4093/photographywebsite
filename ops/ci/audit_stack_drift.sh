#!/usr/bin/env bash
set -euo pipefail

inventory="${AUDIT_STACKS_PATH:-ops/ci/audit_stacks.json}"
[[ -f "$inventory" ]] || { echo 'Drift inventory is missing.' >&2; exit 2; }
jq -e '
  .version == 1
  and ((keys | sort) == ["rumAppMonitor", "stacks", "version"])
  and ((.rumAppMonitor | keys | sort) == ["name", "region"])
  and (.rumAppMonitor.region | test("^[a-z]{2}(-gov)?-[a-z]+-[0-9]$"))
  and (.rumAppMonitor.name | test("^[A-Za-z0-9._#-]{1,255}$"))
  and (.stacks | type == "array" and length > 0)
  and all(.stacks[];
    ((keys | sort) == ["name", "region"]
      or (keys | sort) == ["logicalResourceIds", "name", "region"])
    and (.region | test("^[a-z]{2}(-gov)?-[a-z]+-[0-9]$"))
    and (.name | test("^[A-Za-z][A-Za-z0-9-]{0,127}$"))
    and ((.logicalResourceIds // []) | type == "array")
    and all((.logicalResourceIds // [])[];
      type == "string" and test("^[A-Za-z][A-Za-z0-9]{0,254}$"))
    and (((.logicalResourceIds // []) | unique | length)
      == ((.logicalResourceIds // []) | length)))
  and ((.stacks | map([.region, .name] | join(":")) | unique | length) == (.stacks | length))
' "$inventory" >/dev/null || { echo 'Drift inventory is invalid.' >&2; exit 2; }

workspace="${RUNNER_TEMP:?RUNNER_TEMP is required}/stack-drift-audit"
mkdir -p "$workspace"
detections="$workspace/detections.tsv"
: > "$detections"

filtered_stacks=0
while IFS=$'\t' read -r region stack_name logical_ids_csv; do
  detect_arguments=(
    cloudformation detect-stack-drift
    --region "$region"
    --stack-name "$stack_name"
    --query StackDriftDetectionId
    --output text
  )
  if [[ -n "$logical_ids_csv" ]]; then
    IFS=',' read -r -a logical_ids <<< "$logical_ids_csv"
    detect_arguments+=(--logical-resource-ids "${logical_ids[@]}")
    filtered_stacks=$((filtered_stacks + 1))
  fi
  detection_id="$(aws "${detect_arguments[@]}")"
  [[ "$detection_id" =~ ^[0-9a-fA-F-]{36}$ ]] || {
    echo 'CloudFormation returned an invalid drift detection identifier.' >&2
    exit 2
  }
  printf '%s\t%s\t%s\n' "$region" "$stack_name" "$detection_id" >> "$detections"
done < <(jq -r '.stacks[] | [.region, .name, ((.logicalResourceIds // []) | join(","))] | @tsv' "$inventory")

rum_region="$(jq -r '.rumAppMonitor.region' "$inventory")"
rum_name="$(jq -r '.rumAppMonitor.name' "$inventory")"
rum_posture="$(aws rum get-app-monitor --region "$rum_region" --name "$rum_name" --output json)"
jq -e --arg expected_name "$rum_name" '
  .AppMonitor.Name == $expected_name
  and .AppMonitor.Domain == "iantruongphotography.com"
  and .AppMonitor.Platform == "Web"
  and .AppMonitor.State == "CREATED"
  and ((.AppMonitor.CwLogEnabled // false) == false)
  and .AppMonitor.CustomEvents.Status == "DISABLED"
  and .AppMonitor.DeobfuscationConfiguration.JavaScriptSourceMaps.Status == "DISABLED"
  and .AppMonitor.AppMonitorConfiguration.AllowCookies == false
  and .AppMonitor.AppMonitorConfiguration.EnableXRay == false
  and .AppMonitor.AppMonitorConfiguration.SessionSampleRate == 0.1
  and ((.AppMonitor.AppMonitorConfiguration.Telemetries | sort)
    == ["errors", "http", "performance"])
  and ((.AppMonitor.AppMonitorConfiguration.ExcludedPages | sort) == [
    "https://iantruongphotography.com/admin*",
    "https://iantruongphotography.com/dashboard*",
    "https://iantruongphotography.com/login*",
    "https://iantruongphotography.com/sharedalbum*"
  ])
  and (.AppMonitor.AppMonitorConfiguration.GuestRoleArn | type == "string" and length > 0)
  and (.AppMonitor.AppMonitorConfiguration.IdentityPoolId | type == "string" and length > 0)
' <<< "$rum_posture" >/dev/null || {
  echo 'RUM configuration posture differs from the reviewed privacy contract.' >&2
  exit 2
}

./ops/ci/audit_frontend_edge.sh > "$workspace/frontend-edge.json"
jq -e '.status == "IN_SYNC" and .metadataDocumentCount == 6' \
  "$workspace/frontend-edge.json" >/dev/null || {
  echo 'Frontend edge posture audit did not complete.' >&2
  exit 2
}

checked=0
while IFS=$'\t' read -r region _stack_name detection_id; do
  AWS_REGION="$region" \
  DRIFT_DETECTION_ID="$detection_id" \
  DRIFT_MAX_POLLS="${DRIFT_MAX_POLLS:-90}" \
    ./ops/ci/wait_for_drift.sh
  checked=$((checked + 1))
done < "$detections"

printf '{"filteredStackCount":%d,"frontendEdgeCheckCount":1,"metadataPostureCheckCount":1,"stackCount":%d,"status":"IN_SYNC"}\n' \
  "$filtered_stacks" "$checked"
