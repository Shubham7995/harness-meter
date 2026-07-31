#!/usr/bin/env node
import { classify } from '../src/guard.js'

// Every failure path allows. A guard that blocks what it does not understand
// stops the agent working and teaches the user to disable it. Exit is always
// 0 — a non-zero exit from a PreToolUse hook errors the turn.
function allow () {
  process.exit(0)
}

function main (raw) {
  if (process.env.HM_GUARD === 'off') return allow()

  let input
  try {
    input = JSON.parse(raw)
  } catch {
    return allow()
  }

  if (input?.tool_name !== 'Bash') return allow()

  const { verdict, reason } = classify(input?.tool_input?.command)
  if (verdict === 'allow') return allow()

  // Advisory only: every non-allow verdict is a systemMessage, never a
  // hookSpecificOutput permission decision. The guard warns; it never blocks.
  const payload = { systemMessage: `harness-meter: ${reason}` }

  process.stdout.write(JSON.stringify(payload))
  process.exit(0)
}

let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (c) => { buf += c })
process.stdin.on('end', () => {
  try {
    main(buf)
  } catch {
    allow()
  }
})
