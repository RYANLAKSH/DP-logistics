/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Supabase project URL. Public — it is in the client bundle. */
  readonly VITE_SUPABASE_URL?: string
  /**
   * The anon key. ALSO PUBLIC: it ships in the bundle and grants nothing on
   * its own — every capability behind it is gated by row level security.
   *
   * The service role key must NEVER appear here, in any VITE_ variable, or
   * anywhere else the client can reach. It bypasses all RLS.
   */
  readonly VITE_SUPABASE_ANON_KEY?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
