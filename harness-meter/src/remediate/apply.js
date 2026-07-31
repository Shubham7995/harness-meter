import { join } from 'node:path'
import { readTextOrNull, writeTextAtomic, saveUndo, restoreUndo, loadUndo } from './rawio.js'
import { renderSettings } from './profile.js'
import { renderDiff } from './diff.js'

// hm fix only ever writes the PROJECT-scoped settings file. It must never
// target ~/.claude/settings.json — that file holds the user's credentials and
// this tool has no business writing it.
function claudeDir (projectRoot) {
  return join(projectRoot, '.claude')
}

function settingsPathFor (projectRoot) {
  return join(claudeDir(projectRoot), 'settings.json')
}

export function applyFix (projectRoot, keepNames) {
  const settingsPath = settingsPathFor(projectRoot)
  const before = readTextOrNull(settingsPath)
  const after = renderSettings(keepNames, before)
  return { settingsPath, before, after, diff: renderDiff(before, after) }
}

export function commitFix (projectRoot, plan) {
  saveUndo(claudeDir(projectRoot), plan.settingsPath)
  writeTextAtomic(plan.settingsPath, plan.after)
}

export function undoFix (projectRoot) {
  return restoreUndo(claudeDir(projectRoot), settingsPathFor(projectRoot))
}

// BLOCKER 3: --undo must show what it is about to do BEFORE acting, matching
// applyFix's read-only/commitFix's write split. planUndo previews; undoFix
// above still performs the actual restore/removal.
export function planUndo (projectRoot) {
  const settingsPath = settingsPathFor(projectRoot)
  const env = loadUndo(claudeDir(projectRoot))
  const before = readTextOrNull(settingsPath)
  const after = env.existed ? env.text : null
  const diff = env.existed
    ? renderDiff(before, after)
    : (before === null ? '' : 'will be removed')
  return { settingsPath, before, after, existed: env.existed, diff }
}
