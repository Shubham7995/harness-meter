#!/usr/bin/env node
// SessionEnd hook. Appends one JSON line per session to
// <root>/harness-meter/sessions.jsonl.
//
// THE GOVERNING RULE: this process exits 0 no matter what happens. A metrics
// hook that breaks a session for a number nobody asked for is worse than no
// metrics. Every failure path — unreadable transcript, unwritable log,
// malformed payload, a bug in this file — ends in exit 0 and silence.
//
// Nothing is written to stdout: a SessionEnd hook's stdout can be injected
// into context, and this has nothing to say to the model.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { buildRow } from '../src/metrics/record.js'
import { appendJsonLine } from '../src/remediate/rawio.js'
import { resolveRoot } from '../src/adapter/config.js'

function main () {
  let payload = {}
  try {
    payload = JSON.parse(readFileSync(0, 'utf8'))
  } catch {
    payload = {} // malformed stdin still produces a row: the session happened
  }
  // Must resolve the root exactly as `hm rollup` does, via resolveRoot, which
  // honours CLAUDE_CONFIG_DIR. Hardcoding join(homedir(), '.claude') here meant
  // that for anyone who has relocated their Claude config the hook wrote to a
  // file rollup never reads — metrics collected forever and never reported,
  // with no error on either side. HM_ROOT stays as the test override and keeps
  // highest precedence.
  // `||` not `??`: an EMPTY HM_ROOT must be treated as unset. With `??` it
  // fell through as a valid root and the hook wrote harness-meter/sessions.jsonl
  // into whatever directory the session happened to be running in.
  const root = process.env.HM_ROOT || resolveRoot(homedir())
  const row = buildRow(payload, p => readFileSync(p, 'utf8'), new Date().toISOString())
  appendJsonLine(join(root, 'harness-meter', 'sessions.jsonl'), row)
}

try {
  main()
} catch {
  // Deliberately empty. See the rule above.
}
process.exit(0)
