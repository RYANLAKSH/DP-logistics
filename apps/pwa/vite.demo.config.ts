import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath, URL } from 'node:url'

/**
 * The hosted demonstration build: one self-contained HTML file.
 *
 * No PWA plugin (a service worker in a sandboxed frame caches a demo nobody
 * wants cached) and no code splitting, because every chunk would be a separate
 * request the single file cannot make. scripts/build-demo.mjs inlines what
 * comes out of here.
 */
export default defineConfig({
  configFile: false,
  define: { __APP_VERSION__: JSON.stringify('demo') },
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@shared': fileURLToPath(new URL('../../supabase/functions/_shared', import.meta.url)),
      // The PWA plugin is not in this build, so its virtual module is not
      // either. The shim keeps App.tsx importable unchanged.
      'virtual:pwa-register': fileURLToPath(
        new URL('./src/demo/pwaRegisterStub.ts', import.meta.url)),
    },
    dedupe: ['react', 'react-dom', 'react/jsx-runtime'],
  },
  build: {
    outDir: 'dist-demo',
    emptyOutDir: true,
    assetsInlineLimit: 1024 * 1024,
    rollupOptions: {
      input: fileURLToPath(new URL('./demo.html', import.meta.url)),
      output: { inlineDynamicImports: true, entryFileNames: 'demo.js' },
    },
  },
})
