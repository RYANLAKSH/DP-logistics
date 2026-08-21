import { createContext, useContext, useMemo, type ReactNode } from 'react'
import type { DataSource } from './DataSource'
import { MockDataSource } from './mock/MockDataSource'
import { SupabaseDataSource } from './supabase/SupabaseDataSource'
import { supabaseConfigured } from './supabase/client'

const DataContext = createContext<DataSource | null>(null)

/**
 * The one place the app decides which backend it is talking to.
 *
 * Supabase when it is configured; the mock otherwise, so the UI can be
 * developed and demonstrated without a project. The mock is never a fallback
 * for a *failing* Supabase — only for an unconfigured one. Silently degrading
 * to fake data when the real backend is unreachable would show a driver a
 * verification that never happened.
 */
export function DataProvider({
  children, source,
}: { children: ReactNode; source?: DataSource }) {
  const value = useMemo(
    () => source ?? (supabaseConfigured ? new SupabaseDataSource() : new MockDataSource()),
    [source],
  )
  return <DataContext.Provider value={value}>{children}</DataContext.Provider>
}

export function useData(): DataSource {
  const ctx = useContext(DataContext)
  if (!ctx) throw new Error('useData must be used inside <DataProvider>')
  return ctx
}

/** True when the app is running on fixtures rather than a real backend. */
export function useIsMockBackend(): boolean {
  return useData().kind === 'mock'
}
