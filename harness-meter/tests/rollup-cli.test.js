import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, cpSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const HM = fileURLToPath(new URL('../bin/hm.js', import.meta.url))
const GOOD_SRC = fileURLToPath(new URL('./fixtures/good/', import.meta.url))

// `root` is a per-test mkdtempSync COPY of the committed fixtures/good/ tree,
// same convention as tests/fix-cli.test.js — a bug must land in disposable
// temp state, never in version-controlled fixtures.
let root
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hm-rollup-'))
  cpSync(GOOD_SRC, root, { recursive: true })
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('hm rollup', () => {
  it('reports zero sessions when no log file exists yet', () => {
    const out = execFileSync('node', [HM, 'rollup', '--json', '--root', root], { encoding: 'utf8' })
    const json = JSON.parse(out)
    assert.equal(json.sessions, 0)
  })

  it('counts valid rows and skips a torn line in the real log file', () => {
    const dir = join(root, 'harness-meter')
    mkdirSync(dir, { recursive: true })
    const goodRow = { v: 1, ts: '2026-07-27T00:00:00.000Z', session: 'a', reason: 'clear', inputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 0, toolCalls: 0, toolResults: 0, toolErrors: 0, observationChars: 0, observationTokens: 0, assistantTurns: 1, skippedLines: 0 }
    writeFileSync(
      join(dir, 'sessions.jsonl'),
      JSON.stringify(goodRow) + '\n' + JSON.stringify(goodRow) + '\n' + '{not valid json\n'
    )
    const out = execFileSync('node', [HM, 'rollup', '--json', '--root', root], { encoding: 'utf8' })
    const json = JSON.parse(out)
    assert.equal(json.sessions, 2)
  })

  it('renders markdown by default (no --json)', () => {
    const out = execFileSync('node', [HM, 'rollup', '--root', root], { encoding: 'utf8' })
    assert.match(out, /harness-meter — session metrics/)
  })

  it('wires the measured prefix size from hm audit into guideLoadEfficiency', () => {
    const dir = join(root, 'harness-meter')
    mkdirSync(dir, { recursive: true })
    const goodRow = { v: 1, ts: '2026-07-27T00:00:00.000Z', session: 'a', reason: 'clear', inputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 1000, outputTokens: 0, toolCalls: 0, toolResults: 0, toolErrors: 0, observationChars: 0, observationTokens: 0, assistantTurns: 2, skippedLines: 0 }
    writeFileSync(join(dir, 'sessions.jsonl'), JSON.stringify(goodRow) + '\n')
    const out = execFileSync('node', [HM, 'rollup', '--json', '--root', root], { encoding: 'utf8' })
    const json = JSON.parse(out)
    // fixtures/good's own audit findings total 18 prefix tokens (azure: 15,
    // superpowers: 3) — see tests/audit.test.js. Precondition: the fixture
    // really does carry a nonzero measured prefix, or a null
    // guideLoadEfficiency below would prove nothing about the wiring.
    assert.notEqual(json.guideLoadEfficiency, null)
  })

  it('rejects a flag that is not valid for rollup', () => {
    assert.throws(() => execFileSync(
      'node', [HM, 'rollup', '--cap', '5', '--root', root], { encoding: 'utf8', stdio: 'pipe' }
    ))
  })

  it('documents hm rollup in the bare usage string', () => {
    const out = execFileSync('node', [HM], { encoding: 'utf8' })
    assert.match(out, /hm rollup \[--json\] \[--root PATH\]/)
  })
})

// A genuinely fresh install has no settings.json at all yet — `root` above
// is always a copy of fixtures/good/, which already has one. These use their
// own bare mkdtempSync root (no cpSync) to reproduce that bootstrap case.
describe('hm rollup survives an unreadable log', () => {
  it('exits 0 when sessions.jsonl is a directory', () => {
    // readSessionRows called readFileSync with no try/catch, so an unreadable
    // log crashed with exit 1 and dumped a stack trace — including the log's
    // absolute path — to stderr. The hook itself handles this case cleanly;
    // the reader did not.
    const root = mkdtempSync(join(tmpdir(), 'hm-rollup-'))
    mkdirSync(join(root, 'harness-meter', 'sessions.jsonl'), { recursive: true })
    writeFileSync(join(root, 'settings.json'), '{"enabledPlugins":{}}')
    // spawnSync, not execFileSync: a non-zero exit must be inspected, not thrown.
    const r = spawnSync('node', [HM, 'rollup', '--root', root], { encoding: 'utf8' })
    assert.equal(r.status, 0)
    assert.equal(r.stderr.includes('at '), false) // no stack trace
  })
})

describe('hm rollup on a fresh root with no settings.json', () => {
  let freshRoot
  beforeEach(() => {
    freshRoot = mkdtempSync(join(tmpdir(), 'hm-rollup-fresh-'))
  })
  afterEach(() => {
    rmSync(freshRoot, { recursive: true, force: true })
  })

  it('renders even though hm audit has nothing to read yet', () => {
    const dir = join(freshRoot, 'harness-meter')
    mkdirSync(dir, { recursive: true })
    const goodRow = { v: 1, ts: '2026-07-27T00:00:00.000Z', session: 'a', reason: 'clear', inputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 0, toolCalls: 0, toolResults: 0, toolErrors: 0, observationChars: 0, observationTokens: 0, assistantTurns: 1, skippedLines: 0 }
    writeFileSync(join(dir, 'sessions.jsonl'), JSON.stringify(goodRow) + '\n')
    const out = execFileSync('node', [HM, 'rollup', '--root', freshRoot], { encoding: 'utf8' })
    assert.match(out, /harness-meter — session metrics/)
  })

  it('says no sessions are recorded yet on a completely empty root', () => {
    // No settings.json, no harness-meter/ directory, nothing — the very
    // first run against a brand-new ~/.claude before any hook has fired.
    const out = execFileSync('node', [HM, 'rollup', '--root', freshRoot], { encoding: 'utf8' })
    assert.match(out, /No sessions recorded yet/)
  })
})
