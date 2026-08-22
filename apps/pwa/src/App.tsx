import { lazy, Suspense } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { Spinner } from '@/components/States'
import { DataProvider } from '@/data/provider'
import { OcrProviderScope } from '@/lib/ocr/provider'
import { UpdateBanner } from '@/lib/serviceWorker'
import { SessionProvider } from '@/lib/session'
import { RequireAdmin, RequireAuth, RequireRole, RoleHome } from '@/routes/guards'
import { LoginPage } from '@/routes/LoginPage'
import { NotFoundPage, OfflinePage, UnauthorizedPage } from '@/routes/ErrorPages'

/**
 * Routes are split at the role boundary.
 *
 * A driver's phone should not download the manifest preview grid, the audit
 * table or the realtime board — surfaces they can never open. Before this the
 * whole app was one 726 KB chunk, every byte of it on the critical path of a
 * shift start on a mid-range handset over yard Wi-Fi.
 *
 * Login and the error pages stay eager: they are the first thing rendered, and
 * a lazy boundary there would trade a small download for a visible flash.
 */
const DriverHomePage = lazy(() => import('@/routes/driver/DriverHomePage')
  .then((m) => ({ default: m.DriverHomePage })))
const PickupDetailPage = lazy(() => import('@/routes/driver/PickupDetailPage')
  .then((m) => ({ default: m.PickupDetailPage })))
const ScanPage = lazy(() => import('@/routes/driver/ScanPage')
  .then((m) => ({ default: m.ScanPage })))
const VerificationResultPage = lazy(() => import('@/routes/driver/VerificationResultPage')
  .then((m) => ({ default: m.VerificationResultPage })))
const ExceptionReportPage = lazy(() => import('@/routes/driver/ExceptionReportPage')
  .then((m) => ({ default: m.ExceptionReportPage })))
const CompletedJobsPage = lazy(() => import('@/routes/driver/CompletedJobsPage')
  .then((m) => ({ default: m.CompletedJobsPage })))
const SyncPage = lazy(() => import('@/routes/driver/SyncPage')
  .then((m) => ({ default: m.SyncPage })))

const DashboardPage = lazy(() => import('@/routes/manager/DashboardPage')
  .then((m) => ({ default: m.DashboardPage })))
const ManifestUploadPage = lazy(() => import('@/routes/manager/ManifestUploadPage')
  .then((m) => ({ default: m.ManifestUploadPage })))
const ManifestPreviewPage = lazy(() => import('@/routes/manager/ManifestPreviewPage')
  .then((m) => ({ default: m.ManifestPreviewPage })))
const ManifestHistoryPage = lazy(() => import('@/routes/manager/ManifestHistoryPage')
  .then((m) => ({ default: m.ManifestHistoryPage })))
const AssignmentsPage = lazy(() => import('@/routes/manager/AssignmentsPage')
  .then((m) => ({ default: m.AssignmentsPage })))
const ExceptionsPage = lazy(() => import('@/routes/manager/ExceptionsPage')
  .then((m) => ({ default: m.ExceptionsPage })))
const UsersPage = lazy(() => import('@/routes/manager/UsersPage')
  .then((m) => ({ default: m.UsersPage })))
const AuditLogPage = lazy(() => import('@/routes/manager/AuditLogPage')
  .then((m) => ({ default: m.AuditLogPage })))
const MovementDetailPage = lazy(() => import('@/routes/manager/MovementDetailPage')
  .then((m) => ({ default: m.MovementDetailPage })))
const ShiftReportPage = lazy(() => import('@/routes/manager/ShiftReportPage')
  .then((m) => ({ default: m.ShiftReportPage })))

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Yard data changes under the driver's feet; a stale task list is worse
      // than a slightly slower one.
      staleTime: 30_000,
      refetchOnWindowFocus: true,
      retry: 1,
    },
  },
})

export function AppRoutes() {
  return (
    <Suspense fallback={<Spinner label="Loading" />}>
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/403" element={<UnauthorizedPage />} />
      <Route path="/offline" element={<OfflinePage />} />

      <Route element={<RequireAuth />}>
        <Route path="/" element={<RoleHome />} />

        <Route element={<RequireRole allow={['DRIVER']} />}>
          <Route path="/driver" element={<DriverHomePage />} />
          <Route path="/driver/completed" element={<CompletedJobsPage />} />
          <Route path="/driver/sync" element={<SyncPage />} />
          <Route path="/driver/pickup/:assignmentId" element={<PickupDetailPage />} />
          <Route
            path="/driver/pickup/:assignmentId/scan/container"
            element={<ScanPage kind="container" />}
          />
          <Route
            path="/driver/pickup/:assignmentId/scan/chassis"
            element={<ScanPage kind="chassis" />}
          />
          <Route
            path="/driver/pickup/:assignmentId/result"
            element={<VerificationResultPage />}
          />
          <Route
            path="/driver/pickup/:assignmentId/exception"
            element={<ExceptionReportPage />}
          />
        </Route>

        <Route element={<RequireRole allow={['MANAGER', 'ADMIN']} />}>
          <Route path="/manager" element={<DashboardPage />} />
          <Route path="/manager/manifests" element={<ManifestHistoryPage />} />
          <Route path="/manager/manifests/upload" element={<ManifestUploadPage />} />
          <Route
            path="/manager/manifests/import/:importId"
            element={<ManifestPreviewPage />}
          />
          <Route path="/manager/assignments" element={<AssignmentsPage />} />
          <Route path="/manager/exceptions" element={<ExceptionsPage />} />
          <Route path="/manager/audit" element={<AuditLogPage />} />
          <Route path="/manager/movements/:movementId" element={<MovementDetailPage />} />
          <Route path="/manager/shift-report" element={<ShiftReportPage />} />
        </Route>

        {/* Admin-only. A MANAGER reaching these lands on /403. */}
        <Route element={<RequireAdmin />}>
          <Route path="/manager/users" element={<UsersPage />} />
        </Route>
      </Route>

      <Route path="*" element={<NotFoundPage />} />
    </Routes>
    </Suspense>
  )
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <DataProvider>
        <OcrProviderScope>
          <BrowserRouter>
            <SessionProvider>
              <UpdateBanner />
              <AppRoutes />
            </SessionProvider>
          </BrowserRouter>
        </OcrProviderScope>
      </DataProvider>
    </QueryClientProvider>
  )
}
