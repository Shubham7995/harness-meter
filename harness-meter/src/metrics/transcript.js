// Aggregates one Claude Code transcript into a flat row of raw counters.
// Pure: takes text, returns numbers, touches no filesystem.
//
// Store RAW FACTS ONLY. Every derived metric (cache read ratio, observation
// tax, cost) is computed at read time, so changing a definition re-derives
// history instead of invalidating it.

const CHARS_PER_TOKEN = 4 // same estimator the prefix scanner uses

// `??` guards null and undefined but NOT type, so `0 + "<string>"` silently
// concatenates: a transcript whose usage counters are strings (a format change,
// a proxy rewriting usage, a hand-edited replay) wrote those raw bytes straight
// into sessions.jsonl and back out of `hm rollup --json`. That is the one path
// by which transcript content could reach the file the README calls safe to
// share — and it degraded every ratio to NaN rather than to the honest
// "unavailable", so the corruption did not even surface as a failure.
const num = v => (Number.isFinite(v) ? v : 0)

// Hook output and the skill/agent/MCP rosters reach the model as `attachment`
// lines rather than as messages, which is why neither has ever appeared in a
// counter here. Two buckets, kept apart on purpose: hook output is a cost the
// user chose by installing a plugin, the roster is the cost `hm audit`
// already models statically. Booking them together would hide which is which.
const HOOK_ATTACHMENTS = new Set(['hook_success', 'hook_additional_context'])
const ROSTER_ATTACHMENTS = new Set([
  'skill_listing',
  'agent_listing_delta',
  'mcp_instructions_delta',
  'deferred_tools_delta'
])

// `content` is a string on hook_success and a LIST of strings on
// hook_additional_context; the roster blocks carry their payload under several
// differently-named keys. Measure length structurally rather than special-casing
// each key, so a renamed field degrades to a smaller number instead of silently
// reading as zero. The text itself is never retained — same rule as
// tool_result observations.
function contentLength (v) {
  if (typeof v === 'string') return v.length
  if (Array.isArray(v)) return v.reduce((n, x) => n + contentLength(x), 0)
  if (v !== null && typeof v === 'object') {
    return Object.values(v).reduce((n, x) => n + contentLength(x), 0)
  }
  return 0
}

export function aggregate (text) {
  const row = {
    inputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    toolCalls: 0,
    toolResults: 0,
    toolErrors: 0,
    observationChars: 0,
    observationTokens: 0,
    hookInjectionChars: 0,
    hookInjections: 0,
    rosterChars: 0,
    assistantTurns: 0,
    skippedLines: 0
  }

  // Claude Code writes ONE JSONL LINE PER CONTENT BLOCK of a single assistant
  // API message, and repeats that message's whole `usage` object identically on
  // every one of those lines. Summing usage per line therefore multiply-counts
  // every token counter. Measured on a real 7,112-line transcript: 3,695
  // distinct message ids, 2,244 of them spanning more than one line (worst: 18),
  // and 3,417 repeat lines carrying byte-identical usage with ZERO differing —
  // total input inflated 1.88x, 4.13B claimed against 2.19B actual.
  //
  // So usage is counted ONCE per message id, while content blocks stay counted
  // per line: each line carries a DIFFERENT block (thinking, then text, then
  // tool_use...), so per-line counting is exactly right for toolCalls and would
  // be wrong if deduplicated. The two must not be conflated.
  //
  // A message with no id cannot be deduplicated, so it is counted — undercounting
  // a real turn is worse than the double-count this guards against.
  const countedMessages = new Set()

  for (const line of text.split('\n')) {
    if (line === '') continue
    let r
    try {
      r = JSON.parse(line)
    } catch {
      // A torn final line (the appender is not atomic) or a format change
      // must not lose the whole session. Count it and move on.
      row.skippedLines++
      continue
    }
    if (r?.type === 'assistant') {
      const id = r?.message?.id
      const firstSeen = id === undefined || id === null || !countedMessages.has(id)
      if (id !== undefined && id !== null) countedMessages.add(id)

      // A turn is an API message, not a line. Guide Load Efficiency multiplies
      // by this, so counting lines rather than messages would skew it.
      if (firstSeen) row.assistantTurns++

      const u = r?.message?.usage
      if (u && firstSeen) {
        row.inputTokens += num(u.input_tokens)
        row.cacheCreationTokens += num(u.cache_creation_input_tokens)
        row.cacheReadTokens += num(u.cache_read_input_tokens)
        row.outputTokens += num(u.output_tokens)
      }
      for (const c of r?.message?.content ?? []) {
        if (c?.type === 'tool_use') row.toolCalls++
      }
    } else if (r?.type === 'user') {
      for (const c of r?.message?.content ?? []) {
        if (c?.type !== 'tool_result') continue
        row.toolResults++
        if (c.is_error) row.toolErrors++
        // Length only. The content itself is never stored, never returned,
        // and never logged — it is arbitrary file and command output and
        // routinely contains secrets.
        row.observationChars += JSON.stringify(c.content ?? '').length
      }
    } else if (r?.type === 'attachment') {
      const a = r?.attachment
      const kind = a?.type
      if (HOOK_ATTACHMENTS.has(kind)) {
        // Length only, never the text. `content` is the field the model
        // actually receives; `stdout` duplicates it on hook_success and is
        // deliberately not added, or every such hook would count twice.
        const chars = contentLength(a.content)
        row.hookInjectionChars += chars
        // A hook that emitted nothing did not inject. Most PreToolUse and
        // PostToolUse hooks are silent, and counting them would make a
        // tool-heavy session read as context-heavy.
        if (chars > 0) row.hookInjections++
      } else if (ROSTER_ATTACHMENTS.has(kind)) {
        // Everything except the discriminator, which is this tool's own label
        // for the block rather than anything the model was charged for.
        for (const [k, v] of Object.entries(a)) {
          if (k !== 'type') row.rosterChars += contentLength(v)
        }
      }
      // An unrecognised attachment type is left alone rather than guessed at.
    }
  }

  row.observationTokens = Math.round(row.observationChars / CHARS_PER_TOKEN)
  return row
}
