import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import {
  initDatabase, getDb, getDbPath, getActiveProfile, switchProfile, isDemoMode,
} from '../src/main/db/db'
import { login, logout } from '../src/main/services/authService'

/**
 * The showcase refreshes DAILY, and only the showcase.
 *
 * Two promises, and they pull against each other. The books must be rebuilt whenever
 * they no longer reach today — otherwise a demonstration opens on a shop that stopped
 * trading last week, with an empty "today" on every screen. But they must be rebuilt
 * ONLY for the showcase: the same code running against a real restaurant's books would
 * replace a year of invoices with invented ones, silently.
 *
 * The trigger is signing in as the showcase account. There is no timer, deliberately —
 * a rebuild firing at midnight mid-demonstration would change the figures on screen
 * while somebody was looking at them.
 */

const DEMO_USER = 'fares'
const DEMO_PASS = 'fares123'
const DAY_MIN = 6_000
const DAY_MAX = 8_000

const pad = (n: number) => String(n).padStart(2, '0')
const todayStr = () => {
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** Read a database file directly, without going through the app's connection. */
function inspect(file: string) {
  const db = new Database(file, { readonly: true, fileMustExist: true })
  const newest = (db.prepare(
    `SELECT MAX(date(created_at)) AS d FROM orders WHERE deleted_at IS NULL`
  ).get() as any).d
  const orders = (db.prepare('SELECT COUNT(*) AS c FROM orders').get() as any).c
  const days = db.prepare(`
    SELECT date(created_at) AS d, ROUND(SUM(total_amount),2) AS t
    FROM orders WHERE status='completed' AND deleted_at IS NULL
    GROUP BY date(created_at)
  `).all() as any[]
  db.close()
  return { newest, orders, days }
}

const demoDbPath = () => {
  // `data` for real trading, `data-demo` for the showcase — different folders.
  const real = getDbPath()
  return path.join(path.dirname(real), '..', 'data-demo', 'restaurant.db')
}

beforeAll(() => {
  initDatabase()
})

afterAll(() => {
  logout()
  if (getActiveProfile() !== 'real') switchProfile('real')
})

describe('signing in as the showcase account', () => {
  it('opens a DIFFERENT database from the restaurant’s', () => {
    const realPath = getDbPath()
    expect(isDemoMode()).toBe(false)

    const res = login(DEMO_USER, DEMO_PASS)
    console.log('showcase sign-in:', JSON.stringify({ ok: res.success, error: res.error }))
    expect(res.success).toBe(true)
    expect(isDemoMode()).toBe(true)

    const demoPath = getDbPath()
    console.log('real:', path.basename(path.dirname(realPath)))
    console.log('demo:', path.basename(path.dirname(demoPath)))

    // The invariant is that they are DIFFERENT FILES, not what the folder is called:
    // a packaged till keeps them side by side as `data` and `data-demo`, while an
    // unpackaged one puts the showcase under `<userData>/demo`. Both are separate
    // files, which is the whole guarantee.
    expect(demoPath).not.toBe(realPath)
    expect(path.dirname(demoPath)).not.toBe(path.dirname(realPath))
    expect(path.basename(path.dirname(demoPath))).toMatch(/^(data-)?demo$/)
    expect(fs.existsSync(demoPath)).toBe(true)

    logout()
    expect(isDemoMode()).toBe(false)
  })

  it('builds books that reach today, inside the band', () => {
    login(DEMO_USER, DEMO_PASS)
    const state = inspect(getDbPath())
    logout()

    console.log('demo books:', JSON.stringify({
      newest: state.newest, orders: state.orders, days: state.days.length,
    }))

    expect(state.newest).toBe(todayStr())
    const totals = state.days.map(d => d.t)
    const outside = state.days.filter(d => d.t < DAY_MIN || d.t > DAY_MAX)
    console.log('lowest/highest:', Math.min(...totals), Math.max(...totals))
    expect(outside).toEqual([])
  })

  it('REBUILDS when the books no longer reach today', () => {
    login(DEMO_USER, DEMO_PASS)
    const demoPath = getDbPath()
    logout()

    // Age the showcase by a week, exactly as leaving the machine on would.
    const aged = new Database(demoPath)
    aged.prepare(`UPDATE orders SET created_at = datetime(created_at, '-7 days')`).run()
    aged.pragma('wal_checkpoint(TRUNCATE)')
    const before = inspect(demoPath)
    aged.close()
    console.log('after ageing, newest is:', before.newest)
    expect(before.newest).not.toBe(todayStr())

    // Signing in again is what a demonstration the next morning looks like.
    login(DEMO_USER, DEMO_PASS)
    const after = inspect(getDbPath())
    logout()

    console.log('after signing in again, newest is:', after.newest)
    expect(after.newest).toBe(todayStr())

    const outside = after.days.filter(d => d.t < DAY_MIN || d.t > DAY_MAX)
    expect(outside).toEqual([])
  })

  it('does NOT rebuild twice in the same day — the figures hold still', () => {
    login(DEMO_USER, DEMO_PASS)
    const first = inspect(getDbPath())
    logout()

    login(DEMO_USER, DEMO_PASS)
    const second = inspect(getDbPath())
    logout()

    console.log('two sign-ins, same day — identical:',
      JSON.stringify(first.days) === JSON.stringify(second.days))

    // A showcase that reshuffled on every sign-in would visibly be producing output
    // rather than showing records, in front of the customer.
    expect(second.days).toEqual(first.days)
    expect(second.orders).toBe(first.orders)
  })
})

describe('the restaurant’s own books are never rebuilt', () => {
  it('signing in as a REAL user leaves them exactly as they were', () => {
    // Put something real in the books first.
    const db = getDb()
    expect(isDemoMode()).toBe(false)
    const ownerId = (db.prepare(`SELECT user_id FROM users WHERE role='owner'`).get() as any).user_id
    const catId = Number(db.prepare(`INSERT INTO categories (name, display_order) VALUES ('x',1)`)
      .run().lastInsertRowid)
    const itemId = Number(db.prepare(
      `INSERT INTO menu_items (category_id,name,price,cost_price) VALUES (?,'برجر',85,40)`
    ).run(catId).lastInsertRowid)
    const orderId = Number(db.prepare(`
      INSERT INTO orders (cashier_id, subtotal, tax, discount, total_amount, payment_type, order_type, invoice_number)
      VALUES (?, 85, 0, 0, 85, 'cash', 'takeaway', '0001')
    `).run(ownerId).lastInsertRowid)
    db.prepare('INSERT INTO order_items (order_id, menu_item_id, quantity, unit_price) VALUES (?,?,1,85)')
      .run(orderId, itemId)

    const before = inspectOpen()

    // Into the showcase and back out — the round trip that swaps the database twice.
    login(DEMO_USER, DEMO_PASS)
    expect(isDemoMode()).toBe(true)
    logout()
    expect(isDemoMode()).toBe(false)

    // …and an ordinary sign-in, which must never trigger a rebuild.
    logout()
    login('admin', 'admin123')
    const after = inspectOpen()
    logout()

    console.log('real books before:', JSON.stringify(before))
    console.log('real books after: ', JSON.stringify(after))

    expect(after).toEqual(before)
    expect(after.orders).toBe(1)      // still the one real order
    expect(after.days.length).toBe(1) // not a generated month
  })

  function inspectOpen() {
    const db = getDb()
    return {
      orders: (db.prepare('SELECT COUNT(*) AS c FROM orders').get() as any).c,
      days: db.prepare(`
        SELECT date(created_at) AS d, ROUND(SUM(total_amount),2) AS t
        FROM orders WHERE status='completed' AND deleted_at IS NULL
        GROUP BY date(created_at)
      `).all() as any[],
    }
  }
})
