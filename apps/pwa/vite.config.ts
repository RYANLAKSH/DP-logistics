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
        name: 'DP Verify — Vehicle & Container Verification',
        short_name: 'DP Verify',
        description:
          'Scan the container and the chassis. The movement completes only when both match the manifest.',
        theme_color: '#0b1220',
        background_color: '#0b1220',
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
    // The OCR engine dominates a driver's download and is fetched separately
    // by the worker, so the JS budget here is about everything else.
    chunkSizeWarningLimit: 400,
    rollupOptions: {
      output: {
        manualChunks: {
          // Split by change cadence: the framework moves rarely, Supabase
          // moves on its own schedule, and the app moves every deploy. Keeping
          // them apart means a routine release does not invalidate the two
          // largest cached chunks on every driver's phone.
          react: ['react', 'react-dom', 'react-router-dom'],
          supabase: ['@supabase/supabase-js'],
          query: ['@tanstack/react-query'],
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
