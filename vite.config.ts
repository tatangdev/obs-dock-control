import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      // In dev, forward relay websocket traffic to the local relay server
      '/ws': {
        target: 'ws://localhost:8787',
        ws: true,
      },
    },
  },
})
