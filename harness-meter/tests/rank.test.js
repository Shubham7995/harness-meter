import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { rank, rankScore } from '../src/rank.js'

const f = (id, over = {}) => ({
  id, scanner: 'prefix', subject: id, tokens: 100,
  severity: 'info', confidence: 1.0, risk: 1, remedy: 'x', ...over
})

describe('rankScore', () => {
  it('is tokens times confidence over risk', () => {
    assert.equal(rankScore(f('a', { tokens: 300, confidence: 1.0, risk: 3 })), 100)
    assert.equal(rankScore(f('b', { tokens: 100, confidence: 0.5, risk: 1 })), 50)
  })

  it('returns 0 rather than NaN when risk is 0', () => {
    // A future scanner emitting risk: 0 (with tokens: 0) would otherwise
    // divide 0/0 -> NaN, and a NaN comparator return leaves sort order
    // undefined in rank().
    assert.equal(rankScore(f('c', { tokens: 0, confidence: 1.0, risk: 0 })), 0)
  })
})

describe('rank', () => {
  it('puts error above warn above info regardless of score', () => {
    const out = rank([
      f('lo', { severity: 'info', tokens: 9999 }),
      f('hi', { severity: 'error', tokens: 0 }),
      f('mid', { severity: 'warn', tokens: 5000 })
    ])
    assert.deepEqual(out.map(x => x.id), ['hi', 'mid', 'lo'])
  })

  it('orders by score within a severity band', () => {
    // ids are deliberately chosen so alphabetical order and score order
    // DISAGREE: 'alpha' sorts first alphabetically but has the lower score,
    // 'zulu' sorts last alphabetically but has the higher score. If the
    // rankScore clause were ever deleted from the comparator, the id
    // tie-break would produce ['alpha', 'zulu'] instead — this is what
    // makes the test able to fail.
    const out = rank([
      f('alpha', { severity: 'warn', tokens: 100, confidence: 1.0, risk: 3 }),
      f('zulu', { severity: 'warn', tokens: 100, confidence: 1.0, risk: 1 })
    ])
    assert.deepEqual(out.map(x => x.id), ['zulu', 'alpha'])
  })

  it('breaks score ties by id so output is deterministic', () => {
    const out = rank([f('zebra'), f('apple')])
    assert.deepEqual(out.map(x => x.id), ['apple', 'zebra'])
  })

  it('does not mutate its input', () => {
    const input = [f('b'), f('a')]
    rank(input)
    assert.deepEqual(input.map(x => x.id), ['b', 'a'])
  })

  it('returns an empty array unchanged', () => {
    assert.deepEqual(rank([]), [])
  })
})
