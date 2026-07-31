import { readdirSync } from 'node:fs'
import { join, extname } from 'node:path'
import { SIGNALS } from './signals.js'

// Directories that never justify a capability. node_modules in particular is
// full of other people's config files.
const SKIP = new Set(['node_modules', 'dist', 'build', 'vendor', 'target'])

// Phase 4b: test fixtures are not capabilities.
//
// harness-meter's own repository was the proof. It carries
// tests/fixtures/repos/azure-app/azure.yaml as a FIXTURE for the azure
// signal, and the walk happily credited it — so `hm fix` reported azure as
// justified here, in a repo with no Azure code, and spec success criterion 5
// did not hold. The general form: a repository's test fixtures are
// indistinguishable from its capabilities unless you say otherwise.
//
// Only directories whose NAME says "fixture" are skipped. `tests/` itself is
// NOT skipped: a real project can legitimately hold its only tsconfig.json or
// pyproject.toml under a test tree, and dropping a plugin over that would be
// the walk's existing drop-bias (see the backlog's known-asymmetry note) made
// worse.
const FIXTURE_DIRS = new Set(['fixtures', '__fixtures__', 'testdata', 'test-data', '__mocks__'])

function * walk (dir, skip, depth = 0) {
  if (depth > 8) return
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return // an unreadable subdirectory is not a reason to fail the whole scan
  }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.isDirectory()) continue
    if (skip.has(e.name)) continue
    if (e.isDirectory()) yield * walk(join(dir, e.name), skip, depth + 1)
    // Dotfiles ARE yielded — only dot-DIRECTORIES are skipped above. No
    // current signal is a dotfile (.sentryclirc left with sentry), so nothing
    // exercises this; it is deliberate, not vestigial. A future dotfile
    // signal must keep working without touching the walk.
    else yield e.name
  }
}

export function inferCapabilities (repoRoot, opts = {}) {
  const skip = opts.includeFixtures ? SKIP : new Set([...SKIP, ...FIXTURE_DIRS])
  const found = new Set()
  const names = [...walk(repoRoot, skip)]
  for (const [plugin, sigs] of Object.entries(SIGNALS)) {
    const hit = sigs.some(s =>
      s.file !== undefined
        ? names.includes(s.file)
        : names.some(n => extname(n) === s.ext)
    )
    if (hit) found.add(plugin)
  }
  return found
}
