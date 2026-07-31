import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadSettings, assertNotSameSettingsFile } from '../src/adapter/config.js'
import { AdapterMismatch } from '../src/adapter/errors.js'

const GOOD = fileURLToPath(new URL('./fixtures/good/', import.meta.url))
const EMPTY = fileURLToPath(new URL('./fixtures/empty/', import.meta.url))
const MALFORMED = fileURLToPath(new URL('./fixtures/malformed-json/', import.meta.url))
const MALFORMED_SECRET = fileURLToPath(new URL('./fixtures/malformed-json-secret/', import.meta.url))
const NON_OBJECT = fileURLToPath(new URL('./fixtures/non-object-json/', import.meta.url))
const BAD_PLUGINS = fileURLToPath(new URL('./fixtures/bad-plugins-type/', import.meta.url))

describe('loadSettings', () => {
  it('lists only enabled plugin names, suffix stripped', () => {
    const s = loadSettings(GOOD)
    assert.deepEqual(s.enabledNames, ['azure', 'superpowers'])
  })

  it('exposes enabledIds as the full, qualified name@marketplace form', () => {
    // BLOCKER 1: the remediation write path must carry the FULL identifier
    // through, not the bare display name loadSettings strips for the audit.
    // enabledIds must be in the same order as enabledNames (index-aligned),
    // so a caller can zip them into a name -> id map.
    const s = loadSettings(GOOD)
    assert.deepEqual(s.enabledIds, ['azure@claude-plugins-official', 'superpowers@claude-plugins-official'])
  })

  it('exposes effortLevel', () => {
    assert.equal(loadSettings(GOOD).effortLevel, 'high')
  })

  it('redacts raw settings', () => {
    const raw = JSON.stringify(loadSettings(GOOD).raw)
    assert.equal(raw.includes('gho_'), false)
    assert.equal(raw.includes('/usr/bin'), true)
  })

  it('throws AdapterMismatch when settings.json is missing', () => {
    assert.throws(() => loadSettings(EMPTY), AdapterMismatch)
  })

  it('never returns an empty result instead of throwing', () => {
    try {
      loadSettings(EMPTY)
      assert.fail('expected AdapterMismatch')
    } catch (e) {
      assert.equal(e.name, 'AdapterMismatch')
      assert.match(e.expectedPath, /settings\.json$/)
    }
  })

  it('throws AdapterMismatch when settings.json has malformed JSON', () => {
    assert.throws(() => loadSettings(MALFORMED), AdapterMismatch)
  })

  it('never leaks a credential fragment through a malformed-JSON parse error', () => {
    // V8's JSON.parse SyntaxError embeds a ~20-character window of the source
    // document (e.g. "Unexpected token 'g', ...\"gho_REALLY\"... is not valid
    // JSON"). The fixture places a fake-but-realistic token right where a
    // syntax error occurs, modeling the reviewer's demonstration. Neither
    // err.message nor err.detail may contain any fragment of it.
    try {
      loadSettings(MALFORMED_SECRET)
      assert.fail('expected AdapterMismatch')
    } catch (e) {
      assert.equal(e.name, 'AdapterMismatch')
      assert.equal(e.message.includes('gho_'), false)
      assert.equal(e.detail.includes('gho_'), false)
      assert.equal(e.message.includes('FAKEFAKEFAKEFAKE'), false)
      assert.equal(e.detail.includes('FAKEFAKEFAKEFAKE'), false)
    }
  })

  it('throws AdapterMismatch when settings.json is not a JSON object', () => {
    assert.throws(() => loadSettings(NON_OBJECT), AdapterMismatch)
  })

  it('throws AdapterMismatch when enabledPlugins is not a plain object', () => {
    assert.throws(() => loadSettings(BAD_PLUGINS), AdapterMismatch)
  })
})

// assertRepoIsNotHome (the previous, resolve()-string-comparison guard) is
// removed — superseded by assertNotSameSettingsFile below. See ITEM 1 of the
// Phase 4a design correction.

// ITEM 1 of the Phase 4a design correction: assertRepoIsNotHome asked "does
// --repo resolve() to the home directory?" via bare string comparison, which
// never touches the filesystem — a symlinked --repo, or an uppercase copy of
// the home path on a case-insensitive filesystem, both sailed through it
// while still writing into ~/.claude/settings.json. assertNotSameSettingsFile
// replaces it by asking the real question directly: is the write target the
// SAME FILE ON DISK as the settings.json this run reads from? Checked via
// realpathSync, which is symlink-proof and case-proof because the OS itself
// resolves both.
describe('assertNotSameSettingsFile', () => {
  it('throws — direct: --repo whose .claude/settings.json IS the config root\'s file', () => {
    const parent = mkdtempSync(join(tmpdir(), 'hm-cfg-direct-'))
    const configRoot = join(parent, '.claude')
    mkdirSync(configRoot, { recursive: true })
    const configSettings = join(configRoot, 'settings.json')
    writeFileSync(configSettings, '{}')

    const repoRoot = parent // repoRoot's own .claude IS configRoot, literally
    try {
      assert.throws(
        () => assertNotSameSettingsFile(configSettings, join(repoRoot, '.claude', 'settings.json')),
        /same file/
      )
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  it('throws — symlink: --repo is a symlink resolving to the config root\'s home, defeating bare resolve()', () => {
    // This is the confirmed bypass: a symlink pointing at "home" (here,
    // `real`) sails through resolve()-based string comparison because
    // resolve() never dereferences symlinks. realpathSync does.
    const real = mkdtempSync(join(tmpdir(), 'hm-cfg-symreal-'))
    const configRoot = join(real, '.claude')
    mkdirSync(configRoot, { recursive: true })
    const configSettings = join(configRoot, 'settings.json')
    writeFileSync(configSettings, '{}')

    const linkParent = mkdtempSync(join(tmpdir(), 'hm-cfg-symlink-'))
    const repoRoot = join(linkParent, 'repo-is-a-symlink')
    symlinkSync(real, repoRoot)

    try {
      assert.throws(
        () => assertNotSameSettingsFile(configSettings, join(repoRoot, '.claude', 'settings.json')),
        /same file/
      )
    } finally {
      rmSync(real, { recursive: true, force: true })
      rmSync(linkParent, { recursive: true, force: true })
    }
  })

  it('throws — case-folded: an uppercased variant of the config root path, on case-insensitive filesystems (skips with an explanation otherwise)', (t) => {
    const real = mkdtempSync(join(tmpdir(), 'hm-cfg-case-'))

    // Probe: create a lowercase file, then test whether an uppercased
    // reference to it resolves. If it does not, this filesystem is
    // case-sensitive and the bypass cannot be demonstrated here — skip
    // rather than fail.
    const probeDir = join(real, 'caseprobe')
    mkdirSync(probeDir, { recursive: true })
    writeFileSync(join(probeDir, 'marker.txt'), 'x')
    const caseInsensitive = existsSync(join(real, 'CASEPROBE', 'MARKER.TXT'))

    if (!caseInsensitive) {
      rmSync(real, { recursive: true, force: true })
      t.skip('filesystem is case-sensitive; case-folding bypass cannot be demonstrated here')
      return
    }

    const configRoot = join(real, 'projecthome', '.claude')
    mkdirSync(configRoot, { recursive: true })
    const configSettings = join(configRoot, 'settings.json')
    writeFileSync(configSettings, '{}')

    const repoRoot = join(real, 'PROJECTHOME') // uppercase variant of 'projecthome'

    try {
      assert.throws(
        () => assertNotSameSettingsFile(configSettings, join(repoRoot, '.claude', 'settings.json')),
        /same file/
      )
    } finally {
      rmSync(real, { recursive: true, force: true })
    }
  })

  it('does not throw for an ordinary, unrelated project directory', () => {
    const configRoot = mkdtempSync(join(tmpdir(), 'hm-cfg-root-'))
    const configSettings = join(configRoot, 'settings.json')
    writeFileSync(configSettings, '{}')

    const repoRoot = mkdtempSync(join(tmpdir(), 'hm-cfg-ordinary-'))

    try {
      assert.doesNotThrow(
        () => assertNotSameSettingsFile(configSettings, join(repoRoot, '.claude', 'settings.json'))
      )
    } finally {
      rmSync(configRoot, { recursive: true, force: true })
      rmSync(repoRoot, { recursive: true, force: true })
    }
  })
})
