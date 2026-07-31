---
description: Audit this Claude Code installation for token waste and report the top findings.
allowed-tools: Bash(node:*)
---

Run this exact command and read its JSON output:

!`node "${CLAUDE_PLUGIN_ROOT}/bin/hm.js" audit --json --cap 8`

That output is the complete input for your answer. Do not read the source,
do not re-run the audit with a larger cap, and do not open any file it
mentions — the whole point of this command is to cost less than the waste
it reports.

Report, in this order:

1. The total prefix cost in tokens, and what fraction of a typical request it represents.
2. The three highest-ranked findings, each with its subject, token weight, and remedy.
3. Any `mutation`-scanner finding, called out separately — those break prompt caching rather than adding tokens, so they cost differently and are usually cheaper to fix.
4. One sentence on what to do first.

If `findingCount` exceeds the number of findings returned, say how many were
not shown. Never present a capped list as if it were complete.

If the command exits non-zero, report the error verbatim and stop. Exit code
2 means the installation layout was not recognised, which is a harness-meter
bug worth reporting — not a configuration problem the user caused.
