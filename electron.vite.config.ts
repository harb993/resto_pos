import { resolve } from 'path'
import { copyFileSync, mkdirSync } from 'fs'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'

/**
 * db.ts looks for schema.sql on disk and silently falls back to a hardcoded copy
 * when it cannot find one. package.json only ships `out/**`, so without this the
 * packaged app ALWAYS took the fallback path while dev always took the file — two
 * schemas that had to be kept in sync by hand. Emit the real file next to the
 * bundle so `path.join(__dirname, 'schema.sql')` resolves in a packaged build.
 */
function copySchemaPlugin(): Plugin {
  return {
    name: 'copy-schema-sql',
    closeBundle() {
      const from = resolve(__dirname, 'src/main/db/schema.sql')
      const toDir = resolve(__dirname, 'out/main')
      mkdirSync(toDir, { recursive: true })
      copyFileSync(from, resolve(toDir, 'schema.sql'))
    },
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(), copySchemaPlugin()],
    build: {
      rollupOptions: {
        external: ['better-sqlite3'],
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer'),
        '@shared': resolve('src/shared'),
      },
    },
    plugins: [react()],
    // No manualChunks: AnalyticsScreen is loaded with React.lazy, so Rollup already
    // emits recharts as its own chunk that the till never has to parse.
  },
})
