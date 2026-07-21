#!/usr/bin/env bash
set -euo pipefail

: "${SITE_URL:?SITE_URL is required}"
: "${API_BASE_URL:?API_BASE_URL is required}"

site="${SITE_URL%/}"
api="${API_BASE_URL%/}"
headers="$(mktemp)"
trap 'rm -f "$headers"' EXIT

curl --fail --silent --show-error --location --max-time 20 \
  --dump-header "$headers" --output /dev/null "$site/"
for required in 'strict-transport-security:' 'content-security-policy:' 'x-content-type-options:'; do
  if ! grep -qi "^${required}" "$headers"; then
    echo "Public site is missing a required security header." >&2
    exit 2
  fi
done

curl --fail --silent --show-error --max-time 20 \
  --output "${RUNNER_TEMP:-/tmp}/catalog-smoke.json" \
  "$api/public/albums?type=photo&limit=1"
python3 - "${RUNNER_TEMP:-/tmp}/catalog-smoke.json" <<'PY'
import json
import sys
payload = json.load(open(sys.argv[1], encoding="utf-8"))
if not isinstance(payload, dict) or not isinstance(payload.get("items", payload.get("albums")), list):
    raise SystemExit("catalog smoke response has an unexpected shape")
for album in payload.get("items", payload.get("albums", [])):
    forbidden = {"images", "ownerEmail", "ownerSub", "shareCode", "s3Prefix"} & set(album)
    if forbidden:
        raise SystemExit("catalog smoke response exposed a protected field")
PY
