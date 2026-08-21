import { Link } from 'react-router-dom'
import { Button } from '@/components/Button'

function Shell({ code, title, detail }: { code: string; title: string; detail: string }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4 px-6 text-center">
      <p className="code text-5xl font-bold text-ink-600">{code}</p>
      <h1 className="text-2xl font-bold text-ink-900">{title}</h1>
      <p className="max-w-md text-ink-600">{detail}</p>
      <Link to="/"><Button variant="secondary">Back to start</Button></Link>
    </div>
  )
}

export function UnauthorizedPage() {
  return (
    <Shell
      code="403"
      title="You do not have access to this"
      detail="Your account does not carry the role this screen needs. If that looks wrong, your manager can check your role and yard assignments."
    />
  )
}

export function NotFoundPage() {
  return (
    <Shell
      code="404"
      title="That page does not exist"
      detail="The link may be out of date, or the task it pointed at may have been completed by someone else."
    />
  )
}

export function OfflinePage() {
  return (
    <Shell
      code="⚡"
      title="You are offline"
      detail="This screen needs a connection. Your scans and queued movements are safe on this device and will sync when signal returns."
    />
  )
}
