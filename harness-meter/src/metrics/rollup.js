// Derives tier-5 metrics from stored raw rows. Nothing here is persisted:
// change a definition and re-run, and the whole history re-derives.

const CACHE_READ_TARGET = 0.90

// Guards the ROW and the VALUE, not just null/undefined. `a + (r[k] ?? 0)`
// concatenated on a string-typed counter (the same defect fixed in
// transcript.js) and crashed outright on a log line that is valid JSON but not
// an object — a bare string or number, which readSessionRows admits. The log
// is append-only and may be hand-edited or torn mid-write; one bad row must
// degrade that row, never the whole report.
const sum = (rows, k) => rows.reduce((a, r) => {
  const v = (r !== null && typeof r === 'object') ? r[k] : undefined
  return a + (Number.isFinite(v) ? v : 0)
}, 0)

// Every ratio returns null rather than 0 when its denominator is zero.
// A zero here would read as a real measurement — "the cache never hit",
// "no observations" — when the truth is that nothing was measured. Same
// unmeasurable-vs-zero rule the audit reports follow.
const ratio = (num, den) => (den === 0 ? null : num / den)

export function rollup (rows, opts = {}) {
  const cacheRead = sum(rows, 'cacheReadTokens')
  const cacheCreate = sum(rows, 'cacheCreationTokens')
  const input = sum(rows, 'inputTokens')
  const output = sum(rows, 'outputTokens')
  const obs = sum(rows, 'observationTokens')
  const results = sum(rows, 'toolResults')
  const errors = sum(rows, 'toolErrors')
  const turns = sum(rows, 'assistantTurns')

  const totalInput = cacheRead + cacheCreate + input
  const cacheReadRatio = ratio(cacheRead, totalInput)

  // Guide Load Efficiency: what share of everything the model read was the
  // fixed prefix it re-reads every turn. Needs the measured prefix size from
  // `hm audit`; without it the metric is unavailable, not zero.
  // A prefix of 0 means the audit ran but found nothing to measure, which is
  // "unavailable", not "the prefix costs nothing". Treating it as a real zero
  // rendered Guide Load Efficiency as a measured 0.0% — the exact
  // unmeasurable-vs-zero confusion every other ratio here avoids.
  const rawPrefix = opts.prefixTokens
  const prefixTokens = Number.isFinite(rawPrefix) && rawPrefix > 0 ? rawPrefix : null
  const guideLoadEfficiency = prefixTokens === null
    ? null
    : ratio(prefixTokens * turns, totalInput)

  return {
    sessions: rows.length,
    turns,
    totalInput,
    outputTokens: output,
    cacheReadRatio,
    cacheReadBelowTarget: cacheReadRatio !== null && cacheReadRatio < CACHE_READ_TARGET,
    // Observation-to-Action Ratio: for every token the agent WROTE, how many
    // tokens of tool output did it READ. Bounded on both sides — near-zero
    // means acting without looking; very high means drowning in output it did
    // not need.
    //
    // Deliberately involves NO cache accounting. Two earlier denominators both
    // failed the same way, and the second failure is why this is a ratio of
    // observation to OUTPUT rather than to input at all:
    //
    //   obs / (cacheRead + cacheCreate + input) — cache reads replay the whole
    //     conversation every turn, so this collapsed toward 0 for any long
    //     session. Measured 0.015% on a 3,695-turn transcript.
    //   obs / (cacheCreate + input) — better, still degenerate: cache-TTL
    //     re-creation dominates the denominator for long sessions. Measured
    //     across four real transcripts it ran 27.8% at 336 turns down to 1.5%
    //     at 3,695 — an 18x spread still tracking session length, not
    //     behaviour.
    //
    // Both numerator and denominator here are counted once per message (see
    // transcript.js's per-message-id dedupe), neither is a cache replay, and
    // the same four transcripts span only 0.18x-0.45x — a range that reflects
    // how read-heavy the work actually was.
    observationToActionRatio: ratio(obs, output),
    failureSpendRatio: ratio(errors, results),
    guideLoadEfficiency,

    // GOVERNANCE (Global Constraint 9): cost is a single object holding BOTH
    // numbers, so a caller cannot destructure a bare cost figure out of it
    // without also seeing that task success is unavailable. A harness
    // optimised on cost alone under-explores and returns confidently wrong
    // answers cheaply. harness-meter has no task-outcome sensor, so this is
    // null in ordinary use — and the cost figure is null with it.
    //
    // taskSuccessRate is taken from opts so the pairing is REACHABLE and
    // testable: a caller that genuinely has an outcome signal passes it and
    // gets a figure. Hard-coding null here would make the paired branch dead
    // code, and a rule enforced only by unreachable code is not enforced.
    cost: costWithSuccess(output, rows.length, opts.taskSuccessRate ?? null)
  }
}

// Named for what it actually computes. The previous version was called "cost
// per mission" while its `missions` parameter was bound to assistantTurns and
// its numerator ignored input and cache tokens entirely — so it was neither a
// mission count nor a cost. A SESSION is the closest thing to a mission this
// tool can observe, and output tokens are what it can actually count; pricing
// belongs to whoever knows the rate card, not here.
//
// The pairing rule is unchanged and is the point of the shape: the figure is
// emitted only alongside a task success rate, so a caller cannot destructure a
// bare cost number without also seeing that success is unavailable.
function costWithSuccess (outputTokens, sessions, taskSuccessRate) {
  if (taskSuccessRate === null) return { outputTokensPerSession: null, taskSuccessRate: null }
  return { outputTokensPerSession: ratio(outputTokens, sessions), taskSuccessRate }
}
