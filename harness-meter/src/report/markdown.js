import { toJson } from './json.js'

const n = (x) => x.toLocaleString('en-US')

const SECTIONS = [
  { scanner: 'prefix', title: 'Prefix cost', blurb: 'Metadata replayed in every request.' },
  { scanner: 'mutation', title: 'Cache stability', blurb: 'Configuration that varies between otherwise-identical requests.' }
]

function unmeasuredSection (data) {
  if (data.unmeasurable.length === 0) return []
  return [
    '## Not measured',
    '',
    'These files have no readable frontmatter description. Their real token',
    'cost is unknown and is not included in any total reported here.',
    '',
    ...data.unmeasurable.map(u => `- ${u}`),
    ''
  ]
}

export function toMarkdown (findings, meta, plugins = []) {
  const data = toJson(findings, { ...meta, cap: Infinity }, plugins)

  const out = [
    '# harness-meter audit',
    '',
    `*Root: \`${data.root}\` · Generated: ${data.generatedAt}*`,
    ''
  ]

  if (data.findingCount === 0) {
    out.push(
      'No findings. This is a measured zero — the adapter read the installation',
      'successfully and found nothing to report.',
      ''
    )
    out.push(...unmeasuredSection(data))
    return out.join('\n')
  }

  out.push(`**Total token cost: ~${n(data.totalTokens)} tokens, every request.**`, '')

  for (const section of SECTIONS) {
    const rows = data.findings.filter(f => f.scanner === section.scanner)
    if (rows.length === 0) continue
    out.push(
      `## ${section.title}`,
      '',
      section.blurb,
      '',
      '| Subject | ~tokens | Severity | Remedy |',
      '|---|---:|---|---|',
      ...rows.map(f =>
        `| ${f.subject} | ${f.tokens > 0 ? n(f.tokens) : '—'} | ${f.severity} | ${f.remedy} |`
      ),
      ''
    )
  }

  // A scanner with no SECTIONS entry would silently vanish from the report.
  const known = new Set(SECTIONS.map(s => s.scanner))
  const orphans = data.findings.filter(f => !known.has(f.scanner))
  if (orphans.length > 0) {
    out.push(`## Other`, '', ...orphans.map(f => `- **${f.subject}** — ${f.remedy}`), '')
  }

  out.push(...unmeasuredSection(data))
  return out.join('\n')
}
