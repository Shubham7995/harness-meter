// Zero imports, by design. This module runs on every Bash tool call, so its
// cost is startup cost. No filesystem, no config, no adapter.
//
// SECURITY: `reason` must never contain any part of the command. The guard
// sees every command the agent runs, and a command can carry a credential
// inline (`curl -H "Authorization: Bearer ghp_..."`). Rules name themselves
// and the fix; they never quote their input.
//
// ADVISORY BY DESIGN — this guard never blocks. `classify()` returns only
// 'allow' or 'warn'. There used to be a 'deny' verdict, backed by a
// statement splitter that segmented a command on `;`/`&&`/`||` so each
// statement could carry its own severity. Two consecutive rounds of fixing
// real bypasses of that design each closed one hole and opened another of
// the same size:
//   - a backslash-escaped quote in a search pattern (`grep -r "note: \"a &&
//     b\" is fine" /`) toggled quote state early and fractured one command
//     into two harmless-looking fragments;
//   - after fixing that, `grep -r \; /` — where bash treats an escaped `;`
//     outside quotes as a literal argument character, not a separator — was
//     still ONE unbounded root search that the splitter's own separator
//     logic had no reason to touch, yet a subtler case right next to it
//     did regress: `grep -r 'x\' / ; echo -l` exploits POSIX single quotes
//     not honouring backslash escapes at all, so the quote the splitter
//     opens on `'` never closes, the unbalanced-quote fail-safe (correctly,
//     in isolation) merges the whole line back into one blob, and the
//     unrelated `-l` from `echo -l` then trips the CAPPED check for the
//     merged blob — turning a root search into an `allow`. That is worse
//     than the defect the splitter was added to fix.
//
// Reverting to whole-string matching alone does not rescue this either: the
// same command was already `allow` under whole-string matching before
// segmentation existed, because the stray `-l` masks it either way.
// Whole-string matching has masking bypasses; segmentation has quoting
// bypasses. Both are regex approximations of a real shell grammar, and
// regex cannot segment shell reliably — only a real parser (quote, escape,
// and substitution aware) can tell where one statement ends and the next
// begins with certainty.
//
// Given that ceiling, a `deny` verdict is a liability: a missed pattern
// costs a bypassed security control. An advisory verdict has no such
// failure mode: a missed pattern costs a missed warning, and the agent's
// own judgment is still in the loop. So this guard classifies the whole
// command string (no segmentation) and never returns more than 'warn'. The
// rule that used to deny an unbounded root search still fires — it is the
// single most important thing this guard can flag — it just no longer
// blocks the call.
//
// A future reader: do not reintroduce 'deny' (or statement segmentation in
// service of one) without first replacing this regex classifier with an
// actual shell parser. Short of that, segmentation only ever trades one
// bypass class for another of the same size.
//
// KNOWN GAP — silent masking, not a bug to "fix" with a tighter regex: this
// classifier matches the ENTIRE command string with no statement
// segmentation, so a capping flag (`-l`, `-m N`, etc.) ANYWHERE in a
// compound command suppresses the warning for every part of it, even parts
// in a different statement that flag has nothing to do with. Worked
// example: `ls -l && grep -r key /` is an unbounded root search, but CAPPED
// sees the `-l` from `ls -l` and the whole command classifies as `allow`.
// Empty hook output is therefore ambiguous between "nothing to flag" and
// "flagged, but masked by an unrelated flag elsewhere in the command" — the
// classifier cannot tell you which happened, and neither can its caller.
// This is the accepted cost of removing segmentation (see above): it trades
// a bypassed block for a missed warning, and this is what that missed
// warning looks like in practice.

const SEARCH = /\b(grep|rg|ripgrep)\b/
const FIND = /\bfind\b/

// Any of these bounds the output, so the command cannot flood context.
//   - a pipe into head/wc/tail bounds whatever it reads from (the segment it
//     pipes FROM, not itself).
//   - `-l`/`-m N` as their OWN token, but also inside a combined short-flag
//     cluster (`-rl`, `-Rl`, `-rln`, `-rm 5`) — grep/rg accept clustered
//     short flags, and a rule whose own suggested fix (`-l`) is defeated by
//     clustering it with `-r` is worse than no rule.
//   - `--files-with-matches` and the `--max-count=` long form.
const CAPPED = /\|\s*(head|wc|tail)\b|(^|\s)-[a-zA-Z]*m\s*\d|(^|\s)-[a-zA-Z]*l[a-zA-Z]*\b|--files-with-matches\b|--max-count(=|\s+)\d/

// Anything that narrows the search to a subset of files, in any of the
// spellings grep, ripgrep, or find accept for the same idea:
//   --include=, --include (space form), --glob/-g (ripgrep), --type/-t
//   (ripgrep), -name/-maxdepth (find).
const NARROWED = /--include(=|\s)|--glob\b|(^|\s)-g\s|(^|\s)-t\s|--type\b|(^|\s)-name\s|(^|\s)-maxdepth\s/

// A search whose root is the filesystem root, the home directory, or a
// user's home. These are the only shapes with no plausible bounded reading.
// A path one segment deeper (/Users/me/repo/src) is a bounded path, not an
// unbounded root, and must not match here — see ROOTED_SEGMENT below.
// Optional surrounding quotes and an optional trailing slash are handled so
// that `~/`, `"$HOME"`, `${HOME}/`, `"/"`, and `'/'` all count as rooted,
// same as their unquoted, unslashed spellings.
const ROOTED_SEGMENT = "[^\\s/'\"]+"
const ROOTED = new RegExp(
  '(^|\\s)' +
  '["\']?' +
  '(~|\\$HOME|\\$\\{HOME\\}' +
  `|/Users(?:/${ROOTED_SEGMENT})?` +
  `|/home(?:/${ROOTED_SEGMENT})?` +
  '|/)' +
  '/?' +
  '["\']?' +
  '(\\s|$)'
)

const RECURSIVE = /(^|\s)-[a-zA-Z]*[rR][a-zA-Z]*\b|--recursive\b|--dereference-recursive\b|\brg\b|\bripgrep\b/

// Frozen: this exact object is returned by reference from every allow path,
// so a future caller mutating a `classify()` result must not corrupt the
// shared singleton for every other command in the process.
const ALLOW = Object.freeze({ verdict: 'allow', rule: null, reason: null })

export function classify (command) {
  if (typeof command !== 'string' || command.trim() === '') return ALLOW

  const capped = CAPPED.test(command)
  const narrowed = NARROWED.test(command)

  if (SEARCH.test(command) && RECURSIVE.test(command)) {
    if (ROOTED.test(command) && !capped && !narrowed) {
      return {
        verdict: 'warn',
        rule: 'unbounded-root-search',
        reason: 'Recursive search from the filesystem or home root with no bound. Add a path, --include=, -l, or | head -50.'
      }
    }
    if (!capped && !narrowed) {
      return {
        verdict: 'warn',
        rule: 'uncapped-recursive-search',
        reason: 'Recursive search with no result bound. Consider -l, --include=, or | head -50.'
      }
    }
    return ALLOW
  }

  if (FIND.test(command) && !narrowed && !capped) {
    return {
      verdict: 'warn',
      rule: 'uncapped-find',
      reason: 'find with no -maxdepth and no -name filter. Consider narrowing it.'
    }
  }

  return ALLOW
}
