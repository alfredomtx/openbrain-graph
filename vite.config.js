import { defineConfig } from 'vite'
import path from 'path'

export default defineConfig({
  base: '/openbrain-graph/',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'node_modules/@cosmograph/cosmograph'),
    }
  }
})
