import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Button } from '@/components/Button'
import { BrandMark } from '@/components/Brand'
import { reportError } from './telemetry'

interface State { error: Error | null }

/**
 * The last thing between a render error and a white screen.
 *
 * Without one, a single thrown error unmounts the entire tree: a driver
 * halfway through a shift is left holding a blank phone, with no message, no
 * way back, and no record that anything happened. That is the worst failure
 * this app has, because it is the one where nobody even learns there was a
 * problem.
 *
 * What matters in the fallback is not an apology. It is that the driver can
 * get back to work in one tap, that unsent work is described as safe because
 * it is (the outbox is in IndexedDB, not in React state), and that the error
 * reached somewhere a manager can find it.
 */
export class ErrorBoundary extends Component<
  { children: ReactNode; role?: string }, State
> {
  override state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    reportError(error, { role: this.props.role })
    // The component stack is the part that says WHERE, and React does not put
    // it on the error itself.
    console.error('[ryla] component stack', info.componentStack)
  }

  override render() {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      <div className="flex min-h-dvh flex-col justify-center bg-ink-900 px-5 py-10">
        <div className="mx-auto w-full max-w-sm text-center">
          <BrandMark className="mx-auto h-12 w-12 text-paper" />
          <h1 className="mt-6 text-2xl font-bold text-paper">This screen stopped</h1>
          <p className="mt-2 text-paper/75">
            Nothing you have already scanned or confirmed is lost — it is saved on this
            phone and will be sent when it can be.
          </p>
          <div className="mt-6 flex flex-col gap-3">
            {/* Reload rather than reset: the tree that threw is not a tree to
                keep rendering, and a service worker update is a common reason
                for a screen to break exactly once. */}
            <Button hero onClick={() => window.location.reload()}>
              Reload and carry on
            </Button>
            <Button
              variant="secondary"
              onClick={() => { window.location.href = '/' }}
            >
              Back to my tasks
            </Button>
          </div>
          <p className="code mt-6 break-words text-xs text-paper/50">
            {error.message.slice(0, 200)}
          </p>
          <p className="mt-2 text-xs text-paper/50">
            Show this screen to your manager if it keeps happening.
          </p>
        </div>
      </div>
    )
  }
}
