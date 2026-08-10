import { readFileSync, existsSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { AdapterMismatch } from './errors.js'

// A hooks block looks the same wherever it is declared:
//   { <EventName>: [ { matcher?, hooks: [ { type, command } ] } ] }
function flatten (block, source, out) {
  if (!block || typeof block !== 'object') return
  for (const [event, groups] of Object.entries(block)) {
    if (!Array.isArray(groups)) continue
    for (const group of groups) {
      const matcher = typeof group?.matcher === 'string' ? group.matcher : null
      for (const h of group?.hooks ?? []) {
        if (typeof h?.command !== 'string') continue
        out.push({ source, event, matcher, type: h.type ?? 'command', command: h.command })
      }
    }
  }
}

function readJson (path) {
  if (!existsSync(path)) return null

  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (e) {
    // The file is there and we cannot read it. That is a layout/permission
    // failure, not third-party sloppiness — measuring zero here would be
    // could-not-measure masquerading as measured-zero.
    throw new AdapterMismatch(path, `cannot read plugin manifest (${e.code})`)
  }

  try {
    return JSON.parse(text)
  } catch {
    // One malformed third-party manifest is that plugin's problem. Skip it
    // and keep auditing.
    return null
  }
}

// `hooks` in plugin.json is either an inline block or a path to a file holding
// one. The path is the plugin's own text, so it is contained to the plugin
// directory before being opened: a manifest must not be able to name an
// arbitrary file for this tool to read.
//
// Containment is textual (resolve + prefix). A symlink planted INSIDE the
// plugin directory could still point out of it — accepted, because anyone who
// can write into the plugin cache already controls the hook scripts themselves.
function resolveHooksRef (pluginDir, ref) {
  const base = resolve(pluginDir)
  const target = resolve(base, ref)
  if (target !== base && !target.startsWith(base + sep)) return null
  return readJson(target)
}

export function listHookRegistrations (root, settings, plugins) {
  const out = []

  flatten(settings.hooks, 'settings', out)

  for (const p of plugins) {
    const manifest = readJson(join(p.dir, '.claude-plugin', 'plugin.json'))
    const declared = manifest?.hooks
    flatten(
      typeof declared === 'string'
        ? resolveHooksRef(p.dir, declared)?.hooks
        : declared,
      `plugin:${p.name}`,
      out
    )

    const file = readJson(join(p.dir, 'hooks', 'hooks.json'))
    flatten(file?.hooks, `plugin:${p.name}`, out)
  }

  return out
}
