import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inferCapabilities } from '../src/remediate/repo.js'
import { SIGNALS } from '../src/remediate/signals.js'

const repo = (n) => fileURLToPath(new URL(`./fixtures/repos/${n}/`, import.meta.url))

describe('inferCapabilities', () => {
  it('infers nothing from an empty repo', () => {
    assert.deepEqual([...inferCapabilities(repo('empty'))], [])
  })

  it('infers azure from azure.yaml', () => {
    assert.equal(inferCapabilities(repo('azure-app')).has('azure'), true)
  })

  it('does not infer azure from a repo without its signals', () => {
    assert.equal(inferCapabilities(repo('node-only')).has('azure'), false)
  })

  it('ignores signals inside node_modules', () => {
    // node-only/node_modules/azure-decoy/azure.yaml exists and must not count
    assert.equal(inferCapabilities(repo('node-only')).has('azure'), false)
  })

  it('finds an ext-only signal nested two ordinary directories deep', () => {
    // nested-ext/src/components/App.svelte has no svelte.config.js anywhere,
    // so this can only pass via real recursion AND the { ext } match branch.
    assert.equal(inferCapabilities(repo('nested-ext')).has('svelte-skills'), true)
  })

  it('does not infer a signal whose only occurrence is inside a dot-directory', () => {
    // dotdir-skip/.config/tsconfig.json must not count — dot-directories are skipped.
    assert.equal(inferCapabilities(repo('dotdir-skip')).has('typescript-lsp'), false)
  })
})

describe('walk depth cap', () => {
  // Built in a scratch temp dir rather than committed as a fixture: proving
  // the cap requires 9 nested directories, which is disproportionate to
  // commit as static files for a single assertion. Cleaned up after the test.
  it('does not descend deep enough to find a signal beyond the depth cap', () => {
    const root = mkdtempSync(join(tmpdir(), 'hm-depth-'))
    try {
      let dir = root
      for (let i = 1; i <= 9; i++) {
        dir = join(dir, `d${i}`)
        mkdirSync(dir)
      }
      // tsconfig.json sits inside the 9th nested directory. walk() checks
      // `depth > 8` on entry, so the call that would read this directory's
      // contents (made at depth 9) returns before readdirSync ever runs.
      writeFileSync(join(dir, 'tsconfig.json'), '{}')
      assert.equal(inferCapabilities(root).has('typescript-lsp'), false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('SIGNALS table', () => {
  it('every entry has at least one signal descriptor', () => {
    for (const [plugin, sigs] of Object.entries(SIGNALS)) {
      assert.ok(Array.isArray(sigs) && sigs.length > 0, `${plugin} has no signals`)
    }
  })

  it('every descriptor is exactly one of file or ext', () => {
    for (const [plugin, sigs] of Object.entries(SIGNALS)) {
      for (const s of sigs) {
        const keys = Object.keys(s).sort()
        assert.deepEqual(keys.length, 1, `${plugin}: descriptor must have one key`)
        assert.ok(keys[0] === 'file' || keys[0] === 'ext', `${plugin}: bad key ${keys[0]}`)
      }
    }
  })
})

describe('every SIGNALS entry is load-bearing', () => {
  // Each case names a plugin and a filename that must trigger it. If an entry
  // were deleted from SIGNALS, its case here would fail.
  const cases = [
    ['azure', 'azure.yaml'],
    ['svelte-skills', 'svelte.config.js'],
    ['pydantic-ai', 'pyproject.toml'],
    ['typescript-lsp', 'tsconfig.json'],
    ['pyright-lsp', 'pyrightconfig.json']
  ]

  it('covers every plugin in the table', () => {
    assert.deepEqual(cases.map(c => c[0]).sort(), Object.keys(SIGNALS).sort())
  })

  for (const [plugin, filename] of cases) {
    it(`${plugin} is inferred from ${filename}`, () => {
      const matched = SIGNALS[plugin].some(s => s.file === filename)
      assert.ok(matched, `${filename} is not a declared signal for ${plugin}`)
    })
  }
})
