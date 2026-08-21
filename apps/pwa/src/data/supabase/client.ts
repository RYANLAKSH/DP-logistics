import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

export const supabaseConfigured = Boolean(url && anonKey)

let client: SupabaseClient | null = null

/**
 * The one Supabase client for the app.
 *
 * Created lazily so a build without Supabase configured still runs against the
 * mock rather than crashing on import.
 */
export function getSupabase(): SupabaseClient {
  if (!supabaseConfigured) {
    throw new Error(
      'Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.',
    )
  }
  client ??= createClient(url!, anonKey!, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      // A driver re-authenticating at a ramp in the rain is how you get shared
      // logins, so the refresh token is long-lived and refreshed silently.
      // Revocation is active, not passive: deactivating a user also signs them
      // out server-side. See admin_deactivate_user in the migrations.
      flowType: 'pkce',
    },
    global: {
      headers: { 'x-application-name': 'dp-verify-pwa' },
    },
  })
  return client
}
