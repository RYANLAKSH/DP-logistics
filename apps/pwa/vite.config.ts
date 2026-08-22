import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
import { fileURLToPath, URL } from 'node:url'

// Stamped into the bundle so every movement record says which build produced
// it. Without that, "which version was the driver running?" is unanswerable
// exactly when it matters.
const APP_VERSION = process.env.APP_VERSION ?? process.env.npm_package_version ?? 'dev'

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(APP_VERSION) },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      // generateSW cannot express the outbox this app needs (Background Sync
      // over a queue of captured evidence), so the service worker is ours from
      // the start rather than something to migrate to in phase 13.
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'prompt',
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        // The OCR engine is ~7 MB and only drivers ever load it. Precaching it
        // for everyone would put it in every manager's and auditor's install.
        // sw.ts caches it at runtime instead, on first use, which reaches the
        // same place — cached before the driver leaves signal — without
        // shipping it to people who will never scan anything.
        globIgnores: ['**/ocr/**'],
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
      },
      manifest: {
        name: 'RYLA Verify — Vehicle & Container Verification',
        short_name: 'RYLA Verify',
        description:
          'Scan the container and the chassis. The movement completes only when both match the manifest.',
        theme_color: '#1B3149',
        background_color: '#1B3149',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        scope: '/',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // The manifest parser lives with the Edge Functions so the Supabase CLI
      // bundles it. The mock backend imports it so the preview screen is
      // exercised against the real validation rules rather than a second
      // implementation that would drift.
      '@shared': fileURLToPath(new URL('../../supabase/functions/_shared', import.meta.url)),
    },
    // Kept after packages/mobile left the workspace: deduping React is cheap
    // insurance against any future dependency hoisting a second copy, and the
    // failure it prevents is an opaque null-internals crash on the first hook.
    dedupe: ['react', 'react-dom', 'react/jsx-runtime'],
  },
  build: {
    /**
     * Pinned rather than left to the default, which moves between Vite
     * releases and would quietly drop a handset out of support on a routine
     * dependency bump.
     *
     * iOS 16.4 is the real floor and it is not ours to choose: it is the first
     * Safari that gives an installed PWA camera access, and without a camera
     * there is no evidence and therefore no movement. Chrome 110 is the
     * equivalent vintage on Android. Anything older is told so by name on the
     * camera screen rather than failing in a way a driver cannot interpret.
     */
    target: ['chrome110', 'safari16.4'],
    // The OCR engine dominates a driver's download and is fetched separately
    // by the worker, so the JS budget here is about everything else.
    chunkSizeWarningLimit: 400,
    rollupOptions: {
      output: {
        /**
         * Split by change cadence: the framework moves rarely, Supabase moves
         * on its own schedule, and the app moves every deploy. Keeping them
         * apart means a routine release does not invalidate the two largest
         * cached chunks on every driver's phone.
         *
         * Matched by path rather than by package name. The object form keys on
         * a package's entry module, so listing 'react-dom' never caught
         * `react-dom/client` — which is what the app actually imports. The
         * result was react-dom sitting in the app chunk and its scheduler in
         * the offline chunk, so every release re-downloaded the framework and
         * the split bought nothing it claimed to.
         */
        manualChunks(id) {
          if (!id.includes('node_modules')) return
          if (/node_modules\/(react|react-dom|scheduler|react-router|react-router-dom)\//.test(id)) {
            return 'react'
          }
          if (id.includes('node_modules/@supabase/')) return 'supabase'
          if (id.includes('node_modules/@tanstack/')) return 'query'
          if (id.includes('node_modules/dexie')) return 'offline'
          return
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    css: false,
  },
})
