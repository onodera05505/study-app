import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist' },
  server: {
    port: 5173,
    // 開発時は API を wrangler dev (8787) に転送する
    proxy: { '/api': 'http://localhost:8787' },
  },
})
