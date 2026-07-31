// Over-redaction is the intended failure direction. A config key named
// "monkey" matching /key/ costs a wrong-looking report line; a missed
// credential costs a leaked secret.
const SECRET_KEY_RE = /token|secret|key|password|credential|auth/i

const SECRET_VALUE_RES = [
  /^gho_/,                    // GitHub OAuth
  /^ghp_/,                    // GitHub personal access token
  /^github_pat_/,             // GitHub fine-grained PAT
  /^sk-/,                     // OpenAI-style
  /^AKIA[0-9A-Z]{16}$/,       // AWS access key id
  /^ey[A-Za-z0-9_-]+\.ey/     // JWT
]

function looksSecret (value) {
  return typeof value === 'string' && SECRET_VALUE_RES.some(re => re.test(value))
}

// not exported: the deep walker owns the taint signal, and a caller using
// this directly would lose it.
function redactValue (key, value) {
  if (SECRET_KEY_RE.test(key) || looksSecret(value)) return `<redacted:${key}>`
  return value
}

function redactDeepInternal (input, parentTainted = false) {
  if (Array.isArray(input)) {
    return input.map(v => {
      if (parentTainted || looksSecret(v)) return '<redacted>'
      return redactDeepInternal(v, false)
    })
  }
  if (input && typeof input === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(input)) {
      const keyMatches = SECRET_KEY_RE.test(k)
      const isTainted = parentTainted || keyMatches
      if (v && typeof v === 'object') {
        out[k] = redactDeepInternal(v, isTainted)
      } else {
        out[k] = isTainted ? `<redacted:${k}>` : redactValue(k, v)
      }
    }
    return out
  }
  return input
}

// Redacts a RENDERED DIFF for display. Text-level on purpose: parsing and
// re-serialising would change formatting, so the diff would show edits that are
// not real.
//
// DISPLAY ONLY. Never let its output near a write — the same trap rawio.js
// documents: writing back redacted text replaces real credentials with
// <redacted:KEY> placeholders, irreversibly. applyFix keeps `after` (written)
// and `diff` (shown) as separate fields; this belongs only on the latter.
//
// hm fix re-serialises the whole settings file, so every line reaches the diff
// — including an env block. It printed a live-format token twice on a plain
// dry run with no --apply.
export function redactDiffText (diff) {
  if (typeof diff !== 'string' || diff === '') return diff

  // Depth is tracked PER SIDE of the diff. renderDiff interleaves - and +
  // lines, so a single counter mixes the two documents: a `+  "env": {` left
  // the block open and masked the very next `-` line, which belongs to the
  // other side entirely. Context lines belong to both sides and update both.
  const sides = { '-': { depth: 0, envDepth: null }, '+': { depth: 0, envDepth: null } }

  return diff.split('\n').map(line => {
    // Diff lines carry a leading -, + or space; analyse the payload only.
    const prefix = /^[-+ ]/.test(line) ? line[0] : ''
    const body = prefix ? line.slice(1) : line
    const affected = prefix === '-' || prefix === '+' ? [sides[prefix]] : [sides['-'], sides['+']]
    const st = affected[0]

    const key = /^\s*"([^"]+)"\s*:/.exec(body)?.[1]
    const inEnv = st.envDepth !== null && st.depth > st.envDepth

    let out
    if (key !== undefined && (inEnv || SECRET_KEY_RE.test(key))) {
      // Mask every quoted value but keep the first quoted token — the key
      // itself — so the diff still reads as a diff. An inline object such as
      // `"env": { "TOKEN": "gho_..." }` puts both on ONE line.
      let seenKey = false
      out = body.replace(/"(?:[^"\\]|\\.)*"/g, m => {
        if (!seenKey) { seenKey = true; return m }
        return `"<redacted:${key}>"`
      })
    } else {
      out = body.replace(/"((?:[^"\\]|\\.)*)"/g,
        (whole, v) => (looksSecret(v) ? '"<redacted>"' : whole))
    }

    // Update depth AFTER classifying, so the `"env": {` line is handled by its
    // own key test rather than by the block it opens.
    const delta = (body.match(/\{/g) || []).length - (body.match(/\}/g) || []).length
    for (const s of affected) {
      if (key !== undefined && /^env$/i.test(key)) s.envDepth = s.depth
      s.depth += delta
      if (s.envDepth !== null && s.depth <= s.envDepth) s.envDepth = null
    }

    return prefix + out
  }).join('\n')
}

export function redactDeep (input) {
  return redactDeepInternal(input, false)
}
