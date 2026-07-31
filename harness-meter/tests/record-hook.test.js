import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const HOOK = fileURLToPath(new URL('../bin/hm-record.js', import.meta.url))
const run = (stdin, root) =>
  spawnSync(process.execPath, [HOOK], { input: stdin, encoding: 'utf8', env: { ...process.env, HM_ROOT: root } })

describe('SessionEnd hook', () => {
  it('exits 0 on a well-formed payload and writes one line', () => {
    const root = mkdtempSync(join(tmpdir(), 'hm-hook-'))
    const r = run(JSON.stringify({ session_id: 'x', reason: 'clear' }), root)
    assert.equal(r.status, 0)
    const log = join(root, 'harness-meter', 'sessions.jsonl')
    assert.equal(existsSync(log), true)
    assert.equal(readFileSync(log, 'utf8').trim().split('\n').length, 1)
  })

  it('exits 0 on malformed stdin', () => {
    const root = mkdtempSync(join(tmpdir(), 'hm-hook-'))
    assert.equal(run('not json', root).status, 0)
  })

  it('exits 0 on empty stdin', () => {
    const root = mkdtempSync(join(tmpdir(), 'hm-hook-'))
    assert.equal(run('', root).status, 0)
  })

  it('exits 0 when the log directory cannot be written', () => {
    // The whole point: a metrics hook must never break a session.
    //
    // Use a regular FILE as the root, so mkdirSync fails ENOTDIR on every
    // platform. Do not use /proc — it does not exist on macOS, so the test
    // would pass there for the wrong reason.
    const dir = mkdtempSync(join(tmpdir(), 'hm-hook-'))
    const notADir = join(dir, 'blocker')
    writeFileSync(notADir, 'x')
    assert.equal(run(JSON.stringify({ session_id: 'x' }), notADir).status, 0)
  })

  it('writes nothing to stdout', () => {
    const root = mkdtempSync(join(tmpdir(), 'hm-hook-'))
    const r = run(JSON.stringify({ session_id: 'x' }), root)
    assert.equal(r.stdout, '')
  })

  it('records the session id and reason it was given', () => {
    // Proves the payload reached buildRow at all. Without it, every assertion
    // above would still pass if the hook wrote a hard-coded empty row.
    const root = mkdtempSync(join(tmpdir(), 'hm-hook-'))
    run(JSON.stringify({ session_id: 'sess-abc', reason: 'clear' }), root)
    const row = JSON.parse(readFileSync(join(root, 'harness-meter', 'sessions.jsonl'), 'utf8'))
    assert.equal(row.session, 'sess-abc')
    assert.equal(row.reason, 'clear')
  })

  it('writes the row to the exact path hm rollup reads', () => {
    // The hook and `hm rollup` agree on <root>/harness-meter/sessions.jsonl by
    // convention, not by a shared constant. If either side moves, metrics are
    // silently collected and never reported. This pins the contract from the
    // reader's side: rollup must actually SEE the row the hook wrote.
    const root = mkdtempSync(join(tmpdir(), 'hm-hook-'))
    writeFileSync(join(root, 'settings.json'), '{"enabledPlugins":{}}')
    run(JSON.stringify({ session_id: 'x', reason: 'clear' }), root)

    const CLI = fileURLToPath(new URL('../bin/hm.js', import.meta.url))
    const out = spawnSync(process.execPath, [CLI, 'rollup', '--root', root, '--json'], { encoding: 'utf8' })
    assert.equal(out.status, 0)
    assert.equal(JSON.parse(out.stdout).sessions, 1)
  })

  it('honours CLAUDE_CONFIG_DIR, the same root hm rollup resolves', () => {
    // The hook hardcoded join(homedir(), '.claude') while rollup resolved via
    // resolveRoot, which honours CLAUDE_CONFIG_DIR. For anyone who has
    // relocated their Claude config, the hook wrote to a file rollup never
    // read — metrics collected forever, reported never, no error either side.
    const cfg = mkdtempSync(join(tmpdir(), 'hm-cfg-'))
    writeFileSync(join(cfg, 'settings.json'), '{"enabledPlugins":{}}')
    // HM_ROOT must be unset here or it would mask the variable under test.
    const env = { ...process.env, CLAUDE_CONFIG_DIR: cfg }
    delete env.HM_ROOT
    spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ session_id: 'x' }), encoding: 'utf8', env })

    assert.equal(existsSync(join(cfg, 'harness-meter', 'sessions.jsonl')), true)

    const CLI = fileURLToPath(new URL('../bin/hm.js', import.meta.url))
    const out = spawnSync(process.execPath, [CLI, 'rollup', '--json'], { encoding: 'utf8', env })
    assert.equal(JSON.parse(out.stdout).sessions, 1)
  })

  it('treats an empty HM_ROOT as unset, not as the current directory', () => {
    // `process.env.HM_ROOT ?? resolveRoot(...)` — `??` only guards
    // null/undefined, so HM_ROOT="" fell through as a valid root and the hook
    // wrote harness-meter/sessions.jsonl into whatever directory the session
    // happened to be in. Confirmed by reproduction before this test existed.
    const cwd = mkdtempSync(join(tmpdir(), 'hm-cwd-'))
    const cfg = mkdtempSync(join(tmpdir(), 'hm-cfg-'))
    const env = { ...process.env, HM_ROOT: '', CLAUDE_CONFIG_DIR: cfg }
    spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ session_id: 'x' }), encoding: 'utf8', env, cwd })

    assert.equal(existsSync(join(cwd, 'harness-meter', 'sessions.jsonl')), false)
    assert.equal(existsSync(join(cfg, 'harness-meter', 'sessions.jsonl')), true)
  })

  it('never writes the transcript path or its contents into the log', () => {
    // The hook is the one place a real transcript path is in scope, so the
    // privacy rule is worth re-pinning end-to-end here, not only at the
    // buildRow unit boundary.
    const root = mkdtempSync(join(tmpdir(), 'hm-hook-'))
    const SECRET = 'SUPER-SECRET-XYZ-12345'
    const transcript = join(root, 'transcript-DISTINCTIVE-PATH.jsonl')
    writeFileSync(transcript, JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'tool_result', content: SECRET }] }
    }) + '\n')

    run(JSON.stringify({ session_id: 'x', transcript_path: transcript, reason: 'clear' }), root)
    const text = readFileSync(join(root, 'harness-meter', 'sessions.jsonl'), 'utf8')

    // Precondition: the transcript must actually have been read, or the two
    // absence assertions below prove nothing. This is the vacuity trap that
    // caught Task 4 — an absence assertion over an input that never arrived.
    assert.ok(JSON.parse(text).observationChars > 0, 'precondition: the transcript was read')
    assert.equal(text.includes(SECRET), false)
    assert.equal(text.includes('DISTINCTIVE-PATH'), false)
  })
})
