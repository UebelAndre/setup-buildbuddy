#!/usr/bin/env bash
# Release helpers. Used by .github/workflows/release.yml; runnable locally.
#
#   release.sh next <patch|minor|major>   print the next semver tag (vX.Y.Z)
#   release.sh validate <tag>             exit non-zero unless tag is vX.Y.Z
#   release.sh float <tag>                move the floating major tag (vX) to <tag>
set -euo pipefail

cmd="${1:-}"
arg="${2:-}"

semver_re='^v([0-9]+)\.([0-9]+)\.([0-9]+)$'

latest_tag() {
  git tag --list 'v[0-9]*' | { grep -E "$semver_re" || true; } | sort -V | tail -n1
}

case "$cmd" in
  next)
    latest="$(latest_tag)"
    latest="${latest:-v0.0.0}"
    [[ "$latest" =~ $semver_re ]]
    major="${BASH_REMATCH[1]}"; minor="${BASH_REMATCH[2]}"; patch="${BASH_REMATCH[3]}"
    case "$arg" in
      major) major=$((major + 1)); minor=0; patch=0 ;;
      minor) minor=$((minor + 1)); patch=0 ;;
      patch) patch=$((patch + 1)) ;;
      *) echo "usage: release.sh next <patch|minor|major>" >&2; exit 2 ;;
    esac
    echo "v${major}.${minor}.${patch}"
    ;;
  validate)
    if [[ ! "$arg" =~ $semver_re ]]; then
      echo "::error::Tag '$arg' is not of the form vX.Y.Z. Floating tag not updated." >&2
      exit 1
    fi
    ;;
  float)
    [[ "$arg" =~ $semver_re ]] || { echo "::error::Tag '$arg' is not of the form vX.Y.Z" >&2; exit 1; }
    major_tag="v${BASH_REMATCH[1]}"
    git fetch --force origin "refs/tags/${arg}:refs/tags/${arg}"
    git tag --force --annotate "$major_tag" "${arg}^{}" -m "Update ${major_tag} to ${arg}"
    git push --force origin "refs/tags/${major_tag}"
    echo "${major_tag} -> ${arg} ($(git rev-parse --short "${arg}^{}"))"
    ;;
  *)
    echo "usage: release.sh <next|validate|float> ..." >&2; exit 2 ;;
esac
