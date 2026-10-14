# Contributing

Thanks for helping out. This document covers how the repository is laid out,
how to build and test it, and what a pull request needs before it can merge.

## Prerequisites

Docker is the only requirement. Node, npm and the linters live in a pinned
image ([tools/Dockerfile](tools/Dockerfile)); you never need to install them
on your machine. All commands below go through `tools/dev.sh`, which builds
that image on first use, bind-mounts the repository at `/work`, and runs the
given command as your own user so files it creates are yours.

```bash
tools/dev.sh npm ci          # install dependencies into node_modules/
tools/dev.sh                 # interactive shell inside the container
```

Set `DEV_REBUILD=1` to force the image to rebuild, for example after changing
[.node-version](.node-version) or the Dockerfile.

## Repository layout

| Path                                                           | Purpose                                                                              |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| [action.yml](action.yml)                                       | Action metadata: inputs, outputs, and the Node runtime (`runs.using`).               |
| [src/config.ts](src/config.ts)                                 | Pure logic: key resolution and turning inputs into rc lines. No I/O.                 |
| [src/main.ts](src/main.ts)                                     | Reads inputs, writes the flags file and import line, sets outputs and masks secrets. |
| [src/index.ts](src/index.ts)                                   | Entry point; turns a thrown error into a failed step.                                |
| [src/\_\_tests\_\_/](src/__tests__/)                           | Vitest suites for both of the above.                                                 |
| [dist/](dist/)                                                 | The bundled action, built by ncc. **Committed and checked by CI**, see below.        |
| [test/workspace/](test/workspace/)                             | Minimal Bazel workspace used by the end-to-end CI job.                               |
| [tools/](tools/)                                               | Dev image, the `dev.sh` wrapper, and `check-sync.sh`.                                |
| [.github/workflows/ci.yml](.github/workflows/ci.yml)           | CI: sync check, per-OS behaviour checks, end-to-end Bazel build.                     |
| [.github/workflows/release.yml](.github/workflows/release.yml) | Release automation (see [Releasing](README.md#releasing) in the README).             |

## Build and test

```bash
tools/dev.sh npm run typecheck   # tsc --noEmit
tools/dev.sh npm test            # vitest
tools/dev.sh npm run lint        # eslint, prettier --check, shellcheck, actionlint
tools/dev.sh npm run format      # eslint --fix, then prettier --write
tools/dev.sh npm run build       # bundle src/index.ts into dist/index.js
tools/dev.sh npm run all         # typecheck + lint + test + build
```

To run a single test file or filter by name:

```bash
tools/dev.sh npx vitest run src/__tests__/config.test.ts
tools/dev.sh npx vitest run -t "auth-only"
```

### Testing the built action by hand

The bundle behaves like any Node action: inputs arrive as `INPUT_<NAME>`
environment variables and outputs go to the file named by `GITHUB_OUTPUT`.
This runs it against a throwaway home directory and prints what it wrote:

```bash
tools/dev.sh bash -c '
  export HOME=/tmp/home RUNNER_TEMP=/tmp/rt GITHUB_OUTPUT=/tmp/out GITHUB_ENV=/tmp/env
  mkdir -p "$HOME" "$RUNNER_TEMP" && : > "$GITHUB_OUTPUT" && : > "$GITHUB_ENV"
  env "INPUT_API-KEY=example" "INPUT_REMOTE-TIMEOUT=10m" node dist/index.js
  echo "--- $HOME/.bazelrc"; cat "$HOME/.bazelrc"
  echo "--- flags"; cat "$RUNNER_TEMP"/setup-buildbuddy/*.bazelrc
'
```

If you have Bazel locally you can point it at the generated user rc file to
confirm the flags are accepted: `bazel --bazelrc=/path/to/.bazelrc build //...`.

## Keeping generated files in sync

Actions run straight from the repository checkout, so `dist/index.js` must be
the up-to-date bundle of `src/`. The rule is simple: **after changing anything
under `src/` or in `package.json`, run `tools/dev.sh npm run all` and commit
the result**, including `dist/` and `package-lock.json`.

CI enforces this with `tools/check-sync.sh`, which you can run locally in the
same container:

```bash
tools/dev.sh tools/check-sync.sh
```

It fails if:

- `runs.using` in `action.yml` does not match the Node major in `.node-version`;
- `package-lock.json` does not match `package.json` (`npm ci` refuses to run);
- type-checking, any linter, or any test fails;
- rebuilding `dist/` produces a different result than what is committed.

Note that it reports uncommitted generated files too, so expect it to complain
until you have committed your `dist/` changes.

## What CI runs

- **check**: `tools/dev.sh tools/check-sync.sh` on Ubuntu.
- **configure**: runs the built action on Ubuntu, macOS and Windows in every
  mode (write key, read-only key, environment fallback, auth-only, skip, warn,
  anonymous, error, reruns) and asserts the exact rc contents. Needs no
  BuildBuddy credentials.
- **bazel**: runs `bazel-contrib/setup-bazel`, then this action, then a real
  build of `test/workspace` streaming to BuildBuddy on all three operating
  systems. Uses the repository's `BUILDBUDDY_API_KEY` secret and
  `BUILDBUDDY_READ_ONLY_API_KEY` variable when available and falls back to
  anonymous BES otherwise, so it also passes on pull requests from forks.

## Pull requests

- Keep `src/` changes and the matching `dist/` rebuild in the same pull
  request so every commit on `main` is usable as an action ref.
- Add or update tests in `src/__tests__/` for behaviour changes. The pure
  functions in `config.ts` are the preferred place to put logic, because they
  are trivial to test.
- Update `action.yml` descriptions and the README when inputs or outputs
  change. Do not put `${{ }}` expressions in `action.yml` descriptions: the
  runner evaluates them and fails to load the action.
- If you change the Node major, update `.node-version`, `runs.using` in
  `action.yml`, and rebuild the dev image with `DEV_REBUILD=1`.
- Label the pull request `breaking`, `enhancement`, `bug`, or
  `skip-changelog`; release notes are generated from those labels.

## Releasing

Maintainers cut releases from the GitHub UI; see
[Releasing](README.md#releasing) in the README.
