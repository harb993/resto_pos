import { describe, it, expect, beforeAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { initDatabase, getDb, getDbPath, getDataDirectory, isDemoMode } from '../src/main/db/db'

/**
 * The showcase books and the restaurant's books are SEPARATE FILES.
 *
 * Everything the demo generator does — thirty days of invented trading, rebuilt every
 * day with different figures — must be incapable of reaching a real shop's data. The
 * separation is not a flag inside one database that something could read wrongly; it
 * is a different folder holding a different file, chosen before the connection is
 * opened.
 *
 * Worth pinning, because the failure would be silent and total: a demonstration would
 * overwrite a working restaurant's invoices with made-up ones, and nobody would notice
 * until the accounts were wrong.
 */

beforeAll(() => {
  initDatabase()
})

describe('the real books and the showcase are kept apart', () => {
  it('runs the tests against the REAL profile, never the demo one', () => {
    expect(isDemoMode()).toBe(false)
  })

  it('puts the two databases in different folders', () => {
    // `data` for real trading, `data-demo` for the showcase — see dataFolderName().
    const real = getDataDirectory()
    expect(path.basename(real)).not.toBe('data-demo')

    const demoDir = path.join(real, '..', 'data-demo')
    expect(path.resolve(demoDir)).not.toBe(path.resolve(real))
  })

  it('the demo generator does nothing at all on the real profile', async () => {
    const db = getDb()

    // A real shop's books, with real trading in them.
    const ownerId = (db.prepare(`SELECT user_id FROM users WHERE role='owner'`).get() as any).user_id
    const catId = Number(db.prepare(`INSERT INTO categories (name, display_order) VALUES ('برجر',1)`)
      .run().lastInsertRowid)
    const itemId = Number(db.prepare(
      `INSERT INTO menu_items (category_id,name,price,cost_price) VALUES (?,'تشيكن برجر',85,40)`
    ).run(catId).lastInsertRowid)
    const orderId = Number(db.prepare(`
      INSERT INTO orders (cashier_id, subtotal, tax, discount, total_amount, payment_type, order_type, invoice_number)
      VALUES (?, 85, 0, 0, 85, 'cash', 'takeaway', '0001')
    `).run(ownerId).lastInsertRowid)
    db.prepare(
      'INSERT INTO order_items (order_id, menu_item_id, quantity, unit_price) VALUES (?,?,1,85)'
    ).run(orderId, itemId)

    const before = {
      orders: (db.prepare('SELECT COUNT(*) AS c FROM orders').get() as any).c,
      sales: (db.prepare(
        `SELECT ROUND(COALESCE(SUM(total_amount),0),2) AS s FROM orders WHERE status='completed'`
      ).get() as any).s,
    }
    expect(before.orders).toBe(1)

    // initDatabase() is what would call the generator. It is guarded by isDemoMode(),
    // and this profile is not the demo one — so running it again must change nothing.
    initDatabase()

    const after = {
      orders: (getDb().prepare('SELECT COUNT(*) AS c FROM orders').get() as any).c,
      sales: (getDb().prepare(
        `SELECT ROUND(COALESCE(SUM(total_amount),0),2) AS s FROM orders WHERE status='completed'`
      ).get() as any).s,
    }

    console.log('real books before:', JSON.stringify(before))
    console.log('real books after: ', JSON.stringify(after))

    expect(after).toEqual(before)
    // Specifically: no thirty-day month of invented trading appeared.
    expect(after.orders).toBe(1)
    expect(after.sales).toBe(85)
  })

  it('keeps the two sets of BACKUPS apart', async () => {
    const { getBackupDir, runBackup, listBackups } = await import('../src/main/db/db')
    const { switchProfile, getActiveProfile } = await import('../src/main/db/db')

    const realBackupDir = getBackupDir()
    await runBackup()
    const realNames = listBackups().map(b => b.fileName)
    expect(realNames.length).toBeGreaterThan(0)

    // Into the showcase, and take a backup there too.
    switchProfile('demo')
    expect(getActiveProfile()).toBe('demo')
    const demoBackupDir = getBackupDir()
    await runBackup()
    const demoNames = listBackups().map(b => b.fileName)

    switchProfile('real')

    console.log('real backups:', realBackupDir)
    console.log('demo backups:', demoBackupDir)

    /*
      This is the one route by which a demonstration could genuinely reach a real
      shop's books: not by writing to them, but by leaving a snapshot of invented
      trading where somebody could later RESTORE it over the real ones. The folders are
      derived from the active profile's data directory, so they are never the same
      place, and the restore handler refuses any path outside the active one.
    */
    expect(path.resolve(demoBackupDir)).not.toBe(path.resolve(realBackupDir))

    // And the real folder did not gain the showcase's snapshot.
    const realAfter = listBackups().map(b => b.fileName)
    for (const name of demoNames) {
      if (!realNames.includes(name)) expect(realAfter).not.toContain(name)
    }
  })

  it('a demo database built beside it leaves the real file byte-identical', async () => {
    const { seedDemoData } = await import('../src/main/db/demoSeed')

    const realPath = getDbPath()
    getDb().pragma('wal_checkpoint(TRUNCATE)')
    const realBefore = fs.readFileSync(realPath)

    // Build a showcase database in its own file, exactly as the demo profile does.
    const demoPath = path.join(path.dirname(realPath), 'demo-isolation-check.db')
    fs.copyFileSync(realPath, demoPath)
    const demo = new Database(demoPath)
    demo.pragma('foreign_keys = ON')
    // Empty its trading first: the copy carries the order the previous test wrote,
    // dated today, and the generator correctly leaves books that already reach today
    // alone. Clearing it is what a real stale showcase looks like on the day it rolls.
    demo.prepare('DELETE FROM order_items').run()
    demo.prepare('DELETE FROM orders').run()
    seedDemoData(demo)

    const demoOrders = (demo.prepare('SELECT COUNT(*) AS c FROM orders').get() as any).c
    demo.close()
    fs.rmSync(demoPath, { force: true })
    fs.rmSync(demoPath + '-wal', { force: true })
    fs.rmSync(demoPath + '-shm', { force: true })

    getDb().pragma('wal_checkpoint(TRUNCATE)')
    const realAfter = fs.readFileSync(realPath)

    console.log('orders generated into the demo file:', demoOrders)
    console.log('real file unchanged:', realBefore.equals(realAfter))

    // The demo file filled up with a month of trading…
    expect(demoOrders).toBeGreaterThan(100)
    // …and the real one did not move a byte.
    expect(realBefore.equals(realAfter)).toBe(true)
  })
})
