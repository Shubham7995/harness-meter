#!/usr/bin/env node
// bin/hm.js — CLI entry point for `hm audit` and `hm fix`, per
// task-6-brief.md Step 4 and task-5-brief.md (Phase 4a remediation).
//
// tests/audit.test.js 'emits JSON on --json' asserts
// `typeof JSON.parse(out).totalTokens === 'number'` against a REAL audit of the
// GOOD fixture, so the stubbed `{ totalTokens: 0 }` from the earlier TDD step
// must now be replaced by the actual runAudit(root, ...) result — the stub only
// ever coincidentally satisfied the `typeof` check.
//
// tests/audit.test.js 'exits 2 on AdapterMismatch' is preserved unchanged below.
import { homedir } from 'node:os'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { runAudit } from '../src/audit.js'
import { AdapterMismatch } from '../src/adapter/errors.js'
import { resolveRoot, loadSettings, assertNotSameSettingsFile } from '../src/adapter/config.js'
import { redactDiffText } from '../src/adapter/redact.js'
import { inferCapabilities } from '../src/remediate/repo.js'
import { proposeProfile } from '../src/remediate/profile.js'
import { applyFix, commitFix, undoFix, planUndo } from '../src/remediate/apply.js'
import { rollup } from '../src/metrics/rollup.js'
import { scanTranscripts, listTranscripts } from '../src/metrics/scan.js'
import { renderMetrics } from '../src/report/metrics.js'

// homedir() default-root resolution: this is the project's one and only
// permitted os.homedir() call (see task-6-brief.md constraints); no module
// under src/ may call it, so it must live here in defaultRoot(). The actual
// layout knowledge (env override, join with '.claude') lives in
// resolveRoot(), which is adapter code and takes the home directory in.
function defaultRoot () {
  return resolveRoot(homedir())
}

function parseArgs (argv) {
  const args = { command: argv[0] ?? 'help', json: false, root: null, cap: null, repo: null, apply: false, undo: false, includeFixtures: false, transcripts: false }
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--json') args.json = true
    else if (argv[i] === '--transcripts') args.transcripts = true
    else if (argv[i] === '--apply') args.apply = true
    else if (argv[i] === '--undo') args.undo = true
    else if (argv[i] === '--include-fixtures') args.includeFixtures = true
    else if (argv[i] === '--root') {
      const raw = argv[++i]
      // A missing value (trailing --root) or a value that is itself another
      // flag (--root --json swallowing --json as the path) must not fall
      // through to `args.root ?? defaultRoot()` and silently audit the real
      // ~/.claude. Never interpolate `raw` — same rule as --cap below.
      if (raw === undefined || raw.startsWith('--')) {
        throw new Error('--root requires a path value')
      }
      args.root = raw
    } else if (argv[i] === '--repo') {
      const raw = argv[++i]
      // Same shape as --root above: a missing or flag-shaped value must not
      // silently fall through to `args.repo ?? process.cwd()`. Never
      // interpolate `raw` itself — same rule as --cap below.
      if (raw === undefined || raw.startsWith('--')) {
        throw new Error('--repo requires a path value')
      }
      args.repo = raw
    } else if (argv[i] === '--cap') {
      const raw = argv[++i]
      // Never interpolate `raw` itself into this message: a CLI argument can
      // be anything, including a pasted secret. Only its type is safe to log
      // (see task-6-brief.md's credential-leak note on Phase 1 Blocker 1).
      if (!/^\d+$/.test(raw ?? '')) {
        throw new Error(`--cap requires a non-negative integer, received: ${typeof raw}`)
      }
      args.cap = Number(raw)
    } else if (argv[i].startsWith('--')) {
      // Flag names are safe to interpolate; values are not (see the --cap
      // note above) — this branch only ever sees the flag token itself.
      throw new Error(`unknown option: ${argv[i]}`)
    }
  }
  return args
}

function runAuditCmd (args) {
  const result = runAudit(args.root ?? defaultRoot(), new Date().toISOString(), args.cap)
  process.stdout.write(
    args.json ? JSON.stringify(result.json, null, 2) + '\n' : result.markdown
  )
}

// Reads `<root>/harness-meter/sessions.jsonl`, parsing each line and
// skipping the ones that don't parse — same tolerance
// src/metrics/transcript.js applies to a single torn line in a transcript
// (the appender, appendJsonLine in src/remediate/rawio.js, is not atomic). A
// missing log file is rows = [], not an error: rollup() must render sensibly
// before the SessionEnd hook has ever fired.
function readSessionRows (logPath) {
  if (!existsSync(logPath)) return []
  let text
  try {
    text = readFileSync(logPath, 'utf8')
  } catch {
    // An unreadable log — a directory at that path, bad permissions, a
    // vanished file — must not crash the rollup. The uncaught version exited 1
    // and dumped a stack trace INCLUDING the log's absolute path to stderr.
    // Treating it as no sessions is the same answer a missing file gets.
    return []
  }
  const rows = []
  for (const line of text.split('\n')) {
    if (line === '') continue
    try {
      rows.push(JSON.parse(line))
    } catch {
      // A torn final line (the appender is not atomic) must not lose the
      // whole rollup — skip it and move on.
    }
  }
  return rows
}

function runRollup (args) {
  const configRoot = args.root ?? defaultRoot()
  // --transcripts reads the transcripts Claude Code has already written,
  // instead of the log the SessionEnd hook appends to. Same counters, no setup
  // and no waiting for new sessions — the difference between diagnosing a
  // cache regression today and diagnosing it next week.
  const rows = args.transcripts
    ? scanTranscripts(listTranscripts(configRoot), p => readFileSync(p, 'utf8'))
    : readSessionRows(join(configRoot, 'harness-meter', 'sessions.jsonl'))

  // Guide Load Efficiency needs the measured prefix size, which only
  // `hm audit` knows how to compute. Re-running the real scanners here (not
  // reusing a cached figure — there is nowhere to cache one) keeps rollup()
  // honest about what "the prefix" means: whatever audit would report right
  // now, not a stale snapshot from whenever the plugin set last changed.
  //
  // On a fresh install there is no settings.json yet, so runAudit() throws
  // AdapterMismatch — that must not crash the rollup, which readSessionRows
  // above already promises to render sensibly before any hook has fired. A
  // failed audit yields prefixTokens = null (unavailable), not a crash — same
  // unmeasurable-vs-zero rule every other ratio here follows. Anything other
  // than AdapterMismatch is a genuine bug elsewhere and must still surface.
  let prefixTokens = null
  try {
    const audit = runAudit(configRoot, new Date().toISOString())
    prefixTokens = audit.findings
      .filter(f => f.scanner === 'prefix')
      .reduce((n, f) => n + f.tokens, 0)
  } catch (e) {
    if (!(e instanceof AdapterMismatch)) throw e
  }
  const result = rollup(rows, { prefixTokens })

  // Same --json/markdown branch shape as runAuditCmd above.
  process.stdout.write(
    args.json ? JSON.stringify(result, null, 2) + '\n' : renderMetrics(result)
  )
}

function runFix (args) {
  const repoRoot = args.repo ?? process.cwd()
  const configRoot = args.root ?? defaultRoot()
  const writeTargetPath = join(repoRoot, '.claude', 'settings.json')

  // ITEM 1 of the Phase 4a design correction: the old assertRepoIsNotHome
  // asked "is --repo the home directory?" via bare resolve()'d string
  // comparison — a symlinked or case-folded --repo defeated it (verified
  // both ways; see tests/config.test.js). The real invariant is narrower and
  // filesystem-checkable: hm fix must never write the exact settings.json
  // file loadSettings would read. Checked against BOTH the default config
  // root (defaultRoot() — what gets read in ordinary usage, where --root is
  // never passed, so this is almost always the user's real
  // ~/.claude/settings.json) and the config root actually in effect this
  // run (the same value unless --root was explicitly overridden, which
  // matters when a test or a custom setup points --root elsewhere while
  // --repo still aliases the real home directory). Both calls throw before
  // any read or write.
  assertNotSameSettingsFile(join(defaultRoot(), 'settings.json'), writeTargetPath)
  assertNotSameSettingsFile(join(configRoot, 'settings.json'), writeTargetPath)

  if (args.undo) {
    // BLOCKER 3: print the diff of what undo is about to do BEFORE acting,
    // in the same invocation — matching --apply's print-then-write shape.
    const preview = planUndo(repoRoot)
    // DISPLAY path — redact. The write path uses the undo envelope's verbatim
    // text and must never see redactDiffText's output.
    process.stdout.write(preview.diff === '' ? '(no change)\n' : redactDiffText(preview.diff) + '\n')
    const outcome = undoFix(repoRoot)
    process.stdout.write(`\nharness-meter: settings ${outcome}\n`)
    return
  }

  const settings = loadSettings(configRoot)
  const capabilities = inferCapabilities(repoRoot, { includeFixtures: args.includeFixtures })
  const proposal = proposeProfile(settings.enabledNames, capabilities)

  // BLOCKER 1: proposeProfile reasons over bare names (SIGNALS is keyed by
  // bare name), but the write path needs the qualified name@marketplace
  // form or the written key matches nothing real.
  //
  // ITEM 2 of the Phase 4a design correction: this used to reverse-map each
  // bare name back to a qualified id via a bare-name -> single-id Map
  // (`new Map(settings.enabledNames.map((name, i) => [name, enabledIds[i]]))`).
  // Two enabled ids sharing a bare name (e.g. azure@marketplace-A and
  // azure@marketplace-B) collapsed there: the Map keeps only the LAST
  // insertion for a repeated key, so one id silently vanished from keepIds
  // while proposal.keep/unknown — which push one entry per enabled id, not
  // per distinct name — still counted both as kept. Filtering the ORIGINAL,
  // index-aligned enabledIds/enabledNames directly avoids ever constructing
  // that lossy Map: every enabled id whose bare name was decided to be kept
  // survives, independent of how many OTHER ids happen to share that name.
  const keepNames = new Set([...proposal.keep, ...proposal.unknown])
  const keepIds = settings.enabledIds.filter((id, i) => keepNames.has(settings.enabledNames[i]))
  const plan = applyFix(repoRoot, keepIds)

  process.stdout.write(
    `harness-meter: ${proposal.drop.length} plugin(s) to disable, ` +
    `${proposal.keep.length} justified, ${proposal.unknown.length} declined to judge\n\n`
  )
  if (proposal.unknown.length > 0) {
    process.stdout.write(`declined to judge (kept): ${proposal.unknown.join(', ')}\n\n`)
  }
  // DISPLAY path — redact. commitFix below writes plan.after, which is
  // deliberately untouched: redacting what gets WRITTEN would replace real
  // credentials with placeholders, irreversibly.
  process.stdout.write(plan.diff === '' ? '(no change)\n' : redactDiffText(plan.diff) + '\n')

  if (args.apply) {
    commitFix(repoRoot, plan)
    // I5: commitFix keeps the FIRST saved envelope — a second --apply run
    // before undoing does not update what undo restores to. Say that
    // plainly here rather than letting "undo with: hm fix --undo" imply
    // undo always reverts the most recent apply.
    process.stdout.write(
      `\nwritten: ${plan.settingsPath}\n` +
      'undo with: hm fix --undo (restores the file to how it was before your ' +
      'first --apply since the last undo; re-running --apply again before ' +
      'undoing does not change what undo restores to)\n'
    )
    // Step 5 of task-2-brief.md: the undo envelope (.claude/.hm-undo.json,
    // written by commitFix) holds a PLAINTEXT copy of the prior settings,
    // including any env credentials, and nothing cleans it up except
    // `hm fix --undo`. Ruling: warn, do not write a second, undisclosed file
    // (e.g. auto-appending to .gitignore) — that would contradict ADR-014's
    // diff-before-write rule, since `hm fix` may only write what its printed
    // diff showed. The warning carries the same information without writing
    // anything.
    process.stdout.write(
      '\nnote: .claude/.hm-undo.json now holds a plaintext copy of your previous settings,\n' +
      '      including any env values, until you run `hm fix --undo`. Add it to .gitignore\n' +
      '      if .claude/ is tracked.\n'
    )
  } else {
    process.stdout.write('\nnothing written. re-run with --apply to write.\n')
  }
}

// parseArgs accepts every flag for every command; without this, `hm audit
// --apply` silently does nothing and `hm fix --cap 5` silently ignores the
// cap. Interpolate only the flag NAME — never a value (Global Constraint 3).
const ALLOWED = {
  audit: ['--json', '--root', '--cap'],
  fix: ['--repo', '--root', '--apply', '--undo', '--include-fixtures'],
  rollup: ['--json', '--root', '--transcripts']
}
function assertFlagsAllowed (command, argv) {
  const allowed = ALLOWED[command]
  if (allowed === undefined) return
  for (const tok of argv) {
    if (tok.startsWith('--') && !allowed.includes(tok)) {
      throw new Error(`${tok} is not valid for \`hm ${command}\``)
    }
  }
}

function main () {
  const args = parseArgs(process.argv.slice(2))
  // process.argv is [node, script, command, ...flags]; slice(3) excludes the
  // command word itself so assertFlagsAllowed only sees flag tokens.
  assertFlagsAllowed(args.command, process.argv.slice(3))

  if (args.command === 'audit') {
    runAuditCmd(args)
    return
  }

  if (args.command === 'fix') {
    runFix(args)
    return
  }

  if (args.command === 'rollup') {
    runRollup(args)
    return
  }

  process.stdout.write('usage: hm audit [--json] [--root PATH] [--cap N]\n       hm fix [--repo PATH] [--root PATH] [--include-fixtures] [--apply] [--undo]\n       hm rollup [--json] [--root PATH] [--transcripts]\n')
  process.exit(args.command === 'help' ? 0 : 1)
}

try {
  main()
} catch (e) {
  // tests/audit.test.js 'exits 2 on AdapterMismatch': distinct from the
  // generic exit(1) path, per task-6-brief.md Step 4 exit-code contract.
  // undoFix() throws this same error type when there is nothing to undo
  // (tests/fix-cli.test.js 'exits 2 when there is nothing to undo'), so this
  // one catch handles both commands' mismatch conditions.
  if (e instanceof AdapterMismatch) {
    process.stderr.write(`${e.message}\n`)
    process.exit(2)
  }
  process.stderr.write(`${e.stack}\n`)
  process.exit(1)
}
