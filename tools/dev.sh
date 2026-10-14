#!/usr/bin/env bash
# Runs a command inside the project's Node dev container so Node and npm never
# have to be installed on the host. The repository is bind-mounted at /work and
# files are created with your own uid/gid.
#
#   tools/dev.sh npm ci            install dependencies (node_modules/ on the host)
#   tools/dev.sh npm run all       typecheck + test + build dist/
#   tools/dev.sh npm test
#   tools/dev.sh                   interactive shell in the container
#
# Set DEV_REBUILD=1 to force rebuilding the image.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if ! command -v docker >/dev/null 2>&1; then
  echo "tools/dev.sh: docker is required (https://docs.docker.com/get-docker/)" >&2
  exit 1
fi

node_version="$(tr -d '[:space:]' < "$root/.node-version")"
image="setup-buildbuddy-dev:node${node_version}"

if [[ "${DEV_REBUILD:-0}" == 1 ]] || ! docker image inspect "$image" >/dev/null 2>&1; then
  echo "tools/dev.sh: building $image" >&2
  docker build --quiet --build-arg "NODE_VERSION=${node_version}" -t "$image" "$root/tools" >/dev/null
fi

# Persist the npm cache between runs, on the host, owned by the caller.
cache_dir="${XDG_CACHE_HOME:-$HOME/.cache}/setup-buildbuddy/npm"
mkdir -p "$cache_dir"

tty_flags=()
if [[ -t 0 && -t 1 ]]; then
  tty_flags=(--interactive --tty)
fi

if [[ $# -eq 0 ]]; then
  set -- bash
fi

exec docker run --rm "${tty_flags[@]}" \
  --user "$(id -u):$(id -g)" \
  --env HOME=/tmp \
  --volume "$root:/work" \
  --volume "$cache_dir:/npm-cache" \
  --workdir /work \
  "$image" "$@"
