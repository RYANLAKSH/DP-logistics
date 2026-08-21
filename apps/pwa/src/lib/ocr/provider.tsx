import { createContext, useContext, useMemo, useRef, type ReactNode } from 'react'
import type { OcrProvider } from './types'
import { TesseractProvider } from './TesseractProvider'

const OcrContext = createContext<(() => OcrProvider) | null>(null)

/**
 * One OCR engine per session, created lazily.
 *
 * Lazily because it is a 4 MB download that only drivers need, and only once
 * they open a task. Loading it at startup would put it on the critical path of
 * every screen for every role.
 */
export function OcrProviderScope({
  children, provider,
}: { children: ReactNode; provider?: OcrProvider }) {
  const ref = useRef<OcrProvider | null>(provider ?? null)
  const get = useMemo(
    () => () => (ref.current ??= new TesseractProvider()),
    [],
  )
  return <OcrContext.Provider value={get}>{children}</OcrContext.Provider>
}

export function useOcr(): OcrProvider {
  const get = useContext(OcrContext)
  if (!get) throw new Error('useOcr must be used inside <OcrProviderScope>')
  return get()
}
