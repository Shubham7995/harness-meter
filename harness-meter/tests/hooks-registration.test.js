import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

// hooks/hooks.json is the plugin's OWN hook registration — the file that
// actually wires the guard into every Bash call for every installer. No
// other test in this suite reads it: everything else reads FIXTURE
// plugin.json/hooks.json files that stand in for a third-party plugin.
// Renaming the command target here to a typo would ship a broken hook
// registration straight past a green suite.
const HOOKS_JSON = fileURLToPath(new URL('../hooks/hooks.json', import.meta.url))
const PACKAGE_ROOT = dirname(dirname(HOOKS_JSON))

describe('hooks/hooks.json (the plugin\'s own PreToolUse registration)', () => {
  it('registers the guard against the Bash matcher', () => {
    const manifest = JSON.parse(readFileSync(HOOKS_JSON, 'utf8'))
    const group = manifest.hooks.PreToolUse[0]
    assert.equal(group.matcher, 'Bash')
  })

  it('points the command at a script that actually exists on disk', () => {
    const manifest = JSON.parse(readFileSync(HOOKS_JSON, 'utf8'))
    const command = manifest.hooks.PreToolUse[0].hooks[0].command
    const m = /"\$\{CLAUDE_PLUGIN_ROOT\}(\/[^"]+)"/.exec(command)
    assert.ok(m, 'expected the command to reference a ${CLAUDE_PLUGIN_ROOT}-relative path')
    const resolved = join(PACKAGE_ROOT, m[1])
    assert.ok(existsSync(resolved))
  })
})
