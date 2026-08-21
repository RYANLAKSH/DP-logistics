import { useState, type FormEvent } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { Button } from '@/components/Button'
import { homeFor, useSession } from '@/lib/session'

export function LoginPage() {
  const { profile, signIn, loading } = useSession()
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!loading && profile) return <Navigate to={homeFor(profile)} replace />

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const p = await signIn(email, password)
      navigate(homeFor(p), { replace: true })
    } catch {
      setError('Could not sign in. Check your email and password.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-dvh flex-col justify-center bg-ink-900 px-5 py-10">
      <div className="mx-auto w-full max-w-sm">
        <div className="mb-8 text-center">
          <p className="text-4xl text-brand-500" aria-hidden="true">✓</p>
          <h1 className="mt-2 text-2xl font-bold text-paper">DP Verify</h1>
          <p className="mt-1 text-sm text-paper/70">
            The right vehicle, into the right container.
          </p>
        </div>

        <form onSubmit={onSubmit} className="space-y-4 rounded-card bg-white p-5">
          <label className="block">
            <span className="mb-1 block text-sm font-semibold text-ink-700">Email</span>
            <input
              type="email"
              required
              autoComplete="username"
              inputMode="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-lg border-2 border-line/40 px-3 py-3 text-base
                         focus:border-ink-900"
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-sm font-semibold text-ink-700">Password</span>
            <input
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-lg border-2 border-line/40 px-3 py-3 text-base
                         focus:border-ink-900"
            />
          </label>

          {error && (
            <p role="alert" className="rounded-lg bg-bad-100 px-3 py-2 text-sm text-bad-500">
              {error}
            </p>
          )}

          <Button hero type="submit" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </Button>

          {/* Phase 3 only. Removed when Supabase Auth lands in phase 4. */}
          <p className="rounded-lg bg-warn-100 px-3 py-2 text-xs text-ink-700">
            <strong>Phase 3 shell.</strong> No authentication is wired yet. Sign in with
            <code className="code"> driver@</code>, <code className="code">manager@</code> or
            <code className="code"> admin@</code> to preview each role.
          </p>
        </form>
      </div>
    </div>
  )
}
