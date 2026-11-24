import fs from 'node:fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

function ignoreMediapipeSourcemap() {
  return {
    name: 'ignore-mediapipe-sourcemap',
    enforce: 'pre',
    load(id) {
      const cleanId = id.split('?')[0]
      if (cleanId.includes('@mediapipe/tasks-vision') && cleanId.endsWith('vision_bundle.mjs')) {
        const code = fs.readFileSync(cleanId, 'utf-8').replace(/\/\/# sourceMappingURL=.*$/m, '')
        return { code, map: { mappings: '' } }
      }
    },
  }
}

export default defineConfig({
  plugins: [react(), ignoreMediapipeSourcemap()],
  server: {
    host: true,
    headers: {
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Opener-Policy': 'same-origin',
    },
  },
  optimizeDeps: {
    exclude: ['@mediapipe/tasks-vision'],
  },
})
