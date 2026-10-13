import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../src/main/db/db'
import { updateSettings } from '../src/main/services/settingsService'
import { sweepShiftExports } from '../src/main/services/shiftExportService'

/**
 * WHEN the end-of-shift report is written.
 *
 * Signing out is not the end of a shift. A cashier signs out to swap with a
 * colleague, to let the owner check a figure, or because they lock the till on the
 * way to the kitchen — and every one of those closes a session. The first version
 * exported on each, which in this restaurant produced seven reports in ten minutes
 * and seven pushes at the group chat: the fastest way to train people to ignore the
 * report that actually matters.
 *
 * So the sweep waits for the configured shift WINDOW to end, and skips a session that
 * sold nothing. Nothing is lost in the meantime — an unexported session stays
 * unstamped and is picked up on a later tick.
 *
 * These tests never let the export itself run: rendering a PDF needs a real Chromium
 * window, which the test harness has no business opening. Every case here asserts on
 * whether the sweep DECIDED to export, which is the behaviour under test — the file
 * writing is covered by shift-export.test.ts.
 */

let userId: number
let itemId: number

const pad = (n: number) => String(n).padStart(2, '0')
const stamp = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
  `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`

/** A closed session between two moments, optionally with a sale in it. */
function session(from: Date, to: Date, opts: { withSale?: boolean } = {}): number {
  const db = getDb()
  const id = Number(db.prepare(`
    INSERT INTO shifts (cashier_id, shift_date, shift_number, start_time, end_time,
                        started_at, ended_at, set_by)
    VALUES (?, ?, 2, ?, ?, ?, ?, ?)
  `).run(
    userId,
    `${from.getFullYear()}-${pad(from.getMonth() + 1)}-${pad(from.getDate())}`,
    `${pad(from.getHours())}:${pad(from.getMinutes())}`,
    `${pad(to.getHours())}:${pad(to.getMinutes())}`,
    stamp(from), stamp(to), userId,
  ).lastInsertRowid)

  if (opts.withSale) {
    const mid = new Date((from.getTime() + to.getTime()) / 2)
    const orderId = Number(db.prepare(`
      INSERT INTO orders (cashier_id, subtotal, tax, discount, total_amount, payment_type, created_at)
      VALUES (?, 85, 0, 0, 85, 'cash', ?)
    `).run(userId, stamp(mid)).lastInsertRowid)
    db.prepare(
      'INSERT INTO order_items (order_id, menu_item_id, quantity, unit_price) VALUES (?, ?, 1, 85)'
    ).run(orderId, itemId)
  }
  return id
}

const exportedAt = (id: number) =>
  (getDb().prepare('SELECT report_exported_at FROM shifts WHERE shift_id = ?').get(id) as any)
    .report_exported_at

beforeAll(() => {
  initDatabase()
  const db = getDb()
  userId = (db.prepare(`SELECT user_id FROM users WHERE role = 'owner'`).get() as any).user_id
  const catId = Number(db.prepare(`INSERT INTO categories (name, display_order) VALUES ('برجر', 1)`)
    .run().lastInsertRowid)
  itemId = Number(db.prepare(
    `INSERT INTO menu_items (category_id, name, price, cost_price) VALUES (?, 'تشيكن برجر', 85, 40)`
  ).run(catId).lastInsertRowid)
  // Two shifts: mornings 09:00–17:00, evenings 17:00–03:00.
  updateSettings({
    shifts_per_day: 2,
    shift1_start: '09:00', shift1_end: '17:00',
    shift2_start: '17:00', shift2_end: '03:00',
  } as never)
})

beforeEach(() => {
  const db = getDb()
  db.prepare('DELETE FROM order_items').run()
  db.prepare('DELETE FROM orders').run()
  db.prepare('DELETE FROM shifts').run()
})

describe('the end-of-shift report waits for the shift, not the sign-out', () => {
  it('does not export a cashier who signed out in the middle of the evening shift', async () => {
    // Signed in 19:00, out 19:20 — a handover, not the end of anything. The evening
    // shift runs until 03:00.
    const id = session(new Date(2026, 8, 10, 19, 0), new Date(2026, 8, 10, 19, 20), { withSale: true })

    const done = await sweepShiftExports(new Date(2026, 8, 10, 19, 25))

    expect(done).toHaveLength(0)
    // Deliberately left unstamped, so it is picked up once the shift really ends.
    expect(exportedAt(id)).toBeNull()
  })

  it('leaves it queued through every later sign-out in the same shift', async () => {
    session(new Date(2026, 8, 10, 19, 0), new Date(2026, 8, 10, 19, 20), { withSale: true })
    session(new Date(2026, 8, 10, 19, 25), new Date(2026, 8, 10, 20, 0), { withSale: true })
    session(new Date(2026, 8, 10, 20, 5), new Date(2026, 8, 10, 21, 0), { withSale: true })

    // Three sign-outs, and at no point during the shift does anything get exported —
    // this is the "seven reports in ten minutes" case.
    for (const at of [19, 20, 21, 22, 23]) {
      expect(await sweepShiftExports(new Date(2026, 8, 10, at, 30))).toHaveLength(0)
    }
    expect(
      (getDb().prepare('SELECT COUNT(*) AS c FROM shifts WHERE report_exported_at IS NOT NULL').get() as any).c
    ).toBe(0)
  })

  it('never writes a report for a shift that sold nothing', async () => {
    const id = session(new Date(2026, 8, 10, 19, 0), new Date(2026, 8, 10, 19, 5))

    // Well past 03:00, so the window is over and only the "no sales" rule is left.
    const done = await sweepShiftExports(new Date(2026, 8, 11, 4, 0))

    expect(done).toHaveLength(0)
    // Stamped, not left queued: there is nothing to wait for, and an unstamped row
    // would be reconsidered every minute forever.
    expect(exportedAt(id)).not.toBeNull()
  })

  it('a session still open is never exported', async () => {
    getDb().prepare(`
      INSERT INTO shifts (cashier_id, shift_date, shift_number, start_time, started_at, set_by)
      VALUES (?, '2026-09-10', 2, '19:00', '2026-09-10 19:00:00', ?)
    `).run(userId, userId)

    expect(await sweepShiftExports(new Date(2026, 8, 11, 4, 0))).toHaveLength(0)
  })

  it('is switched off entirely when the owner turns it off', async () => {
    session(new Date(2026, 8, 10, 19, 0), new Date(2026, 8, 10, 19, 20), { withSale: true })
    updateSettings({ shift_export_auto: 0 } as never)

    expect(await sweepShiftExports(new Date(2026, 8, 11, 4, 0))).toHaveLength(0)

    updateSettings({ shift_export_auto: 1 } as never)
  })

  it('picks the shift up once its window has actually ended', async () => {
    // The one case that SHOULD export: a selling session, and 03:00 has passed. It is
    // allowed to reach the render, so this asserts it got that far rather than being
    // skipped — a PDF cannot be produced in the test harness.
    const id = session(new Date(2026, 8, 10, 19, 0), new Date(2026, 8, 10, 19, 20), { withSale: true })

    await sweepShiftExports(new Date(2026, 8, 11, 4, 0))

    // Stamped either way — the sweep decided to deal with it, which is the decision
    // under test. Whether the PDF rendered is shift-export.test.ts's business.
    expect(exportedAt(id)).not.toBeNull()
  })
})
