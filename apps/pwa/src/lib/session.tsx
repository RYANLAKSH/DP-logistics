import {
  createContext, useCallback, useContext, useEffect, useMemo, useState,
  type ReactNode,
} from 'react'
import { useNavigate } from 'react-router-dom'
import { useData } from '@/data/provider'
import type { Profile } from '@/data/types'

interface SessionValue {
  profile: Profile | null
  loading: boolean
  signIn(email: string, password: string): Promise<Profile>
  signOut(): Promise<void>
}

const SessionContext = createContext<SessionValue | null>(null)

/**
 * Holds who is signed in, for the UI's benefit.
 *
 * Backed by Supabase Auth when configured, and by the mock otherwise. The
 * important property either way: this context decides which SCREEN renders and
 * never which DATA returns. That is RLS's job, in the database, and it stays
 * RLS's job — a user who edits this state in devtools gains a screen, not a row.
 */
export function SessionProvider({ children }: { children: ReactNode }) {
  const data = useData()
  const [profile, setProfile] = useState<Profile | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false

    function refresh() {
      return data.currentProfile()
        .then((p) => { if (!cancelled) setProfile(p) })
        .catch(() => { if (!cancelled) setProfile(null) })
        .finally(() => { if (!cancelled) setLoading(false) })
    }

    void refresh()

    // Supabase refreshes tokens in the background and can drop a session when
    // a refresh token is revoked — for instance when an administrator
    // deactivates the user. React to that rather than waiting for the next
    // failed request, so a revoked user is returned to the login screen.
    const withAuthEvents = data as Partial<{
      onAuthChange(handler: (signedIn: boolean) => void): () => void
    }>
    const unsubscribe = withAuthEvents.onAuthChange?.((signedIn) => {
      if (!signedIn) setProfile(null)
      else void refresh()
    })

    return () => { cancelled = true; unsubscribe?.() }
  }, [data])

  const signIn = useCallback(async (email: string, password: string) => {
    const p = await data.signIn(email, password)
    setProfile(p)
    return p
  }, [data])

  const signOut = useCallback(async () => {
    await data.signOut()
    setProfile(null)
  }, [data])

  const value = useMemo(
    () => ({ profile, loading, signIn, signOut }),
    [profile, loading, signIn, signOut],
  )

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}

export function useSession(): SessionValue {
  const ctx = useContext(SessionContext)
  if (!ctx) throw new Error('useSession must be used inside <SessionProvider>')
  return ctx
}

/** Where a role lands after signing in. */
export function homeFor(profile: Profile): string {
  return profile.role === 'DRIVER' ? '/driver' : '/manager'
}

export function useSignOut(): () => void {
  const { signOut } = useSession()
  const navigate = useNavigate()
  return useCallback(() => {
    void signOut().then(() => navigate('/login', { replace: true }))
  }, [signOut, navigate])
}
