/** Presentation helpers. Nothing here changes a value — only how it reads. */

/**
 * Groups a long identifier so a human can check it character by character.
 * Purely visual: the grouped form is never compared or submitted.
 */
export function groupCode(code: string, size = 4): string {
  const s = code.replace(/\s+/g, '')
  const out: string[] = []
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size))
  return out.join(' ')
}

export function timeOfDay(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export function dateLong(iso: string): string {
  return new Date(iso).toLocaleDateString([], {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
  })
}

export function relativeTime(iso: string, now = Date.now()): string {
  const secs = Math.round((now - new Date(iso).getTime()) / 1000)
  if (secs < 60) return 'just now'
  const mins = Math.round(secs / 60)
  if (mins < 60) return `${mins} min ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours} h ago`
  return `${Math.round(hours / 24)} d ago`
}

/**
 * Highlights where two identifiers diverge. This is what turns "those look
 * similar" into "character 9 differs", which is the difference between a
 * driver trusting a block and arguing with it.
 */
export function diffPositions(a: string, b: string): number[] {
  const out: number[] = []
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i++) if (a[i] !== b[i]) out.push(i)
  return out
}
