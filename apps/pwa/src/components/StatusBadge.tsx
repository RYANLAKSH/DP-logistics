import { STATUS, toneClasses, type StatusKey } from '@/lib/status'

/**
 * Word + icon + colour, always all three. A badge that relied on colour alone
 * would be unreadable in sunlight and invisible to a colour-blind driver.
 */
export function StatusBadge({
  status, size = 'md',
}: { status: StatusKey; size?: 'sm' | 'md' | 'lg' }) {
  const meta = STATUS[status]
  const sizing =
    size === 'lg' ? 'text-base px-3 py-1.5'
    : size === 'sm' ? 'text-xs px-2 py-0.5'
    : 'text-sm px-2.5 py-1'
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border font-semibold
                  uppercase tracking-wide ${toneClasses(meta.tone)} ${sizing}`}
    >
      <span aria-hidden="true">{meta.icon}</span>
      {meta.label}
    </span>
  )
}
