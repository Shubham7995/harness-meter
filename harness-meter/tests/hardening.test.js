import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { resolveRoot } from '../src/adapter/config.js'

describe('resolveRoot', () => {
  it('joins .claude onto the supplied home directory', () => {
    delete process.env.CLAUDE_CONFIG_DIR
    assert.equal(resolveRoot('/home/x'), '/home/x/.claude')
  })

  it('prefers CLAUDE_CONFIG_DIR when set', () => {
    process.env.CLAUDE_CONFIG_DIR = '/custom/dir'
    assert.equal(resolveRoot('/home/x'), '/custom/dir')
    delete process.env.CLAUDE_CONFIG_DIR
  })
})
