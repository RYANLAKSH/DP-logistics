import { createContext, useContext, useMemo, type ReactNode } from 'react'
import type { DataSource } from './DataSource'
import { MockDataSource } from './mock/MockDataSource'

const DataContext = createContext<DataSource | null>(null)

/**
 * The one place the app decides which backend it is talking to. Swapping the
 * mock for Supabase is a change here and nowhere else.
 */
export function DataProvider({
  children, source,
}: { children: ReactNode; source?: DataSource }) {
  const value = useMemo(() => source ?? new MockDataSource(), [source])
  return <DataContext.Provider value={value}>{children}</DataContext.Provider>
}

export function useData(): DataSource {
  const ctx = useContext(DataContext)
  if (!ctx) throw new Error('useData must be used inside <DataProvider>')
  return ctx
}
