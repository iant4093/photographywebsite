#!/usr/bin/env bash
set -euo pipefail

if [[ $# != 1 ]]; then
  echo "Usage: $0 /path/to/publisher.zip" >&2
  exit 2
fi

ops_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
build_dir=$(mktemp -d)
trap 'rm -rf "$build_dir"' EXIT

# Hide the null from the minifier so it preserves the code that reads the snapshot.
sed 's/const snapshot = null;/const snapshot = __PHOTO_API_SNAPSHOT__;/' "$ops_dir/photo_api_selector.js" |
  "$ops_dir/../node_modules/.bin/esbuild" --minify --target=es2015 --legal-comments=none |
  sed 's/__PHOTO_API_SNAPSHOT__/null/' > "$build_dir/photo_api_selector.js"

zip -X -q -j "$1" "$ops_dir/photo_api_publisher.py" "$build_dir/photo_api_selector.js"
