import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
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
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    // The repo still contains packages/mobile from the superseded Expo
    // direction, which pins React 18 and hoists it to the workspace root.
    // Without deduping, dependencies hoisted to the root resolve React 18
    // while this app resolves its own React 19, and the two instances produce
    // a null-internals crash on the first hook. Pin every 'react' import in
    // this app to this app's copy.
    dedupe: ['react', 'react-dom', 'react/jsx-runtime'],
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    css: false,
  },
})
