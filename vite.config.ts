import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

// The playground server (server/index.js) serves the build from dist/ and, in development,
// runs Vite in middleware mode. There is no separate Vite dev server or proxy.
export default defineConfig({
  plugins: [vue()],
  build: {
    outDir: 'dist',
    // Never inline assets as data: URIs, so the production CSP can stay at 'self'.
    assetsInlineLimit: 0,
    sourcemap: false,
  },
})
