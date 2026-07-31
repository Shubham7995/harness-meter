import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { chmodSync, statSync } from 'node:fs'
import { listInstalledPlugins, pickNewestVersion, readDescription } from '../src/adapter/plugins.js'
import { AdapterMismatch } from '../src/adapter/errors.js'

const GOOD = fileURLToPath(new URL('./fixtures/good/', import.meta.url))
const EMPTY = fileURLToPath(new URL('./fixtures/empty/', import.meta.url))
const FLATTENED = fileURLToPath(new URL('./fixtures/flattened-cache/', import.meta.url))
const UNREADABLE_SKILL = fileURLToPath(new URL('./fixtures/unreadable-skill/', import.meta.url))

describe('pickNewestVersion', () => {
  it('compares numerically, not lexically', () => {
    assert.equal(pickNewestVersion(['1.9.0', '1.10.0']), '1.10.0')
    assert.equal(pickNewestVersion(['6.0.3', '6.2.0', '6.1.1']), '6.2.0')
  })
})

describe('readDescription', () => {
  it('extracts a description from frontmatter', () => {
    assert.equal(readDescription('---\nname: x\ndescription: hello\n---\nbody').text, 'hello')
  })

  it('returns empty string when frontmatter is absent', () => {
    assert.equal(readDescription('no frontmatter here').text, '')
  })

  it('returns empty string when description is absent', () => {
    assert.equal(readDescription('---\nname: x\n---\nbody').text, '')
  })

  it('captures both paragraphs of a `description: |` block scalar across a blank line', () => {
    const text = [
      '---',
      'name: x',
      'description: |',
      '  Paragraph one.',
      '',
      '  Paragraph two.',
      '---',
      'body'
    ].join('\n')
    const d = readDescription(text).text
    assert.match(d, /Paragraph one\./)
    assert.match(d, /Paragraph two\./)
  })

  it('stops a `description: |` block scalar at the next top-level frontmatter key', () => {
    const text = [
      '---',
      'name: x',
      'description: |',
      '  Paragraph one.',
      '',
      '  Paragraph two.',
      'version: 1.0.0',
      '---',
      'body'
    ].join('\n')
    const d = readDescription(text).text
    assert.match(d, /Paragraph one\./)
    assert.match(d, /Paragraph two\./)
    assert.equal(d.includes('version'), false)
    assert.equal(d.includes('1.0.0'), false)
  })

  it('captures both paragraphs of a `description: >` folded scalar across a blank line', () => {
    const text = [
      '---',
      'name: x',
      'description: >',
      '  Folded paragraph one.',
      '',
      '  Folded paragraph two.',
      '---',
      'body'
    ].join('\n')
    const d = readDescription(text).text
    assert.match(d, /Folded paragraph one\./)
    assert.match(d, /Folded paragraph two\./)
  })
})

describe('readDescription measurability', () => {
  it('reports measurable for a real description', () => {
    const r = readDescription('---\nname: x\ndescription: hello\n---\nbody')
    assert.equal(r.text, 'hello')
    assert.equal(r.measurable, true)
  })

  it('reports measurable for a genuinely empty description', () => {
    assert.equal(readDescription('---\nname: x\ndescription:\n---\nb').measurable, true)
  })

  it('reports UNmeasurable when frontmatter is absent', () => {
    const r = readDescription('no frontmatter here')
    assert.equal(r.text, '')
    assert.equal(r.measurable, false)
  })

  it('reports UNmeasurable when the description key is absent', () => {
    assert.equal(readDescription('---\nname: x\n---\nbody').measurable, false)
  })

  it('handles CRLF frontmatter rather than calling it unmeasurable', () => {
    const r = readDescription('---\r\nname: x\r\ndescription: hi\r\n---\r\nbody')
    assert.equal(r.text, 'hi')
    assert.equal(r.measurable, true)
  })
})

describe('listInstalledPlugins', () => {
  it('returns only enabled plugins', () => {
    const names = listInstalledPlugins(GOOD, ['azure']).map(p => p.name)
    assert.deepEqual(names, ['azure'])
  })

  it('selects the newest version', () => {
    const [azure] = listInstalledPlugins(GOOD, ['azure'])
    assert.equal(azure.version, '1.10.0')
    // fixtures/good/.../azure/1.10.0/skills/ now also has azure-nodesc, a
    // fixture with frontmatter but no description: key (added for the
    // 'threads measurable through collect()' test below). It sorts after
    // azure-compute alphabetically.
    assert.deepEqual(azure.skills.map(s => s.name), ['azure-compute', 'azure-nodesc'])
  })

  it('counts description bytes for skills and agents', () => {
    const [azure] = listInstalledPlugins(GOOD, ['azure'])
    assert.equal(azure.skills[0].descriptionBytes, 40)
    assert.equal(azure.agents[0].descriptionBytes, 20)
  })

  it('threads measurable through collect() from a real file with no description key', () => {
    // The line `measurable: desc.measurable` inside collect() is what
    // carries readDescription()'s measurability detection into the
    // Descriptor objects that flow through listInstalledPlugins() ->
    // runAudit() -> toJson().unmeasurable. Nothing else in this suite reads
    // a real file with no description: key through collect(), so a
    // hardcoded `measurable: true` at that line would go undetected without
    // this test.
    const [azure] = listInstalledPlugins(GOOD, ['azure'])
    const nodesc = azure.skills.find(s => s.name === 'azure-nodesc')
    const compute = azure.skills.find(s => s.name === 'azure-compute')
    assert.equal(nodesc.measurable, false)
    // The sibling assertion matters just as much: it is what would catch a
    // hardcoded `measurable: false` instead of a hardcoded `true`.
    assert.equal(compute.measurable, true)
  })

  it('omits enabled plugins that are not installed', () => {
    const names = listInstalledPlugins(GOOD, ['azure', 'ghost']).map(p => p.name)
    assert.deepEqual(names, ['azure'])
  })

  it('throws AdapterMismatch when the plugin cache is absent', () => {
    assert.throws(() => listInstalledPlugins(EMPTY, ['azure']), AdapterMismatch)
  })

  it('throws AdapterMismatch when the cache exists but no enabled plugin resolves (layout changed)', () => {
    // fixtures/flattened-cache mimics Claude Code flattening
    // plugins/cache/<marketplace>/<name>/<version> down to
    // plugins/cache/<name>/<version> — one directory level short. The cache
    // directory is present, but every wanted.has(name) check misses because
    // "1.10.0" is read as a plugin name, not "azure". Silently returning []
    // here would let the markdown reporter claim a false "measured zero".
    assert.throws(() => listInstalledPlugins(FLATTENED, ['azure']), AdapterMismatch)
  })

  it('returns [] without throwing when enabledNames is empty, even for a bare cache dir', () => {
    // The honest zero: nothing is enabled, so finding nothing is not a
    // layout-mismatch signal. Must remain reachable.
    assert.deepEqual(listInstalledPlugins(GOOD, []), [])
  })

  it('ignores stray non-plugin files in the cache tree instead of crashing', () => {
    // Three stray files sit alongside real plugin directories; all must be
    // skipped, not crash:
    //   - cache/.hidden-stray: a hidden file (stand-in for e.g. macOS
    //     .DS_Store, which is itself gitignored repo-wide). Filtered by the
    //     dot-file check in dirsIn(), before isDirectory() is ever reached.
    //   - cache/mk/README.md: a non-hidden file at the plugin-name level.
    //     Even without isDirectory(), it would be discarded by the
    //     `wanted.has(name)` check, since "README.md" is never an enabled
    //     plugin name.
    //   - cache/NOTES.md: a non-hidden file directly at the cache root, a
    //     sibling of the `mk` marketplace directory. This is the one entry
    //     that reaches dirsIn()'s isDirectory() check unshielded by any
    //     other filter (the marketplace loop has no wanted-set check) — if
    //     that check were ever removed, this fixture would make the suite
    //     fail with ENOTDIR instead of silently staying green.
    assert.doesNotThrow(() => listInstalledPlugins(GOOD, ['azure', 'superpowers']))
    const names = listInstalledPlugins(GOOD, ['azure', 'superpowers']).map(p => p.name)
    assert.deepEqual(names, ['azure', 'superpowers'])
  })

  it('does not crash on a dangling symlink in the cache', () => {
    // fixture created in Step 6
    assert.doesNotThrow(() => listInstalledPlugins(GOOD, ['azure']))
  })

  it('surfaces a live symlinked plugin directory instead of silently dropping it', () => {
    // cache/mk/azure-link is a symlink to ./azure (real version subdirs and
    // all). The wanted list deliberately includes a REAL sibling
    // ('superpowers') alongside the symlinked name: if isDir() were ever
    // reverted to a bare entry.isDirectory(), 'azure-link' would vanish from
    // dirsIn()'s output silently (no throw, since 'superpowers' still
    // resolves and found.length > 0) and this exact deepEqual would catch
    // the shrunk list. A wanted list of only ['azure-link'] would instead
    // make a revert hit the `enabledNames.length > 0 && found.length === 0`
    // AdapterMismatch throw — a loud failure, not the silent one this test
    // exists to guard against.
    const names = listInstalledPlugins(GOOD, ['azure-link', 'superpowers']).map(p => p.name)
    assert.deepEqual(names, ['azure-link', 'superpowers'])
  })
})

describe('descriptor read failures are loud', () => {
  const isRoot = process.getuid?.() === 0
  if (isRoot) {
    console.log('skipping unreadable-SKILL.md test: running as root, chmod 000 does not prevent reads')
  }

  ;(isRoot ? it.skip : it)('throws AdapterMismatch when a SKILL.md exists but cannot be read', () => {
    // Uses its own single-purpose fixture (unreadable-skill/), not GOOD —
    // GOOD is read concurrently by audit.test.js and hooks.test.js (both of
    // which run as separate, parallel test-file processes under
    // `node --test`), and a shared chmod 000 window flaked ~17% of suite
    // runs (Blocker I5). Nothing else in the suite points at this fixture.
    const file = fileURLToPath(new URL('./fixtures/unreadable-skill/plugins/cache/mk/probe/1.0.0/skills/probe-skill/SKILL.md', import.meta.url))
    const original = statSync(file).mode
    chmodSync(file, 0o000)
    try {
      assert.throws(() => listInstalledPlugins(UNREADABLE_SKILL, ['probe']), AdapterMismatch)
    } finally {
      chmodSync(file, original)
    }
  })
})
