# harness-meter

**Finds and removes the tokens your Claude Code setup spends before you type a word.**

```
hm audit      # what is the fixed overhead, and where does it go
hm fix        # propose a per-project plugin profile, show the diff, write nothing
hm rollup     # tier-5 metrics from recorded sessions
```

Measured on the machine it was built for: **16,002 tokens on every request**, reduced to **8,753** — a 45% cut, from a tool that costs nothing to re-run.

---

## Contents

- [WHY — the problem](#why--the-problem)
- [WHAT — the tool](#what--the-tool)
- [HOW — the mechanism](#how--the-mechanism)
- [Install and use](#install-and-use)
- [Design constraints](#design-constraints-and-why-each-one-is-load-bearing)
- [What it deliberately will not do](#what-it-deliberately-will-not-do)
- [Contributing](#contributing)

---

## WHY — the problem

### Every plugin you install taxes every request you make

Claude Code injects the `description` frontmatter of **every skill and every agent** from **every enabled plugin** into the system prompt. This happens on every request, before your task is read, whether or not the plugin is remotely relevant to what you are doing.

Nobody chose this cost. It accumulates one `plugin install` at a time, and nothing in the interface shows it to you.

On the machine this was built for, a hand audit found:

| Plugin | tokens/request | relevant to the repo? |
|---|---:|---|
| `azure` | **4,736** | no Azure code anywhere |
| `dev-workflows-frontend` | 2,115 | duplicate roster (see below) |
| `dev-workflows` | 2,093 | 16 of ~20 agents identical to the above |
| `plugin-dev` | 1,612 | three agents, each embedding full example dialogues |
| *…24 others* | ~5,446 | mixed |
| **Total** | **16,002** | |

**30% of the bill was Azure routing keywords in a repository with no Azure code.** Another 4,208 tokens went to two near-identical agent rosters differing mainly by a `-frontend` suffix — the same nineteen roles, paid for twice.

### Why "it's cached, so it's cheap" is not the whole answer

Cache reads are billed at roughly 10% of input price, so the steady-state monetary cost is modest. That is cache discipline working. Two things it does not cover:

1. **The first request of every session pays full price**, at a cache-*write* premium. Every plugin install, update, or marketplace refresh invalidates the prefix for every session.
2. **Attention dilution is not discounted by caching.** Research on guide compression measured a **+2.8% task-quality gain** purely from removing non-actionable content, and multi-model studies find degradation as input grows well below the context limit. Those 4,736 Azure keywords compete with your actual task on every single turn — at full cognitive price and 10% monetary price.

### Why a tool, rather than just fixing it once

The hand audit that produced the table above cost **roughly 19,000 tokens of context** to perform, and was stale the next time a plugin was installed.

> **A finding you cannot cheaply re-measure is a finding you will act on once and then forget.**

That is the entire justification for this tool: make the audit cost approximately zero so it can run whenever you want, and act on what it finds.

---

## WHAT — the tool

A zero-dependency Node CLI with three commands. It reads your Claude Code configuration from the outside and never participates in it.

### `hm audit` — measure

Walks every enabled plugin, measures the `description` frontmatter of every skill and agent, and ranks what it finds.

```
# harness-meter audit

**Total token cost: ~16,002 tokens, every request.**

| Subject | ~tokens | Severity | Remedy |
|---|---:|---|---|
| azure | 4,736 | warn | Disable azure in repositories with no evidence of needing it |
| dev-workflows-frontend | 2,115 | warn | ...
```

**Unmeasurable is never reported as zero.** A plugin whose files cannot be read is reported as *unmeasurable* and listed separately. A silent zero would read as "this plugin is free, keep it" — the failure mode of an auditing tool is not being wrong loudly, it is being wrong quietly.

### `hm fix` — remediate

Proposes a project-scoped profile that disables plugins this repository shows no evidence of needing.

```
harness-meter: 5 plugin(s) to disable, 0 justified, 25 declined to judge
```

Three properties make this safe enough to run on a real machine:

- **It writes only the project's `.claude/settings.json`**, never your global config. Enforced by a filesystem check that resolves symlinks and case-folding, not a string comparison.
- **It prints a diff and writes nothing without `--apply`.**
- **Undo is byte-identical.** `--apply` stores the file's exact prior bytes; `--undo` writes them back verbatim. An undo that reformats your file is not an undo.

### `hm rollup` — track

Derives five metrics from sessions recorded by the optional `SessionEnd` hook: Cache Read Ratio, Observation-to-Action, Failure Spend Ratio, Guide Load Efficiency, and output tokens per session.

**The cost figure is never reported alone.** It is emitted only alongside a task success rate, and there is no task-outcome sensor yet, so both read `unavailable`. This is structural, not an oversight — a harness optimised on cost alone under-explores and returns confidently wrong answers cheaply.

It is deliberately *not* called "cost per mission". An earlier version was, while dividing output tokens by assistant turns and ignoring input entirely — neither a mission count nor a cost. Pricing belongs to whoever knows the rate card.

---

## HOW — the mechanism

### Where the numbers come from

Claude Code stores plugins at `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`, with `skills/*/SKILL.md` and `agents/*.md` carrying YAML frontmatter. `hm audit` reads the newest installed version of each **enabled** plugin, extracts each `description`, and estimates tokens as `chars / 4`.

**Why not a real tokenizer?** It means a dependency and a model-version coupling, for precision no decision here needs. The decisions this drives are *"disable azure, save ~4,700"* — a 3% estimation error changes nothing. And because the same estimator applies to every plugin, the *ranking* is unaffected.

### How `hm fix` decides — allowlist only

A curated table maps a plugin to the files that would justify it (`azure` → `azure.yaml`, `.bicep`, `.csproj`). A plugin is proposed for removal **only when the table knows it AND no signal is found.** Everything else is reported as **"declined to judge"** and kept.

On a real machine that means 25 of 30 plugins are left alone. Deliberately, loudly conservative:

> **Wrongly disabling a plugin you need costs far more than failing to save 500 tokens.** Declining to judge is an honest answer; guessing is not.

The walk skips `node_modules`, `dist`, `build`, `vendor`, `target`, and — learned the hard way — `fixtures`, `__fixtures__`, `testdata`, `__mocks__`. **This repository's own test fixtures once made it report `azure` as justified.** A repo's test data is indistinguishable from its capabilities unless you say otherwise. `--include-fixtures` opts out.

### How session metrics work

`bin/hm-record.js` is an optional `SessionEnd` hook. It reads the transcript, appends **one line of counters** to `~/.claude/harness-meter/sessions.jsonl`, and exits.

**Stored:** token counters, tool call/result/error counts, observation *length* in characters, turn count, an opaque session id, and why the session ended.

**Never stored:** no file paths — not the transcript path, not your cwd. No prompt text. No file contents or command output. No credentials. Observation length is a *number*; the content it measures is never stored, returned, or logged. The row's exact key set is asserted by a test, so any new field fails loudly.

**The hook cannot break your session.** It exits 0 no matter what — unreadable transcript, unwritable log, malformed payload, or a bug in the file itself — and writes nothing to stdout, because a `SessionEnd` hook's stdout can be injected into your context.

> A metrics hook that breaks a session for a number nobody asked for is worse than no metrics.

Only raw counters are stored; every metric is derived at read time. Change a definition and your whole history re-derives instead of being invalidated.

One subtlety worth knowing, because it cost a 1.88× error before it was caught: **Claude Code writes one JSONL line per content block** of a single assistant message, repeating that message's `usage` object identically on each. Usage is therefore counted once per message id, while content blocks stay counted per line.

---

## Install and use

Requires Node ≥ 22. There are no dependencies to fetch either way.

### As a Claude Code plugin

The repository root carries a `.claude-plugin/marketplace.json`, so it installs
like any other marketplace:

```
/plugin marketplace add Shubham7995/harness-meter
/plugin install harness-meter@harness-meter
```

That gives you the `/token-audit` command and the advisory Bash guard. The
`SessionEnd` metrics hook is opt-in and wired separately — see below.

**Installing it costs you nothing per request.** The plugin ships no `skills/`
and no `agents/`, which is where per-request cost lives. That is a deliberate
constraint, not an accident: see [Design constraints](#design-constraints-and-why-each-one-is-load-bearing).

### As a plain CLI

```bash
git clone https://github.com/Shubham7995/harness-meter.git
cd harness-meter/harness-meter
npm test                    # 348 tests, nothing to install
node bin/hm.js audit        # see what your setup costs
```

### Cutting the cost in a project

```bash
cd ~/your-project
node /path/to/harness-meter/bin/hm.js fix --repo .     # read the diff
node /path/to/harness-meter/bin/hm.js fix --repo . --apply
```

Takes effect next session. Reverse with `--undo` at any time.

> `.claude/.hm-undo.json` holds a plaintext copy of your previous settings — including any `env` values — until you run `--undo`. Add it to `.gitignore` if `.claude/` is tracked.

### Turning on session metrics

Add to `~/.claude/settings.json`, using an absolute path:

```json
{
  "hooks": {
    "SessionEnd": [
      { "hooks": [ {
          "type": "command",
          "command": "node /absolute/path/to/harness-meter/bin/hm-record.js",
          "timeout": 5
      } ] }
    ]
  }
}
```

Then `node bin/hm.js rollup`. The log is append-only and safe to delete at any time.

### All flags

```
hm audit  [--json] [--root PATH] [--cap N]
hm fix    [--repo PATH] [--root PATH] [--include-fixtures] [--apply] [--undo]
hm rollup [--json] [--root PATH]
```

A `/token-audit` slash command wraps `hm audit --json --cap 8`.

---

## Design constraints, and why each one is load-bearing

**Zero npm dependencies.** This tool reads `settings.json` files that routinely contain live credentials. The fewer third-party packages in that process, the better. It also has to run instantly with no install step, or it will not be run.

**No LLM anywhere in the tool.** Every measurement is deterministic, reproducible, and free. A token auditor that spends tokens to measure token spend is self-refuting, and would produce a number that changes between runs.

**It ships as a plugin but contributes nothing to the prefix.** There is a `plugin.json`, a hook, and a command — but no `skills/` and no `agents/`, which is where per-request cost lives. Commands and hooks are not injected into the prompt; skill and agent descriptions are.

**Redact by default; never interpolate a read value.** Error messages carry the position, the type, the flag name, or the error code — never a value read from a file. This is not theoretical: an early version passed a `JSON.parse` error message straight through, and V8 embeds a *source window* in those. Parsing a settings file with a syntax error near a token would have printed that token to stderr.

**One writer.** Every write syscall in the project lives in `src/remediate/rawio.js`, asserted by a test. This tool modifies real configuration; one choke point means the entire write path is auditable by reading one file.

Four structural invariants are asserted mechanically in `tests/constraints.test.js`, not merely documented:

1. No module under `src/` imports `node:os`.
2. `src/guard.js` has zero imports — a hook running on every tool call must not break because something it imported did.
3. Nothing under `src/remediate/` references the audit config adapter, whose loader returns *redacted* values that must never be written back to disk.
4. `rawio.js` is the only module containing a write syscall.

---

## What it deliberately will not do

| Not built | Why |
|---|---|
| LLM-judged "is this description bloated?" | Costs tokens to measure token cost; not reproducible |
| A real tokenizer | Dependency + model coupling, for precision no decision needs |
| Auto-remediate without `--apply` | Never silently modify a live config |
| Touch your global `~/.claude/settings.json` | Disabling `azure` globally breaks your actual Azure work |
| Guess relevance for unknown plugins | False positives cost more than the tokens saved |
| Choose between two near-identical plugins | That is an editorial judgment; it reports the overlap and leaves the call to you |

### Known gaps

- A `transcript_path` that blocks on read (a FIFO, a stalled network mount) hangs the `SessionEnd` hook: `readFileSync` has no timeout, so "always exits 0" becomes "never exits".
- `.claude/.hm-undo.json` and the metrics log are written with default permissions (`0644`). The undo envelope holds a verbatim copy of your previous settings — **add it to `.gitignore`**, which this repo's own `.gitignore` demonstrates.

*(Fixed in Phase 4c: `hm fix` used to print the full project `settings.json` in its diff, credentials included. It now redacts by key taint, by enclosing `env` block, and by value shape — display only. `--apply` still writes the real value and `--undo` still restores it byte-identically.)*

---

## Contributing

```bash
npm test    # node --test tests/*.test.js
```

`node --test tests/` does **not** work in this project (MODULE_NOT_FOUND). Use the glob.

### A warning about tests here

This project has shipped **six** tests that passed and **could not fail**. Every one was found by *mutating the source and watching the suite stay green* — never by reading the test. One was found only because an interrupted process left its mutation in the working tree by accident.

If you add a test, delete the behaviour it names and watch it go red. In particular:

- **An assertion that something is absent proves nothing** unless that thing was actually present in the input. Assert a precondition first.
- **A ratio test where numerator equals denominator cannot detect an inverted formula**, because `ratio(a,b) === ratio(b,a)` when `a === b`.
- **Asserting only one side of a comparison** lets the comparison be deleted entirely.

The full record — including why cross-validating a parser against a second implementation caught nothing, and why a test-gating hook with no reporter for this project's test runner was worse than no hook at all — is kept in a separate research repository.
