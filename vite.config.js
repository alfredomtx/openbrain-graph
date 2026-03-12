import { defineConfig } from 'vite'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  base: '/openbrain-graph/',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'node_modules/@cosmograph/cosmograph'),
    }
  }
})
