export function ProgressBar({
  value, total, tone = 'brand', label,
}: { value: number; total: number; tone?: 'brand' | 'ok'; label?: string }) {
  const pct = total === 0 ? 0 : Math.round((value / total) * 100)
  return (
    <div>
      {label && (
        <div className="mb-1 flex items-baseline justify-between text-sm">
          <span className="font-medium text-ink-700">{label}</span>
          <span className="code font-semibold text-ink-900">{value} / {total}</span>
        </div>
      )}
      <div
        className="h-3 w-full overflow-hidden rounded-full bg-paper-dim"
        role="progressbar"
        aria-valuenow={value}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-label={label ?? 'progress'}
      >
        <div
          className={`h-full rounded-full transition-[width] ${
            tone === 'ok' ? 'bg-ok-500' : 'bg-brand-600'
          }`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}

/**
 * Slot dots for a container: ●●, ●○, ○○.
 *
 * The most valuable indicator on the manager's board — a half-filled container
 * is the error no per-movement check can see, because every scan passed.
 */
export function SlotDots({
  filled, capacity,
}: { filled: number; capacity: number }) {
  return (
    <span
      className="inline-flex gap-1"
      aria-label={`${filled} of ${capacity} vehicles loaded`}
    >
      {Array.from({ length: capacity }, (_, i) => (
        <span
          key={i}
          aria-hidden="true"
          className={`inline-block h-3 w-3 rounded-full border-2 ${
            i < filled ? 'border-ok-500 bg-ok-500' : 'border-idle-500 bg-transparent'
          }`}
        />
      ))}
    </span>
  )
}
