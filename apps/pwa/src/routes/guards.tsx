import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { useSession, homeFor } from '@/lib/session'
import { Spinner } from '@/components/States'
import type { UserRole } from '@/data/types'

/**
 * Route guards decide WHICH SCREEN RENDERS. They do not decide which data
 * returns — that is RLS, in the database.
 *
 * The acceptance test for this file: delete it, and a user who navigates
 * directly to a route they should not see gets the screen shell with an empty
 * table, because every query underneath returns nothing. If removing a guard
 * would expose data, the authorisation model is wrong and the fix belongs in a
 * policy, not here.
 */
export function RequireAuth() {
  const { profile, loading } = useSession()
  const location = useLocation()
  if (loading) return <Spinner label="Checking your session" />
  if (!profile) return <Navigate to="/login" replace state={{ from: location.pathname }} />
  return <Outlet />
}

export function RequireRole({ allow }: { allow: UserRole[] }) {
  const { profile, loading } = useSession()
  if (loading) return <Spinner label="Checking your session" />
  if (!profile) return <Navigate to="/login" replace />
  if (!allow.includes(profile.role)) return <Navigate to="/403" replace />
  return <Outlet />
}

/**
 * ADMIN can reach everything a MANAGER can. The reverse is not true, so
 * admin-only screens use this rather than widening RequireRole.
 */
export function RequireAdmin() {
  return <RequireRole allow={['ADMIN']} />
}

export function RoleHome() {
  const { profile, loading } = useSession()
  if (loading) return <Spinner label="Loading" />
  if (!profile) return <Navigate to="/login" replace />
  return <Navigate to={homeFor(profile)} replace />
}
