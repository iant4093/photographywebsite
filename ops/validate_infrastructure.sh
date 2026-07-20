#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

python3 -m py_compile \
  ops/backfill_album_owner_sub.py \
  ops/check_album_indexes.py \
  ops/cloudfront_frontend.py \
  ops/dns_hardening.py \
  ops/invalidate_media_cache.py \
  ops/migrate_frontend_origin.py \
  ops/set_lambda_log_retention.py \
  ops/tag_existing_media.py \
  update-cf.py
python3 -m unittest discover -s ops/tests -p 'test_*.py' -v

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
