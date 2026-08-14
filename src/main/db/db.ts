import Database from 'better-sqlite3'
import path from 'node:path'
import fs from 'node:fs'
import { app } from 'electron'
import log from 'electron-log/main'

let db: Database.Database

export function getDbPath(): string {
  const userDataPath = app.getPath('userData')
  return path.join(userDataPath, 'restaurant.db')
}

export function initDatabase(): Database.Database {
  const dbPath = getDbPath()
  log.info(`[DB] Opening database at: ${dbPath}`)

  // Ensure the directory exists
  const dir = path.dirname(dbPath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }

  db = new Database(dbPath)

  // Critical PRAGMAs
  db.pragma('journal_mode = WAL')       // crash-safe writes
  db.pragma('synchronous = NORMAL')     // safe pairing with WAL
  db.pragma('foreign_keys = ON')        // enforce foreign keys every connection

  // Run schema
  const schemaPath = path.join(__dirname, '..', 'db', 'schema.sql')
  let schemaSQL: string

  // In packaged app, schema.sql might be in different location
  if (fs.existsSync(schemaPath)) {
    schemaSQL = fs.readFileSync(schemaPath, 'utf-8')
  } else {
    // Fallback: try relative to this file
    const altPath = path.join(__dirname, 'schema.sql')
    if (fs.existsSync(altPath)) {
      schemaSQL = fs.readFileSync(altPath, 'utf-8')
    } else {
      log.error('[DB] schema.sql not found at', schemaPath, 'or', altPath)
      throw new Error('schema.sql not found')
    }
  }

  db.exec(schemaSQL)
  log.info('[DB] Schema applied successfully')

  // Seed default owner account if no users exist
  const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number }
  if (userCount.count === 0) {
    const bcrypt = require('bcryptjs')
    const hash = bcrypt.hashSync('admin123', 10)
    const pinHash = bcrypt.hashSync('1234', 10)
    db.prepare(
      `INSERT INTO users (username, pin_hash, password_hash, role, full_name) VALUES (?, ?, ?, ?, ?)`
    ).run('admin', pinHash, hash, 'owner', 'Owner')
    log.info('[DB] Default owner account created (username: admin, password: admin123, PIN: 1234)')
  }

  return db
}

export function getDb(): Database.Database {
  if (!db) {
    throw new Error('Database not initialized. Call initDatabase() first.')
  }
  return db
}

export async function runBackup(): Promise<string> {
  const backupDir = path.join(app.getPath('userData'), 'backups')
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true })
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const filename = `restaurant-${timestamp}.db`
  const backupPath = path.join(backupDir, filename)

  await getDb().backup(backupPath)
  log.info(`[DB] Backup created: ${backupPath}`)

  // Keep only the last 30 backups
  const files = fs.readdirSync(backupDir)
    .filter(f => f.startsWith('restaurant-') && f.endsWith('.db'))
    .sort()

  if (files.length > 30) {
    const toDelete = files.slice(0, files.length - 30)
    for (const file of toDelete) {
      fs.unlinkSync(path.join(backupDir, file))
      log.info(`[DB] Old backup deleted: ${file}`)
    }
  }

  return backupPath
}

export function closeDatabase(): void {
  if (db) {
    db.close()
    log.info('[DB] Database closed')
  }
}

export default { initDatabase, getDb, getDbPath, runBackup, closeDatabase }
