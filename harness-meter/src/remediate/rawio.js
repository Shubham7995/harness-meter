import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, rmSync, appendFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { AdapterMismatch } from '../adapter/errors.js'

// This module is the ONLY writer in the project, and it deliberately does not
// import the audit adapter's settings loader. That loader's loadSettings()
// returns `raw: redactDeep(parsed)` with the unredacted object discarded —
// round-tripping it to disk would overwrite real credentials with
// <redacted:KEY> placeholders, irreversibly. Everything here works on file TEXT.

const ENVELOPE = '.hm-undo.json'

export function readTextOrNull (path) {
  if (!existsSync(path)) return null
  try {
    return readFileSync(path, 'utf8')
  } catch (e) {
    throw new AdapterMismatch(path, `cannot read settings file (${e.code})`)
  }
}

export function writeTextAtomic (path, text) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.hm-tmp`
  try {
    writeFileSync(tmp, text)
    renameSync(tmp, path)
  } catch (e) {
    rmSync(tmp, { force: true })
    throw new AdapterMismatch(path, `cannot write settings file (${e.code})`)
  }
}

// I5: never overwrites an existing envelope — a second commitFix (without an
// intervening --undo) must not destroy the FIRST saved original, or it
// becomes irrecoverable. Once --undo consumes and deletes the envelope
// (restoreUndo below), the next saveUndo call is free to save a fresh one.
export function saveUndo (dir, settingsPath) {
  const envPath = join(dir, ENVELOPE)
  if (existsSync(envPath)) return
  const text = readTextOrNull(settingsPath)
  writeTextAtomic(envPath, JSON.stringify({
    existed: text !== null,
    text
  }))
}

// Reads and parses the undo envelope without consuming it — used by
// apply.js's planUndo (BLOCKER 3) to compute a preview diff BEFORE
// restoreUndo below performs the actual restore/removal and deletes the
// envelope. restoreUndo's own behavior and error messages are unchanged.
export function loadUndo (dir) {
  const envPath = join(dir, ENVELOPE)
  const raw = readTextOrNull(envPath)
  if (raw === null) {
    throw new AdapterMismatch(envPath, 'nothing to undo — no saved state')
  }
  try {
    return JSON.parse(raw)
  } catch {
    throw new AdapterMismatch(envPath, 'undo envelope is not valid JSON')
  }
}

export function restoreUndo (dir, settingsPath) {
  const envPath = join(dir, ENVELOPE)
  const env = loadUndo(dir)

  if (env.existed) {
    writeTextAtomic(settingsPath, env.text)
  } else {
    rmSync(settingsPath, { force: true })
  }
  rmSync(envPath, { force: true })
  return env.existed ? 'restored' : 'removed'
}

// Phase 4b's session-metrics appender. It lives HERE, rather than becoming a
// second permitted writer in constraints.test.js, deliberately: one choke
// point is the reason every reviewer since Phase 1 could re-establish
// "nothing else writes" by inspection, and this is the highest-frequency
// writer the project has.
//
// Not atomic, and it does not need to be: a single write(2) of a short line
// to a file opened O_APPEND is atomic enough for a metrics log, and
// temp-then-rename cannot append. A torn line loses one session's row; the
// reader (src/metrics/rollup.js) skips unparseable lines by design.
export function appendJsonLine (path, obj) {
  mkdirSync(dirname(path), { recursive: true })
  try {
    // JSON.stringify never emits a literal newline inside a string — it
    // escapes it as \n — so one object is always exactly one line.
    appendFileSync(path, JSON.stringify(obj) + '\n')
  } catch (e) {
    throw new AdapterMismatch(path, `cannot append to metrics log (${e.code})`)
  }
}
