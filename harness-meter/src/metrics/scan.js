import { readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { aggregate } from './transcript.js'
import { SCHEMA_VERSION } from './record.js'

// Reads the transcripts Claude Code has ALREADY written, instead of waiting for
// the SessionEnd hook to record new ones. Same counters, same row shape, no
// setup and no waiting — which matters when the question is "is my gateway
// breaking prompt caching", and the answer is sitting in files on disk.
//
// Rows are stamped at the CURRENT schema version, not below it. A scanned row
// genuinely carries injection counters, because the attachment records are
// right there in the transcript; stamping it lower would exclude it from the
// injected-context denominator and report "unavailable" for something this
// scan actually measured.

// PRIVACY: the path is used to READ and is never carried into a row. A
// transcript path contains the project directory — on a work machine that is
// the employer's and the client's project names — and the row is written into
// a file the README calls safe to share. The session id is synthetic for the
// same reason: the real one is the filename.
export function scanTranscripts (paths, readText) {
  const rows = []
  let n = 0
  for (const path of paths) {
    let text
    try {
      text = readText(path)
    } catch {
      // An unreadable transcript is one lost session, not a failed scan.
      continue
    }
    const counters = aggregate(text)
    // A transcript with no assistant turn contributes nothing and would drag
    // every per-session average toward zero if counted as a session.
    if (counters.assistantTurns === 0) continue
    rows.push({
      v: SCHEMA_VERSION,
      ts: null,
      session: `scan-${++n}`,
      reason: 'scan',
      ...counters
    })
  }
  return rows
}

// Claude Code stores transcripts at <root>/projects/<encoded-cwd>/<uuid>.jsonl.
export function listTranscripts (root) {
  const base = join(root, 'projects')
  if (!existsSync(base)) return []
  const out = []
  let projects
  try {
    projects = readdirSync(base, { withFileTypes: true })
  } catch {
    return []
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const dir = join(base, project.name)
    let entries
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }
    for (const name of entries) {
      if (name.endsWith('.jsonl')) out.push(join(dir, name))
    }
  }
  return out.sort()
}
