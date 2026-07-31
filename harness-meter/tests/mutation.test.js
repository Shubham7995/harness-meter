import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { scanMutation } from '../src/scan/mutation.js'

const reg = (command, over = {}) => ({
  source: 'plugin:demo', event: 'PreToolUse', matcher: null,
  type: 'command', command, ...over
})

const ids = fs => fs.map(f => f.id)

describe('scanMutation', () => {
  it('flags unpinned version specifiers', () => {
    assert.deepEqual(ids(scanMutation([reg('npx tdd-guard@latest')])),
      ['mutation/plugin:demo/PreToolUse/unpinned-version'])
  })

  it('gives two registrations from the same source with the same pattern but different events distinct ids', () => {
    // On the real installation, three separate registrations from
    // plugin:tdd-guard (PreToolUse, UserPromptSubmit, SessionStart) all match
    // unpinned-version. Without the event component in the id, all three
    // would collide on one id, which breaks rank()'s id tie-break and any
    // future dedupe/remediation keyed on id.
    const out = scanMutation([
      reg('npx tdd-guard@latest', { event: 'PreToolUse' }),
      reg('npx tdd-guard@latest', { event: 'UserPromptSubmit' })
    ])
    assert.equal(out.length, 2)
    assert.notEqual(out[0].id, out[1].id)
    assert.deepEqual(ids(out), [
      'mutation/plugin:demo/PreToolUse/unpinned-version',
      'mutation/plugin:demo/UserPromptSubmit/unpinned-version'
    ])
  })

  it('flags timestamp interpolation', () => {
    assert.equal(scanMutation([reg('echo $(date +%s)')]).length, 1)
  })

  it('flags working-directory interpolation', () => {
    assert.equal(scanMutation([reg('node $PWD/hook.js')]).length, 1)
  })

  it('flags git SHA interpolation', () => {
    assert.equal(scanMutation([reg('echo $(git rev-parse HEAD)')]).length, 1)
  })

  it('flags machine-specific absolute home paths', () => {
    assert.equal(scanMutation([reg('node /Users/alice/x.js')]).length, 1)
  })

  it('leaves a static command alone', () => {
    assert.deepEqual(scanMutation([reg('node hook.js --quiet')]), [])
  })

  it('NEVER puts the command text in any finding field', () => {
    const secret = 'curl -H "Authorization: Bearer ghp_FAKEFAKEFAKE" @latest'
    const out = JSON.stringify(scanMutation([reg(secret)]))
    assert.equal(out.includes('ghp_'), false)
    assert.equal(out.includes('Authorization'), false)
    assert.equal(out.includes('curl'), false)
  })

  it('emits the Finding shape the ranker expects', () => {
    const [f] = scanMutation([reg('npx x@latest')])
    assert.equal(f.scanner, 'mutation')
    assert.equal(f.tokens, 0)
    assert.equal(f.confidence, 0.7)
    assert.equal(f.risk, 1)
    assert.ok(['error', 'warn', 'info'].includes(f.severity))
  })

  it('pins the exact severity per pattern class', () => {
    // The severity map is the entire editorial judgment of this scanner.
    // Asserting membership in ['error','warn','info'] can't fail if a
    // pattern's severity is silently downgraded/upgraded; pin the exact
    // expected value per pattern instead.
    const severityFor = (command) => scanMutation([reg(command)])[0].severity
    assert.equal(severityFor('npx x@latest'), 'error')
    assert.equal(severityFor('echo $(date +%s)'), 'error')
    assert.equal(severityFor('node $PWD/hook.js'), 'warn')
    assert.equal(severityFor('echo $(git rev-parse HEAD)'), 'warn')
    assert.equal(severityFor('node /Users/alice/x.js'), 'warn')
  })

  it('pins the exact subject string format: "<source> (<event>)"', () => {
    const [f] = scanMutation([reg('npx x@latest', { source: 'plugin:demo', event: 'PreToolUse' })])
    assert.equal(f.subject, 'plugin:demo (PreToolUse)')
  })

  it('reports one finding per matched pattern per registration', () => {
    const out = scanMutation([reg('npx x@latest && echo $(date)')])
    assert.equal(out.length, 2)
  })

  it('returns an empty array for no registrations', () => {
    assert.deepEqual(scanMutation([]), [])
  })
})
