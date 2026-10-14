import * as core from '@actions/core'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ensureImport, importLineFor, run, userRcPaths } from '../main'

const INPUT_KEYS = [
  'api-key',
  'read-only-api-key',
  'missing-key',
  'export-env',
  'auth-only',
  'read-only-disable-uploads',
  'remote-endpoint',
  'app-url',
  'bes',
  'remote-cache',
  'remote-execution',
  'remote-timeout',
  'cache-compression',
  'download-toplevel',
  'visibility',
  'build-metadata',
  'rc-command',
  'config',
  'bazelrc-path',
  'flags-file',
  'bazelrc',
]

function envName(input: string): string {
  return `INPUT_${input.replace(/ /g, '_').toUpperCase()}`
}

interface Harness {
  tmp: string
  rc: string
  outputs: Record<string, string>
  exported: Record<string, string>
  secrets: string[]
  warnings: string[]
  notices: string[]
  infos: string[]
  env: NodeJS.ProcessEnv
  flagsFile: () => string
}

let h: Harness

function setInputs(values: Record<string, string>): void {
  for (const k of INPUT_KEYS) Reflect.deleteProperty(process.env, envName(k))
  // Mirror action.yml defaults the runner would pass.
  const defaults: Record<string, string> = { 'remote-timeout': '10m', 'rc-command': 'common', 'missing-key': 'warn' }
  for (const [k, v] of Object.entries({ ...defaults, ...values })) process.env[envName(k)] = v
}

beforeEach(() => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-buildbuddy-'))
  h = {
    tmp,
    rc: path.join(tmp, 'home', '.bazelrc'),
    outputs: {},
    exported: {},
    secrets: [],
    warnings: [],
    notices: [],
    infos: [],
    env: { RUNNER_TEMP: path.join(tmp, 'runner-temp') },
    flagsFile: (): string => path.join(tmp, 'runner-temp', 'setup-buildbuddy', 'common.bazelrc'),
  }
  vi.spyOn(core, 'setOutput').mockImplementation((k, v) => {
    h.outputs[k] = String(v)
  })
  vi.spyOn(core, 'exportVariable').mockImplementation((k, v) => {
    h.exported[k] = String(v)
  })
  vi.spyOn(core, 'setSecret').mockImplementation((v) => {
    h.secrets.push(v)
  })
  vi.spyOn(core, 'warning').mockImplementation((m) => {
    h.warnings.push(String(m))
  })
  vi.spyOn(core, 'notice').mockImplementation((m) => {
    h.notices.push(String(m))
  })
  vi.spyOn(core, 'info').mockImplementation((m) => {
    h.infos.push(m)
  })
  setInputs({ 'bazelrc-path': h.rc })
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(h.tmp, { recursive: true, force: true })
})

const read = (p: string): string => fs.readFileSync(p, 'utf8')

describe('run', () => {
  it('writes the flags file and a single import line', () => {
    setInputs({ 'bazelrc-path': h.rc, 'api-key': ' key1\n', 'read-only-api-key': 'ro' })
    run(h.env)

    expect(h.outputs).toEqual({
      mode: 'read-write',
      authenticated: 'true',
      'bazelrc-path': h.rc,
      'flags-file': h.flagsFile(),
    })
    expect(h.secrets).toEqual(['key1', 'ro'])
    expect(read(h.rc)).toBe(`import ${h.flagsFile()}\n`)
    expect(read(h.flagsFile())).toContain('common --remote_header=x-buildbuddy-api-key=key1\n')
    expect(h.exported).toEqual({ BUILDBUDDY_BAZELRC: h.flagsFile() })
    expect(h.infos.join('\n')).not.toContain('key1')
    expect(h.infos.join('\n')).toContain('x-buildbuddy-api-key=***')
  })

  it('rewrites the flags file and keeps one import on rerun', () => {
    fs.mkdirSync(path.dirname(h.rc), { recursive: true })
    fs.writeFileSync(h.rc, 'build --user') // no trailing newline
    setInputs({ 'bazelrc-path': h.rc, 'api-key': 'a', bazelrc: 'build --jobs=16' })
    run(h.env)
    setInputs({ 'bazelrc-path': h.rc, 'api-key': 'b' })
    run(h.env)
    setInputs({ 'bazelrc-path': h.rc, 'api-key': 'c', config: 'other' })
    run(h.env)

    const other = path.join(h.tmp, 'runner-temp', 'setup-buildbuddy', 'common-other.bazelrc')
    expect(read(h.rc)).toBe(`build --user\nimport ${h.flagsFile()}\nimport ${other}\n`)
    const common = read(h.flagsFile())
    expect(common).toContain('x-buildbuddy-api-key=b')
    expect(common).not.toContain('x-buildbuddy-api-key=a')
    expect(common).not.toContain('jobs=16')
    expect(read(other)).toContain('common:other --remote_header=x-buildbuddy-api-key=c')
  })

  it('falls back to environment variables, inputs winning', () => {
    setInputs({ 'bazelrc-path': h.rc })
    run({ ...h.env, BUILDBUDDY_READ_ONLY_API_KEY: ' envro ' })
    expect(h.outputs.mode).toBe('read-only')
    expect(read(h.flagsFile())).toContain('x-buildbuddy-api-key=envro')
    expect(read(h.flagsFile())).toContain('--noremote_upload_local_results')

    run({ ...h.env, BUILDBUDDY_API_KEY: 'envrw', BUILDBUDDY_READ_ONLY_API_KEY: 'envro' })
    expect(h.outputs.mode).toBe('read-write')
    expect(read(h.flagsFile())).toContain('x-buildbuddy-api-key=envrw')

    setInputs({ 'bazelrc-path': h.rc, 'api-key': 'input' })
    run({ ...h.env, BUILDBUDDY_API_KEY: 'envrw' })
    expect(read(h.flagsFile())).toContain('x-buildbuddy-api-key=input')
  })

  it('warns and skips by default when no key is available', () => {
    run(h.env)
    expect(h.outputs).toEqual({ mode: 'disabled', authenticated: 'false', 'bazelrc-path': '', 'flags-file': '' })
    expect(h.warnings).toHaveLength(1)
    expect(h.notices).toHaveLength(0)
    expect(fs.existsSync(h.rc)).toBe(false)
    expect(h.exported).toEqual({})
  })

  it('skips quietly with missing-key=skip', () => {
    setInputs({ 'bazelrc-path': h.rc, 'missing-key': 'skip' })
    run(h.env)
    expect(h.outputs.mode).toBe('disabled')
    expect(h.warnings).toHaveLength(0)
    expect(h.notices).toHaveLength(1)
  })

  it('configures BES only in anonymous mode', () => {
    setInputs({ 'bazelrc-path': h.rc, 'missing-key': 'anonymous', 'remote-cache': 'false' })
    run(h.env)
    expect(h.outputs.mode).toBe('anonymous')
    expect(h.outputs.authenticated).toBe('false')
    const content = read(h.flagsFile())
    expect(content).toContain('--bes_backend=')
    expect(content).not.toContain('remote_header')
    expect(content).not.toContain('remote_cache')
  })

  it('fails with missing-key=error and on bad input', () => {
    setInputs({ 'bazelrc-path': h.rc, 'missing-key': 'error' })
    expect(() => {
      run(h.env)
    }).toThrow(/missing-key=error/)
    setInputs({ 'bazelrc-path': h.rc, 'api-key': 'k', 'build-metadata': 'nope' })
    expect(() => {
      run(h.env)
    }).toThrow(/KEY=VALUE/)
  })

  it('exports the key when asked', () => {
    setInputs({ 'bazelrc-path': h.rc, 'api-key': 'k', 'export-env': 'true' })
    run(h.env)
    expect(h.exported).toEqual({ BUILDBUDDY_BAZELRC: h.flagsFile(), BUILDBUDDY_API_KEY: 'k' })
  })

  it('honours an explicit flags-file', () => {
    const ff = path.join(h.tmp, 'custom.bazelrc')
    setInputs({ 'bazelrc-path': h.rc, 'api-key': 'k', 'flags-file': ff })
    run(h.env)
    expect(h.outputs['flags-file']).toBe(ff)
    expect(read(h.rc)).toBe(`import ${ff}\n`)
  })
})

describe('userRcPaths', () => {
  it('uses HOME on POSIX', () => {
    expect(userRcPaths({ HOME: '/h' }, 'linux', '/h')).toEqual([path.resolve('/h/.bazelrc')])
  })
  it('returns both HOME and USERPROFILE on Windows when they differ', () => {
    const paths = userRcPaths({ HOME: '/a', USERPROFILE: '/b' }, 'win32', '/b')
    expect(paths).toEqual([path.resolve('/a/.bazelrc'), path.resolve('/b/.bazelrc')])
  })
  it('falls back to the OS home directory', () => {
    expect(userRcPaths({}, 'linux', '/home/x')).toEqual([path.resolve('/home/x/.bazelrc')])
  })
})

describe('importLineFor / ensureImport', () => {
  it('uses forward slashes', () => {
    expect(importLineFor('C:\\Users\\r\\x.bazelrc')).toBe('import C:/Users/r/x.bazelrc')
  })
  it('creates, appends once, and fixes a missing trailing newline', () => {
    const rc = path.join(h.tmp, 'sub', 'rc')
    expect(ensureImport(rc, 'import a')).toBe(true)
    expect(ensureImport(rc, 'import a')).toBe(false)
    fs.writeFileSync(rc, 'x')
    expect(ensureImport(rc, 'import a')).toBe(true)
    expect(read(rc)).toBe('x\nimport a\n')
  })
})
