// A deliberately simple line diff. It exists so a human sees what will change
// before it changes, not to be a minimal edit script.
export function renderDiff (before, after) {
  if (before === after) return ''
  const a = before === null ? [] : before.split('\n')
  const b = after.split('\n')
  const out = []
  const max = Math.max(a.length, b.length)
  for (let i = 0; i < max; i++) {
    if (a[i] === b[i]) {
      if (a[i] !== undefined) out.push(` ${a[i]}`)
      continue
    }
    if (a[i] !== undefined) out.push(`-${a[i]}`)
    if (b[i] !== undefined) out.push(`+${b[i]}`)
  }
  return out.join('\n')
}
