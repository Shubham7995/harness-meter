export function estimateTokens (bytes) {
  return Math.round(bytes / 4)
}

const WARN_AT_TOKENS = 500

export function scanPrefix (plugins) {
  return plugins
    .map(p => {
      const bytes =
        p.skills.reduce((n, s) => n + s.descriptionBytes, 0) +
        p.agents.reduce((n, a) => n + a.descriptionBytes, 0)
      return { plugin: p, tokens: estimateTokens(bytes) }
    })
    .filter(({ tokens }) => tokens > 0)
    .map(({ plugin, tokens }) => ({
      id: `prefix/${plugin.name}`,
      scanner: 'prefix',
      subject: plugin.name,
      tokens,
      severity: tokens >= WARN_AT_TOKENS ? 'warn' : 'info',
      confidence: 1.0,
      risk: 3,
      remedy: `Disable ${plugin.name} in repositories with no evidence of needing it`
    }))
}
