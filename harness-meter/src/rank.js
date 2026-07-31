// Severity leads the ordering because scanners disagree about magnitude.
// Prefix findings measure tokens; mutation findings carry tokens: 0 and
// express cost as cache invalidation. Ranking on score alone would bury a
// cache-breaking error under a 1-token info finding.
const SEVERITY_RANK = { error: 0, warn: 1, info: 2 }

export function rankScore (finding) {
  if (finding.risk === 0) return 0
  return (finding.tokens * finding.confidence) / finding.risk
}

export function rank (findings) {
  return [...findings].sort((a, b) =>
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
    rankScore(b) - rankScore(a) ||
    a.id.localeCompare(b.id)
  )
}
