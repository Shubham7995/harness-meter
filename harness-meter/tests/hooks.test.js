import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { chmodSync, statSync, existsSync } from 'node:fs'
import { listHookRegistrations } from '../src/adapter/hooks.js'
import { loadSettings } from '../src/adapter/config.js'
import { listInstalledPlugins } from '../src/adapter/plugins.js'
import { AdapterMismatch } from '../src/adapter/errors.js'

const HOOKS = fileURLToPath(new URL('./fixtures/hooks/', import.meta.url))
const GOOD = fileURLToPath(new URL('./fixtures/good/', import.meta.url))
const OMITTED_TYPE = fileURLToPath(new URL('./fixtures/hooks-omitted-type/', import.meta.url))
const EXPLICIT_TYPE = fileURLToPath(new URL('./fixtures/hooks-explicit-type/', import.meta.url))
const SECRET_EVENT = fileURLToPath(new URL('./fixtures/hooks-secret-event/', import.meta.url))
const UNREADABLE_MANIFEST = fileURLToPath(new URL('./fixtures/unreadable-manifest/', import.meta.url))
const PATH_REF = fileURLToPath(new URL('./fixtures/hooks-path-ref/', import.meta.url))
const PATH_ESCAPE = fileURLToPath(new URL('./fixtures/hooks-path-escape/', import.meta.url))

function regs (root) {
  const settings = loadSettings(root)
  const plugins = listInstalledPlugins(root, settings.enabledNames)
  return listHookRegistrations(root, settings, plugins)
}

describe('listHookRegistrations', () => {
  it('reads hooks declared in settings.json', () => {
    const r = regs(HOOKS).filter(h => h.source === 'settings')
    assert.equal(r.length, 1)
    assert.equal(r[0].event, 'SessionStart')
    assert.equal(r[0].command, 'echo settings-hook')
  })

  it('reads hooks declared inline in plugin.json', () => {
    const r = regs(HOOKS).filter(h => h.source === 'plugin:inline')
    assert.equal(r.length, 1)
    assert.equal(r[0].event, 'UserPromptSubmit')
    assert.equal(r[0].command, 'node inline-hook.js')
  })

  it('reads hooks declared in a plugin hooks/hooks.json', () => {
    const r = regs(HOOKS).filter(h => h.source === 'plugin:filebased')
    assert.equal(r.length, 1)
    assert.equal(r[0].event, 'PreToolUse')
    assert.equal(r[0].matcher, 'Write|Edit')
    assert.equal(r[0].command, 'npx tool@latest')
  })

  it('finds all three sources in one pass', () => {
    assert.equal(regs(HOOKS).length, 3)
  })

  it('sets matcher to null when absent', () => {
    const r = regs(HOOKS).find(h => h.source === 'settings')
    assert.equal(r.matcher, null)
  })

  it('returns an empty array when nothing declares hooks', () => {
    assert.deepEqual(regs(GOOD), [])
  })

  it('skips a malformed plugin manifest without throwing, keeping hooks from well-formed plugins', () => {
    // tests/fixtures/hooks/plugins/cache/mk/broken/1.0.0/.claude-plugin/plugin.json
    // is deliberately truncated, invalid JSON. It is enabled alongside the two
    // well-formed plugins in tests/fixtures/hooks/settings.json. A malformed
    // manifest is that plugin's problem, not a layout mismatch — the audit
    // must not throw, and the other two sources must still be found.
    let r
    assert.doesNotThrow(() => { r = regs(HOOKS) })
    assert.equal(r.some(h => h.source === 'plugin:broken'), false)
    assert.equal(r.length, 3)
  })

  it('defaults type to "command" when a hook entry omits it', () => {
    const r = regs(OMITTED_TYPE)
    assert.equal(r.length, 1)
    assert.equal(r[0].type, 'command')
  })

  it('preserves an explicitly declared non-default type rather than coercing it to "command"', () => {
    // HookReg.type is captured but never consumed today; a future scanner
    // may flag a non-command type. A test that only ever exercises the
    // omitted-type default would pass identically against a `flatten()`
    // that hardcodes type: 'command', which is exactly the defect class
    // this project has spent fourteen review findings on. This fixture's
    // hook declares "type": "prompt" explicitly.
    const r = regs(EXPLICIT_TYPE)
    assert.equal(r.length, 1)
    assert.equal(r[0].type, 'prompt')
  })

  it('follows a plugin.json "hooks" declared as a PATH STRING to another file', () => {
    // The manifest field is documented as either an inline block or a path
    // relative to the plugin root. flatten() only ever handled the object form:
    // a string fell through `typeof block !== 'object'` and the plugin's entire
    // hook set vanished with no throw and no unmeasurable entry. Every hook
    // ponytail ships is declared this way ("hooks": "./hooks/claude-codex-hooks.json"),
    // and the file is NOT named hooks/hooks.json, so the file-based branch
    // misses it too. Precondition: the fixture's only registration lives behind
    // the path reference, so a regression empties the array rather than
    // silently returning a hook found by some other branch.
    const r = regs(PATH_REF)
    assert.equal(r.length, 1)
    assert.equal(r[0].source, 'plugin:pathref')
    assert.equal(r[0].event, 'SessionStart')
    assert.equal(r[0].command, 'node activate.js')
    assert.equal(r[0].matcher, 'startup|resume|clear|compact')
  })

  it('refuses a "hooks" path that escapes the plugin directory', () => {
    // A third-party manifest names the file this tool opens. Without a
    // containment check the resolver would read a file outside the plugin.
    //
    // The escape target is deliberately the hooks-path-ref fixture's REAL hooks
    // file: it exists, parses, and declares a SessionStart hook. An unguarded
    // resolver therefore returns a registration and this test goes red. An
    // earlier version pointed at a file with no `hooks` key, so it passed
    // whether or not containment was implemented — an absence assertion over an
    // input that never arrived, the shape README.md names.
    assert.equal(
      existsSync(join(PATH_ESCAPE, 'plugins/cache/mk/escaper/1.0.0/../../../../../../hooks-path-ref/plugins/cache/mk/pathref/1.0.0/hooks/claude-codex-hooks.json')),
      true,
      'precondition: the escape target must exist and carry hooks, or this test cannot fail'
    )
    assert.deepEqual(regs(PATH_ESCAPE), [])
  })

  it('keeps a hook registration intact when its EVENT NAME matches the secret-key pattern', () => {
    // settings.hooks is never emitted to any report, so redacting it protects
    // nothing — but it WAS piped through redactDeep, whose tainted-array
    // branch flattens each group in a matching event to the string
    // '<redacted>'. flatten() then reads group?.hooks ?? [] off that string,
    // finds nothing, and the whole registration silently vanishes with no
    // throw and no signal. 'AuthRefresh' matches /auth/i.
    const r = regs(SECRET_EVENT)
    assert.equal(r.length, 1)
    assert.equal(r[0].event, 'AuthRefresh')
    assert.equal(r[0].command, 'echo refresh')
  })
})

describe('unreadable vs malformed manifests', () => {
  it('still skips a malformed manifest without throwing', () => {
    // regression guard for the Phase 2 behaviour this task must not break
    assert.doesNotThrow(() => regs(HOOKS))
  })

  const isRoot = process.getuid?.() === 0
  if (isRoot) {
    console.log('skipping unreadable-manifest test: running as root, chmod 000 does not prevent reads')
  }

  ;(isRoot ? it.skip : it)('throws AdapterMismatch when a manifest exists but cannot be read', () => {
    // Uses its own single-purpose fixture (unreadable-manifest/), not HOOKS —
    // HOOKS is read concurrently by audit.test.js (via runAudit) and by this
    // file's own regs(HOOKS) calls above, all of which run as separate,
    // parallel test-file processes under `node --test`. A shared chmod 000
    // window on plugins/cache/mk/inline/1.0.0/.claude-plugin/plugin.json
    // flaked ~17% of suite runs (Blocker I5). Nothing else in the suite
    // points at this fixture.
    const dir = fileURLToPath(new URL('./fixtures/unreadable-manifest/plugins/cache/mk/probe/1.0.0/.claude-plugin/', import.meta.url))
    const file = join(dir, 'plugin.json')
    const original = statSync(file).mode
    chmodSync(file, 0o000)
    try {
      assert.throws(() => regs(UNREADABLE_MANIFEST), AdapterMismatch)
    } finally {
      chmodSync(file, original)
    }
  })
})
