import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync, cpSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const HM = fileURLToPath(new URL('../bin/hm.js', import.meta.url))
const GOOD_SRC = fileURLToPath(new URL('./fixtures/good/', import.meta.url))

// `root` is a per-test mkdtempSync COPY of the committed fixtures/good/ tree,
// never the tracked directory itself. A mutation or a bug in runFix that
// points a write at `--root` instead of `--repo` must land in disposable temp
// state, not in version-controlled files — see 'never targets the
// user-level settings file' below, which is the test this protects.
let repo
let root
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'hm-fix-'))
  writeFileSync(join(repo, 'package.json'), '{}')
  root = mkdtempSync(join(tmpdir(), 'hm-fix-root-'))
  cpSync(GOOD_SRC, root, { recursive: true })
})
afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
  rmSync(root, { recursive: true, force: true })
})

const settings = () => join(repo, '.claude', 'settings.json')
// Two calling conventions on one helper (per task-2-brief.md: "use the
// file's existing helper for invoking the CLI; do not introduce a second
// one"). `run('--apply', ...)` — the shorthand every existing test in this
// file already uses — prepends `fix --repo repo --root root` and returns
// stdout, throwing on a non-zero exit. `run([...fullArgv])` is for tests
// that need a DIFFERENT command (e.g. `audit`) or expect a non-zero exit:
// it runs the argv verbatim and returns { status, stdout, stderr } instead
// of throwing.
const run = (...args) => {
  if (args.length === 1 && Array.isArray(args[0])) {
    try {
      const stdout = execFileSync('node', [HM, ...args[0]], { encoding: 'utf8', stdio: 'pipe' })
      return { status: 0, stdout, stderr: '' }
    } catch (e) {
      return { status: e.status, stdout: e.stdout, stderr: e.stderr }
    }
  }
  return execFileSync('node', [HM, 'fix', '--repo', repo, '--root', root, ...args], { encoding: 'utf8' })
}

describe('hm fix', () => {
  it('prints a diff and writes nothing by default', () => {
    const out = run()
    assert.match(out, /^[+\-]/m)
    assert.equal(existsSync(settings()), false)
  })

  it('writes only with --apply, and prints the diff too', () => {
    const out = run('--apply')
    assert.match(out, /^[+\-]/m)
    assert.equal(existsSync(settings()), true)
  })

  // BLOCKER 1: the GOOD fixture's superpowers@claude-plugins-official is
  // unknown to SIGNALS (always kept), while azure@claude-plugins-official is
  // known but the repo fixture has no azure signal (so it is dropped). The
  // written enabledPlugins must key by the FULL qualified id, not the bare
  // name loadSettings strips for audit display — round-tripping the bare
  // form would produce a key ("superpowers") that matches nothing real.
  it('writes qualified plugin identifiers (name@marketplace), not bare names', () => {
    run('--apply')
    const written = JSON.parse(readFileSync(settings(), 'utf8'))
    assert.deepEqual(written.enabledPlugins, { 'superpowers@claude-plugins-official': true })
  })

  // I5: commitFix now refuses to overwrite an existing undo envelope (a
  // second --apply keeps the FIRST saved original), so the CLI's own output
  // must say plainly what --undo does and does not guarantee, rather than
  // just "undo with: hm fix --undo".
  it('states what undo guarantees when applying', () => {
    const out = run('--apply')
    assert.match(out, /undo with: hm fix --undo/)
    assert.match(out, /first --apply/i)
  })

  it('never targets the user-level settings file', () => {
    const out = run('--apply')
    assert.equal(out.includes(root), false)
    assert.equal(existsSync(join(root, 'settings.json.hm-tmp')), false)
  })

  it('undo restores and reports', () => {
    run('--apply')
    assert.equal(existsSync(settings()), true)
    run('--undo')
    assert.equal(existsSync(settings()), false)
  })

  // BLOCKER 3: --undo must print a diff of what it is about to do BEFORE
  // acting, matching --apply's shape (Global Constraint: every write prints
  // its diff first). Previously --undo printed only the status line.
  it('undo prints a diff of what it is about to do before acting, not just the status line', () => {
    run('--apply')
    const out = run('--undo')
    assert.match(out, /will be removed/)
  })

  // Exact scenario from the whole-branch review's demonstration: apply into a
  // repo with no settings file (envelope existed:false), then hand-write a
  // real settings file afterward. Undo still removes it (unchanged
  // behavior), but must now show "will be removed" BEFORE doing so.
  it('shows "will be removed" before deleting a hand-written file the undo envelope does not know about', () => {
    run('--apply')
    writeFileSync(settings(), '{"handWritten":true}')
    const out = run('--undo')
    assert.match(out, /will be removed/)
    assert.equal(existsSync(settings()), false)
  })

  it('exits 2 when there is nothing to undo', () => {
    try {
      execFileSync('node', [HM, 'fix', '--repo', repo, '--undo'], { encoding: 'utf8', stdio: 'pipe' })
      assert.fail('expected non-zero exit')
    } catch (e) {
      assert.equal(e.status, 2)
    }
  })

  it('reports plugins it declined to judge', () => {
    assert.match(run(), /declined|unknown/i)
  })

  // BLOCKER 4: catches `proposal.drop.length`/`proposal.keep.length` being
  // swapped in the summary line. GOOD fixture + this repo's capabilities:
  // azure is known but has no signal here (dropped), superpowers is unknown
  // to SIGNALS (kept unconditionally) — so drop=1, keep=0, unknown=1.
  it('summary line reports the actual proposal counts, not swapped', () => {
    assert.match(run(), /harness-meter: 1 plugin\(s\) to disable, 0 justified, 1 declined to judge/)
  })

  // The assertion above also matches the always-printed summary sentence
  // ("... declined to judge"), so it cannot tell whether the itemized
  // "declined to judge (kept): ..." listing itself is present. This test
  // names the specific fixture plugin (superpowers — absent from SIGNALS,
  // so always unknown/kept) that only the itemized line would print.
  it('names the specific plugin it declined to judge in the itemized list', () => {
    assert.match(run(), /declined to judge \(kept\):.*superpowers/)
  })

  // Reachable via `plan.diff === ''`: applying twice against the same repo
  // produces an identical settings document the second time, so the diff is
  // empty and the "(no change)" branch — not the diff-printing branch — must
  // fire.
  it('reports no change on a second --apply against the same repo', () => {
    run('--apply')
    const out = run('--apply')
    assert.match(out, /\(no change\)/)
  })
})

describe('home-directory guard', () => {
  // ITEM 1 of the Phase 4a design correction: `hm fix --repo <home> --apply`
  // must refuse before any read/write, rather than silently overwriting
  // ~/.claude/settings.json. HOME is overridden only for this spawned child
  // process (execFileSync's env fully replaces the child's environment) so
  // this never touches the real machine's home directory — a fresh
  // mkdtempSync dir stands in for "home" instead.
  //
  // This scenario passes --root pointing at an UNRELATED, valid fixture copy
  // (not fakeHome), so the read succeeds normally — the guard must still
  // refuse because the WRITE target (fakeHome/.claude/settings.json, since
  // --repo IS fakeHome here) is the real default config root's settings
  // file, independent of what --root was overridden to for reading. See the
  // 'symlink' and 'case-folded' bypass tests in tests/config.test.js for the
  // two concrete bypasses this replaces the old assertRepoIsNotHome guard to
  // close.
  it('refuses --repo pointed at the (env-overridden) home directory, without writing anything', () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'hm-fakehome-'))
    try {
      execFileSync(
        'node', [HM, 'fix', '--repo', fakeHome, '--root', root, '--apply'],
        { encoding: 'utf8', stdio: 'pipe', env: { ...process.env, HOME: fakeHome } }
      )
      assert.fail('expected non-zero exit')
    } catch (e) {
      assert.notEqual(e.status, 0)
      assert.match(e.stderr, /same file/)
      assert.equal(existsSync(join(fakeHome, '.claude', 'settings.json')), false)
    } finally {
      rmSync(fakeHome, { recursive: true, force: true })
    }
  })

  // The confirmed symlink bypass, reproduced at the CLI level: --repo is a
  // symlink resolving to the (env-overridden) home directory. The OLD guard
  // (bare resolve() string comparison) let this through because resolve()
  // never dereferences symlinks; assertNotSameSettingsFile's realpath-based
  // check does.
  it('refuses --repo that is a SYMLINK resolving to the (env-overridden) home directory', () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'hm-fakehome-sym-'))
    const linkParent = mkdtempSync(join(tmpdir(), 'hm-fakehome-symlink-'))
    const repoLink = join(linkParent, 'repo-link')
    symlinkSync(fakeHome, repoLink)
    try {
      execFileSync(
        'node', [HM, 'fix', '--repo', repoLink, '--root', root, '--apply'],
        { encoding: 'utf8', stdio: 'pipe', env: { ...process.env, HOME: fakeHome } }
      )
      assert.fail('expected non-zero exit')
    } catch (e) {
      assert.notEqual(e.status, 0)
      assert.match(e.stderr, /same file/)
      assert.equal(existsSync(join(fakeHome, '.claude', 'settings.json')), false)
    } finally {
      rmSync(fakeHome, { recursive: true, force: true })
      rmSync(linkParent, { recursive: true, force: true })
    }
  })
})

describe('--repo validation', () => {
  it('rejects a trailing --repo with no value rather than falling back to process.cwd()', () => {
    try {
      execFileSync('node', [HM, 'fix', '--root', root, '--repo'], { encoding: 'utf8', stdio: 'pipe' })
      assert.fail('expected non-zero exit')
    } catch (e) {
      assert.notEqual(e.status, 0)
      assert.match(e.stderr, /--repo/)
    }
  })

  it('rejects --repo immediately followed by another flag, rather than swallowing it as the path', () => {
    // '--repo --apply' must not consume '--apply' as the repo path (which
    // would both point at a bogus path AND silently drop apply mode).
    try {
      execFileSync('node', [HM, 'fix', '--repo', '--apply'], { encoding: 'utf8', stdio: 'pipe' })
      assert.fail('expected non-zero exit')
    } catch (e) {
      assert.notEqual(e.status, 0)
      assert.match(e.stderr, /--repo/)
    }
  })
})

const DUPLICATE_BARE_NAME_ROOT = fileURLToPath(new URL('./fixtures/duplicate-bare-name/', import.meta.url))

describe('duplicate bare plugin names', () => {
  // ITEM 2 of the Phase 4a design correction: two enabled ids that share a
  // BARE name (superpowers@marketplace-A and superpowers@marketplace-B) used
  // to collapse in idByName, a bare-name -> single-id Map built from
  // settings.enabledNames/enabledIds — the later id silently won and the
  // other vanished from keepIds, even though proposal.keep/unknown (which
  // count one NAME OCCURRENCE per enabled id, not distinct names) still
  // reported both as kept. 'superpowers' is absent from SIGNALS, so both
  // occurrences land in `unknown` (always kept) regardless of capabilities,
  // making this deterministic.
  it('keeps BOTH ids when two enabled plugins share a bare name, matching what the summary reports as kept', () => {
    const out = execFileSync(
      'node', [HM, 'fix', '--repo', repo, '--root', DUPLICATE_BARE_NAME_ROOT, '--apply'],
      { encoding: 'utf8' }
    )
    // The summary must count both occurrences (2 declined to judge / kept),
    // not silently collapse to 1.
    assert.match(out, /harness-meter: 0 plugin\(s\) to disable, 0 justified, 2 declined to judge/)

    const written = JSON.parse(readFileSync(settings(), 'utf8'))
    assert.deepEqual(written.enabledPlugins, {
      'superpowers@marketplace-A': true,
      'superpowers@marketplace-B': true
    })
  })
})

describe('per-command flag validation', () => {
  // parseArgs accepts every flag for every command, so without a per-command
  // allowlist `hm audit --apply` silently does nothing instead of refusing.
  // `root` here is the per-test copy of fixtures/good/ set up in beforeEach —
  // safe to pass because the flag is rejected before any read is attempted.
  it('rejects --apply on audit', () => {
    const r = run(['audit', '--root', root, '--apply'])
    assert.equal(r.status, 1)
    assert.match(r.stderr, /--apply/)
  })

  // Same shape for `--cap`, which is meaningless on `fix`. `repo` is the
  // per-test mkdtempSync repo dir from beforeEach.
  it('rejects --cap on fix', () => {
    const r = run(['fix', '--repo', repo, '--cap', '5'])
    assert.equal(r.status, 1)
    assert.match(r.stderr, /--cap/)
  })
})

describe('undo envelope warning', () => {
  // The undo envelope (.claude/.hm-undo.json) is a plaintext copy of the
  // prior settings, including any env credentials, and nothing cleans it up
  // except `hm fix --undo`. Warn on the --apply path rather than writing a
  // second, undisclosed file (a .gitignore entry) — see task-2-brief.md
  // Step 5's ruling against that (contradicts ADR-014's diff-before-write
  // rule).
  it('warns about the undo envelope on --apply', () => {
    const out = run('--apply')
    assert.match(out, /\.claude\/\.hm-undo\.json/)
    assert.match(out, /gitignore/i)
  })

  it('does not warn without --apply', () => {
    const out = run()
    assert.equal(/\.hm-undo\.json/.test(out), false)
  })
})
