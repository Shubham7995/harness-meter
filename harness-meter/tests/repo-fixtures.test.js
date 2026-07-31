import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { inferCapabilities } from '../src/remediate/repo.js'

const repo = n => fileURLToPath(new URL(`./fixtures/repos/${n}/`, import.meta.url))

describe('walk excludes fixture directories', () => {
  it('does not credit a signal that only exists under tests/fixtures/', () => {
    const caps = inferCapabilities(repo('fixture-contaminated'))
    assert.equal(caps.has('azure'), false)
  })

  it('still credits a signal outside the fixture directory', () => {
    const caps = inferCapabilities(repo('fixture-contaminated'))
    assert.equal(caps.has('typescript-lsp'), true)
  })

  it('--include-fixtures restores the old behaviour', () => {
    const caps = inferCapabilities(repo('fixture-contaminated'), { includeFixtures: true })
    assert.equal(caps.has('azure'), true)
  })

  it('this repository no longer credits azure to its own fixtures', () => {
    // The defect that motivated this task, asserted against the real repo root.
    const caps = inferCapabilities(fileURLToPath(new URL('../', import.meta.url)))
    assert.equal(caps.has('azure'), false)
    assert.equal(caps.has('svelte-skills'), false)
  })
})

describe('SKIP members are individually load-bearing', () => {
  // Each assertion fails if its directory name is removed from SKIP.
  for (const [dir, plugin] of [
    ['dist', 'azure'],
    ['build', 'typescript-lsp'],
    ['vendor', 'pydantic-ai'],
    ['target', 'svelte-skills']
  ]) {
    it(`ignores signals under ${dir}/`, () => {
      const caps = inferCapabilities(repo('skip-dirs'))
      assert.equal(caps.has(plugin), false)
    })
  }
})
