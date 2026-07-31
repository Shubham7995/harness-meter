import { SIGNALS } from './signals.js'

// Allowlist-only, per spec §6 failure mode 2. A plugin is dropped ONLY when
// the signals table knows it AND none of its signals are present. A plugin the
// table does not know is ALWAYS kept — reported as `unknown` so the user can
// see what the tool declined to judge rather than silently losing it.
export function proposeProfile (enabledNames, capabilities) {
  const keep = []
  const drop = []
  const unknown = []

  for (const name of enabledNames) {
    if (!(name in SIGNALS)) unknown.push(name)
    else if (capabilities.has(name)) keep.push(name)
    else drop.push(name)
  }

  return {
    keep: keep.sort(),
    drop: drop.sort(),
    unknown: unknown.sort()
  }
}

export function renderSettings (keepNames, existingText) {
  let doc = {}
  if (existingText !== null && existingText !== undefined) {
    // An unparseable project settings file stops the operation. Overwriting it
    // would discard whatever the user meant to put there.
    //
    // Same rule as the adapter's settings loader: a JSON.parse message embeds
    // a V8 source window, so the file's own bytes — which can include the
    // credentials in an env block — would land in an error the user sees.
    // Only the position is safe to surface.
    try {
      doc = JSON.parse(existingText)
    } catch (e) {
      const m = /position (\d+)/.exec(e.message)
      throw new Error(
        `existing settings is not valid JSON${m ? ` (at position ${m[1]})` : ''}`
      )
    }
    if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
      throw new Error('existing settings is not a JSON object')
    }
  }

  // An entry the project already set EXPLICITLY is the user's decision and
  // outranks this tool's. Without this, `{...doc, enabledPlugins}` replaced the
  // whole key: a plugin deliberately disabled at project level came back as
  // true on the next run, because "declined to judge" plugins land in
  // keepNames. Observed on a real machine — hm fix proposed re-enabling a hook
  // the user had switched off an hour earlier, which is precisely the silent
  // config damage the diff-before-write rule exists to prevent.
  const prior = (doc.enabledPlugins && typeof doc.enabledPlugins === 'object' && !Array.isArray(doc.enabledPlugins))
    ? doc.enabledPlugins
    : {}
  const enabledPlugins = {}
  for (const n of [...keepNames].sort()) {
    enabledPlugins[n] = Object.hasOwn(prior, n) ? prior[n] : true
  }

  return JSON.stringify({ ...doc, enabledPlugins }, null, 2) + '\n'
}
