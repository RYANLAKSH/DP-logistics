import type { ReactNode } from 'react'
import { Button } from './Button'

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <div role="status" className="flex items-center gap-3 py-8 text-ink-600">
      <span
        aria-hidden="true"
        className="h-5 w-5 animate-spin rounded-full border-2 border-line
                   border-t-ink-900"
      />
      {label}…
    </div>
  )
}

/**
 * An empty state always says WHY it is empty. "No tasks" leaves a driver
 * standing in a yard with no idea whether the app is broken or their shift is
 * finished, and those need different responses.
 */
export function EmptyState({
  title, detail, action,
}: { title: string; detail: string; action?: ReactNode }) {
  return (
    <div className="rounded-card border border-dashed border-line/40 bg-white px-6 py-10 text-center">
      <p className="text-lg font-semibold text-ink-900">{title}</p>
      <p className="mx-auto mt-1 max-w-md text-sm text-ink-600">{detail}</p>
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  )
}

export function ErrorState({
  detail, onRetry,
}: { detail: string; onRetry?: () => void }) {
  return (
    <div className="rounded-card border-2 border-bad-500 bg-bad-100 px-5 py-4">
      <p className="font-semibold text-bad-500">Something went wrong</p>
      <p className="mt-1 text-sm text-ink-700">{detail}</p>
      {onRetry && (
        <Button variant="secondary" className="mt-3" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  )
}
