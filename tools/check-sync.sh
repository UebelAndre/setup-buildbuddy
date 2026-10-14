#!/usr/bin/env bash
# Verifies that everything derived is consistent:
#   - action.yml runs on the Node major pinned in .node-version
#   - package-lock.json matches package.json (npm ci enforces this)
#   - code is formatted and lint-clean (npm run all)
#   - dist/ is exactly what the sources produce
# Run inside the dev container (tools/dev.sh tools/check-sync.sh) or in CI.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

fail() { echo "::error::$*" >&2; exit 1; }

major="$(tr -d '[:space:]' < .node-version | cut -d. -f1)"
grep -qx "  using: node${major}" action.yml \
  || fail "action.yml 'runs.using' does not match .node-version (expected 'using: node${major}')."
grep -qx "  main: dist/index.js" action.yml \
  || fail "action.yml 'runs.main' must be dist/index.js."

npm ci
npm run all

if [[ -n "$(git status --porcelain -- dist package-lock.json)" ]]; then
  git --no-pager status --short -- dist package-lock.json
  git --no-pager diff --stat -- dist package-lock.json
  fail "Generated files are out of date. Run 'tools/dev.sh npm run all' and commit the result."
fi
echo "All generated files are in sync."
