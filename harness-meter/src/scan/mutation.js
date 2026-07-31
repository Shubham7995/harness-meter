// Each pattern makes a hook's behaviour vary between otherwise-identical
// invocations. Severity reflects how directly that harms cache stability
// or reproducibility.
//
// SECURITY: `re` is matched against the command, but the command NEVER
// reaches a finding. A hook command can carry a credential inline, and
// redactDeep cannot catch a token embedded mid-string. Findings name the
// source and the pattern class only.
const PATTERNS = [
  {
    id: 'unpinned-version',
    re: /@(?:latest|next)\b/,
    severity: 'error',
    why: 'resolves over the network on every invocation and can change without notice',
    fix: 'pin an explicit version'
  },
  {
    id: 'timestamp',
    re: /\$\(\s*date\b|`\s*date\b|%date%/i,
    severity: 'error',
    why: 'injects a value that differs on every invocation',
    fix: 'remove the timestamp or move it out of injected content'
  },
  {
    id: 'working-directory',
    re: /\$PWD\b|\$\{PWD\}|\$\(\s*pwd\s*\)/,
    severity: 'warn',
    why: 'varies per project, so output differs between repositories',
    fix: 'use ${CLAUDE_PLUGIN_ROOT} or a path relative to the hook'
  },
  {
    id: 'git-sha',
    re: /git\s+rev-parse/,
    severity: 'warn',
    why: 'changes with every commit',
    fix: 'drop the SHA from injected content'
  },
  {
    id: 'absolute-home-path',
    re: /\/(?:Users|home)\/[^/\s"']+\//,
    severity: 'warn',
    why: 'is machine-specific and breaks for anyone else',
    fix: 'use ${CLAUDE_PLUGIN_ROOT} or $HOME'
  }
]

export function scanMutation (registrations) {
  const out = []
  for (const r of registrations) {
    for (const p of PATTERNS) {
      if (!p.re.test(r.command)) continue
      out.push({
        id: `mutation/${r.source}/${r.event}/${p.id}`,
        scanner: 'mutation',
        subject: `${r.source} (${r.event})`,
        tokens: 0,
        severity: p.severity,
        confidence: 0.7,
        risk: 1,
        remedy: `${r.event} hook from ${r.source} ${p.why} — ${p.fix}`
      })
    }
  }
  return out
}
