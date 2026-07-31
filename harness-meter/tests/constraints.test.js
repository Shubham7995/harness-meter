import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const SRC = fileURLToPath(new URL('../src/', import.meta.url))

function allSourceFiles (dir) {
  const out = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...allSourceFiles(p))
    else if (e.name.endsWith('.js')) out.push(p)
  }
  return out
}

describe('binding structural constraints', () => {
  it('no module under src/ imports node:os', () => {
    const offenders = allSourceFiles(SRC)
      .filter(p => /from\s+['"]node:os['"]/.test(readFileSync(p, 'utf8')))
    assert.deepEqual(offenders, [])
  })

  it('src/guard.js has zero imports', () => {
    const text = readFileSync(join(SRC, 'guard.js'), 'utf8')
    assert.equal(/^\s*import\s/m.test(text), false)
  })

  it('nothing under src/remediate/ imports the audit config adapter', () => {
    const offenders = allSourceFiles(join(SRC, 'remediate'))
      .filter(p => /adapter\/config\.js/.test(readFileSync(p, 'utf8')))
    assert.deepEqual(offenders, [])
  })

  it('src/remediate/rawio.js is the only module under src/ or bin/ with a write syscall', () => {
    // Phase 4b resolved this: the SessionEnd appender was routed THROUGH
    // rawio.js (appendJsonLine) rather than becoming a second permitted
    // writer. If you are here because you want to add one, that is the
    // decision you are reversing — see the plan's Task 3.
    // Covers three API surfaces, not one. The original regex listed only the
    // synchronous fs calls, so the whole node:fs/promises surface — plus the
    // callback API, cpSync, writeSync, and child_process — could introduce a
    // second writer anywhere under src/ or bin/ with the suite still green.
    // Verified: adding `import { writeFile } from 'node:fs/promises'` to
    // src/metrics/record.js left all four constraints passing.
    // The *Sync names are distinctive enough to match as bare words. The
    // promise/callback names (rename, unlink, symlink, truncate…) are ordinary
    // English and appear throughout this codebase's comments, so those must be
    // matched as CALLS — `name(` — or the invariant fails on prose about
    // symlink resolution rather than on a real writer.
    const SYNC = [
      'writeFileSync', 'appendFileSync', 'renameSync', 'rmSync', 'unlinkSync',
      'mkdirSync', 'copyFileSync', 'openSync', 'truncateSync', 'ftruncateSync',
      'cpSync', 'writeSync', 'writevSync', 'rmdirSync', 'symlinkSync',
      'linkSync', 'chmodSync', 'chownSync', 'utimesSync', 'mkdtempSync',
      'createWriteStream'
    ]
    const ASYNC = [
      'writeFile', 'appendFile', 'rename', 'unlink', 'mkdir', 'copyFile',
      'rmdir', 'symlink', 'truncate', 'mkdtemp', 'cp', 'chmod', 'chown'
    ]
    const WRITE_SYSCALL = new RegExp([
      `\\b(${SYNC.join('|')})\\b`,
      `\\b(${ASYNC.join('|')})\\s*\\(`,
      // Importing either module at all is enough: both are whole surfaces for
      // writing that this project has no reason to touch outside rawio.
      'node:fs/promises', 'node:child_process'
    ].join('|'))
    const BIN = fileURLToPath(new URL('../bin/', import.meta.url))
    const rawio = join('src', 'remediate', 'rawio.js')
    const offenders = [...allSourceFiles(SRC), ...allSourceFiles(BIN)]
      .filter(p => !p.endsWith(rawio))
      .filter(p => WRITE_SYSCALL.test(readFileSync(p, 'utf8')))
    assert.deepEqual(offenders, [])
  })
})
