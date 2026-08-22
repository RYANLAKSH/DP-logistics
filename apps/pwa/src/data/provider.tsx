import {
  createContext, useContext, useEffect, useMemo, useState, type ReactNode,
} from 'react'
import type { DataSource } from './DataSource'
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
  // Configured builds resolve synchronously, so nothing about the mock is on
  // the path to a login screen.
  const eager = useMemo(
    () => source ?? (supabaseConfigured ? new SupabaseDataSource() : null),
    [source],
  )
  const [value, setValue] = useState<DataSource | null>(eager)

  /**
   * The mock is imported dynamically, and that is a payload decision rather
   * than a stylistic one.
   *
   * It drags in the fixtures, the CSV parser and the browser XLSX reader —
   * none of which a configured build ever executes, and all of which were
   * landing in the entry chunk that a driver downloads on a mid-range phone
   * before the login screen paints. Behind a dynamic import they become a
   * chunk production never asks for.
   */
  useEffect(() => {
    if (eager) { setValue(eager); return }
    let alive = true
    void import('./mock/MockDataSource').then((m) => {
      if (alive) setValue(new m.MockDataSource())
    })
    return () => { alive = false }
  }, [eager])

  if (!value) return null
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
