import { readFileSync, realpathSync } from 'node:fs'
import { join, resolve, dirname, basename } from 'node:path'
import { AdapterMismatch } from './errors.js'
import { redactDeep } from './redact.js'

// Root resolution is Claude Code layout knowledge, so it belongs in the
// adapter. bin/hm.js keeps the os.homedir() call and passes the result in,
// which is what keeps that constraint to one call site.
export function resolveRoot (homeDir) {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homeDir, '.claude')
}

// realpathSync throws ENOENT outright for a path that doesn't exist yet —
// and hm fix's write target (<repo>/.claude/settings.json, frequently even
// <repo>/.claude itself) very often doesn't exist before the first --apply.
// This walks up to the deepest EXISTING ancestor, canonicalizes THAT
// (resolving any symlink or case-folding along the way), and reattaches the
// missing trailing segments unresolved — they can't alias anything real,
// since nothing exists there yet for them to alias. Handles the parent not
// existing either by continuing to walk up.
function realpathOfDeepestExisting (path) {
  let current = resolve(path)
  const missing = []
  for (;;) {
    try {
      // realpathSync.native, not the plain export: the plain (legacy, pure
      // JS) implementation resolves symlinks but does NOT canonicalize case
      // on a case-insensitive filesystem — it echoes back whatever casing
      // was given for any path segment that isn't itself a symlink. Only
      // .native (backed by the real realpath(3) syscall) asks the OS for
      // the segment's actual on-disk name, which is what makes an
      // uppercase-vs-lowercase --repo alias detectable at all.
      const real = realpathSync.native(current)
      return missing.length === 0 ? real : join(real, ...missing)
    } catch (e) {
      if (e.code !== 'ENOENT') throw e
      const parent = dirname(current)
      if (parent === current) throw e // reached the filesystem root; give up honestly
      missing.unshift(basename(current))
      current = parent
    }
  }
}

// ITEM 1 of the Phase 4a design correction: the previous guard
// (assertRepoIsNotHome, now removed) asked "does --repo resolve() to the
// home directory?" via bare string comparison, which never touches the
// filesystem. Two confirmed bypasses: a --repo that
// is a SYMLINK to home (resolve() does not dereference symlinks), and an
// all-uppercase copy of the home path on a case-insensitive filesystem
// (APFS/NTFS defaults) — resolve() does not fold case either. Both let
// `hm fix --apply` write straight into ~/.claude/settings.json.
//
// The human partner ruled that patching the string comparison is the wrong
// fix, because "is --repo the home directory?" is only a PROXY for the real
// risk. The actual invariant: `hm fix` must never write the exact
// settings.json file this invocation would read via loadSettings. That is
// checkable directly against the filesystem — symlink-proof and case-proof,
// since realpathSync is the OS's own answer to "what file is this, really"
// — and it does not require knowing where home is.
export function assertNotSameSettingsFile (configSettingsPath, writeTargetPath) {
  const a = realpathOfDeepestExisting(configSettingsPath)
  const b = realpathOfDeepestExisting(writeTargetPath)
  if (a === b) {
    throw new Error(
      'refusing to write settings: the write target is the same file this ' +
      `run would read settings from (${writeTargetPath})`
    )
  }
}

export function loadSettings (root) {
  const path = join(root, 'settings.json')

  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (e) {
    throw new AdapterMismatch(path, `cannot read settings.json (${e.code})`)
  }

  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    // V8's JSON.parse SyntaxError embeds a ~20-character window of the
    // source document itself (e.g. "Unexpected token 'g', ...\"gho_REALLY\"...
    // is not valid JSON"). Interpolating e.message here would put credential
    // fragments that sit next to a syntax error straight onto stderr,
    // bypassing redactDeep entirely (parsing fails before redaction ever
    // runs). Only the numeric character position is safe to surface — never
    // any substring of the parsed document.
    const m = /position (\d+)/.exec(e.message)
    const detail = m
      ? `settings.json is not valid JSON (at character ${m[1]})`
      : 'settings.json is not valid JSON'
    throw new AdapterMismatch(path, detail)
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AdapterMismatch(path, 'settings.json is not a JSON object')
  }

  if (parsed.enabledPlugins !== undefined) {
    const ep = parsed.enabledPlugins
    if (ep === null || typeof ep !== 'object' || Array.isArray(ep)) {
      // Name the received TYPE, never the value — same lesson as the
      // JSON.parse detail above: types are safe to interpolate, values
      // (and value fragments) are not.
      const received = Array.isArray(ep) ? 'array' : typeof ep
      throw new AdapterMismatch(path, `enabledPlugins must be a plain object or absent (received ${received})`)
    }
  }

  const enabledPlugins = parsed.enabledPlugins ?? {}
  // Every identifier Claude Code actually records is `name@marketplace` — the
  // bare form below exists only for the audit's display purposes. Anything
  // that writes back to settings.json (hm fix's remediation path) must use
  // enabledIds, not enabledNames: round-tripping the bare form loses the
  // marketplace qualifier and the written key then matches nothing. See
  // BLOCKER 1 in the Phase 4a whole-branch review. enabledIds and
  // enabledNames are derived from the same filtered, ordered entry list, so
  // enabledIds[i] is always the qualified form of enabledNames[i].
  const enabledEntries = Object.entries(enabledPlugins).filter(([, on]) => on === true)
  const enabledIds = enabledEntries.map(([id]) => id)
  const enabledNames = enabledIds.map(id => id.split('@')[0])

  return {
    enabledNames,
    enabledIds,
    effortLevel: parsed.effortLevel ?? null,
    // settings.hooks is never emitted to any report (see
    // tests/audit.test.js 'never plumbs raw settings into the audit
    // output'), so redacting it protected nothing while actively breaking
    // hook measurement: redactDeep's tainted-array branch flattens an
    // event's group array to the literal string '<redacted>' whenever the
    // EVENT NAME matches the secret-key pattern (e.g. "AuthRefresh"), and
    // hooks.js's flatten() then reads `group?.hooks ?? []` off that string,
    // silently dropping the whole registration with no throw and no signal.
    // `raw` below stays redacted — this only unredacts the one field that
    // downstream code actually reads.
    hooks: parsed.hooks ?? null,
    raw: redactDeep(parsed)
  }
}
