import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { renderDiff } from '../src/remediate/diff.js'
import { applyFix, commitFix, undoFix, planUndo } from '../src/remediate/apply.js'

let root
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'hm-apply-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

const settingsPath = () => join(root, '.claude', 'settings.json')

function seed (text) {
  mkdirSync(join(root, '.claude'), { recursive: true })
  writeFileSync(settingsPath(), text)
}

describe('renderDiff', () => {
  it('marks every line as added when before is null', () => {
    const d = renderDiff(null, 'a\nb\n')
    assert.match(d, /^\+a$/m)
    assert.match(d, /^\+b$/m)
  })

  it('marks removals and additions', () => {
    const d = renderDiff('a\nb\n', 'a\nc\n')
    assert.match(d, /^-b$/m)
    assert.match(d, /^\+c$/m)
  })

  it('returns an empty string when nothing changed', () => {
    assert.equal(renderDiff('a\n', 'a\n'), '')
  })

  it('marks trailing lines removed when before has more lines than after', () => {
    const d = renderDiff('a\nb\nc\n', 'a\n')
    assert.match(d, /^-b$/m)
    assert.match(d, /^-c$/m)
  })

  it('marks trailing lines added when after has more lines than a non-null before', () => {
    const d = renderDiff('a\n', 'a\nb\nc\n')
    assert.match(d, /^\+b$/m)
    assert.match(d, /^\+c$/m)
  })
})

describe('applyFix', () => {
  it('targets the project-scoped settings path', () => {
    const plan = applyFix(root, ['a'])
    assert.equal(plan.settingsPath, settingsPath())
  })

  it('does not write anything', () => {
    applyFix(root, ['a'])
    assert.equal(existsSync(settingsPath()), false)
  })

  it('reports before as null when no file exists', () => {
    assert.equal(applyFix(root, ['a']).before, null)
  })
})

describe('commitFix and undoFix', () => {
  it('writes the proposed settings', () => {
    commitFix(root, applyFix(root, ['a']))
    assert.deepEqual(JSON.parse(readFileSync(settingsPath(), 'utf8')).enabledPlugins, { a: true })
  })

  it('restores a pre-existing file byte-identically', () => {
    const odd = '{\n\t"env": {"X": "1"},\n\t"enabledPlugins": {"old":   true}\n}'
    seed(odd)
    commitFix(root, applyFix(root, ['a']))
    assert.notEqual(readFileSync(settingsPath(), 'utf8'), odd)
    assert.equal(undoFix(root), 'restored')
    assert.equal(readFileSync(settingsPath(), 'utf8'), odd)
  })

  it('removes a file it created', () => {
    commitFix(root, applyFix(root, ['a']))
    assert.equal(undoFix(root), 'removed')
    assert.equal(existsSync(settingsPath()), false)
  })

  it('preserves unrelated keys through the round trip', () => {
    seed('{"env":{"X":"1"},"enabledPlugins":{"old":true}}')
    commitFix(root, applyFix(root, ['a']))
    assert.deepEqual(JSON.parse(readFileSync(settingsPath(), 'utf8')).env, { X: '1' })
  })
})

describe('commitFix does not clobber an existing undo envelope', () => {
  // I5: a second --apply must not overwrite the FIRST saved envelope, or the
  // true original bytes become irrecoverable — undo would only ever restore
  // to the most recent apply's result, not the pristine pre-fix state.
  it('undo still restores the ORIGINAL pre-apply content after a second commitFix', () => {
    const odd = '{"env":{"X":"1"},"enabledPlugins":{"old":true}}'
    seed(odd)
    commitFix(root, applyFix(root, ['a']))
    commitFix(root, applyFix(root, ['b']))
    assert.equal(undoFix(root), 'restored')
    assert.equal(readFileSync(settingsPath(), 'utf8'), odd)
  })
})

describe('planUndo', () => {
  // BLOCKER 3: --undo must show what it is about to do BEFORE acting.
  // planUndo is the read-only preview half (mirrors applyFix); undoFix
  // above remains the write half (mirrors commitFix) and is unchanged.
  it('says "will be removed" when the envelope has no prior file but one exists now', () => {
    commitFix(root, applyFix(root, ['a'])) // envelope: existed=false
    const plan = planUndo(root)
    assert.equal(plan.diff, 'will be removed')
  })
})
