import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { proposeProfile, renderSettings } from '../src/remediate/profile.js'

describe('proposeProfile — allowlist only', () => {
  it('drops a known plugin whose capability is absent', () => {
    const p = proposeProfile(['azure', 'superpowers'], new Set())
    assert.deepEqual(p.drop, ['azure'])
  })

  it('keeps a known plugin whose capability is present', () => {
    const p = proposeProfile(['azure'], new Set(['azure']))
    assert.deepEqual(p.drop, [])
    assert.deepEqual(p.keep, ['azure'])
  })

  it('NEVER drops a plugin absent from the signals table', () => {
    const p = proposeProfile(['superpowers', 'caveman', 'firecrawl'], new Set())
    assert.deepEqual(p.drop, [])
    assert.deepEqual(p.unknown, ['caveman', 'firecrawl', 'superpowers'])
  })

  it('reports unknown plugins separately from kept ones', () => {
    const p = proposeProfile(['azure', 'superpowers'], new Set(['azure']))
    assert.deepEqual(p.keep, ['azure'])
    assert.deepEqual(p.unknown, ['superpowers'])
  })

  it('returns empty arrays for no enabled plugins', () => {
    assert.deepEqual(proposeProfile([], new Set()), { keep: [], drop: [], unknown: [] })
  })

  it('sorts every array', () => {
    const p = proposeProfile(['zzz', 'aaa'], new Set())
    assert.deepEqual(p.unknown, ['aaa', 'zzz'])
  })

  it('sorts keep and drop too, not just unknown', () => {
    const p = proposeProfile(
      ['typescript-lsp', 'azure', 'svelte-skills', 'pydantic-ai'],
      new Set(['typescript-lsp', 'azure'])
    )
    assert.deepEqual(p.keep, ['azure', 'typescript-lsp'])
    assert.deepEqual(p.drop, ['pydantic-ai', 'svelte-skills'])
  })
})

describe('renderSettings preserves existing project decisions', () => {
  it('never flips an explicit false back to true', () => {
    // `{...doc, enabledPlugins}` replaced the whole key, so a plugin the user
    // had DELIBERATELY disabled at project level was silently re-enabled the
    // next time hm fix ran — it is "declined to judge", so it landed in
    // keepNames as true. Caught on a real machine: hm fix proposed re-enabling
    // a guard the user had turned off an hour earlier.
    const existing = JSON.stringify({ enabledPlugins: { 'tdd-guard@tdd-guard': false } })
    const out = JSON.parse(renderSettings(['tdd-guard@tdd-guard', 'other@x'], existing))
    assert.equal(out.enabledPlugins['tdd-guard@tdd-guard'], false)
    assert.equal(out.enabledPlugins['other@x'], true)
  })
})

describe('renderSettings', () => {
  it('creates a fresh document when there is no existing file', () => {
    const out = renderSettings(['a', 'b'], null)
    assert.deepEqual(JSON.parse(out).enabledPlugins, { a: true, b: true })
    assert.equal(out.endsWith('\n'), true)
  })

  it('uses two-space indentation', () => {
    const out = renderSettings(['a'], null)
    assert.equal(out, '{\n  "enabledPlugins": {\n    "a": true\n  }\n}\n')
  })

  it('preserves other keys in an existing document', () => {
    const existing = '{"env":{"X":"1"},"enabledPlugins":{"old":true}}'
    const parsed = JSON.parse(renderSettings(['a'], existing))
    assert.deepEqual(parsed.env, { X: '1' })
    assert.deepEqual(parsed.enabledPlugins, { a: true })
  })

  it('throws rather than guessing when the existing document is unparseable', () => {
    assert.throws(() => renderSettings(['a'], '{not json'))
  })

  it('throws when the existing document parses to an array, not an object', () => {
    assert.throws(() => renderSettings(['a'], '[1,2,3]'))
  })

  it('throws when the existing document parses to null', () => {
    assert.throws(() => renderSettings(['a'], 'null'))
  })

  it('throws when the existing document parses to a bare number', () => {
    assert.throws(() => renderSettings(['a'], '42'))
  })
})

describe('renderSettings sanitises parse failures', () => {
  it('does not leak file content in the error message', () => {
    const secret = 'gho_EXAMPLENOTAREALTOKEN'
    // An unquoted VALUE is the form whose V8 message embeds a source window:
    //   Unexpected token 'g', ..."{"token": gho_EXAMPL"... is not valid JSON
    // Verified on node v22. The trailing-comma form does NOT leak, which is
    // why an earlier version of this test passed before the fix existed.
    // Note this form carries no "position N" — do not assert one here.
    assert.throws(
      () => renderSettings(['a'], `{"token": ${secret}}`),
      e => !e.message.includes(secret) && !e.message.includes('gho_')
    )
  })

  it('surfaces the position when V8 provides one', () => {
    assert.throws(() => renderSettings(['a'], '{"a": 1, }'), /position \d+/)
  })
})
