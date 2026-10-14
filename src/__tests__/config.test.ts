import { describe, expect, it } from 'vitest'
import {
  buildLines,
  cleanKey,
  defaultInputs,
  flagsFileName,
  maskLine,
  parseBuildMetadata,
  rcPrefix,
  resolveKey,
  truthy,
  type Inputs,
} from '../config'

const inputs = (overrides: Partial<Inputs> = {}): Inputs => ({ ...defaultInputs, ...overrides })
const flags = (lines: string[]): string[] => lines.filter((l) => !l.startsWith('#'))

describe('truthy / cleanKey', () => {
  it('accepts the usual spellings', () => {
    for (const v of ['true', 'TRUE', '1', 'yes', 'on', ' True ']) expect(truthy(v)).toBe(true)
    for (const v of ['false', '0', 'no', '', undefined, 'maybe']) expect(truthy(v)).toBe(false)
  })
  it('strips whitespace from keys', () => {
    expect(cleanKey(' abc\n')).toBe('abc')
    expect(cleanKey(undefined)).toBe('')
  })
})

describe('resolveKey', () => {
  it('prefers the write key', () => {
    expect(resolveKey('w', 'r', 'warn')).toEqual({ mode: 'read-write', key: 'w' })
  })
  it('falls back to the read-only key', () => {
    expect(resolveKey('', 'r', 'warn')).toEqual({ mode: 'read-only', key: 'r' })
  })
  it('handles missing keys per missing-key', () => {
    expect(resolveKey('', '', 'warn')).toEqual({ mode: 'disabled', key: '' })
    expect(resolveKey('', '', 'skip')).toEqual({ mode: 'disabled', key: '' })
    expect(resolveKey('', '', '')).toEqual({ mode: 'disabled', key: '' })
    expect(resolveKey('', '', 'anonymous')).toEqual({ mode: 'anonymous', key: '' })
    expect(() => resolveKey('', '', 'error')).toThrow(/missing-key=error/)
    expect(() => resolveKey('', '', 'nope')).toThrow(/Invalid missing-key value 'nope'/)
  })
})

describe('rcPrefix / flagsFileName', () => {
  it('builds prefixes and file names', () => {
    expect(rcPrefix({ rcCommand: 'common', config: '' })).toBe('common')
    expect(rcPrefix({ rcCommand: '', config: '' })).toBe('common')
    expect(rcPrefix({ rcCommand: 'build', config: 'bb' })).toBe('build:bb')
    expect(flagsFileName('common')).toBe('common.bazelrc')
    expect(flagsFileName('build:bb')).toBe('build-bb.bazelrc')
  })
})

describe('parseBuildMetadata', () => {
  it('parses KEY=VALUE lines and skips blanks and comments', () => {
    expect(parseBuildMetadata('TAGS=a,b\n\n# c\n  X=1  \r\n')).toEqual(['TAGS=a,b', 'X=1'])
  })
  it('rejects malformed lines', () => {
    expect(() => parseBuildMetadata('nope')).toThrow(/KEY=VALUE/)
  })
})

describe('buildLines', () => {
  it('writes the full default set for a write key', () => {
    expect(flags(buildLines(inputs(), { mode: 'read-write', key: 'k' }))).toEqual([
      'common --bes_results_url=https://app.buildbuddy.io/invocation/',
      'common --bes_backend=grpcs://remote.buildbuddy.io',
      'common --remote_cache=grpcs://remote.buildbuddy.io',
      'common --remote_timeout=10m',
      'common --build_metadata=ROLE=CI',
      'common --remote_header=x-buildbuddy-api-key=k',
    ])
  })

  it('disables uploads for a read-only key, unless told not to', () => {
    const ro = { mode: 'read-only' as const, key: 'r' }
    expect(flags(buildLines(inputs(), ro))).toContain('common --noremote_upload_local_results')
    expect(flags(buildLines(inputs({ readOnlyDisableUploads: false }), ro))).not.toContain(
      'common --noremote_upload_local_results',
    )
  })

  it('uses the config prefix and optional flags', () => {
    const lines = flags(
      buildLines(
        inputs({
          rcCommand: 'build',
          config: 'bb',
          bes: false,
          remoteExecution: true,
          cacheCompression: true,
          downloadToplevel: true,
          visibility: 'PUBLIC',
          buildMetadata: 'TAGS=ci',
          bazelrc: 'build --jobs=16\nbuild --foo',
          appUrl: 'https://bb.example.com/',
          remoteEndpoint: 'grpcs://bb.example.com',
        }),
        { mode: 'read-only', key: 'r' },
      ),
    )
    expect(lines).toEqual([
      'build:bb --remote_cache=grpcs://bb.example.com',
      'build:bb --remote_executor=grpcs://bb.example.com',
      'build:bb --remote_timeout=10m',
      'build:bb --noremote_upload_local_results',
      'build:bb --remote_cache_compression',
      'build:bb --remote_download_toplevel',
      'build:bb --build_metadata=ROLE=CI',
      'build:bb --build_metadata=VISIBILITY=PUBLIC',
      'build:bb --build_metadata=TAGS=ci',
      'build:bb --remote_header=x-buildbuddy-api-key=r',
      'build --jobs=16',
      'build --foo',
    ])
  })

  it('omits remote-only flags when nothing remote is enabled', () => {
    const lines = flags(
      buildLines(inputs({ remoteCache: false, cacheCompression: true, downloadToplevel: true }), {
        mode: 'read-only',
        key: 'r',
      }),
    )
    expect(lines).toEqual([
      'common --bes_results_url=https://app.buildbuddy.io/invocation/',
      'common --bes_backend=grpcs://remote.buildbuddy.io',
      'common --build_metadata=ROLE=CI',
      'common --remote_header=x-buildbuddy-api-key=r',
    ])
  })

  it('omits the timeout when empty', () => {
    expect(flags(buildLines(inputs({ remoteTimeout: '' }), { mode: 'read-write', key: 'k' }))).not.toContain(
      'common --remote_timeout=10m',
    )
  })

  it('writes only the header in auth-only mode', () => {
    expect(
      flags(
        buildLines(inputs({ authOnly: true, visibility: 'PUBLIC', cacheCompression: true }), {
          mode: 'read-write',
          key: 'k',
        }),
      ),
    ).toEqual(['common --remote_header=x-buildbuddy-api-key=k'])
    expect(flags(buildLines(inputs({ authOnly: true, config: 'remote' }), { mode: 'read-only', key: 'r' }))).toEqual([
      'common:remote --noremote_upload_local_results',
      'common:remote --remote_header=x-buildbuddy-api-key=r',
    ])
  })

  it('writes no header in anonymous mode', () => {
    const lines = flags(buildLines(inputs({ remoteCache: false }), { mode: 'anonymous', key: '' }))
    expect(lines.join('\n')).not.toContain('remote_header')
    expect(lines.join('\n')).not.toContain('remote_cache')
  })

  it('marks the mode in the header comment', () => {
    expect(buildLines(inputs({ authOnly: true }), { mode: 'read-only', key: 'r' })[0]).toContain(
      'mode: read-only, auth-only',
    )
  })
})

describe('maskLine', () => {
  it('hides the key', () => {
    expect(maskLine('common --remote_header=x-buildbuddy-api-key=secret')).toBe(
      'common --remote_header=x-buildbuddy-api-key=***',
    )
    expect(maskLine('common --bes_backend=x')).toBe('common --bes_backend=x')
  })
})
