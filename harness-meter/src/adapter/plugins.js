import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'
import { AdapterMismatch } from './errors.js'

export function pickNewestVersion (versions) {
  return [...versions].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true })
  ).pop()
}

const UNMEASURED = { text: '', measurable: false }

export function readDescription (text) {
  // \r? throughout: a CRLF file previously failed the frontmatter match
  // entirely and measured 0 bytes, indistinguishable from an empty value.
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (!fm) return UNMEASURED

  const lines = fm[1].split(/\r?\n/)
  const idx = lines.findIndex(l => /^description:/.test(l))
  if (idx === -1) return UNMEASURED

  const rest = lines[idx].replace(/^description:[ \t]*/, '')

  // tests/plugins.test.js: 'captures both paragraphs of a `description: |`
  // block scalar across a blank line' — the old single regex
  // `/^description:[ \t]*(.*(?:\n[ \t]+.*)*)/m` required every continuation
  // line to start with whitespace, so a blank line (zero characters before
  // its newline) silently ended the match, dropping every later paragraph.
  // A YAML block indicator (`|` literal, `>` folded), optionally followed by
  // a chomping modifier (`-`/`+`) and/or a comment, instead continues until a
  // line back at zero indentation starts the next top-level frontmatter key.
  if (/^[|>][-+]?\s*(#.*)?$/.test(rest)) {
    const body = []
    for (let i = idx + 1; i < lines.length; i++) {
      const line = lines[i]
      if (line.trim() !== '' && /^[A-Za-z_-]+:/.test(line)) break
      body.push(line)
    }
    return {
      text: body.join('\n').replace(/^[ \t]+/gm, '').trim(),
      measurable: true
    }
  }

  // Single line, plus simple indented continuations.
  const cont = [rest]
  for (let i = idx + 1; i < lines.length; i++) {
    if (!/^[ \t]+\S/.test(lines[i])) break
    cont.push(lines[i])
  }
  return { text: cont.join('\n').replace(/^[ \t]+/gm, '').trim(), measurable: true }
}

// readdirSync(withFileTypes) never follows symlinks, so a symlinked plugin
// directory reads as "not a directory" and disappears from the audit. Resolve
// it explicitly. The try/catch is what keeps a DANGLING symlink from throwing
// ENOENT and crashing the whole run — the reason dirsIn moved off statSync in
// the first place.
function isDir (dir, entry) {
  if (entry.isDirectory()) return true
  if (!entry.isSymbolicLink()) return false
  try {
    return statSync(join(dir, entry.name)).isDirectory()
  } catch {
    return false
  }
}

function dirsIn (path) {
  if (!existsSync(path)) return []
  return readdirSync(path, { withFileTypes: true })
    .filter(entry => {
      if (entry.name.startsWith('.') || entry.name.startsWith('temp_')) return false
      return isDir(path, entry)
    })
    .map(entry => entry.name)
}

function collect (dir, filename) {
  const out = []
  if (!existsSync(dir)) return out
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name)
      if (entry.isDirectory()) { walk(p); continue }
      if (filename === '*.md' ? entry.name.endsWith('.md') : entry.name === filename) {
        let raw
        try {
          raw = readFileSync(p, 'utf8')
        } catch (e) {
          throw new AdapterMismatch(p, `cannot read descriptor file (${e.code})`)
        }
        const desc = readDescription(raw)
        // A skill is named by its containing directory; an agent by its filename.
        // basename(), not split('/'), so this works on Windows too.
        const name = entry.name === 'SKILL.md'
          ? basename(d)
          : entry.name.replace(/\.md$/, '')
        out.push({
          name,
          descriptionBytes: Buffer.byteLength(desc.text, 'utf8'),
          measurable: desc.measurable
        })
      }
    }
  }
  walk(dir)
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

export function listInstalledPlugins (root, enabledNames) {
  const cache = join(root, 'plugins', 'cache')
  if (!existsSync(cache)) {
    throw new AdapterMismatch(cache, 'plugin cache directory not found')
  }

  const wanted = new Set(enabledNames)
  const found = []

  for (const marketplace of dirsIn(cache)) {
    for (const name of dirsIn(join(cache, marketplace))) {
      if (!wanted.has(name)) continue
      const pluginRoot = join(cache, marketplace, name)
      const versions = dirsIn(pluginRoot)
      // A plugin directory with no version subdirectory is a half-finished
      // install, not a layout mismatch. Skipping is correct; the enabled-but-
      // unresolved guard below still fires if NOTHING resolves.
      if (versions.length === 0) continue
      const version = pickNewestVersion(versions)
      const dir = join(pluginRoot, version)
      found.push({
        name,
        version,
        dir,
        skills: collect(join(dir, 'skills'), 'SKILL.md'),
        agents: collect(join(dir, 'agents'), '*.md')
      })
    }
  }

  if (enabledNames.length > 0 && found.length === 0) {
    throw new AdapterMismatch(cache, 'no enabled plugin resolved under the cache — layout may have changed')
  }

  return found.sort((a, b) => a.name.localeCompare(b.name))
}
