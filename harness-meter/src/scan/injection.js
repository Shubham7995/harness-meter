// Hooks on these events return `hookSpecificOutput.additionalContext`, which
// Claude Code places in the model's context window. That text is a recurring
// per-session (or per-turn) input cost that `scanPrefix` cannot see: prefix
// cost is measured by reading skill and agent `description` frontmatter, and a
// hook's contribution exists only in whatever its command prints at runtime.
//
// The list is deliberately the events whose documented purpose includes adding
// context, not every event that can influence a turn. Stop and PreToolUse can
// put a *reason* string in front of the model when they block, but that is a
// conditional failure path rather than a standing per-session charge, and
// guessing wider would report cost where there is none. An unlisted event is
// not judged — the same posture `hm fix` takes toward unknown plugins.
export const INJECTING_EVENTS = new Set([
  'SessionStart',
  'SubagentStart',
  'UserPromptSubmit'
])

// SECURITY: findings name the source and the event only. The hook command is
// read to classify nothing here, and must never reach a finding — it can carry
// a credential inline, which redaction cannot catch mid-string. Same rule as
// scan/mutation.js.
export function scanInjection (registrations) {
  const events = new Map()

  for (const r of registrations) {
    if (!INJECTING_EVENTS.has(r.event)) continue
    if (!events.has(r.source)) events.set(r.source, new Set())
    events.get(r.source).add(r.event)
  }

  return [...events].map(([source, seen]) => {
    // Set preserves insertion order, which follows registration order and would
    // make the remedy text vary with manifest key order. Sort for a stable
    // report — an audit that reads differently between identical runs is the
    // defect scan/mutation.js exists to catch.
    const names = [...seen].sort().join(', ')
    return {
      id: `injection/${source}`,
      scanner: 'injection',
      subject: source,
      // Never an estimate. json.js sums `tokens` into totalTokens without
      // discrimination, so any guess here would be laundered into a measured
      // figure. This cost is real and unknown; zero is the only honest value
      // that keeps it out of the total.
      tokens: 0,
      severity: 'warn',
      confidence: 1.0,
      risk: 1,
      remedy: `Injects context into every session via ${names} — size is not statically knowable and is NOT included in the total above`
    }
  })
}
