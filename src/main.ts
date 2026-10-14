import * as core from '@actions/core'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { Inputs } from './config'
import {
  MISSING_KEY_MESSAGE,
  buildLines,
  cleanKey,
  flagsFileName,
  maskLine,
  rcPrefix,
  resolveKey,
  truthy,
} from './config'

const TITLE = 'setup-buildbuddy'

export function readInputs(): Inputs {
  const str = (name: string): string => core.getInput(name)
  const bool = (name: string): boolean => truthy(core.getInput(name))
  return {
    apiKey: str('api-key'),
    readOnlyApiKey: str('read-only-api-key'),
    missingKey: str('missing-key') || 'warn',
    exportEnv: bool('export-env'),
    authOnly: bool('auth-only'),
    readOnlyDisableUploads: truthy(core.getInput('read-only-disable-uploads') || 'true'),
    remoteEndpoint: str('remote-endpoint'),
    appUrl: str('app-url'),
    bes: truthy(core.getInput('bes') || 'true'),
    remoteCache: truthy(core.getInput('remote-cache') || 'true'),
    remoteExecution: bool('remote-execution'),
    remoteTimeout: str('remote-timeout'),
    cacheCompression: bool('cache-compression'),
    downloadToplevel: bool('download-toplevel'),
    visibility: str('visibility'),
    buildMetadata: str('build-metadata'),
    rcCommand: str('rc-command'),
    config: str('config'),
    bazelrcPath: str('bazelrc-path'),
    flagsFile: str('flags-file'),
    bazelrc: str('bazelrc'),
  }
}

/**
 * The user rc files Bazel loads automatically. On Windows Bazel uses $HOME
 * when set and %USERPROFILE% otherwise, so both are returned when they differ.
 */
export function userRcPaths(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  homedir: string = os.homedir(),
): string[] {
  const candidates = platform === 'win32' ? [env.HOME, env.USERPROFILE, homedir] : [env.HOME, homedir]
  const out: string[] = []
  for (const dir of candidates) {
    if (!dir) continue
    const rc = path.resolve(dir, '.bazelrc')
    if (!out.includes(rc)) out.push(rc)
  }
  return out
}

export function writeFlagsFile(file: string, lines: string[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, lines.join('\n') + '\n', { encoding: 'utf8', mode: 0o600 })
  try {
    fs.chmodSync(file, 0o600)
  } catch {
    // Best effort; not meaningful on Windows.
  }
}

/** Appends `importLine` to `rcPath` unless it is already present. */
export function ensureImport(rcPath: string, importLine: string): boolean {
  fs.mkdirSync(path.dirname(rcPath), { recursive: true })
  let existing = ''
  if (fs.existsSync(rcPath)) {
    existing = fs.readFileSync(rcPath, 'utf8')
  }
  if (existing.split(/\r?\n/).includes(importLine)) return false
  if (existing && !existing.endsWith('\n')) existing += '\n'
  fs.writeFileSync(rcPath, existing + importLine + '\n', 'utf8')
  return true
}

/** Bazel's rc parser treats backslashes as escapes; forward slashes work everywhere. */
export function importLineFor(flagsFile: string): string {
  return `import ${flagsFile.replace(/\\/g, '/')}`
}

function setOutputs(mode: string, authenticated: boolean, bazelrcPath: string, flagsFile: string): void {
  core.setOutput('mode', mode)
  core.setOutput('authenticated', authenticated ? 'true' : 'false')
  core.setOutput('bazelrc-path', bazelrcPath)
  core.setOutput('flags-file', flagsFile)
}

export function run(env: NodeJS.ProcessEnv = process.env): void {
  const inputs = readInputs()

  // Inputs win; otherwise fall back to the conventional environment variables
  // so a workflow-level `env:` block is enough.
  const apiKey = cleanKey(inputs.apiKey || env.BUILDBUDDY_API_KEY)
  const readOnlyApiKey = cleanKey(inputs.readOnlyApiKey || env.BUILDBUDDY_READ_ONLY_API_KEY)

  // Never let either key reach the log, even the "read-only" one.
  if (apiKey) core.setSecret(apiKey)
  if (readOnlyApiKey) core.setSecret(readOnlyApiKey)

  const resolution = resolveKey(apiKey, readOnlyApiKey, inputs.missingKey)

  if (resolution.mode === 'disabled') {
    if (inputs.missingKey === 'skip') {
      core.notice(MISSING_KEY_MESSAGE, { title: TITLE })
    } else {
      core.warning(MISSING_KEY_MESSAGE, { title: TITLE })
    }
    setOutputs('disabled', false, '', '')
    return
  }

  const prefix = rcPrefix(inputs)
  const lines = buildLines(inputs, resolution)

  const flagsFile = path.resolve(
    inputs.flagsFile || path.join(env.RUNNER_TEMP ?? os.tmpdir(), 'setup-buildbuddy', flagsFileName(prefix)),
  )
  const rcPaths = inputs.bazelrcPath ? [path.resolve(inputs.bazelrcPath)] : userRcPaths(env)

  writeFlagsFile(flagsFile, lines)
  const importLine = importLineFor(flagsFile)
  for (const rc of rcPaths) {
    ensureImport(rc, importLine)
  }

  core.exportVariable('BUILDBUDDY_BAZELRC', flagsFile)
  if (inputs.exportEnv && resolution.key) {
    core.exportVariable('BUILDBUDDY_API_KEY', resolution.key)
  }

  switch (resolution.mode) {
    case 'read-write':
      core.info('BuildBuddy configured with a read-write API key.')
      break
    case 'read-only':
      core.info('BuildBuddy configured with a read-only API key (cache uploads disabled).')
      break
    case 'anonymous':
      core.notice(
        'BuildBuddy configured without an API key. Invocations are not tied to your organization and are viewable by anyone with the link.',
        { title: TITLE },
      )
      break
  }
  core.info(`Wrote ${flagsFile} (imported from ${rcPaths.join(' and ')}):`)
  for (const line of lines) {
    core.info(`  ${maskLine(line)}`)
  }

  setOutputs(resolution.mode, Boolean(resolution.key), rcPaths[0], flagsFile)
}
