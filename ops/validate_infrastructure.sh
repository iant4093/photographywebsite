#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

python3 -m compileall -q ops backend/functions
python3 -m unittest discover -s ops/tests -p 'test_*.py' -v

if command -v cfn-lint >/dev/null 2>&1; then
  cfn-lint \
    backend/template.yaml \
    ops/ci_bootstrap_template.yaml \
    ops/dnssec-key-template.yaml \
    ops/security_audit_foundation_template.yaml \
    ops/security_notifications_template.yaml \
    ops/security_managed_services_template.yaml \
    ops/security_backup_template.yaml \
    ops/security_backup_replica_template.yaml \
    ops/observability_template.yaml \
    ops/waf_front_door_template.yaml
else
  for template in \
    backend/template.yaml \
    ops/ci_bootstrap_template.yaml \
    ops/dnssec-key-template.yaml \
    ops/security_audit_foundation_template.yaml \
    ops/security_notifications_template.yaml \
    ops/security_managed_services_template.yaml \
    ops/security_backup_template.yaml \
    ops/security_backup_replica_template.yaml \
    ops/observability_template.yaml \
    ops/waf_front_door_template.yaml; do
    sam validate --lint --template-file "$template"
  done
fi

(
  cd backend
  sam validate --lint
)

if [[ -f backend/preview_worker/contract.test.mjs ]]; then
  node --test backend/preview_worker/*.test.mjs
fi

if [[ "${1:-}" == "--build" ]]; then
  (
    cd backend
    sam build --no-cached
  )
  if find backend/.aws-sam/build -mindepth 2 -maxdepth 2 -type f \( \
      -name 'google_oauth_token.json' -o \
      -name 'voice-assistant-*.json' -o \
      -name '*service-account*.json' \
    \) -print -quit | grep -q .; then
    echo 'Credential-like local JSON was found at a Lambda artifact root.' >&2
    exit 1
  fi
fi

echo 'Infrastructure validation passed.'
