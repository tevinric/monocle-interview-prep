import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: parseInt(process.env.VITE_LENS_DEV_PORT) || 3000,
    proxy: {
      '/api': {
        target: process.env.VITE_LENS_API_URL || 'http://localhost:5100',
        changeOrigin: true,
      },
    },
  },
})
