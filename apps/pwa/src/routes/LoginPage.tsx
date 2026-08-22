import { useState, type FormEvent } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { Button } from '@/components/Button'
import { homeFor, useSession } from '@/lib/session'
import { BrandFooter, BrandLogo } from '@/components/Brand'
import { useIsMockBackend } from '@/data/provider'

export function LoginPage() {
  const { profile, signIn, loading } = useSession()
  const isMock = useIsMockBackend()
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
        <div className="mb-8 flex flex-col items-center text-center">
          {/* On navy, the logo needs its own light plate: the wordmark is navy
              and the tagline is grey, and neither survives being placed
              directly on the shell's background. */}
          <div className="rounded-card bg-white px-6 py-4">
            <BrandLogo width={216} />
          </div>
          <p className="mt-4 text-sm text-paper/70">
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
          {/* Only shown on the mock backend; with Supabase configured there is
              nothing to preview and this would be misleading. */}
          {isMock && (
            <p className="rounded-lg bg-warn-100 px-3 py-2 text-xs text-ink-700">
              <strong>Demo data.</strong> No backend is configured. Sign in with
              <code className="code"> driver@</code>, <code className="code">manager@</code> or
              <code className="code"> admin@</code> to preview each role.
            </p>
          )}
        </form>

        <BrandFooter className="mt-6 text-paper/60" />
      </div>
    </div>
  )
}
