export function toJson (findings, meta, plugins = []) {
  const cap = meta.cap ?? 15

  const byScanner = {}
  for (const f of findings) byScanner[f.scanner] = (byScanner[f.scanner] ?? 0) + 1

  const unmeasurable = []
  for (const p of plugins) {
    for (const d of [...p.skills, ...p.agents]) {
      if (!d.measurable) unmeasurable.push(`${p.name}/${d.name}`)
    }
  }

  return {
    generatedAt: meta.generatedAt,
    root: meta.root,
    totalTokens: findings.reduce((n, f) => n + f.tokens, 0),
    findingCount: findings.length,
    byScanner,
    findings: findings.slice(0, cap),
    unmeasurable
  }
}
