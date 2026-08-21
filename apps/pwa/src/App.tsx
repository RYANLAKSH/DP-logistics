import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { DataProvider } from '@/data/provider'
import { OcrProviderScope } from '@/lib/ocr/provider'
import { SessionProvider } from '@/lib/session'
import { RequireAdmin, RequireAuth, RequireRole, RoleHome } from '@/routes/guards'
import { LoginPage } from '@/routes/LoginPage'
import { NotFoundPage, OfflinePage, UnauthorizedPage } from '@/routes/ErrorPages'
import { DriverHomePage } from '@/routes/driver/DriverHomePage'
import { PickupDetailPage } from '@/routes/driver/PickupDetailPage'
import { ScanPage } from '@/routes/driver/ScanPage'
import { VerificationResultPage } from '@/routes/driver/VerificationResultPage'
import { ExceptionReportPage } from '@/routes/driver/ExceptionReportPage'
import { CompletedJobsPage } from '@/routes/driver/CompletedJobsPage'
import { DashboardPage } from '@/routes/manager/DashboardPage'
import { ManifestUploadPage } from '@/routes/manager/ManifestUploadPage'
import { ManifestPreviewPage } from '@/routes/manager/ManifestPreviewPage'
import { ManifestHistoryPage } from '@/routes/manager/ManifestHistoryPage'
import { AssignmentsPage } from '@/routes/manager/AssignmentsPage'
import { ExceptionsPage } from '@/routes/manager/ExceptionsPage'
import { UsersPage } from '@/routes/manager/UsersPage'
import { AuditLogPage } from '@/routes/manager/AuditLogPage'

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
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/403" element={<UnauthorizedPage />} />
      <Route path="/offline" element={<OfflinePage />} />

      <Route element={<RequireAuth />}>
        <Route path="/" element={<RoleHome />} />

        <Route element={<RequireRole allow={['DRIVER']} />}>
          <Route path="/driver" element={<DriverHomePage />} />
          <Route path="/driver/completed" element={<CompletedJobsPage />} />
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
        </Route>

        {/* Admin-only. A MANAGER reaching these lands on /403. */}
        <Route element={<RequireAdmin />}>
          <Route path="/manager/users" element={<UsersPage />} />
        </Route>
      </Route>

      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  )
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <DataProvider>
        <OcrProviderScope>
          <BrowserRouter>
            <SessionProvider>
              <AppRoutes />
            </SessionProvider>
          </BrowserRouter>
        </OcrProviderScope>
      </DataProvider>
    </QueryClientProvider>
  )
}
