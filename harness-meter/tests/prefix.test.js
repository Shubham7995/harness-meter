import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { scanPrefix, estimateTokens } from '../src/scan/prefix.js'

const plugins = [
  {
    name: 'small',
    version: '1.0.0',
    dir: '/x',
    skills: [{ name: 's', descriptionBytes: 40 }],
    agents: []
  },
  {
    name: 'big',
    version: '1.0.0',
    dir: '/y',
    skills: [{ name: 'a', descriptionBytes: 4000 }],
    agents: [{ name: 'b', descriptionBytes: 400 }]
  },
  {
    name: 'zero',
    version: '1.0.0',
    dir: '/z',
    skills: [],
    agents: []
  }
]

describe('estimateTokens', () => {
  it('is bytes over four, rounded', () => {
    assert.equal(estimateTokens(40), 10)
    assert.equal(estimateTokens(41), 10)
    assert.equal(estimateTokens(42), 11)
  })
})

describe('scanPrefix', () => {
  it('sums skill and agent description bytes per plugin', () => {
    const byId = Object.fromEntries(scanPrefix(plugins).map(f => [f.id, f]))
    assert.equal(byId['prefix/big'].tokens, 1100)
    assert.equal(byId['prefix/small'].tokens, 10)
  })

  it('omits plugins contributing nothing', () => {
    assert.equal(scanPrefix(plugins).some(f => f.subject === 'zero'), false)
  })

  it('returns findings in input order, not sorted by score (rank() owns ordering)', () => {
    // The fixture lists plugins in order small, big, zero. 'zero' contributes
    // nothing and is filtered out, so raw output order should be exactly
    // ['small', 'big'] — the input order — not sorted by tokens/score. A
    // scanner that re-sorts internally (e.g. by tokens descending) would
    // still pass a membership check but would fail this order check, and
    // would also violate rank()'s exclusive ownership of ordering.
    assert.deepEqual(scanPrefix(plugins).map(f => f.subject), ['small', 'big'])
  })

  it('sets severity from the token threshold', () => {
    const byId = Object.fromEntries(scanPrefix(plugins).map(f => [f.id, f]))
    assert.equal(byId['prefix/big'].severity, 'warn')
    assert.equal(byId['prefix/small'].severity, 'info')
  })

  it('reports measured confidence and capability-loss risk', () => {
    for (const f of scanPrefix(plugins)) {
      assert.equal(f.scanner, 'prefix')
      assert.equal(f.confidence, 1.0)
      assert.equal(f.risk, 3)
      assert.match(f.remedy, /disable/i)
    }
  })

  it('returns an empty array for no plugins', () => {
    assert.deepEqual(scanPrefix([]), [])
  })
})

describe('severity threshold boundary', () => {
  const at = (bytes) => scanPrefix([{
    name: 'p', version: '1', dir: '/d',
    skills: [{ name: 's', descriptionBytes: bytes, measurable: true }], agents: []
  }])[0].severity

  it('is info at 499 tokens and warn at 500', () => {
    assert.equal(at(1996), 'info')
    assert.equal(at(2000), 'warn')
  })
})
