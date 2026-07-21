#!/usr/bin/env bash
set -euo pipefail

inventory="${AUDIT_STACKS_PATH:-ops/ci/audit_stacks.json}"
[[ -f "$inventory" ]] || { echo 'Drift inventory is missing.' >&2; exit 2; }
jq -e '
  .version == 2
  and ((keys | sort) == ["regionalSecurityPosture", "rumAppMonitor", "stacks", "version"])
  and ((.rumAppMonitor | keys | sort) == ["name", "region"])
  and (.rumAppMonitor.region | test("^[a-z]{2}(-gov)?-[a-z]+-[0-9]$"))
  and (.rumAppMonitor.name | test("^[A-Za-z0-9._#-]{1,255}$"))
  and (.stacks | type == "array" and length > 0)
  and all(.stacks[];
    ((keys | sort) == ["name", "region"]
      or (keys | sort) == ["logicalResourceIds", "name", "region"]
      or (keys | sort) == ["excludedLogicalResourceIds", "name", "region"])
    and (.region | test("^[a-z]{2}(-gov)?-[a-z]+-[0-9]$"))
    and (.name | test("^[A-Za-z][A-Za-z0-9-]{0,127}$"))
    and ((.logicalResourceIds // []) | type == "array")
    and ((.excludedLogicalResourceIds // []) | type == "array")
    and all((.logicalResourceIds // [])[];
      type == "string" and test("^[A-Za-z][A-Za-z0-9]{0,254}$"))
    and (((.logicalResourceIds // []) | unique | length)
      == ((.logicalResourceIds // []) | length))
    and all((.excludedLogicalResourceIds // [])[];
      type == "string" and test("^[A-Za-z][A-Za-z0-9]{0,254}$"))
    and (((.excludedLogicalResourceIds // []) | unique | length)
      == ((.excludedLogicalResourceIds // []) | length)))
  and ((.stacks | map([.region, .name] | join(":")) | unique | length) == (.stacks | length))
  and ((.regionalSecurityPosture | keys | sort)
    == ["cloudFormationExclusion", "homeRegion", "satelliteStackName"])
  and (.regionalSecurityPosture.homeRegion
    | test("^[a-z]{2}(-gov)?-[a-z]+-[0-9]$"))
  and (.regionalSecurityPosture.satelliteStackName
    | test("^[A-Za-z][A-Za-z0-9-]{0,127}$"))
  and ((.regionalSecurityPosture.cloudFormationExclusion | keys | sort)
    == ["logicalResourceId", "region", "stackName"])
  and (.regionalSecurityPosture.cloudFormationExclusion as $excluded |
    $excluded.region == .regionalSecurityPosture.homeRegion
    and ($excluded.stackName | test("^[A-Za-z][A-Za-z0-9-]{0,127}$"))
    and ($excluded.logicalResourceId | test("^[A-Za-z][A-Za-z0-9]{0,254}$"))
    and ([.stacks[]
      | select(.region == $excluded.region and .name == $excluded.stackName)
      | .excludedLogicalResourceIds[]?] == [$excluded.logicalResourceId])
    and ([.stacks[] | .excludedLogicalResourceIds[]?] == [$excluded.logicalResourceId]))
' "$inventory" >/dev/null || { echo 'Drift inventory is invalid.' >&2; exit 2; }

workspace="${RUNNER_TEMP:?RUNNER_TEMP is required}/stack-drift-audit"
mkdir -p "$workspace"
detections="$workspace/detections.tsv"
: > "$detections"

filtered_stacks=0
excluded_resources=0
while IFS='|' read -r region stack_name logical_ids_csv excluded_ids_csv; do
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
  elif [[ -n "$excluded_ids_csv" ]]; then
    stack_resources="$(aws cloudformation list-stack-resources \
      --region "$region" \
      --stack-name "$stack_name" \
      --query 'StackResourceSummaries[].LogicalResourceId' \
      --output json 2>"$workspace/provider-error.log")" || {
        : > "$workspace/provider-error.log"
        echo 'CloudFormation stack resource inventory failed.' >&2
        exit 2
      }
    jq -e '
      type == "array" and length > 0 and length <= 100
      and all(.[]; type == "string" and test("^[A-Za-z][A-Za-z0-9]{0,254}$"))
      and (unique | length) == length
    ' <<< "$stack_resources" >/dev/null || {
      echo 'CloudFormation stack resource inventory was malformed.' >&2
      exit 2
    }
    IFS=',' read -r -a excluded_ids <<< "$excluded_ids_csv"
    for excluded_id in "${excluded_ids[@]}"; do
      jq -e --arg excluded_id "$excluded_id" 'index($excluded_id) != null' \
        <<< "$stack_resources" >/dev/null || {
          echo 'A reviewed drift exclusion is not present in its stack.' >&2
          exit 2
        }
    done
    logical_ids=()
    while IFS= read -r logical_id; do
      logical_ids[${#logical_ids[@]}]="$logical_id"
    done < <(jq -r --arg excluded_ids "$excluded_ids_csv" '
        ($excluded_ids | split(",")) as $excluded
        | .[] as $logical_id
        | select(($excluded | index($logical_id)) == null)
        | $logical_id
      ' <<< "$stack_resources")
    [[ ${#logical_ids[@]} -gt 0 && ${#logical_ids[@]} -le 100 ]] || {
      echo 'Reviewed drift exclusions left an invalid resource set.' >&2
      exit 2
    }
    detect_arguments+=(--logical-resource-ids "${logical_ids[@]}")
    filtered_stacks=$((filtered_stacks + 1))
    excluded_resources=$((excluded_resources + ${#excluded_ids[@]}))
  fi
  detection_id="$(aws "${detect_arguments[@]}" 2>"$workspace/provider-error.log")" || {
    : > "$workspace/provider-error.log"
    echo 'CloudFormation drift detection could not be started.' >&2
    exit 2
  }
  [[ "$detection_id" =~ ^[0-9a-fA-F-]{36}$ ]] || {
    echo 'CloudFormation returned an invalid drift detection identifier.' >&2
    exit 2
  }
  printf '%s\t%s\t%s\n' "$region" "$stack_name" "$detection_id" >> "$detections"
done < <(jq -r '.stacks[] | [
  .region,
  .name,
  ((.logicalResourceIds // []) | join(",")),
  ((.excludedLogicalResourceIds // []) | join(","))
] | join("|")' "$inventory")

security_home_region="$(jq -r '.regionalSecurityPosture.homeRegion' "$inventory")"
security_posture_path="$workspace/regional-security.json"
python3 ops/ci/regional_security_posture.py \
  --home-region "$security_home_region" \
  --satellite-stack-name "$(jq -r '.regionalSecurityPosture.satelliteStackName' "$inventory")" \
  > "$security_posture_path" || {
  echo 'Regional security posture audit did not complete.' >&2
  exit 2
}
jq -e '
  .enabledRegionCount > 0
  and .detectorCount == .enabledRegionCount
  and .securityHubCount == .enabledRegionCount
  and .findingAggregatorCount == 1
  and .homeStandardCount == 2
  and .satelliteStandardCount == 0
  and .satelliteStackCount == (.enabledRegionCount - 1)
  and .status == "IN_SYNC"
' "$security_posture_path" >/dev/null || {
  echo 'Regional security posture audit returned an invalid report.' >&2
  exit 2
}
guardduty_checks="$(jq -r '.detectorCount' "$security_posture_path")"
security_hub_checks="$(jq -r '.securityHubCount' "$security_posture_path")"

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

printf '{"excludedResourceCount":%d,"filteredStackCount":%d,"frontendEdgeCheckCount":1,"guardDutyPostureCheckCount":%d,"metadataPostureCheckCount":1,"securityHubPostureCheckCount":%d,"stackCount":%d,"status":"IN_SYNC"}\n' \
  "$excluded_resources" "$filtered_stacks" "$guardduty_checks" "$security_hub_checks" "$checked"
