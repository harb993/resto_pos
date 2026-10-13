import { describe, it, expect, beforeAll } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { initDatabase, getDb, getDbPath } from '../src/main/db/db'
import { seedDemoData } from '../src/main/db/demoSeed'

/**
 * The showcase books: what a day takes, and that it is a different day each day.
 *
 * Two promises. Every date in the generated month lands between 6,000 and 8,000 — the
 * figure somebody being shown the system actually looks at. And the numbers are drawn
 * fresh each day, so a demonstration is never the same month twice, while staying
 * settled WITHIN a day: a demo that reshuffled itself on every refresh would be
 * visibly producing output rather than showing records, in front of the customer.
 */

const DAY_MIN = 6_000
const DAY_MAX = 8_000

/** Day totals from a demo database, oldest first. */
function dailyTotals(db: any): { date: string; total: number }[] {
  return db.prepare(`
    SELECT date(created_at) AS date, ROUND(SUM(total_amount), 2) AS total
    FROM orders
    WHERE status = 'completed' AND deleted_at IS NULL
    GROUP BY date(created_at)
    ORDER BY date
  `).all() as any[]
}

beforeAll(() => {
  initDatabase()
  seedDemoData(getDb())
})

describe('a day in the showcase books', () => {
  it('generates a full month ending today', () => {
    const days = dailyTotals(getDb())
    const today = new Date()
    const p = (n: number) => String(n).padStart(2, '0')
    const todayStr = `${today.getFullYear()}-${p(today.getMonth() + 1)}-${p(today.getDate())}`

    console.log('days generated:', days.length)
    expect(days.length).toBeGreaterThanOrEqual(28)
    expect(days[days.length - 1].date).toBe(todayStr)
  })

  it('every single day lands between 6,000 and 8,000', () => {
    const days = dailyTotals(getDb())
    const totals = days.map(d => d.total)

    console.log('lowest day: ', Math.min(...totals))
    console.log('highest day:', Math.max(...totals))
    console.log('month:      ', Math.round(totals.reduce((a, b) => a + b, 0)))

    const outside = days.filter(d => d.total < DAY_MIN || d.total > DAY_MAX)
    if (outside.length) console.log('outside the band:', JSON.stringify(outside))

    // The generator stops just short of each day's target and the order that crosses
    // the line carries it over, so a small overshoot on the top is expected — but
    // never enough to leave the band.
    expect(outside).toEqual([])
  })

  it('no two days are identical — this is trading, not a repeated row', () => {
    const totals = dailyTotals(getDb()).map(d => d.total)
    expect(new Set(totals).size).toBeGreaterThan(totals.length * 0.8)
  })

  it('the month is roughly thirty days at that rate', () => {
    const totals = dailyTotals(getDb()).map(d => d.total)
    const month = totals.reduce((a, b) => a + b, 0)
    expect(month).toBeGreaterThan(DAY_MIN * 28)
    expect(month).toBeLessThan(DAY_MAX * 31)
  })
})

describe('fresh figures each day, settled within one', () => {
  /**
   * The generator seeds its randomness from the DATE. Running it twice for the same
   * day must give the same books; running it for different days must not.
   *
   * Driven directly rather than through the app, because the whole point is what
   * changes when the calendar does — and the calendar cannot be waited for.
   */
  function buildFor(seedDate: Date): number[] {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-'))
    const file = path.join(dir, 'restaurant.db')
    // Reuse the shape of a real demo database by copying the one already built —
    // folding the write-ahead log in first, or the copy is an empty schema-less file
    // and every statement below fails with "no such table".
    getDb().pragma('wal_checkpoint(TRUNCATE)')
    fs.copyFileSync(getDbPath(), file)

    const db = new Database(file)
    db.pragma('foreign_keys = ON')

    // Wipe the trading and regenerate as if it were that date.
    const realNow = Date.now
    try {
      Date.now = () => seedDate.getTime()
      const RealDate = Date
      // @ts-expect-error — swapping the clock for the duration of the build
      globalThis.Date = class extends RealDate {
        constructor(...args: any[]) {
          super(...(args.length ? args : [seedDate.getTime()]) as [])
        }
        static now() { return seedDate.getTime() }
      }
      db.prepare('DELETE FROM order_items').run()
      db.prepare('DELETE FROM raw_material_transactions').run()
      db.prepare('DELETE FROM orders').run()
      db.prepare('DELETE FROM driver_settlements').run()
      db.prepare('DELETE FROM worker_attendance').run()
      db.prepare('DELETE FROM salaries').run()
      db.prepare('DELETE FROM workers').run()
      db.prepare('DELETE FROM expenses').run()
      db.prepare('DELETE FROM shifts').run()
      db.prepare('DELETE FROM delivery_drivers').run()
      seedDemoData(db)
      // @ts-expect-error — put the real clock back
      globalThis.Date = RealDate
    } finally {
      Date.now = realNow
    }

    const totals = dailyTotals(db).map(d => d.total)
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
    return totals
  }

  it('gives the same books twice for the same day', () => {
    const day = new Date(2026, 5, 15, 12, 0, 0)
    const a = buildFor(day)
    const b = buildFor(day)
    console.log('same day, two runs — totals equal:', JSON.stringify(a) === JSON.stringify(b))
    expect(a).toEqual(b)
  })

  it('gives different books on a different day', () => {
    const a = buildFor(new Date(2026, 5, 15, 12, 0, 0))
    const b = buildFor(new Date(2026, 5, 16, 12, 0, 0))
    console.log('15th vs 16th — first three days:', JSON.stringify(a.slice(0, 3)), JSON.stringify(b.slice(0, 3)))
    expect(a).not.toEqual(b)
  })

  it('stays inside the band whatever day it is generated for', () => {
    for (const day of [
      new Date(2026, 0, 1, 12), new Date(2026, 5, 15, 12),
      new Date(2026, 10, 30, 12), new Date(2027, 2, 8, 12),
    ]) {
      const totals = buildFor(day)
      const outside = totals.filter(t => t < DAY_MIN || t > DAY_MAX)
      expect(outside, `${day.toDateString()} produced ${JSON.stringify(outside)}`).toEqual([])
    }
  })
})
