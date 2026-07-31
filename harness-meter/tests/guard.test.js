import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { classify } from '../src/guard.js'

const v = (cmd) => classify(cmd).verdict

describe('classify — fails open', () => {
  it('allows an empty command', () => {
    assert.deepEqual(classify(''), { verdict: 'allow', rule: null, reason: null })
  })

  it('allows a non-string input', () => {
    assert.equal(v(undefined), 'allow')
    assert.equal(v(null), 'allow')
    assert.equal(v(42), 'allow')
  })

  it('allows array and object input rather than coercing via toString()', () => {
    // The real bite of the typeof guard: an array or a toString()-carrying
    // object would otherwise implicitly coerce to a string wherever a regex
    // .test() call touches it, letting a crafted object slip a dangerous
    // command past the classifier under a disguise. Both must short-circuit
    // to allow before any regex ever sees them.
    assert.equal(v(['find', '.', '-type', 'f']), 'allow')
    assert.equal(v({ toString () { return 'grep -r "x" /' } }), 'allow')
  })

  it('returns a frozen ALLOW singleton (Task 1: a caller must not corrupt it for every other command)', () => {
    assert.equal(Object.isFrozen(classify('')), true)
  })

  it('allows shell syntax it cannot parse', () => {
    assert.equal(v('$(( ¯\\_(ツ)_/¯ ))'), 'allow')
  })

  it('allows ordinary commands', () => {
    assert.equal(v('npm test'), 'allow')
    assert.equal(v('git status'), 'allow')
    assert.equal(v('node bin/hm.js audit'), 'allow')
    assert.equal(v('ls -la src'), 'allow')
  })
})

describe('classify — warn, reserved for unbounded root searches', () => {
  it('warns on a recursive grep rooted at /', () => {
    const r = classify('grep -r "TODO" /')
    assert.equal(r.verdict, 'warn')
    assert.equal(r.rule, 'unbounded-root-search')
  })

  it('warns on a recursive search rooted at the home directory', () => {
    assert.equal(v('grep -r "key" ~'), 'warn')
    assert.equal(v('rg "key" $HOME'), 'warn')
    assert.equal(v('grep -r "key" /Users/someone'), 'warn')
  })

  it('does NOT warn when a result cap is present', () => {
    assert.equal(v('grep -r "TODO" / | head -50'), 'allow')
    assert.equal(v('grep -rm 5 "TODO" /'), 'allow')
    assert.equal(v('rg -l "TODO" ~'), 'allow')
  })

  it('does NOT warn with --files-with-matches spelled out (I6.9)', () => {
    assert.equal(v('grep -r "TODO" / --files-with-matches'), 'allow')
  })

  it('does NOT warn with a pipe into wc or tail, not just head (I6.10)', () => {
    assert.equal(v('grep -r "TODO" / | wc -l'), 'allow')
    assert.equal(v('grep -r "TODO" / | tail -20'), 'allow')
  })

  it('warns on a bare ${HOME}, not just $HOME (I6.12)', () => {
    assert.equal(v('grep -r key ${HOME}'), 'warn')
  })

  it('does NOT warn when the search is narrowed by a path filter', () => {
    assert.equal(v('grep -r --include=*.js "TODO" /'), 'allow')
  })

  it('warns on the -R and --recursive long-form flags, not just -r', () => {
    assert.equal(v('grep -R "key" /'), 'warn')
    assert.equal(v('grep --recursive "key" /'), 'warn')
  })

  it('warns on GNU grep\'s --dereference-recursive long form, not just -R (Task 6.1)', () => {
    assert.equal(v('grep --dereference-recursive "key" /'), 'warn')
  })

  it('--dereference-recursive still composes with CAPPED (own mutation check, not in brief)', () => {
    // The brief's own test only exercises --dereference-recursive against the
    // ROOTED branch. A regex added in the wrong place in the alternation, or
    // one that accidentally overlaps CAPPED/NARROWED's character classes,
    // would not be caught by that single case. This pins that the new
    // alternative still lets -l suppress the warning like every other
    // recursive spelling does.
    assert.equal(v('grep --dereference-recursive -l "key" /'), 'allow')
  })

  it('--dereference-recursive on a bounded (non-rooted) directory still warns uncapped-recursive-search, not unbounded-root-search (own mutation check, not in brief)', () => {
    assert.equal(classify('grep --dereference-recursive "key" src').rule, 'uncapped-recursive-search')
  })

  it('warns on a bare /Users root with no trailing slash or user segment', () => {
    assert.equal(v('grep -r "key" /Users'), 'warn')
  })
})
describe('classify — C1: ROOTED must not fire on a bounded path merely rooted under /Users or /home', () => {
  // The original ROOTED regex, `\/Users\b(\/[^\s]*)?`, permitted arbitrary
  // depth, so it matched any absolute path at all as long as it started with
  // /Users or /home — warning on ordinary, bounded work with the rooted-search
  // rule id instead of allowing it. The fix anchors the match to the home
  // root itself, or root plus exactly one segment.
  it('does not raise unbounded-root-search several segments below /Users', () => {
    // ROOTED correctly fails to match, so these fall through to the plain
    // uncapped-recursive-search rule (still 'warn', but a different rule),
    // not 'allow' — the search is still unbounded, just not rooted.
    assert.deepEqual(classify('rg TODO /Users/me/projects/foo/src'), { verdict: 'warn', rule: 'uncapped-recursive-search', reason: 'Recursive search with no result bound. Consider -l, --include=, or | head -50.' })
    assert.equal(classify('grep -r TODO /Users/me/projects/foo/src/adapter').rule, 'uncapped-recursive-search')
    assert.equal(classify('grep -rn TODO /Users/me/repo/src/*.js').rule, 'uncapped-recursive-search')
  })

  it('does not raise unbounded-root-search several segments below /home', () => {
    assert.equal(classify('rg "classify" /home/dev/repo/src').rule, 'uncapped-recursive-search')
  })

  it('still raises unbounded-root-search for root-plus-exactly-one-segment', () => {
    const r = classify('grep -r key /Users/me')
    assert.equal(r.verdict, 'warn')
    assert.equal(r.rule, 'unbounded-root-search')
  })
})

describe('classify — I1: combined short flags still count as capped', () => {
  it('recognises -l clustered with -r or -R', () => {
    assert.equal(v('grep -rl X /'), 'allow')
    assert.equal(v('grep -Rl X /'), 'allow')
    assert.equal(v('grep -rln X /'), 'allow')
    assert.equal(v('rg -rl X /'), 'allow')
  })

  it('still recognises -l and -r as separate tokens', () => {
    assert.equal(v('grep -r -l X /'), 'allow')
  })

  it('recognises the --max-count= long form, not just -m', () => {
    assert.equal(v('grep -r X --max-count=5 /'), 'allow')
    assert.equal(v('grep -r X -m 5 /'), 'allow')
  })
})

describe('classify — I2: NARROWED recognises ripgrep and space-form spellings', () => {
  it('recognises -g (ripgrep glob shorthand)', () => {
    assert.equal(v('rg -g "*.js" TODO /'), 'allow')
  })

  it('recognises -t / --type (ripgrep type filter)', () => {
    assert.equal(v('rg -t js TODO /'), 'allow')
    assert.equal(v('rg --type js TODO /'), 'allow')
  })

  it('recognises the space form of --include, not just --include=', () => {
    assert.equal(v('grep -r --include *.js TODO /'), 'allow')
  })

  it('recognises --glob explicitly, not just via NARROWED being broad by accident (I6.11)', () => {
    assert.equal(v('rg --glob "*.js" TODO /'), 'allow')
  })
})

describe('classify — I3: quoting and trailing slashes no longer escape ROOTED', () => {
  it('warns on ~/ just like bare ~', () => {
    assert.equal(v('grep -r key ~/'), 'warn')
    assert.equal(v('grep -r key ~'), 'warn')
  })

  it('warns on quoted and slash-suffixed $HOME / ${HOME}', () => {
    assert.equal(v('grep -r key "$HOME"'), 'warn')
    assert.equal(v('grep -r key $HOME/'), 'warn')
    assert.equal(v('grep -r key ${HOME}/'), 'warn')
  })

  it('warns on a quoted root, single or double quoted', () => {
    assert.equal(v('grep -r key "/"'), 'warn')
    assert.equal(v("grep -r key '/'"), 'warn')
  })
})

describe('classify — segmentation removed: the whole command is one string', () => {
  // splitStatements() and per-statement severity are gone. classify() now
  // regex-matches the entire command string in one pass, exactly as it did
  // before segmentation was introduced. That closes every quoting bypass a
  // quote-aware splitter could have (nothing can toggle "quote state" that
  // no longer exists) but it reopens the masking class whole-string matching
  // always had: a flag that belongs to an unrelated statement can still
  // suppress or trigger a rule for the statement that actually matters. With
  // no `deny` verdict, that masking now costs a missed (or false) `warn`,
  // never a bypassed block — the whole point of this change.
  it('an unrelated -l elsewhere in the command now masks the search that matters (accepted tradeoff, not a bug)', () => {
    // Before segmentation removal this was 'deny': the splitter kept ls -l's
    // -l from reaching the grep statement. With segmentation gone, CAPPED
    // matches the whole string and sees ls -l's -l as if it capped the grep.
    // This is the mirror image of the quoting bypass segmentation was
    // removed to close, and it is accepted for the same reason: the worst
    // outcome is now a missed warning, never a bypassed deny.
    assert.equal(v('ls -l && grep -r key /'), 'allow')
  })

  it('an unrelated rooted path elsewhere in the command can still trigger unbounded-root-search for a bounded search', () => {
    // 'cd /' has nothing to do with the grep that follows, but whole-string
    // ROOTED matching sees the bare "/" regardless of which statement it
    // came from. A false warn here is the accepted cost — it is advisory,
    // not a block.
    const r = classify('cd / && grep -r TODO src')
    assert.equal(r.verdict, 'warn')
    assert.equal(r.rule, 'unbounded-root-search')
  })

  it('still warns across ; and || separators when nothing masks it', () => {
    assert.equal(v('echo hi; grep -r key /'), 'warn')
    assert.equal(v('echo hi || grep -r key /'), 'warn')
  })

  it('a pipe cap still bounds the search it pipes from', () => {
    assert.equal(v('grep -r "TODO" / | head -50'), 'allow')
  })
})

describe('classify — C2: whole-string matching on commands that used to fracture a quote-aware splitter', () => {
  it('warns on a rooted search whose pattern contains a backslash-escaped quote plus a separator', () => {
    // This was the Round 1 bypass: a splitter that did not understand
    // backslash escapes toggled quote state on the escaped `"` and split the
    // command mid-string, so each fragment looked harmless alone and the
    // verdict silently fell to 'warn'. With no splitter at all, the whole
    // string is matched directly and this now warns for the right reason —
    // the unbounded-root-search rule, not luck.
    const r = classify(String.raw`grep -r "note: \"a && b\" is fine" /`)
    assert.equal(r.verdict, 'warn')
    assert.equal(r.rule, 'unbounded-root-search')
  })

  it('still warns on plain quoting with a separator inside it (no regression)', () => {
    assert.equal(v('grep -r "a && b" /'), 'warn')
  })

  it('still warns on the unquoted baseline', () => {
    assert.equal(v('grep -r TODO /'), 'warn')
  })

  it('warns on an unbalanced-quote command containing a rooted recursive search', () => {
    // No splitter means no quote-balance fail-safe to reason about either —
    // the string is matched as-is, whole, every time.
    assert.equal(v('grep -r "unclosed && quote /'), 'warn')
  })
})

describe('classify — the three named bypasses from the fix history, re-verified after segmentation removal', () => {
  it('bypass 1 (escaped-quote fracture): now warns, matched on the whole string', () => {
    const r = classify(String.raw`grep -r "note: \"a && b\" is fine" /`)
    assert.equal(r.verdict, 'warn')
    assert.equal(r.rule, 'unbounded-root-search')
  })

  it('bypass 2 (bash treats an escaped ; outside quotes as a literal, so this is one unbounded command): now warns', () => {
    const r = classify(String.raw`grep -r \; /`)
    assert.equal(r.verdict, 'warn')
    assert.equal(r.rule, 'unbounded-root-search')
  })

  it('bypass 3 (POSIX single quotes never honour \\, the quote never closes, -l from echo -l masks the whole string): STILL ALLOWS', () => {
    // This is not a passing assertion for the guard's safety — it is a
    // pinned, honest record of a surviving masking bypass. The design
    // rationale for this change says outright that reverting segmentation
    // does not rescue this exact command, because the unrelated -l in
    // `echo -l` masks the CAPPED check for the whole string regardless of
    // whether a splitter ran first. Do not "fix" this by tightening CAPPED
    // to require -l be adjacent to the grep/rg token — that is a real
    // parser's job, not a regex's, and is exactly the kind of patch that
    // opened the last two bypass rounds. 'allow' here is the accepted
    // ceiling: a missed warning, never a bypassed block.
    const r = classify(String.raw`grep -r 'x\' / ; echo -l`)
    assert.equal(r.verdict, 'allow')
  })
})

describe('classify — never returns deny for any input (the contract this change establishes)', () => {
  const NEVER_DENY = [
    'grep -r "TODO" /',
    'grep -r "key" ~',
    'rg "key" $HOME',
    'grep -r "key" /Users/someone',
    'grep -r key ${HOME}',
    'grep -R "key" /',
    'grep --recursive "key" /',
    'grep -r "key" /Users',
    'grep -r key /Users/me',
    'grep -r key ~/',
    'grep -r key ~',
    'grep -r key "$HOME"',
    'grep -r key $HOME/',
    'grep -r key ${HOME}/',
    'grep -r key "/"',
    "grep -r key '/'",
    'ls -l && grep -r key /',
    'echo hi; grep -r key /',
    'echo hi || grep -r key /',
    'grep -r "a && b" /',
    'grep -r TODO /',
    'grep -r "unclosed && quote /',
    String.raw`grep -r "note: \"a && b\" is fine" /`,
    String.raw`grep -r \; /`,
    String.raw`grep -r 'x\' / ; echo -l`
  ]

  it('never classifies any previously-denying command, or any of the three bypasses, as deny', () => {
    for (const cmd of NEVER_DENY) {
      const r = classify(cmd)
      assert.notEqual(r.verdict, 'deny')
      assert.ok(r.verdict === 'allow' || r.verdict === 'warn', `unexpected verdict ${r.verdict} for ${JSON.stringify(cmd)}`)
    }
  })
})

describe('classify — warn', () => {
  it('warns on a recursive search of a real directory with no cap', () => {
    const r = classify('grep -r "TODO" src')
    assert.equal(r.verdict, 'warn')
    assert.equal(r.rule, 'uncapped-recursive-search')
  })

  it('warns on find with no depth limit and no name filter', () => {
    const r = classify('find . -type f')
    assert.equal(r.verdict, 'warn')
    assert.equal(r.rule, 'uncapped-find')
  })

  it('does not warn on a capped or narrowed search', () => {
    assert.equal(v('grep -r "TODO" src | head -20'), 'allow')
    assert.equal(v('rg -l "TODO" src'), 'allow')
    assert.equal(v('find . -maxdepth 2 -type f'), 'allow')
    assert.equal(v('find . -name "*.test.js"'), 'allow')
  })

  it('does not warn on a non-recursive grep of named files', () => {
    assert.equal(v('grep "TODO" src/guard.js'), 'allow')
  })
})

describe('classify — the reason never leaks the command', () => {
  it('omits command text entirely, including an inline credential', () => {
    const secret = 'grep -r "ghp_FAKEFAKEFAKE" / --context=curl'
    const out = JSON.stringify(classify(secret))
    assert.equal(out.includes('ghp_'), false)
    assert.equal(out.includes('curl'), false)
    assert.equal(out.includes('grep'), false)
  })

  it('still returns a usable reason naming the fix', () => {
    const r = classify('grep -r "TODO" /')
    assert.match(r.reason, /head|-m|--include/)
  })

  it('omits command text from a warn-verdict result too', () => {
    const secret = 'grep -r "ghp_FAKEFAKEFAKE" src --context=curl'
    const r = classify(secret)
    assert.equal(r.verdict, 'warn')
    const out = JSON.stringify(r)
    assert.equal(out.includes('ghp_'), false)
    assert.equal(out.includes('curl'), false)
    assert.equal(out.includes('src'), false)
  })
})
