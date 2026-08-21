import { groupCode } from '@/lib/format'

/**
 * A container or chassis number, rendered to be checked character by character.
 *
 * `highlight` marks the positions that differ from an expected value — turning
 * "those look similar" into "character 9 differs", which is what makes a driver
 * trust a block instead of arguing with it.
 */
export function CodeValue({
  value, size = 'md', highlight, label,
}: {
  value: string
  size?: 'sm' | 'md' | 'lg'
  highlight?: number[]
  label?: string
}) {
  const sizing =
    size === 'lg' ? 'text-code font-bold'
    : size === 'sm' ? 'text-sm'
    : 'text-lg font-semibold'

  const body = highlight?.length
    ? [...value].map((ch, i) => (
        <span
          key={i}
          className={highlight.includes(i) ? 'rounded bg-bad-100 text-bad-500 px-0.5' : ''}
        >
          {ch}
        </span>
      ))
    : groupCode(value)

  return (
    <span className="block">
      {label && (
        <span className="mb-0.5 block text-xs font-semibold uppercase tracking-wider text-ink-600">
          {label}
        </span>
      )}
      <span className={`code break-all text-ink-900 ${sizing}`}>{body}</span>
    </span>
  )
}
