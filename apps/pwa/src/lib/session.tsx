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
 * PHASE 3 NOTE: this is backed by the mock data source and grants nothing —
 * there is no real authentication yet, and nothing is protected. Phase 4
 * replaces the implementation with Supabase Auth. The important property, then
 * and now, is that this context decides which SCREEN renders and never which
 * DATA returns: that is RLS's job, and it stays RLS's job.
 */
export function SessionProvider({ children }: { children: ReactNode }) {
  const data = useData()
  const [profile, setProfile] = useState<Profile | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    data.currentProfile()
      .then((p) => { if (!cancelled) setProfile(p) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
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
