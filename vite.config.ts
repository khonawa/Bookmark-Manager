import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
import { metadataPlugin } from './metadata.ts'

export default defineConfig({
  plugins: [react(), tailwindcss(), metadataPlugin()],
  server: { port: 5173, strictPort: true },
  clearScreen: false,
})
