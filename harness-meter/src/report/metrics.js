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
