import type { ReactNode } from 'react'
import { NavLink, useNavigate } from 'react-router-dom'
import { useSession } from '@/lib/session'
import { BrandFooter, BrandLogo, BrandMark } from '@/components/Brand'

/** The driver shell: one column, big type, nothing decorative. */
export function DriverShell({
  title, subtitle, children, back, action,
}: {
  title: string
  subtitle?: string
  children: ReactNode
  back?: string
  action?: ReactNode
}) {
  const navigate = useNavigate()
  return (
    <div className="min-h-dvh bg-paper">
      <header className="sticky top-0 z-10 border-b border-line/20 bg-ink-900 text-paper">
        <div className="mx-auto flex max-w-2xl items-center gap-3 px-4 py-3">
          {back && (
            <button
              onClick={() => navigate(back)}
              aria-label="Back"
              className="-ml-2 flex h-11 w-11 items-center justify-center rounded-lg
                         text-2xl hover:bg-ink-800"
            >
              ‹
            </button>
          )}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <BrandMark height={16} className="shrink-0 text-paper/80" />
              <span className="text-paper/30" aria-hidden="true">|</span>
              <h1 className="truncate text-lg font-bold">{title}</h1>
            </div>
            {subtitle && <p className="truncate text-sm text-paper/70">{subtitle}</p>}
          </div>
          {action}
        </div>
      </header>
      <main className="mx-auto flex min-h-[calc(100dvh-4rem)] max-w-2xl flex-col
                       px-4 py-5">
        {children}
      </main>
    </div>
  )
}

/**
 * The primary action, always under the thumb.
 *
 * Sticky rather than fixed, and rendered at the end of the content flow. A
 * fixed bar sits outside layout and silently covers whatever is beneath it —
 * which on the blocked-movement screen hid the button for requesting a
 * manager's authorisation entirely. Sticky occupies real space, so it can
 * never overlap content however many buttons it grows to.
 */
export function ActionBar({ children }: { children: ReactNode }) {
  return (
    <div className="sticky bottom-0 z-20 mt-auto -mx-4 border-t border-line/20
                    bg-white/95 px-4 pb-[max(1rem,env(safe-area-inset-bottom))]
                    pt-3 backdrop-blur">
      <div className="mx-auto flex max-w-2xl flex-col gap-2">{children}</div>
    </div>
  )
}

const MANAGER_NAV = [
  { to: '/manager', label: 'Dashboard', end: true },
  { to: '/manager/manifests', label: 'Manifests' },
  { to: '/manager/assignments', label: 'Assignments' },
  { to: '/manager/exceptions', label: 'Exceptions' },
  { to: '/manager/shift-report', label: 'Shift close' },
  { to: '/manager/users', label: 'Users', adminOnly: true },
  { to: '/manager/audit', label: 'Audit log' },
]

/** The manager shell: responsive, sidebar on desktop, tabs on tablet. */
export function ManagerShell({
  title, subtitle, children, action,
}: { title: string; subtitle?: string; children: ReactNode; action?: ReactNode }) {
  const { profile, signOut } = useSession()
  return (
    <div className="min-h-dvh bg-paper lg:flex">
      <nav
        aria-label="Sections"
        className="border-b border-line/20 bg-ink-900 text-paper
                   lg:w-60 lg:shrink-0 lg:border-b-0 lg:border-r"
      >
        <div className="px-4 py-4">
          <div className="inline-block rounded-lg bg-white px-3 py-2">
            <BrandLogo width={168} />
          </div>
        </div>
        {/* Hiding a link the role cannot use is courtesy, not security: the
            route guard refuses it and RLS returns nothing regardless. */}
        <ul className="flex gap-1 overflow-x-auto px-2 pb-2 lg:flex-col lg:overflow-visible">
          {MANAGER_NAV
            .filter((item) => !item.adminOnly || profile?.role === 'ADMIN')
            .map((item) => (
            <li key={item.to}>
              <NavLink
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  `block whitespace-nowrap rounded-lg px-3 py-2.5 text-sm font-medium
                   ${isActive ? 'bg-paper text-ink-900' : 'text-paper/75 hover:bg-ink-800'}`
                }
              >
                {item.label}
              </NavLink>
            </li>
          ))}
        </ul>
        <div className="hidden px-4 py-4 text-sm text-paper/60 lg:block">
          <p className="font-medium text-paper">{profile?.fullName}</p>
          <p className="mb-3">{profile?.role}</p>
          <button onClick={signOut} className="underline hover:text-paper">
            Sign out
          </button>
          <BrandFooter className="mt-6 text-left text-paper/40" />
        </div>
      </nav>

      <div className="min-w-0 flex-1">
        <header className="border-b border-line/20 bg-white px-5 py-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h1 className="text-xl font-bold text-ink-900">{title}</h1>
              {subtitle && <p className="text-sm text-ink-600">{subtitle}</p>}
            </div>
            {action}
          </div>
        </header>
        <main className="px-5 py-5">{children}</main>
      </div>
    </div>
  )
}
