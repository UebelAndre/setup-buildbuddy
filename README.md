# setup-buildbuddy

A GitHub Action that wires Bazel up to [BuildBuddy](https://www.buildbuddy.io)
for the rest of the job: build event streaming, remote cache, optional remote
execution, and the right API key for the context the job runs in. It is a
plain Node action, so it runs on Linux, macOS and Windows runners without
needing any shell, and pairs with
[bazel-contrib/setup-bazel](https://github.com/bazel-contrib/setup-bazel) for
installing Bazelisk and GitHub caches.

The core idea is **two keys, chosen automatically**:

| Key                 | Stored as                       | Who gets it                                    | Purpose                                          |
| ------------------- | ------------------------------- | ---------------------------------------------- | ------------------------------------------------ |
| `api-key`           | GitHub **secret**               | pushes, and PRs from branches in the same repo | writes to the remote cache                       |
| `read-only-api-key` | GitHub **variable** (or secret) | everything else, including PRs from forks      | reads from the cache, still streams build events |

If `api-key` is empty (as it is in a fork pull request) the action falls back
to `read-only-api-key`. If both are empty it skips BuildBuddy configuration
with a warning, so the workflow still works and Bazel simply runs without
BuildBuddy. Each input also falls back to an environment variable
(`BUILDBUDDY_API_KEY`, `BUILDBUDDY_READ_ONLY_API_KEY`), so a workflow-level
`env:` block is enough if you prefer that to inputs.

## Usage

```yaml
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      # Optional, but if present it must come first (see below).
      - uses: bazel-contrib/setup-bazel@0.19.1
        with:
          bazelisk-cache: true
          repository-cache: true
          cache-save: ${{ github.event_name != 'pull_request' }}

      - uses: UebelAndre/setup-buildbuddy@v1
        with:
          api-key: ${{ secrets.BUILDBUDDY_API_KEY }}
          read-only-api-key: ${{ vars.BUILDBUDDY_READ_ONLY_API_KEY }}

      - run: bazel test //...
```

Nothing else changes in your workflow. The action writes the flags (and the
key) to a standalone rc file under `$RUNNER_TEMP` and adds one `import` line
for it to the user rc file (`$HOME/.bazelrc`), which Bazel loads for every
invocation. Plain `bazel build` and `bazel test` commands pick up BuildBuddy
automatically.

> **Order matters with setup-bazel.** `bazel-contrib/setup-bazel` truncates
> `$HOME/.bazelrc` when it runs, which would drop the import line, so it must
> run **before** this action. If you cannot control the order, pass the flags
> file explicitly: `bazel --bazelrc="$BUILDBUDDY_BAZELRC" build //...`.

### Creating the keys

In the BuildBuddy app, open **Settings** and go to the organization's
**API keys** page.

1. Create a key labelled, for example, `github-actions-write`. Store it as a
   repository or organization **secret** named `BUILDBUDDY_API_KEY`.
2. Create a second key labelled `github-actions-read`, ticking
   **Read-only key (disable remote cache uploads)**. Store it as a
   **variable** named `BUILDBUDDY_READ_ONLY_API_KEY` if you want fork pull
   requests to read your cache, or as a secret if you do not (see
   [Security posture](#security-posture)).

Rotate either key from the same page; nothing in the repository changes.

### Only applying BuildBuddy with `--config`

If you prefer the flags to be opt-in per invocation, set `config`:

```yaml
- uses: UebelAndre/setup-buildbuddy@v1
  with:
    api-key: ${{ secrets.BUILDBUDDY_API_KEY }}
    read-only-api-key: ${{ vars.BUILDBUDDY_READ_ONLY_API_KEY }}
    config: buildbuddy
- run: bazel test --config=buildbuddy //...
```

### Bring your own configs (auth only)

If your `.bazelrc` already describes how to talk to BuildBuddy, let the action
contribute only the credential and pick a config per invocation. The `mode`
output tells you which kind of key was found, so you can map it onto your own
configs:

```bazelrc
# .bazelrc (checked in, no secrets)
common:bes          --bes_results_url=https://app.buildbuddy.io/invocation/
common:bes          --bes_backend=grpcs://remote.buildbuddy.io
common:read-only    --config=bes --remote_cache=grpcs://remote.buildbuddy.io --noremote_upload_local_results
common:read-write   --config=bes --remote_cache=grpcs://remote.buildbuddy.io
common:rbe          --config=read-write --remote_executor=grpcs://remote.buildbuddy.io
```

```yaml
- uses: UebelAndre/setup-buildbuddy@v1
  id: buildbuddy
  with:
    api-key: ${{ secrets.BUILDBUDDY_API_KEY }}
    read-only-api-key: ${{ vars.BUILDBUDDY_READ_ONLY_API_KEY }}
    auth-only: true

# mode is read-write, read-only, anonymous or disabled.
- if: steps.buildbuddy.outputs.authenticated == 'true'
  run: bazel test --config=${{ steps.buildbuddy.outputs.mode }} //...
- if: steps.buildbuddy.outputs.authenticated != 'true'
  run: bazel test //...
```

In `auth-only` mode the action writes `--remote_header=x-buildbuddy-api-key=...`
under `common` (or `common:<config>` if `config` is set) and nothing else,
except `--noremote_upload_local_results` for read-only keys, which you can turn
off with `read-only-disable-uploads: false`.

### Disk cache

Bazel can use a local `--disk_cache` and a remote cache at the same time, and
setup-bazel can persist that disk cache in GitHub's cache. When a BuildBuddy
key is available this mostly duplicates the remote cache while adding
save/restore time at the start and end of every job. Where it does help is
jobs that end up with **no** key, typically fork pull requests: GitHub lets
them restore caches saved from the base branch. Enable it on setup-bazel for
exactly those runs:

```yaml
- uses: bazel-contrib/setup-bazel@0.19.1
  with:
    disk-cache: ${{ github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name != github.repository }}
    cache-save: ${{ github.event_name != 'pull_request' }}
- uses: UebelAndre/setup-buildbuddy@v1
  with:
    api-key: ${{ secrets.BUILDBUDDY_API_KEY }}
```

## Inputs

### Authentication

| Input                       | Default | Description                                                                                                                                                                                                                 |
| --------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api-key`                   | `""`    | Key with cache write access. Pass a secret. Falls back to `$BUILDBUDDY_API_KEY`.                                                                                                                                            |
| `read-only-api-key`         | `""`    | Read-only key, used when `api-key` is empty. Falls back to `$BUILDBUDDY_READ_ONLY_API_KEY`.                                                                                                                                 |
| `missing-key`               | `warn`  | When no key is available: `warn` skips configuration with a warning annotation, `skip` does so quietly, `anonymous` configures BES without a key (invocations are public and not tied to your org), `error` fails the step. |
| `export-env`                | `false` | Also export the chosen key as `BUILDBUDDY_API_KEY` for later steps.                                                                                                                                                         |
| `auth-only`                 | `false` | Write only the API key header; ignore the feature inputs below. See [Bring your own configs](#bring-your-own-configs-auth-only).                                                                                            |
| `read-only-disable-uploads` | `true`  | With a read-only key, also write `--noremote_upload_local_results`.                                                                                                                                                         |

### BuildBuddy features

| Input               | Default                        | Description                                                                                                   |
| ------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `remote-endpoint`   | `grpcs://remote.buildbuddy.io` | Endpoint for BES, cache and execution.                                                                        |
| `app-url`           | `https://app.buildbuddy.io`    | UI base URL for `--bes_results_url`.                                                                          |
| `bes`               | `true`                         | Stream build events.                                                                                          |
| `remote-cache`      | `true`                         | Use the remote cache.                                                                                         |
| `remote-execution`  | `false`                        | Add `--remote_executor`. Your repo still needs RBE toolchains.                                                |
| `remote-timeout`    | `10m`                          | `--remote_timeout`. Empty string omits it (on Windows an empty input reads as unset, so the default applies). |
| `cache-compression` | `false`                        | Add `--remote_cache_compression` (Bazel 7+).                                                                  |
| `download-toplevel` | `false`                        | Add `--remote_download_toplevel`.                                                                             |
| `visibility`        | `""`                           | `--build_metadata=VISIBILITY=...`, e.g. `PUBLIC`.                                                             |
| `build-metadata`    | `""`                           | Extra `KEY=VALUE` lines, one per line.                                                                        |

Unless `auth-only` is set, the action always writes `--build_metadata=ROLE=CI`.
Repository URL, commit, branch and user are detected by BuildBuddy from the
`GITHUB_*` environment. In read-only mode it also writes
`--noremote_upload_local_results` so Bazel does not attempt uploads the key
cannot perform.

### Where flags are written

| Input          | Default                                                         | Description                                                                         |
| -------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `rc-command`   | `common`                                                        | Command the flags attach to. Use `build` for Bazel older than 7.                    |
| `config`       | `""`                                                            | Write flags as `<rc-command>:<config>` so they only apply with `--config=<config>`. |
| `bazelrc-path` | `$HOME/.bazelrc`                                                | Rc file that receives the `import` line.                                            |
| `flags-file`   | `$RUNNER_TEMP/setup-buildbuddy/<rc-command>[-<config>].bazelrc` | Standalone file holding the generated flags and key.                                |
| `bazelrc`      | `""`                                                            | Extra lines appended to the flags file after the BuildBuddy flags.                  |

The flags file is rewritten on every run, and there is one per
`rc-command`/`config` combination, so runs with different configs coexist while
a rerun with the same config replaces its predecessor. The user rc file only
ever gains a single `import` line per flags file, so rerunning the action
never duplicates flags. A duplicated `--remote_header` would otherwise be sent
as a comma-joined value and break authentication.

The flags file path is exported to later steps as `BUILDBUDDY_BAZELRC`, so
`bazel --bazelrc="$BUILDBUDDY_BAZELRC" build //...` works even if something
later clobbers the user rc file.

## Outputs

| Output          | Description                                                             |
| --------------- | ----------------------------------------------------------------------- |
| `mode`          | `read-write`, `read-only`, `anonymous` or `disabled`.                   |
| `authenticated` | `true` when an API key was written.                                     |
| `bazelrc-path`  | Rc file that imports the flags file (empty when `disabled`).            |
| `flags-file`    | Standalone rc file holding the generated flags (empty when `disabled`). |

## Security posture

### Secrets vs variables

- **Secrets** are encrypted, masked in logs, and, apart from `GITHUB_TOKEN`,
  are _not_ passed to workflows triggered by a pull request from a fork
  ([docs](https://docs.github.com/en/actions/security-for-github-actions/security-guides/using-secrets-in-github-actions)).
  That is exactly the property you want for a key that can write to a shared
  cache: fork code can never see it.
- **Variables** are plain-text configuration. They are readable by anyone who
  can read the repository settings, render unmasked unless you mask them, and
  are not withheld from fork pull requests. This action masks whichever key it
  uses, so neither key appears in logs even when it comes from a variable.

### Why forks must not get the write key

Anyone holding a key that can write to the action cache can store arbitrary
outputs under the cache key of a real action. Later trusted builds on `main`
would download those outputs instead of building them. That is cache
poisoning, and it is why:

- The write key goes in a secret, so fork pull requests never receive it.
- Do **not** use `pull_request_target` together with a checkout of the PR
  head. That trigger runs with the base repository's secrets and would hand
  the write key to untrusted code
  ([docs](https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions)).
- Collaborators with write access to your repository already receive secrets
  in their pull requests. That matches their existing trust level.

### What a leaked read-only key allows

A read-only key cannot upload to the cache, but it still lets the holder
download every cached artifact and stream build events into your
organization's invocation history. For a public repository whose outputs are
derived from public source this is usually an acceptable trade for faster
fork PR builds. If it is not, store the read-only key as a secret too; fork
pull requests then hit `missing-key` (`warn` by default) and simply build
without BuildBuddy.

### Other notes

- GitHub-hosted runners are ephemeral, so the flags file holding the key is
  discarded with the job. It lives under `$RUNNER_TEMP`, which self-hosted
  runners clean between jobs; still treat it like any other credential on
  disk and avoid self-hosted runners for public repositories.
- Bazel marks `--remote_header` as fully redacted in its own logs, and
  BuildBuddy redacts the API key from invocation pages.
- Bazel fails the build when it cannot reach the remote cache or the build
  event service, and this action does not change that. Hosted runners
  occasionally hit transient DNS failures; `--remote_local_fallback` does
  not help for an unreachable cache, so if that matters to you, retry the
  Bazel step or run with `missing-key: skip` on jobs where BuildBuddy is
  optional.
- Pin this action to a release tag or commit SHA, as you would any action.
  The embedded `setup-bazel` step is pinned to a commit SHA.

## Runners and shells

The action is a Node action (`runs.using: node24`), executed by the Node
runtime that the GitHub runner itself ships. It therefore needs no bash,
PowerShell or other shell on the runner, and works the same on GitHub-hosted
and self-hosted Linux, macOS and Windows machines. On Windows the import line
is added to both `%USERPROFILE%\.bazelrc` and `$HOME\.bazelrc` when those
differ, matching where Bazel looks.

Running the action more than once in a job is safe; see
[Where flags are written](#where-flags-are-written).

## Development

Only Docker is required; Node, npm and the linters run in a pinned container
via `tools/dev.sh`. See [CONTRIBUTING.md](CONTRIBUTING.md) for the build,
test, and `dist/` sync workflow.

## Releasing

Releases are cut from the GitHub UI; nothing is tagged or pushed locally.
Versions follow semver with a `v` prefix, and a floating major tag (`v1`)
always points at the latest `v1.x.y` so consumers can write `@v1`.

Either:

- **Actions → Release → Run workflow.** Choose `patch`, `minor` or `major`
  (or type an exact `vX.Y.Z`). The workflow creates the tag and the GitHub
  Release with generated notes, then moves the major tag.
- **Releases → Draft a new release.** Type a new tag such as `v1.2.3`, click
  "Generate release notes", publish. The `release` event then moves the
  major tag. Pre-releases do not move it.

Release notes are grouped by pull request label; see
[.github/release.yml](.github/release.yml). Tick "Publish this Action to the
GitHub Marketplace" on the release page when you want it listed.

## License

Apache 2.0, see [LICENSE](LICENSE).
