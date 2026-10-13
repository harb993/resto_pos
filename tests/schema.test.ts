import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '..')

/**
 * db.ts loads src/main/db/schema.sql if it can find it on disk, and otherwise
 * falls back to the copy hardcoded in getEmbeddedSchema().
 *
 * schema.sql is NOT copied into out/ by electron-vite, and package.json only
 * packages out/**, so a PACKAGED build always takes the embedded path while dev
 * always takes the file path. Nothing keeps the two in sync — this test does.
 */
function embeddedSchema(): string {
  const dbts = fs.readFileSync(path.join(ROOT, 'src/main/db/db.ts'), 'utf-8')
  const m = dbts.match(/function getEmbeddedSchema\(\): string \{\s*return `([\s\S]*?)`\s*\}/)
  if (!m) throw new Error('could not locate getEmbeddedSchema()')
  return m[1]
}

function introspect(sql: string) {
  const db = new Database(':memory:')
  db.exec(sql)
  const objects = (db.prepare(
    `SELECT type, name FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name`
  ).all() as any[]).map(o => `${o.type}:${o.name}`)

  const columns: Record<string, string[]> = {}
  for (const name of objects.filter(o => o.startsWith('table:')).map(o => o.slice(6))) {
    columns[name] = (db.prepare(`PRAGMA table_info('${name}')`).all() as any[])
      .map(c => `${c.name} ${c.type}${c.notnull ? ' NOT NULL' : ''}${c.dflt_value ? ` DEFAULT ${c.dflt_value}` : ''}`)
  }
  const settings = (db.prepare(`SELECT key FROM settings ORDER BY key`).all() as any[]).map(r => r.key)
  db.close()
  return { objects, columns, settings }
}

describe('schema.sql vs the embedded fallback schema', () => {
  const file = introspect(fs.readFileSync(path.join(ROOT, 'src/main/db/schema.sql'), 'utf-8'))
  const embedded = introspect(embeddedSchema())

  it('defines the same tables and indexes', () => {
    expect(embedded.objects).toEqual(file.objects)
  })

  it('defines the same columns on every table', () => {
    expect(embedded.columns).toEqual(file.columns)
  })

  it('seeds the same settings keys', () => {
    expect(embedded.settings).toEqual(file.settings)
  })

  it('ships schema.sql next to the main bundle so packaged builds use the real file', () => {
    // electron.vite.config.ts copies it in via the copy-schema-sql plugin. Only
    // meaningful once a build has run, so skip on a clean tree rather than fail.
    const bundle = path.join(ROOT, 'out/main/index.js')
    if (!fs.existsSync(bundle)) return

    const shipped = path.join(ROOT, 'out/main/schema.sql')
    expect(fs.existsSync(shipped)).toBe(true)
    // And it must be the same file db.ts would have loaded in dev.
    expect(fs.readFileSync(shipped, 'utf-8'))
      .toBe(fs.readFileSync(path.join(ROOT, 'src/main/db/schema.sql'), 'utf-8'))
  })
})
