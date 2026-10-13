import { defineConfig } from 'vitest/config'
import { existsSync } from 'fs'
import { resolve } from 'path'

/**
 * The better-sqlite3 in node_modules is built for Electron's ABI (see the
 * `postinstall` script), so plain node — and therefore vitest — cannot load it.
 *
 * `npm test` runs scripts/setup-test-sqlite.mjs first, which stages a Node-ABI copy
 * under node_modules/.test-sqlite. Alias to it when present. RESTO_TEST_SQLITE
 * overrides for anyone pointing at a hand-built binary. If neither exists the
 * database-backed suites fail to import and the pure-logic ones still run.
 */
const staged = resolve(__dirname, '.test-sqlite/node_modules/better-sqlite3/lib/index.js')
const nodeSqlite = process.env.RESTO_TEST_SQLITE ?? (existsSync(staged) ? staged : undefined)

export default defineConfig({
  resolve: {
    alias: nodeSqlite ? { 'better-sqlite3': nodeSqlite } : {},
  },
  test: {
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    environment: 'node',
    pool: 'forks',
  },
})
