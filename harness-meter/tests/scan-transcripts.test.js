import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { scanTranscripts } from '../src/metrics/scan.js'
import { SCHEMA_VERSION } from '../src/metrics/record.js'

// A transcript line carrying real usage, so a row built from it is non-zero.
const line = (over = {}) => JSON.stringify({
  type: 'assistant',
  message: {
    id: 'msg_1',
    usage: { input_tokens: 10, cache_read_input_tokens: 900, cache_creation_input_tokens: 90, output_tokens: 50 },
    content: [{ type: 'text', text: 'hi' }]
  },
  ...over
}) + '\n'

describe('scanTranscripts', () => {
  it('builds one row per transcript file', () => {
    const rows = scanTranscripts(['/a/x.jsonl', '/a/y.jsonl'], () => line())
    assert.equal(rows.length, 2)
  })

  it('carries the counters the rollup metrics need', () => {
    const [row] = scanTranscripts(['/a/x.jsonl'], () => line())
    assert.equal(row.cacheReadTokens, 900)
    assert.equal(row.cacheCreationTokens, 90)
    assert.equal(row.inputTokens, 10)
    assert.equal(row.outputTokens, 50)
  })

  it('stamps rows at the current schema so they are not excluded as pre-upgrade', () => {
    // A row scanned from a transcript HAS injection counters — the attachment
    // records are right there in the file. Stamping it below the injection
    // schema would drop it from the injected-context denominator, reporting
    // "unavailable" for something this scan actually measured.
    const [row] = scanTranscripts(['/a/x.jsonl'], () => line())
    assert.equal(row.v, SCHEMA_VERSION)
  })

  it('never puts the transcript path, or anything from it, in a row', () => {
    // Same rule as buildRow: a row is counters plus an opaque id. A path here
    // would put the user's directory layout — and their employer's project
    // names — into a file the README calls safe to share.
    const rows = scanTranscripts(['/Users/someone/.claude/projects/-Users-someone-secret-client/abc.jsonl'], () => line())
    const s = JSON.stringify(rows)
    assert.equal(s.includes('secret-client'), false)
    assert.equal(s.includes('/Users/'), false)
    assert.equal(s.includes('.jsonl'), false)
  })

  it('skips a file it cannot read rather than failing the whole scan', () => {
    const rows = scanTranscripts(['/a/bad.jsonl', '/a/good.jsonl'], p => {
      if (p.includes('bad')) throw new Error('EACCES')
      return line()
    })
    assert.equal(rows.length, 1)
    assert.equal(rows[0].cacheReadTokens, 900)
  })

  it('returns no rows for no files, rather than one empty row', () => {
    // One all-zero row would render a 0% cache ratio — a measured-looking
    // figure for a machine that was never measured.
    assert.deepEqual(scanTranscripts([], () => ''), [])
  })

  it('drops a file that parsed but contained no assistant turn', () => {
    // A transcript with no turns contributes nothing but would pull the
    // per-session averages toward zero if counted as a session.
    const rows = scanTranscripts(['/a/empty.jsonl'], () => '\n')
    assert.deepEqual(rows, [])
  })

  it('gives each row a distinct session id so sessions are countable', () => {
    const rows = scanTranscripts(['/a/x.jsonl', '/a/y.jsonl'], () => line())
    assert.notEqual(rows[0].session, rows[1].session)
  })
})
