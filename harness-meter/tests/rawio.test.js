import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readTextOrNull, writeTextAtomic, saveUndo, restoreUndo, loadUndo, appendJsonLine } from '../src/remediate/rawio.js'
import { AdapterMismatch } from '../src/adapter/errors.js'

// chmod-based tests are no-ops when running as root (root bypasses permission
// bits), which would make the assertion pass for the wrong reason. Skip them
// explicitly in that case rather than early-returning, so the skip is visible
// in the counters instead of silently reporting a false pass.
const isRoot = process.getuid?.() === 0
if (isRoot) {
  console.log('# skipping chmod-based rawio tests: running as root, permission bits are bypassed')
}

let dir
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'hm-rawio-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const settings = () => join(dir, 'settings.json')

describe('readTextOrNull', () => {
  it('returns null for an absent file', () => {
    assert.equal(readTextOrNull(settings()), null)
  })

  it('returns the exact bytes, preserving formatting', () => {
    const odd = '{\n\t"a":   1,\n  "b": 2\n}'
    writeFileSync(settings(), odd)
    assert.equal(readTextOrNull(settings()), odd)
  })

  ;(isRoot ? it.skip : it)('throws AdapterMismatch when the file exists but cannot be read', () => {
    const target = settings()
    writeFileSync(target, '{}')
    chmodSync(target, 0o000)
    try {
      assert.throws(() => readTextOrNull(target), AdapterMismatch)
    } finally {
      chmodSync(target, 0o644)
    }
  })
})

describe('writeTextAtomic', () => {
  it('creates parent directories', () => {
    const nested = join(dir, 'a', 'b', 'settings.json')
    writeTextAtomic(nested, '{}')
    assert.equal(readFileSync(nested, 'utf8'), '{}')
  })

  it('throws AdapterMismatch and leaves no temp file when the write fails', () => {
    // A directory where the settings file should be: writeFileSync on the temp
    // path succeeds, but the rename onto a directory fails. That exercises the
    // failure path and the temp-file cleanup together.
    const target = join(dir, 'blocked')
    mkdirSync(target)
    assert.throws(() => writeTextAtomic(target, '{}'), AdapterMismatch)
    assert.equal(existsSync(`${target}.hm-tmp`), false)
  })

  // Discriminates a real temp-then-rename implementation from a naive direct
  // writeFileSync onto the same path. POSIX rename(2) only needs write
  // permission on the CONTAINING DIRECTORY, not on the target file itself, so
  // renaming a temp file over a read-only target succeeds — while a direct
  // writeFileSync onto that same read-only target fails EACCES. This is
  // POSIX-specific and is defeated (silently passes for the wrong reason) if
  // the test suite is ever run as root, since root bypasses permission bits —
  // hence the isRoot skip below, matching the other chmod-based tests.
  ;(isRoot ? it.skip : it)('overwrites a read-only file via rename, proving the real temp-then-rename path is used', () => {
    const target = settings()
    writeFileSync(target, 'ORIGINAL')
    chmodSync(target, 0o444)
    try {
      writeTextAtomic(target, 'NEW')
      assert.equal(readFileSync(target, 'utf8'), 'NEW')
    } finally {
      chmodSync(target, 0o644)
    }
  })
})

describe('loadUndo', () => {
  // Used by apply.js's planUndo (BLOCKER 3) to preview a diff BEFORE
  // restoreUndo acts. Unlike restoreUndo, it must not consume the envelope.
  it('returns the parsed envelope without deleting it', () => {
    const odd = '{\n\t"enabledPlugins": {\n\t\t"x@mk":  true\n\t}\n}\n'
    writeFileSync(settings(), odd)
    saveUndo(dir, settings())
    const env = loadUndo(dir)
    assert.equal(env.existed, true)
    assert.equal(env.text, odd)
    assert.equal(existsSync(join(dir, '.hm-undo.json')), true)
  })
})

describe('undo envelope', () => {
  it('round-trips an existing file byte-identically', () => {
    const odd = '{\n\t"enabledPlugins": {\n\t\t"x@mk":  true\n\t}\n}\n'
    writeFileSync(settings(), odd)
    saveUndo(dir, settings())
    writeTextAtomic(settings(), '{"replaced":true}')
    assert.equal(restoreUndo(dir, settings()), 'restored')
    assert.equal(readFileSync(settings(), 'utf8'), odd)
  })

  it('removes a file that did not exist before', () => {
    saveUndo(dir, settings())
    writeTextAtomic(settings(), '{"created":true}')
    assert.equal(restoreUndo(dir, settings()), 'removed')
    assert.equal(existsSync(settings()), false)
  })

  it('deletes the envelope after restoring', () => {
    saveUndo(dir, settings())
    restoreUndo(dir, settings())
    assert.equal(existsSync(join(dir, '.hm-undo.json')), false)
  })

  it('throws AdapterMismatch when there is nothing to undo', () => {
    assert.throws(() => restoreUndo(dir, settings()), AdapterMismatch)
  })

  it('throws AdapterMismatch when the envelope is not valid JSON', () => {
    writeFileSync(join(dir, '.hm-undo.json'), 'not json{{{')
    assert.throws(() => restoreUndo(dir, settings()), AdapterMismatch)
  })
})

describe('appendJsonLine', () => {
  // `dir` comes from the file's top-level beforeEach, which mints a fresh
  // mkdtempSync directory for every single `it` (see top of file). That
  // already gives each test case here its own unique temp dir — no shared
  // fixture path across cases, which is what makes the chmod test below safe
  // under `node --test`'s parallel-by-FILE execution.
  it('creates the file and its parent directory', () => {
    const p = join(dir, 'nested', 'deep', 'sessions.jsonl')
    appendJsonLine(p, { a: 1 })
    assert.equal(readFileSync(p, 'utf8'), '{"a":1}\n')
  })

  it('appends without rewriting existing lines', () => {
    const p = join(dir, 'sessions.jsonl')
    appendJsonLine(p, { n: 1 })
    appendJsonLine(p, { n: 2 })
    assert.equal(readFileSync(p, 'utf8'), '{"n":1}\n{"n":2}\n')
  })

  it('writes exactly one line even when a value contains a newline', () => {
    const p = join(dir, 'sessions.jsonl')
    appendJsonLine(p, { s: 'a\nb' })
    assert.equal(readFileSync(p, 'utf8').split('\n').filter(Boolean).length, 1)
  })

  ;(isRoot ? it.skip : it)('throws AdapterMismatch when the path is not writable', () => {
    chmodSync(dir, 0o500)
    try {
      assert.throws(() => appendJsonLine(join(dir, 'x.jsonl'), { a: 1 }), AdapterMismatch)
    } finally {
      chmodSync(dir, 0o700) // restore, or the temp cleanup fails
    }
  })
})
