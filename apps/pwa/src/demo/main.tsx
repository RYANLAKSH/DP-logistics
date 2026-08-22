/**
 * Entry point for the hosted demonstration build.
 *
 * Three things differ from the app drivers install, and nothing else does:
 *
 *  - hash routing, because the demo is one static file with no server to
 *    rewrite deep links;
 *  - the in-memory backend, which is what the app already falls back to when
 *    Supabase is not configured;
 *  - a canvas camera and a matching OCR provider, because the sandbox exposes
 *    no capture device and the 23 MB engine will not fit in one file.
 *
 * Every screen, route, guard, parser and matching rule is the shipped one.
 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AppRoutes } from '@/App'
import { DataProvider } from '@/data/provider'
import { MockDataSource } from '@/data/mock/MockDataSource'
import { OcrProviderScope } from '@/lib/ocr/provider'
import { SessionProvider } from '@/lib/session'
import { DemoOcrProvider } from './DemoOcrProvider'
import { DemoBar } from './DemoBar'
import { installSyntheticCamera } from './syntheticCamera'
import '@/index.css'

installSyntheticCamera()

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, retry: 1 } },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <DataProvider source={new MockDataSource()}>
        <OcrProviderScope provider={new DemoOcrProvider()}>
          <HashRouter>
            <SessionProvider>
              <DemoBar />
              <AppRoutes />
            </SessionProvider>
          </HashRouter>
        </OcrProviderScope>
      </DataProvider>
    </QueryClientProvider>
  </StrictMode>,
)
