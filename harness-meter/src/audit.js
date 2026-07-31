import { loadSettings } from './adapter/config.js'
import { listInstalledPlugins } from './adapter/plugins.js'
import { listHookRegistrations } from './adapter/hooks.js'
import { scanPrefix } from './scan/prefix.js'
import { scanMutation } from './scan/mutation.js'
import { rank } from './rank.js'
import { toJson } from './report/json.js'
import { toMarkdown } from './report/markdown.js'

export function runAudit (root, generatedAt, cap = null) {
  const settings = loadSettings(root)
  const plugins = listInstalledPlugins(root, settings.enabledNames)
  const registrations = listHookRegistrations(root, settings, plugins)

  const findings = rank([
    ...scanPrefix(plugins),
    ...scanMutation(registrations)
  ])

  const meta = { generatedAt, root }
  if (cap !== null) meta.cap = cap
  return {
    findings,
    json: toJson(findings, meta, plugins),
    markdown: toMarkdown(findings, meta, plugins)
  }
}
