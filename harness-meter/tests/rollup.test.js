import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { rollup } from '../src/metrics/rollup.js'
import { renderMetrics } from '../src/report/metrics.js'

const row = o => ({
  v: 1, ts: '2026-07-27T00:00:00.000Z', session: 's', reason: 'clear',
  inputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 0,
  toolCalls: 0, toolResults: 0, toolErrors: 0,
  observationChars: 0, observationTokens: 0, assistantTurns: 0, skippedLines: 0,
  ...o
})

describe('rollup', () => {
  it('computes cache read ratio over all cacheable input', () => {
    const r = rollup([row({ cacheReadTokens: 900, cacheCreationTokens: 100, inputTokens: 0 })])
    assert.equal(r.cacheReadRatio, 0.9)
  })

  it('survives a row with string-typed counters', () => {
    // Same root cause as the transcript.js fix: `a + (r[k] ?? 0)` guards
    // null/undefined but not type, so a string field concatenates and every
    // downstream ratio becomes nonsense rather than failing loudly.
    const r = rollup([row({ cacheReadTokens: '900', cacheCreationTokens: 100 })])
    assert.equal(typeof r.totalInput, 'number')
    assert.equal(r.totalInput, 100)
  })

  it('survives log rows that are not objects', () => {
    // readSessionRows admits any parseable JSON value, so a bare string,
    // number or null in the log crashed hm rollup with an unhandled TypeError.
    // The log is append-only and may be hand-edited or torn; one bad row must
    // degrade that row, never the whole report.
    assert.doesNotThrow(() => rollup(['not an object', 42, null, row({ outputTokens: 5 })]))
    assert.equal(rollup(['x', row({ outputTokens: 5 })]).outputTokens, 5)
  })

  it('reports guide load efficiency as unavailable when the prefix is unknown', () => {
    // prefixTokens arrives as 0 when hm audit succeeds but finds no prefix
    // findings. Zero is a measurement; "we could not measure it" is not.
    assert.equal(rollup([row({ cacheReadTokens: 100, assistantTurns: 2 })], { prefixTokens: 0 }).guideLoadEfficiency, null)
  })

  it('reports cacheReadRatio as null when there was no input at all', () => {
    // Zero is a lie here: it reads as "cache never hit" when nothing ran.
    assert.equal(rollup([row({})]).cacheReadRatio, null)
  })

  it('flags a cache read ratio below the 0.90 target', () => {
    const r = rollup([row({ cacheReadTokens: 500, cacheCreationTokens: 500 })])
    assert.equal(r.cacheReadBelowTarget, true)
  })

  it('does NOT flag a cache read ratio at or above the target', () => {
    // Both sides of the threshold must be pinned. Asserting only the `true`
    // case let `cacheReadRatio !== null && cacheReadRatio < CACHE_READ_TARGET`
    // be reduced to `cacheReadRatio !== null` — the comparison deleted
    // outright — with the whole suite still green. 0.95 is above the 0.90
    // target; 1.0 is the boundary a `<=` typo would break.
    assert.equal(rollup([row({ cacheReadTokens: 950, cacheCreationTokens: 50 })]).cacheReadBelowTarget, false)
    assert.equal(rollup([row({ cacheReadTokens: 1000 })]).cacheReadBelowTarget, false)
  })

  it('computes observation-to-action as tokens read per token written', () => {
    // Involves NO cache accounting. Both earlier denominators were dominated
    // by cache replay or cache-TTL re-creation and so measured session length
    // rather than behaviour. observationTokens(150) / outputTokens(100) = 1.5.
    //
    // Every cache field here is large and must NOT reach the denominator: a
    // formula using fresh input would give 150/200 = 0.75, and one using total
    // input would give 150/2000 = 0.075. Only 1.5 pins this definition.
    const r = rollup([row({
      observationTokens: 150,
      outputTokens: 100,
      cacheCreationTokens: 150,
      inputTokens: 50,
      cacheReadTokens: 1800
    })])
    assert.equal(r.observationToActionRatio, 1.5)
  })

  it('renders observation-to-action as a multiplier, not a percentage', () => {
    // It is tokens-read per token-written, routinely above 1 and not a share
    // of anything, so rendering it as a percentage misreads by 100x.
    const out = renderMetrics(rollup([row({ observationTokens: 150, outputTokens: 100 })]))
    assert.match(out, /1\.50x/)
    assert.equal(out.includes('150.0%'), false)
  })

  it('computes failure spend ratio from tool errors', () => {
    const r = rollup([row({ toolResults: 10, toolErrors: 2 })])
    assert.equal(r.failureSpendRatio, 0.2)
  })

  it('reports guide load efficiency against the measured prefix', () => {
    // prefixTokens(16000) * turns(2) = 32000, over totalInput = cacheRead
    // (64000) + cacheCreate(0) + input(0) = 64000 → exactly 0.5.
    //
    // Numerator and denominator MUST differ. An earlier version used 32000 for
    // both, giving 1.0 — and ratio(a,b) === ratio(b,a) when a === b, so an
    // inverted formula passed. Asymmetric inputs are what make this test able
    // to fail: inverting now yields 2, not 0.5.
    const r = rollup([row({ cacheReadTokens: 64000, assistantTurns: 2 })], { prefixTokens: 16000 })
    assert.equal(r.guideLoadEfficiency, 0.5)
  })

  // Added beyond the brief's literal test list: the brief's own "Produces"
  // line documents `{ sessions, ... }` as part of the output shape, and
  // renderMetrics (src/report/metrics.js) reads r.sessions and r.turns
  // directly. Nothing else in this file exercises those two fields, and a
  // manual run of renderMetrics(rollup([...])) printed literal "undefined"
  // for both before this test existed.
  it('reports session count and total assistant turns', () => {
    const r = rollup([row({ assistantTurns: 2 }), row({ assistantTurns: 3 })])
    assert.equal(r.sessions, 2)
    assert.equal(r.turns, 5)
  })
})

describe('injected context', () => {
  const v2 = o => row({ v: 2, hookInjectionChars: 0, hookInjections: 0, rosterChars: 0, ...o })

  it('derives hook tokens per session from stored characters', () => {
    const r = rollup([v2({ hookInjectionChars: 4000 }), v2({ hookInjectionChars: 8000 })])
    assert.equal(r.injectedContext.hookTokensPerSession, 1500)
  })

  it('derives roster tokens per session', () => {
    const r = rollup([v2({ rosterChars: 40000 })])
    assert.equal(r.injectedContext.rosterTokensPerSession, 10000)
  })

  it('reports unavailable, NOT zero, for rows written before the counters existed', () => {
    // The whole failure this project keeps re-encountering. A v1 row has no
    // hookInjectionChars field at all; `sum` reads a missing key as 0, so an
    // archive of old sessions would render as "this machine injects no context"
    // — a confident measurement of something never measured. v1 rows must be
    // excluded from the denominator, not averaged into it as zeroes.
    const r = rollup([row({ outputTokens: 100 }), row({ outputTokens: 200 })])
    assert.equal(r.injectedContext.sessionsMeasured, 0)
    assert.equal(r.injectedContext.hookTokensPerSession, null)
    assert.equal(r.injectedContext.rosterTokensPerSession, null)
  })

  it('averages over measured sessions only when the log mixes schema versions', () => {
    // Two v1 rows and one v2 row carrying 4,000 chars. Averaging over all three
    // gives 333 tokens/session; over the one that was actually measured, 1,000.
    // The first number is an artifact of the upgrade, not a property of the
    // machine.
    const r = rollup([row(), row(), v2({ hookInjectionChars: 4000 })])
    assert.equal(r.injectedContext.sessionsMeasured, 1)
    assert.equal(r.injectedContext.hookTokensPerSession, 1000)
  })

  it('reports a measured zero when a v2 session genuinely injected nothing', () => {
    // The other side of the rule: absent must read unavailable, but a real
    // observation of zero must read zero. Without this the two are conflated
    // and the null branch above could be implemented as "null whenever the
    // chars are 0", which would be wrong.
    const r = rollup([v2({ hookInjectionChars: 0 })])
    assert.equal(r.injectedContext.sessionsMeasured, 1)
    assert.equal(r.injectedContext.hookTokensPerSession, 0)
  })

  it('counts injections per session alongside their size', () => {
    // Size alone cannot separate one 2,000-token SessionStart payload from
    // forty 50-token per-turn ones, and they are different problems.
    const r = rollup([v2({ hookInjections: 10, hookInjectionChars: 4000 })])
    assert.equal(r.injectedContext.hookInjectionsPerSession, 10)
  })
})

describe('injected context in the rendered report', () => {
  const v2 = o => row({ v: 2, hookInjectionChars: 0, hookInjections: 0, rosterChars: 0, ...o })

  it('renders the observed figures with the sessions they were measured over', () => {
    const out = renderMetrics(rollup([v2({ hookInjectionChars: 5612, rosterChars: 77282 })]))
    assert.match(out, /Injected context/)
    assert.match(out, /1,403/) // 5612 chars / 4
    assert.match(out, /19,321/) // 77282 chars / 4, rounded
  })

  it('says unavailable rather than 0 when no session carried the counters', () => {
    const out = renderMetrics(rollup([row(), row()]))
    assert.match(out, /Injected context/)
    assert.equal(/\b0 tokens\b/.test(out), false, 'a pre-upgrade log must not render as a measured zero')
    assert.match(out, /unavailable/)
  })
})

describe('cost/success pairing rule', () => {
  it('never emits a cost figure without a task success rate', () => {
    // assistantTurns must be NON-ZERO, or ratio(output, 0) returns null via the
    // ordinary zero-denominator path and this test passes whether or not the
    // governance guard exists. That is exactly how it was vacuous before.
    const r = rollup([row({ outputTokens: 1000, assistantTurns: 4 })])
    assert.equal(r.cost.taskSuccessRate, null)
    assert.equal(r.cost.outputTokensPerSession, null)
  })

  it('says unavailable in the rendered report rather than omitting the row', () => {
    const out = renderMetrics(rollup([row({ outputTokens: 1000 })]))
    assert.match(out, /task success rate/i)
    assert.match(out, /unavailable/i)
  })

  it('computes output tokens per session, not per turn', () => {
    // It was named "cost per mission" while dividing by assistantTurns — so it
    // was neither a mission count nor a cost, just output-tokens-per-turn under
    // a misleading label. A session is the closest thing to a mission this tool
    // can actually observe. 3000 output over 2 sessions = 1500.
    const r = rollup(
      [row({ outputTokens: 1000, assistantTurns: 4 }), row({ outputTokens: 2000, assistantTurns: 6 })],
      { taskSuccessRate: 0.8 }
    )
    assert.equal(r.cost.outputTokensPerSession, 1500)
  })

  it('emits both together when a success rate IS supplied', () => {
    // Pins the paired branch as reachable. A governance rule enforced only by
    // unreachable code is not enforced.
    const r = rollup([row({ outputTokens: 1000, assistantTurns: 2 })], { taskSuccessRate: 0.8 })
    assert.equal(r.cost.taskSuccessRate, 0.8)
    assert.notEqual(r.cost.outputTokensPerSession, null)
  })

  it('renders without throwing on an empty log', () => {
    assert.doesNotThrow(() => renderMetrics(rollup([])))
  })
})
