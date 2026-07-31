import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { classify } from '../src/guard.js'

const GUARD = fileURLToPath(new URL('../bin/hm-guard.js', import.meta.url))

function run (payload, env = {}) {
  const out = execFileSync('node', [GUARD], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, ...env }
  })
  return out.trim() === '' ? null : JSON.parse(out)
}

const bash = (command) => ({ tool_name: 'Bash', tool_input: { command } })

describe('hm-guard', () => {
  it('allows an ordinary command with empty stdout', () => {
    assert.equal(run(bash('npm test')), null)
  })

  it('warns on an unbounded root search, with no hookSpecificOutput at all', () => {
    const out = run(bash('grep -r "TODO" /'))
    assert.equal(out.hookSpecificOutput, undefined)
    assert.match(out.systemMessage, /head|--include/)
  })

  it('warns on an uncapped recursive search of a real directory, with no hookSpecificOutput', () => {
    const out = run(bash('grep -r "TODO" src'))
    assert.equal(out.hookSpecificOutput, undefined)
    assert.match(out.systemMessage, /bound/i)
  })

  it('never puts the command in the message', () => {
    const out = run(bash('grep -r "ghp_FAKEFAKEFAKE" /'))
    assert.equal(JSON.stringify(out).includes('ghp_'), false)
  })

  it('never emits hookSpecificOutput for any input — the guard is advisory only, it never blocks', () => {
    // Every non-allow verdict is a plain systemMessage. There is no verdict
    // this hook can receive from classify() that produces a permission
    // decision — 'deny' does not exist in the contract anymore.
    const commands = [
      'grep -r "TODO" /',
      'grep -r "TODO" src',
      'find . -type f',
      'grep -r "key" ~',
      String.raw`grep -r "note: \"a && b\" is fine" /`,
      String.raw`grep -r \; /`,
      String.raw`grep -r 'x\' / ; echo -l`
    ]
    for (const command of commands) {
      const out = run(bash(command))
      if (out !== null) assert.equal(out.hookSpecificOutput, undefined, `hookSpecificOutput present for ${JSON.stringify(command)}`)
    }
  })
})

describe('hm-guard — fails open', () => {
  it('allows when stdin is not valid JSON', () => {
    assert.equal(run('not json at all'), null)
  })

  it('allows when stdin is empty', () => {
    assert.equal(run(''), null)
  })

  it('allows a non-Bash tool even with a dangerous-looking input', () => {
    assert.equal(run({ tool_name: 'Read', tool_input: { command: 'grep -r x /' } }), null)
  })

  it('allows when tool_input is missing', () => {
    assert.equal(run({ tool_name: 'Bash' }), null)
  })

  it('allows everything when HM_GUARD=off', () => {
    assert.equal(run(bash('grep -r "TODO" /'), { HM_GUARD: 'off' }), null)
  })

  it('exits 0 even when warning, so the hook never errors the turn', () => {
    // execFileSync throws on non-zero exit; reaching this line proves exit 0.
    run(bash('grep -r "TODO" /'))
    assert.ok(true)
  })
})

describe('hm-guard — performance', () => {
  // The previous version of this test spawned 5 `node` subprocesses running
  // the full hook and asserted an average under 400ms. That measured process
  // startup cost, not the guard's own work — it could never fail for the
  // reason its name claimed, and it was flaky under load from unrelated
  // subprocess scheduling noise. This measures classify() itself, in-process,
  // over enough iterations to average out timer jitter.
  it('classify() costs under 1ms per call, averaged over 1000 iterations', () => {
    const t0 = process.hrtime.bigint()
    for (let i = 0; i < 1000; i++) classify('grep -r "TODO" /Users/someone/deep/bounded/path')
    const perCall = Number(process.hrtime.bigint() - t0) / 1e6 / 1000
    assert.ok(perCall < 1, `classify averaged ${perCall.toFixed(4)}ms per call`)
  })
})
