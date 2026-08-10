import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { scanInjection, INJECTING_EVENTS } from '../src/scan/injection.js'
import { rank } from '../src/rank.js'

const reg = (over = {}) => ({
  source: 'plugin:ponytail',
  event: 'SessionStart',
  matcher: null,
  type: 'command',
  command: 'node activate.js',
  ...over
})

describe('scanInjection', () => {
  it('flags a hook on a context-injecting event', () => {
    const out = scanInjection([reg()])
    assert.equal(out.length, 1)
    assert.equal(out[0].scanner, 'injection')
    assert.equal(out[0].subject, 'plugin:ponytail')
  })

  it('ignores a hook whose event cannot inject context', () => {
    // Precondition: the input is a real registration that the scanner DID see —
    // an empty result must mean "classified as non-injecting", not "no input".
    const nonInjecting = reg({ event: 'PreToolUse', matcher: 'Write|Edit' })
    assert.equal(INJECTING_EVENTS.has(nonInjecting.event), false)
    assert.deepEqual(scanInjection([nonInjecting]), [])
    assert.equal(scanInjection([reg()]).length, 1, 'the same shape on an injecting event must still be flagged')
  })

  it('reports one finding per source, naming every injecting event it registers', () => {
    const out = scanInjection([
      reg({ event: 'SessionStart' }),
      reg({ event: 'SubagentStart' }),
      reg({ event: 'UserPromptSubmit' }),
      reg({ event: 'PreToolUse' })
    ])
    assert.equal(out.length, 1)
    assert.match(out[0].remedy, /SessionStart/)
    assert.match(out[0].remedy, /SubagentStart/)
    assert.match(out[0].remedy, /UserPromptSubmit/)
    assert.doesNotMatch(out[0].remedy, /PreToolUse/)
  })

  it('names each event once however many hooks a source registers on it', () => {
    const out = scanInjection([
      reg({ command: 'node a.js' }),
      reg({ command: 'node b.js' })
    ])
    assert.equal(out.length, 1)
    assert.equal(out[0].remedy.match(/SessionStart/g).length, 1)
  })

  it('keeps sources separate', () => {
    const out = scanInjection([reg(), reg({ source: 'settings' })])
    assert.equal(out.length, 2)
    assert.notEqual(out[0].id, out[1].id)
  })

  it('reports zero tokens so an unmeasured cost can never enter a measured total', () => {
    // The whole point of the scanner: the size of injected context is not
    // statically knowable. Emitting an estimate here would put a guess into
    // totalTokens, which json.js sums without discrimination.
    const out = scanInjection([reg()])
    assert.equal(out[0].tokens, 0)
  })

  it('never puts the hook command in a finding', () => {
    // Same rule scan/mutation.js documents: a command can carry an inline
    // credential that redaction cannot find mid-string.
    const secret = 'node activate.js --token=sk-ant-SUPERSECRET'
    const out = scanInjection([reg({ command: secret })])
    assert.equal(JSON.stringify(out).includes('SUPERSECRET'), false)
  })

  it('returns an empty array when nothing registers a hook', () => {
    assert.deepEqual(scanInjection([]), [])
  })

  it('names events in a stable order however the manifest ordered them', () => {
    // Registration order follows JSON key order in a third-party manifest.
    // Passing it through unsorted makes the report text differ between two
    // audits of the same machine — the exact defect scan/mutation.js exists to
    // flag in other people's hooks. Reversed input, so an unsorted
    // implementation produces the reversed string and fails.
    const reversed = scanInjection([
      reg({ event: 'UserPromptSubmit' }),
      reg({ event: 'SubagentStart' }),
      reg({ event: 'SessionStart' })
    ])
    assert.match(reversed[0].remedy, /SessionStart, SubagentStart, UserPromptSubmit/)
  })
})

describe('scanInjection ranking', () => {
  it('ranks an unmeasured injection above a measured but trivial prefix finding', () => {
    // rankScore multiplies tokens, so an injection finding scores 0 and would
    // sort last on score alone. Severity leads the comparator precisely so a
    // zero-token finding is not buried; if injection dropped to 'info' it would
    // fall behind this 900-token info finding and read as the smaller problem.
    const trivial = {
      id: 'prefix/big',
      scanner: 'prefix',
      subject: 'big',
      tokens: 900,
      severity: 'info',
      confidence: 1.0,
      risk: 3,
      remedy: 'x'
    }
    const [first] = rank([trivial, ...scanInjection([reg()])])
    assert.equal(first.scanner, 'injection')
  })
})
