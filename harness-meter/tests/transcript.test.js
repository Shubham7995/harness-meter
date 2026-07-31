import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { aggregate } from '../src/metrics/transcript.js'

const SAMPLE = readFileSync(
  fileURLToPath(new URL('./fixtures/transcripts/sample.jsonl', import.meta.url)), 'utf8')

describe('aggregate', () => {
  it('sums the four usage counters across assistant records', () => {
    const r = aggregate(SAMPLE)
    assert.equal(r.inputTokens, 15)
    assert.equal(r.cacheCreationTokens, 100)
    assert.equal(r.cacheReadTokens, 1900)
    assert.equal(r.outputTokens, 70)
  })

  it('counts tool calls, tool results, and errors', () => {
    const r = aggregate(SAMPLE)
    assert.equal(r.toolCalls, 2)
    assert.equal(r.toolResults, 2)
    assert.equal(r.toolErrors, 1)
  })

  it('estimates observation tokens from tool_result content', () => {
    const r = aggregate(SAMPLE)
    assert.equal(typeof r.observationTokens, 'number')
    assert.ok(r.observationTokens > 0)
  })

  it('skips unparseable lines rather than throwing', () => {
    assert.doesNotThrow(() => aggregate(SAMPLE))
    assert.equal(aggregate(SAMPLE).skippedLines, 1)
  })

  it('counts usage once per message id, not once per JSONL line', () => {
    // Claude Code splits ONE assistant API message across one line per content
    // block and repeats the identical `usage` on each. Real transcripts inflate
    // ~1.88x without this. Two lines, same id, usage repeated:
    const mk = (id, type) => JSON.stringify({
      type: 'assistant',
      message: { id, usage: { input_tokens: 100, output_tokens: 10 }, content: [{ type }] }
    })
    const r = aggregate([mk('msg_1', 'text'), mk('msg_1', 'tool_use')].join('\n') + '\n')

    assert.equal(r.inputTokens, 100) // counted ONCE, not 200
    assert.equal(r.outputTokens, 10)
    assert.equal(r.assistantTurns, 1) // one message, not two lines
    assert.equal(r.toolCalls, 1) // content blocks still counted PER LINE
  })

  it('counts distinct message ids separately', () => {
    // The dedupe must not collapse genuinely different messages.
    const mk = id => JSON.stringify({
      type: 'assistant',
      message: { id, usage: { input_tokens: 100 }, content: [] }
    })
    const r = aggregate([mk('msg_1'), mk('msg_2')].join('\n') + '\n')
    assert.equal(r.inputTokens, 200)
    assert.equal(r.assistantTurns, 2)
  })

  it('counts every message when ids are absent', () => {
    // Undercounting a real turn is worse than the double-count being guarded
    // against, so a missing id falls back to per-line counting.
    const line = JSON.stringify({
      type: 'assistant',
      message: { usage: { input_tokens: 100 }, content: [] }
    })
    const r = aggregate([line, line].join('\n') + '\n')
    assert.equal(r.inputTokens, 200)
    assert.equal(r.assistantTurns, 2)
  })

  it('never lets a non-numeric usage value reach the row', () => {
    // `+=` against unvalidated JSON string-concatenates: "0" + secret. This was
    // the only path by which raw transcript bytes could reach sessions.jsonl.
    const SECRET = 'ghp_LEAKEDviaUSAGEfield999'
    const r = aggregate(JSON.stringify({
      type: 'assistant',
      message: { usage: { input_tokens: SECRET, output_tokens: 3 } }
    }) + '\n')
    // Precondition: the record must have been read, or the assertions below
    // prove nothing.
    assert.equal(r.assistantTurns, 1)
    assert.equal(r.outputTokens, 3)
    assert.equal(typeof r.inputTokens, 'number')
    assert.equal(JSON.stringify(r).includes(SECRET), false)
  })

  it('returns a zeroed row for empty input', () => {
    const r = aggregate('')
    assert.equal(r.inputTokens, 0)
    assert.equal(r.toolCalls, 0)
  })

  it('never returns tool_result content, only its length', () => {
    const SECRET = 'SUPER-SECRET-XYZ-12345'
    const text = JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'tool_result', content: SECRET }] }
    }) + '\n'
    const r = aggregate(text)
    // Precondition: without this, the assertion below would pass vacuously
    // for a transcript the aggregator never actually read.
    assert.ok(r.observationChars > 0, 'precondition: the content was seen')
    assert.equal(JSON.stringify(r).includes(SECRET), false)
  })
})
