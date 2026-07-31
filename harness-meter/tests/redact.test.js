import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { redactDeep, redactDiffText } from '../src/adapter/redact.js'

describe('redactDiffText', () => {
  it('masks a credential in a diff line while keeping the diff readable', () => {
    // hm fix re-serialises the whole settings file, so an env block holding a
    // live token reached the printed diff — on a plain dry run, no --apply.
    const diff = [
      ' {',
      '-  "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "gho_REALcredential123" },',
      '+  "enabledPlugins": {}',
      ' }'
    ].join('\n')
    const out = redactDiffText(diff)
    assert.equal(out.includes('gho_REALcredential123'), false)
    assert.equal(out.includes('GITHUB_PERSONAL_ACCESS_TOKEN'), true) // key stays
    assert.equal(out.includes('enabledPlugins'), true) // the real change stays
    assert.match(out, /^-/m) // still a diff
  })

  it('masks a nested env value whose key looks innocuous', () => {
    // Multi-line env block: `A_SETTING` matches no secret pattern and the value
    // looks like nothing, so only the enclosing `env` block marks it.
    const diff = [
      ' {',
      '   "env": {',
      '-    "A_SETTING": "s3cr3t-value"',
      '   }',
      ' }'
    ].join('\n')
    const out = redactDiffText(diff)
    assert.equal(out.includes('s3cr3t-value'), false)
    assert.equal(out.includes('A_SETTING'), true)
  })

  it('leaves an ordinary diff untouched', () => {
    // Over-redaction has a cost too: a diff nobody can read is not a diff.
    const diff = ' {\n-  "enabledPlugins": { "azure@x": true }\n+  "enabledPlugins": {}\n }'
    assert.equal(redactDiffText(diff), diff)
  })

  it('masks a secret-shaped value under any key', () => {
    const out = redactDiffText('-  "somekey": "ghp_AAAABBBBCCCCDDDDEEEEFFFF"')
    assert.equal(out.includes('ghp_AAAABBBBCCCCDDDDEEEEFFFF'), false)
  })

  it('tracks brace depth per diff side, not across interleaved lines', () => {
    // renderDiff interleaves - and + lines, so counting braces across the
    // whole stream mixes the two sides: a `+  "env": {` line left envDepth
    // open, and the very next `-  "enabledPlugins": {...}` line — from the
    // OTHER side of the diff, nowhere near an env block — was masked as if it
    // were inside it. Over-redaction is the safe direction, but it hid the
    // actual change the user was being asked to approve.
    const diff = [
      ' {',
      '-  "env": { "TOKEN": "gho_AAAABBBBCCCCDDDD" },',
      '+  "env": {',
      '-  "enabledPlugins": { "azure@x": true }',
      '+    "TOKEN": "gho_AAAABBBBCCCCDDDD"',
      '+  },',
      '+  "enabledPlugins": {}'
    ].join('\n')
    const out = redactDiffText(diff)
    assert.equal(out.includes('gho_AAAABBBBCCCCDDDD'), false) // still masked
    assert.equal(out.includes('"azure@x"'), true) // the real change stays VISIBLE
  })

  it('leaves the env block once it closes', () => {
    // Depth tracking must not leak: a key AFTER the env block closes is not
    // secret by association.
    const diff = [' {', '   "env": {', '     "A": "x"', '   },', '-  "other": "visible-value"', ' }'].join('\n')
    assert.equal(redactDiffText(diff).includes('visible-value'), true)
  })
})

describe('redactValue', () => {
  it('redacts by key name', () => {
    assert.equal(
      redactDeep({ GITHUB_PERSONAL_ACCESS_TOKEN: 'anything' }).GITHUB_PERSONAL_ACCESS_TOKEN,
      '<redacted:GITHUB_PERSONAL_ACCESS_TOKEN>'
    )
    assert.equal(redactDeep({ apiKey: 'abc' }).apiKey, '<redacted:apiKey>')
    assert.equal(redactDeep({ my_password: 'abc' }).my_password, '<redacted:my_password>')
  })

  it('redacts by value shape even when the key looks innocent', () => {
    assert.equal(redactDeep({ foo: 'gho_AAAABBBBCCCCDDDD' }).foo, '<redacted:foo>')
    assert.equal(redactDeep({ foo: 'ghp_AAAABBBBCCCCDDDD' }).foo, '<redacted:foo>')
    assert.equal(redactDeep({ foo: 'sk-AAAABBBBCCCCDDDD' }).foo, '<redacted:foo>')
    assert.equal(redactDeep({ foo: 'AKIAIOSFODNN7EXAMPLE' }).foo, '<redacted:foo>')
    assert.equal(redactDeep({ foo: 'eyJhbGci.eyJzdWIi.sig' }).foo, '<redacted:foo>')
  })

  it('leaves ordinary values alone', () => {
    assert.equal(redactDeep({ PATH: '/usr/bin:/bin' }).PATH, '/usr/bin:/bin')
    assert.equal(redactDeep({ effortLevel: 'high' }).effortLevel, 'high')
    assert.equal(redactDeep({ enabled: true }).enabled, true)
    assert.equal(redactDeep({ count: 3 }).count, 3)
  })
})

describe('redactDeep', () => {
  it('redacts nested values and does not mutate the input', () => {
    const input = {
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'gho_SECRETVALUE', PATH: '/bin' },
      list: ['gho_ANOTHERSECRET', 'plain']
    }
    const out = redactDeep(input)

    assert.equal(out.env.GITHUB_PERSONAL_ACCESS_TOKEN, '<redacted:GITHUB_PERSONAL_ACCESS_TOKEN>')
    assert.equal(out.env.PATH, '/bin')
    assert.equal(out.list[0], '<redacted>')
    assert.equal(out.list[1], 'plain')
    assert.equal(input.env.GITHUB_PERSONAL_ACCESS_TOKEN, 'gho_SECRETVALUE')
  })

  it('leaks no fragment of a redacted secret', () => {
    const out = JSON.stringify(redactDeep({ token: 'gho_lzjOTdeadbeefEXAMPLE' }))
    assert.equal(out.includes('gho_'), false)
    assert.equal(out.includes('lzjOT'), false)
  })

  it('redacts descendants when a secret-sounding parent key wraps an innocuous leaf', () => {
    const out = redactDeep({ secrets: { blob: 'proprietary-credential' } })
    assert.equal(out.secrets.blob, '<redacted:blob>')
  })

  it('redacts descendants two levels deep under a secret-sounding parent key', () => {
    const out = redactDeep({ secrets: { middle: { blob: 'plain-value' } } })
    assert.equal(out.secrets.middle.blob, '<redacted:blob>')
  })

  it('redacts array elements under a secret-sounding parent key', () => {
    const out = redactDeep({ secrets: ['plain1', 'plain2'] })
    assert.equal(out.secrets[0], '<redacted>')
    assert.equal(out.secrets[1], '<redacted>')
  })

  it('does not redact innocent nested values under non-secret parent keys', () => {
    const out = redactDeep({ config: { debug: true, level: 5 } })
    assert.equal(out.config.debug, true)
    assert.equal(out.config.level, 5)
  })
})
