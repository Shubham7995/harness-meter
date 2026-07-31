import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildRow } from '../src/metrics/record.js'

const payload = {
  session_id: 'abc-123',
  transcript_path: '/nonexistent/t.jsonl',
  reason: 'clear'
}

describe('buildRow', () => {
  it('carries session id, reason, schema version, and timestamp', () => {
    const row = buildRow(payload, () => '', '2026-07-27T00:00:00.000Z')
    assert.equal(row.session, 'abc-123')
    assert.equal(row.reason, 'clear')
    assert.equal(row.v, 1)
    assert.equal(row.ts, '2026-07-27T00:00:00.000Z')
  })

  it('never includes a transcript path or any raw content', () => {
    const row = buildRow(payload, () => '', '2026-07-27T00:00:00.000Z')
    const s = JSON.stringify(row)
    assert.equal(s.includes('/nonexistent'), false)
    assert.equal(s.includes('transcript'), false)
  })

  it('emits exactly this key set and nothing else', () => {
    // A keyword grep only catches the leaks you thought to name. The two
    // assertions above search for '/nonexistent' and 'transcript', so adding
    // `cwd` or `prompt` to the row — both real SessionEnd payload fields, and
    // both promised as never-stored in README.md — left the whole suite green.
    //
    // This pins the shape instead of guessing at names: any NEW field fails
    // here, whatever it is called. Adding one is then a deliberate act with a
    // test to update, which is the point.
    const full = buildRow(
      { session_id: 'abc-123', transcript_path: '/nonexistent/t.jsonl', reason: 'clear', cwd: '/private/project', prompt: 'secret text' },
      () => '', '2026-07-27T00:00:00.000Z'
    )
    assert.deepEqual(Object.keys(full).sort(), [
      'assistantTurns', 'cacheCreationTokens', 'cacheReadTokens', 'inputTokens',
      'observationChars', 'observationTokens', 'outputTokens', 'reason',
      'session', 'skippedLines', 'toolCalls', 'toolErrors', 'toolResults', 'ts', 'v'
    ])
    const s = JSON.stringify(full)
    assert.equal(s.includes('/private/project'), false)
    assert.equal(s.includes('secret text'), false)
  })

  it('tolerates a payload with no session id', () => {
    const row = buildRow({}, () => '', '2026-07-27T00:00:00.000Z')
    assert.equal(row.session, null)
  })

  it('excludes tool_result content from the row', () => {
    const SECRET = 'SUPER-SECRET-XYZ-12345'
    const transcript = JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'tool_result', content: SECRET }] }
    }) + '\n'
    const row = buildRow(
      { session_id: 'x', transcript_path: '/nonexistent/t.jsonl' },
      () => transcript,
      '2026-07-27T00:00:00.000Z'
    )
    // Precondition: buildRow must have actually ingested the content, or the
    // assertion below proves nothing. This is the defect this test fixes —
    // the original passed a readText returning '' and could never fire.
    assert.ok(row.observationChars > 0, 'precondition: the content was seen')
    assert.equal(JSON.stringify(row).includes(SECRET), false)
  })
})
