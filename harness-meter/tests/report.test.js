import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { toJson } from '../src/report/json.js'
import { toMarkdown } from '../src/report/markdown.js'

const meta = { generatedAt: '2026-07-26T00:00:00Z', root: '/fake/.claude' }

const findings = [
  { id: 'prefix/big', scanner: 'prefix', subject: 'big', tokens: 1100, severity: 'warn', confidence: 1, risk: 3, remedy: 'Disable big' },
  { id: 'prefix/small', scanner: 'prefix', subject: 'small', tokens: 10, severity: 'info', confidence: 1, risk: 3, remedy: 'Disable small' }
]

describe('toJson', () => {
  it('totals tokens across all findings', () => {
    assert.equal(toJson(findings, meta).totalTokens, 1110)
  })

  it('reports the full count even when the list is capped', () => {
    const out = toJson(findings, { ...meta, cap: 1 })
    assert.equal(out.findingCount, 2)
    assert.equal(out.findings.length, 1)
    assert.equal(out.findings[0].subject, 'big')
  })

  it('echoes generatedAt from meta rather than reading the clock', () => {
    const out = toJson(findings, { ...meta, generatedAt: '1999-01-01T00:00:00Z' })
    assert.equal(out.generatedAt, '1999-01-01T00:00:00Z')
    assert.equal(out.root, '/fake/.claude')
  })
})

describe('toMarkdown', () => {
  it('includes the total and a row per finding', () => {
    const md = toMarkdown(findings, meta)
    assert.match(md, /1,110/)
    assert.match(md, /\| big \|/)
    assert.match(md, /\| small \|/)
  })

  it('states measured-zero explicitly when there are no findings', () => {
    const md = toMarkdown([], meta)
    assert.match(md, /No findings/)
    assert.match(md, /measured/i)
  })

  it('renders all findings in markdown even beyond the default cap of 15', () => {
    const manyFindings = Array.from({ length: 20 }, (_, i) => ({
      id: `prefix/plugin${i}`,
      scanner: 'prefix',
      subject: `plugin${i}`,
      tokens: 100 - i,
      severity: i < 10 ? 'warn' : 'info',
      confidence: 1,
      risk: 3,
      remedy: `Disable plugin${i}`
    }))
    const md = toMarkdown(manyFindings, meta)
    assert.match(md, /plugin19/)
    const rows = md.match(/\| plugin\d+ \|/g)
    assert.equal(rows.length, 20)
  })
})

describe('multi-scanner reports', () => {
  const mixed = [
    { id: 'mutation/plugin:a/PreToolUse/unpinned-version', scanner: 'mutation', subject: 'plugin:a (PreToolUse)', tokens: 0, severity: 'error', confidence: 0.7, risk: 1, remedy: 'pin it' },
    { id: 'prefix/azure', scanner: 'prefix', subject: 'azure', tokens: 4577, severity: 'warn', confidence: 1, risk: 3, remedy: 'disable it' }
  ]
  const m2 = { generatedAt: '2026-07-26T00:00:00Z', root: '/fake/.claude' }

  it('counts findings per scanner across the full set', () => {
    assert.deepEqual(toJson(mixed, { ...m2, cap: 1 }).byScanner, { mutation: 1, prefix: 1 })
  })

  it('groups markdown by scanner with headings', () => {
    const md = toMarkdown(mixed, m2)
    assert.match(md, /## Prefix cost/)
    assert.match(md, /## Cache stability/)
  })

  it('no longer claims the whole report is a prefix audit', () => {
    assert.equal(toMarkdown(mixed, m2).includes('prefix audit'), false)
  })

  it('shows a dash rather than 0 tokens for findings with no token weight', () => {
    const md = toMarkdown(mixed, m2)
    assert.match(md, /\| plugin:a \(PreToolUse\) \| — \|/)
  })

  it('still totals tokens across every finding, even when the list is capped', () => {
    assert.equal(toJson(mixed, { ...m2, cap: 1 }).totalTokens, 4577)
  })
})

describe('unmeasurable reporting', () => {
  const m3 = { generatedAt: '2026-07-26T00:00:00Z', root: '/fake/.claude' }
  const plugins = [{
    name: 'demo', version: '1.0.0', dir: '/d',
    skills: [{ name: 'ok', descriptionBytes: 40, measurable: true },
             { name: 'broken', descriptionBytes: 0, measurable: false }],
    agents: []
  }]

  it('lists unmeasurable descriptors in json', () => {
    assert.deepEqual(toJson([], m3, plugins).unmeasurable, ['demo/broken'])
  })

  it('renders a Not measured section in markdown', () => {
    assert.match(toMarkdown([], m3, plugins), /## Not measured/)
  })

  it('renders the actual Not-measured wording, not just any text under the heading', () => {
    // Regression guard: replacing this sentence with e.g. "XXXXX" left the
    // suite green before, since nothing checked the wording itself.
    const md = toMarkdown([], m3, plugins)
    assert.match(
      md,
      /These files have no readable frontmatter description\. Their real token\s*\ncost is unknown and is not included in any total reported here\./
    )
  })

  it('omits the section entirely when everything was measurable', () => {
    assert.equal(toMarkdown([], m3, []).includes('Not measured'), false)
  })

  it('renders a Not measured section on the has-findings path too, not just the zero-findings path', () => {
    // Every real run has findings, so the zero-findings early return is not
    // the path that matters in production — the has-findings call site is.
    const someFindings = [
      { id: 'prefix/demo', scanner: 'prefix', subject: 'demo', tokens: 10, severity: 'info', confidence: 1, risk: 3, remedy: 'Disable demo' }
    ]
    const md = toMarkdown(someFindings, m3, plugins)
    assert.match(md, /## Not measured/)
  })
})

describe('orphan scanner handling', () => {
  const m3 = { generatedAt: '2026-07-26T00:00:00Z', root: '/fake/.claude' }

  it('surfaces a finding under "## Other" when its scanner has no SECTIONS entry', () => {
    const orphan = [
      { id: 'future-scanner/thing', scanner: 'future-scanner', subject: 'thing', tokens: 5, severity: 'info', confidence: 1, risk: 1, remedy: 'do something about it' }
    ]
    const md = toMarkdown(orphan, m3)
    assert.match(md, /## Other/)
    assert.match(md, /thing/)
  })
})
