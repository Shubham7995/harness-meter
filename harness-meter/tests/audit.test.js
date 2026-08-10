import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { runAudit } from '../src/audit.js'

const GOOD = fileURLToPath(new URL('./fixtures/good/', import.meta.url))
const EMPTY = fileURLToPath(new URL('./fixtures/empty/', import.meta.url))
const HM = fileURLToPath(new URL('../bin/hm.js', import.meta.url))
const AT = '2026-07-26T00:00:00Z'

describe('runAudit', () => {
  it('finds the enabled, installed plugins in the fixture', () => {
    const { findings } = runAudit(GOOD, AT)
    assert.deepEqual(findings.map(f => f.subject).sort(), ['azure', 'superpowers'])
  })

  it('attributes tokens from the newest version only', () => {
    const azure = runAudit(GOOD, AT).findings.find(f => f.subject === 'azure')
    assert.equal(azure.tokens, 15)
  })

  it('produces markdown containing the total', () => {
    assert.match(runAudit(GOOD, AT).markdown, /Total token cost/)
  })

  it('surfaces a real no-description-key fixture file end-to-end in json.unmeasurable', () => {
    // This is the test that would have caught a hardcoded `measurable: true`
    // (or `false`) inside collect() — everything upstream of it (readDescription
    // unit tests, unmeasurable-reporting tests with hand-built plugin objects)
    // bypasses collect()/listInstalledPlugins() entirely.
    const { json } = runAudit(GOOD, AT)
    assert.ok(json.unmeasurable.includes('azure/azure-nodesc'))
  })

  it('never plumbs raw settings into the audit output', () => {
    // Real credential-redaction coverage lives in tests/config.test.js
    // ('redacts raw settings') and tests/redact.test.js. This test instead
    // guards the architectural decision that runAudit never serializes
    // loadSettings().raw (or any settings blob) into its output in the first
    // place, so there is nothing left downstream for redaction to miss. It
    // replaces a prior assertion that checked for a literal `gho_` fragment
    // in the fixture's settings, which could never fail because runAudit's
    // output never contained the raw settings to begin with.
    const { json, markdown } = runAudit(GOOD, AT)
    assert.equal(Object.prototype.hasOwnProperty.call(json, 'raw'), false)
    assert.equal(Object.prototype.hasOwnProperty.call(json, 'settings'), false)
    // Cheap, live guard now that Blocker 1's leak path (malformed-JSON parse
    // errors quoting document content) exists — if it ever regresses and
    // findings/markdown end up carrying credential fragments, this catches it.
    assert.equal(JSON.stringify({ json, markdown }).includes('gho_'), false)
  })

  it('completes well within the two-second budget', () => {
    const t0 = process.hrtime.bigint()
    runAudit(GOOD, AT)
    const ms = Number(process.hrtime.bigint() - t0) / 1e6
    assert.ok(ms < 2000, `audit took ${ms}ms`)
  })
})

describe('bin/hm.js', () => {
  it('emits JSON on --json', () => {
    const out = execFileSync('node', [HM, 'audit', '--json', '--root', GOOD], { encoding: 'utf8' })
    // GOOD fixture arithmetic: azure = 40 (skill) + 20 (agent) = 60 bytes ->
    // Math.round(60/4) = 15 tokens. superpowers = 10 bytes (skill
    // "0123456789") -> Math.round(10/4) = 3 tokens. Total = 15 + 3 = 18.
    // A hardcoded-stub regression (e.g. `{ totalTokens: 0 }`) would fail this
    // concrete check, unlike the old `typeof === 'number'` assertion.
    assert.equal(JSON.parse(out).totalTokens, 18)
  })

  it('exits 2 on AdapterMismatch', () => {
    try {
      execFileSync('node', [HM, 'audit', '--root', EMPTY], { encoding: 'utf8', stdio: 'pipe' })
      assert.fail('expected non-zero exit')
    } catch (e) {
      assert.equal(e.status, 2)
    }
  })
})

describe('runAudit across both scanners', () => {
  const HOOKS = fileURLToPath(new URL('./fixtures/hooks/', import.meta.url))

  it('reports mutation findings from the hooks fixture', () => {
    const { findings } = runAudit(HOOKS, AT)
    const mutation = findings.filter(f => f.scanner === 'mutation')
    assert.equal(mutation.length, 1)
    assert.match(mutation[0].id, /unpinned-version$/)
  })

  it('ranks the error-severity mutation finding first', () => {
    assert.equal(runAudit(HOOKS, AT).findings[0].scanner, 'mutation')
  })

  it('leaks no hook command text into the report', () => {
    const { json, markdown } = runAudit(HOOKS, AT)
    assert.equal(JSON.stringify({ json, markdown }).includes('npx tool'), false)
  })

  it('reports the context-injecting hooks the fixture registers', () => {
    // The fixture registers SessionStart in settings.json and UserPromptSubmit
    // in the inline plugin's manifest. Both put text in the model's context
    // that scanPrefix cannot see, because prefix cost is read from skill and
    // agent frontmatter only.
    const { findings } = runAudit(HOOKS, AT)
    const injection = findings.filter(f => f.scanner === 'injection')
    assert.deepEqual(injection.map(f => f.subject).sort(), ['plugin:inline', 'settings'])
  })

  it('excludes injected context from the measured total', () => {
    // 68 is the prefix cost of the fixture's one described skill, and was the
    // whole total before this scanner existed. An injection finding that
    // guessed a size would land in totalTokens, which json.js sums across every
    // finding without discrimination — an unknown laundered into a measurement.
    const { json } = runAudit(HOOKS, AT)
    assert.equal(json.byScanner.injection, 2, 'precondition: injection findings must be present to be excluded')
    assert.equal(json.totalTokens, 68)
  })

  it('says in the report that the injected cost is real, unknown, and not in the total', () => {
    const { markdown } = runAudit(HOOKS, AT)
    assert.match(markdown, /Injected context/)
    assert.match(markdown, /not included in the total/i)
  })
})

describe('--cap', () => {
  it('caps the findings array without changing the totals', () => {
    const out = JSON.parse(
      execFileSync('node', [HM, 'audit', '--json', '--cap', '1', '--root', GOOD], { encoding: 'utf8' })
    )
    assert.equal(out.findings.length, 1)
    assert.equal(out.findingCount, 2)
    assert.equal(out.totalTokens, 18)
  })

  it('rejects a non-numeric cap rather than silently ignoring it', () => {
    try {
      execFileSync(
        'node', [HM, 'audit', '--json', '--cap', 'abc', '--root', GOOD],
        { encoding: 'utf8', stdio: 'pipe' }
      )
      assert.fail('expected non-zero exit')
    } catch (e) {
      assert.equal(e.status, 1)
      assert.match(e.stderr, /--cap requires a non-negative integer/)
    }
  })

  it('rejects an unknown flag rather than ignoring it', () => {
    assert.throws(() => execFileSync(
      'node', [HM, 'audit', '--jsn', '--root', GOOD], { encoding: 'utf8', stdio: 'pipe' }
    ))
  })
})

describe('--root validation', () => {
  it('rejects a trailing --root with no value rather than falling back to the real ~/.claude', () => {
    try {
      execFileSync('node', [HM, 'audit', '--json', '--cap', '0', '--root'], { encoding: 'utf8', stdio: 'pipe' })
      assert.fail('expected non-zero exit')
    } catch (e) {
      assert.notEqual(e.status, 0)
      assert.match(e.stderr, /--root/)
    }
  })

  it('rejects --root immediately followed by another flag, rather than swallowing it as the path', () => {
    // '--root --json' must not consume '--json' as the root value (which
    // would both point at a bogus path AND silently drop JSON mode).
    try {
      execFileSync('node', [HM, 'audit', '--root', '--json'], { encoding: 'utf8', stdio: 'pipe' })
      assert.fail('expected non-zero exit')
    } catch (e) {
      assert.notEqual(e.status, 0)
      assert.match(e.stderr, /--root/)
    }
  })
})

describe('cap is a single authority', () => {
  const MANY = fileURLToPath(new URL('./fixtures/many/', import.meta.url))

  it('the fixture produces more findings than the default cap', () => {
    assert.equal(runAudit(MANY, AT).json.findingCount, 18)
  })

  it('defaults to 15 findings when no cap is given', () => {
    assert.equal(runAudit(MANY, AT).json.findings.length, 15)
  })

  it('honours an explicit cap above the default', () => {
    assert.equal(runAudit(MANY, AT, 17).json.findings.length, 17)
  })

  it('honours an explicit cap below the default', () => {
    assert.equal(runAudit(MANY, AT, 3).json.findings.length, 3)
  })

  it('keeps totals over the full set regardless of cap', () => {
    const out = runAudit(MANY, AT, 3).json
    assert.equal(out.findingCount, 18)
    assert.equal(out.byScanner.prefix, 18)
  })

  it('markdown still renders every finding despite the cap', () => {
    const md = runAudit(MANY, AT, 3).markdown
    assert.equal((md.match(/^\| p\d\d /gm) ?? []).length, 18)
  })
})

describe('cap is a single authority (CLI)', () => {
  const MANY = fileURLToPath(new URL('./fixtures/many/', import.meta.url))

  it('CLI defaults to 15 findings when no cap is given, with findingCount over the full set', () => {
    const out = JSON.parse(
      execFileSync('node', [HM, 'audit', '--json', '--root', MANY], { encoding: 'utf8' })
    )
    assert.equal(out.findings.length, 15)
    assert.equal(out.findingCount, 18)
  })

  it('CLI honours an explicit cap below the default, without changing totals', () => {
    const out = JSON.parse(
      execFileSync('node', [HM, 'audit', '--json', '--cap', '3', '--root', MANY], { encoding: 'utf8' })
    )
    assert.equal(out.findings.length, 3)
    assert.equal(out.findingCount, 18)
    assert.equal(out.byScanner.prefix, 18)
  })

  it('CLI honours an explicit cap ABOVE the default — the case a post-hoc re-slice of an already-15-capped array cannot satisfy', () => {
    const out = JSON.parse(
      execFileSync('node', [HM, 'audit', '--json', '--cap', '17', '--root', MANY], { encoding: 'utf8' })
    )
    assert.equal(out.findings.length, 17)
  })
})
