import { aggregate } from './transcript.js'

export const SCHEMA_VERSION = 1

// `readText` and `now` are injected so this is testable without a filesystem
// or a clock. bin/hm-record.js supplies the real ones.
export function buildRow (payload, readText, now) {
  let text = ''
  try {
    if (payload?.transcript_path) text = readText(payload.transcript_path)
  } catch {
    // An unreadable transcript yields a zeroed row, not a failure. A metrics
    // hook must never be the reason a session ends badly.
  }

  // NOTE what is absent: transcript_path, cwd, and every byte of content.
  // The row is counters plus an opaque session id. Adding a path here would
  // put the user's directory layout into a file they may share.
  return {
    v: SCHEMA_VERSION,
    ts: now,
    session: payload?.session_id ?? null,
    reason: payload?.reason ?? null,
    ...aggregate(text)
  }
}
