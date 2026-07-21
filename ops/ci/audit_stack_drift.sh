#!/usr/bin/env bash
set -euo pipefail

inventory="${AUDIT_STACKS_PATH:-ops/ci/audit_stacks.json}"
[[ -f "$inventory" ]] || { echo 'Drift inventory is missing.' >&2; exit 2; }
jq -e '
  .version == 4
  and ((keys | sort) == ["homeSecurityPosture", "stacks", "version"])
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
  and ((.homeSecurityPosture | keys | sort)
    == ["cloudFormationExclusion", "homeRegion"])
  and (.homeSecurityPosture.homeRegion
    | test("^[a-z]{2}(-gov)?-[a-z]+-[0-9]$"))
  and ((.homeSecurityPosture.cloudFormationExclusion | keys | sort)
    == ["logicalResourceId", "region", "stackName", "unsupportedLogicalResourceIds"])
  and (.homeSecurityPosture.cloudFormationExclusion as $excluded |
    $excluded.region == .homeSecurityPosture.homeRegion
    and ($excluded.stackName | test("^[A-Za-z][A-Za-z0-9-]{0,127}$"))
    and ($excluded.logicalResourceId | test("^[A-Za-z][A-Za-z0-9]{0,254}$"))
    and ($excluded.unsupportedLogicalResourceIds | type == "array" and length == 3)
    and all($excluded.unsupportedLogicalResourceIds[];
      type == "string" and test("^[A-Za-z][A-Za-z0-9]{0,254}$"))
    and (($excluded.unsupportedLogicalResourceIds | unique | length)
      == ($excluded.unsupportedLogicalResourceIds | length))
    and ([.stacks[]
      | select(.region == $excluded.region and .name == $excluded.stackName)
      | .excludedLogicalResourceIds[]?] | sort
        == ([$excluded.logicalResourceId] + $excluded.unsupportedLogicalResourceIds | sort))
    and ([.stacks[] | .excludedLogicalResourceIds[]?] | sort
      == ([$excluded.logicalResourceId] + $excluded.unsupportedLogicalResourceIds | sort)))
' "$inventory" >/dev/null || { echo 'Drift inventory is invalid.' >&2; exit 2; }

workspace="${RUNNER_TEMP:?RUNNER_TEMP is required}/stack-drift-audit"
mkdir -p "$workspace"
detections="$workspace/detections.tsv"
: > "$detections"

filtered_stacks=0
resource_drift_checks=0
stack_count=0
direct_posture_resources=1
unsupported_resources="$(jq '.homeSecurityPosture.cloudFormationExclusion.unsupportedLogicalResourceIds | length' "$inventory")"
excluded_resources=$((direct_posture_resources + unsupported_resources))
while IFS='|' read -r region stack_name logical_ids_csv excluded_ids_csv; do
  stack_count=$((stack_count + 1))
  logical_ids=()
  if [[ -n "$logical_ids_csv" ]]; then
    IFS=',' read -r -a logical_ids <<< "$logical_ids_csv"
    current_resources="$(aws cloudformation list-stack-resources \
      --region "$region" \
      --stack-name "$stack_name" \
      --query 'StackResourceSummaries[].LogicalResourceId' \
      --output json 2>"$workspace/provider-error.log")" || {
        : > "$workspace/provider-error.log"
        echo 'CloudFormation filtered resource inventory failed.' >&2
        exit 2
      }
    expected_csv="${logical_ids_csv}"
    jq -e --arg expected_csv "$expected_csv" '
      type == "array" and length > 0 and length <= 100
      and all(.[]; type == "string" and test("^[A-Za-z][A-Za-z0-9]{0,254}$"))
      and (unique | length) == length
      and (sort == ($expected_csv | split(",") | map(select(length > 0)) | sort))
    ' <<< "$current_resources" >/dev/null || {
      echo 'CloudFormation filtered resource coverage was incomplete.' >&2
      exit 2
    }
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
    filtered_stacks=$((filtered_stacks + 1))
  fi
  if [[ ${#logical_ids[@]} -gt 0 ]]; then
    for logical_id in "${logical_ids[@]}"; do
      resource_drift="$(aws cloudformation detect-stack-resource-drift \
        --region "$region" \
        --stack-name "$stack_name" \
        --logical-resource-id "$logical_id" \
        --query 'StackResourceDrift.{LogicalId:LogicalResourceId,Status:StackResourceDriftStatus}' \
        --output json 2>"$workspace/provider-error.log")" || {
          : > "$workspace/provider-error.log"
          echo 'CloudFormation resource drift detection failed.' >&2
          exit 2
        }
      jq -e --arg logical_id "$logical_id" '
        .LogicalId == $logical_id and .Status == "IN_SYNC"
      ' <<< "$resource_drift" >/dev/null || {
        echo 'A filtered CloudFormation resource is drifted.' >&2
        exit 2
      }
      resource_drift_checks=$((resource_drift_checks + 1))
    done
  else
    detection_id="$(aws cloudformation detect-stack-drift \
      --region "$region" \
      --stack-name "$stack_name" \
      --query StackDriftDetectionId \
      --output text 2>"$workspace/provider-error.log")" || {
        : > "$workspace/provider-error.log"
        echo 'CloudFormation drift detection could not be started.' >&2
        exit 2
      }
    [[ "$detection_id" =~ ^[0-9a-fA-F-]{36}$ ]] || {
      echo 'CloudFormation returned an invalid drift detection identifier.' >&2
      exit 2
    }
    printf '%s\t%s\t%s\n' "$region" "$stack_name" "$detection_id" >> "$detections"
  fi
done < <(jq -r '.stacks[] | [
  .region,
  .name,
  ((.logicalResourceIds // []) | join(",")),
  ((.excludedLogicalResourceIds // []) | join(","))
] | join("|")' "$inventory")

home_security_path="$workspace/home-security.json"
python3 ops/ci/home_security_posture.py \
  --region "$(jq -r '.homeSecurityPosture.homeRegion' "$inventory")" \
  > "$home_security_path" || {
  echo 'Home security posture audit did not complete.' >&2
  exit 2
}
jq -e '
  .detectorCount == 1
  and (.providerTransitionCount | type == "number" and . >= 0 and . <= 2)
  and .securityHubCount == 1
  and .standardCount == 2
  and .status == "IN_SYNC"
' "$home_security_path" >/dev/null || {
  echo 'Home security posture audit returned an invalid report.' >&2
  exit 2
}
guardduty_checks="$(jq -r '.detectorCount' "$home_security_path")"
security_hub_checks="$(jq -r '.securityHubCount' "$home_security_path")"
security_hub_transitions="$(jq -r '.providerTransitionCount' "$home_security_path")"

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

[[ $((checked + filtered_stacks)) -eq "$stack_count" ]] || {
  echo 'CloudFormation drift coverage was incomplete.' >&2
  exit 2
}

printf '{"directPostureResourceCount":%d,"excludedResourceCount":%d,"filteredStackCount":%d,"frontendEdgeCheckCount":1,"guardDutyPostureCheckCount":%d,"metadataPostureCheckCount":1,"resourceDriftCheckCount":%d,"securityHubPostureCheckCount":%d,"securityHubProviderTransitionCount":%d,"stackCount":%d,"status":"IN_SYNC","unsupportedResourceCount":%d}\n' \
  "$direct_posture_resources" "$excluded_resources" "$filtered_stacks" "$guardduty_checks" "$resource_drift_checks" "$security_hub_checks" "$security_hub_transitions" "$stack_count" "$unsupported_resources"
