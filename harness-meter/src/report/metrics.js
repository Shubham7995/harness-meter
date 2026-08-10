const pct = v => (v === null ? 'unavailable' : `${(v * 100).toFixed(1)}%`)

export function renderMetrics (r) {
  const lines = [
    '# harness-meter — session metrics',
    '',
    `sessions: ${r.sessions}   assistant turns: ${r.turns}`,
    '',
    '| metric | value | target |',
    '|---|---|---|',
    `| Cache Read Ratio | ${pct(r.cacheReadRatio)}${r.cacheReadBelowTarget ? ' ⚠️' : ''} | ≥ 90% |`,
    // Rendered as a multiplier, not a percentage: it is tokens-read per
    // token-written, which routinely exceeds 1 and is not a share of anything.
    `| Observation-to-Action | ${r.observationToActionRatio === null ? 'unavailable' : r.observationToActionRatio.toFixed(2) + 'x'} | bounded — near-zero means acting without looking |`,
    `| Failure Spend Ratio | ${pct(r.failureSpendRatio)} | lower |`,
    `| Guide Load Efficiency | ${pct(r.guideLoadEfficiency)} | lower |`,
    '',
    '## Cost',
    '',
    // Never a bare cost number. See rollup.js's governance note.
    `- Output tokens per session: ${r.cost.outputTokensPerSession === null ? 'unavailable' : Math.round(r.cost.outputTokensPerSession).toLocaleString()}`,
    `- Task success rate: ${r.cost.taskSuccessRate === null ? 'unavailable' : pct(r.cost.taskSuccessRate)}`,
    ''
  ]
  const inj = r.injectedContext
  const tok = v => (v === null ? 'unavailable' : Math.round(v).toLocaleString())
  lines.push(
    '## Injected context',
    '',
    'What the fixed overhead actually cost, observed in the transcript rather',
    'than estimated from frontmatter. `hm audit` measures the roster statically;',
    'these are the bytes the model was handed.',
    '',
    `- Hook output per session: ${tok(inj.hookTokensPerSession)} tokens across ${tok(inj.hookInjectionsPerSession)} injections`,
    `- Roster per session: ${tok(inj.rosterTokensPerSession)} tokens (skills, agents, MCP instructions, deferred tools)`,
    `- Measured over: ${inj.sessionsMeasured} of ${r.sessions} recorded session(s)`,
    ''
  )
  if (inj.sessionsMeasured < r.sessions) {
    // Absent is not zero. Sessions recorded before schema 2 carry no injection
    // counters at all, and averaging them in as zeroes would understate a real
    // cost — the failure mode this whole section exists to correct.
    lines.push(
      `${r.sessions - inj.sessionsMeasured} session(s) predate these counters and are excluded, not counted as zero.`,
      ''
    )
  }

  if (r.cost.taskSuccessRate === null) {
    lines.push(
      'Output tokens per session is withheld because task success rate is unavailable.',
      'A cost figure without an outcome figure rewards a harness for failing cheaply.',
      ''
    )
  }
  if (r.sessions === 0) {
    // Do NOT point at `hm rollup --help`: it is not a supported invocation and
    // exits 1 with a raw stack trace. Name the file that actually explains it.
    lines.push('No sessions recorded yet. Wire the SessionEnd hook — see README.md, "hm rollup and the SessionEnd hook".', '')
  }
  return lines.join('\n')
}
