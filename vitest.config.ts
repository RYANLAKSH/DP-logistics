import { defineConfig } from 'vitest/config'

/**
 * Root-level tests for code that is shared with Deno Edge Functions.
 *
 * The manifest parser lives under supabase/functions/_shared so the Supabase
 * CLI bundles it, and is tested here rather than being duplicated into a
 * workspace package. `allowImportingTsExtensions` is what lets the same source
 * carry Deno-style `./foo.ts` imports and still run under Vitest.
 */
export default defineConfig({
  test: {
    include: ['supabase/functions/**/__tests__/**/*.test.ts'],
    environment: 'node',
  },
  esbuild: { target: 'es2022' },
})
