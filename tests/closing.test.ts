import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../src/main/db/db'
import { updateSettings } from '../src/main/services/settingsService'
import { closingWindowAt, closingWindowOn } from '../src/main/services/shiftService'
import { getClosingReport } from '../src/main/services/closingService'
import { getFinanceReport } from '../src/main/services/financeService'

/**
 * «تقفيل الوردية» follows the shift hours in the settings — not the calendar day, and
 * not one cashier's sign-in.
 */

let ownerId: number
let cashierId: number

const at = (y: number, m: number, d: number, h: number, min = 0) => new Date(y, m - 1, d, h, min)
const hm = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`

const order = (createdAt: string, total: number, by: number, opts: { payment?: string; status?: string } = {}) =>
  getDb().prepare(`
    INSERT INTO orders (cashier_id, order_type, payment_type, subtotal, tax, discount, total_amount, status, created_at)
    VALUES (?, 'takeaway', ?, ?, 0, 0, ?, ?, ?)
  `).run(by, opts.payment ?? 'cash', total, total, opts.status ?? 'completed', createdAt)

const expense = (createdAt: string, amount: number, by: number) =>
  getDb().prepare(`
    INSERT INTO expenses (category, description, amount, recorded_by, expense_date, created_at)
    VALUES ('other', 'اختبار', ?, ?, ?, ?)
  `).run(amount, by, createdAt.slice(0, 10), createdAt)

beforeAll(() => {
  initDatabase()
  const db = getDb()
  ownerId = (db.prepare(`SELECT user_id FROM users WHERE role='owner'`).get() as any).user_id
  cashierId = (db.prepare(`SELECT user_id FROM users WHERE role='cashier'`).get() as any)?.user_id ?? ownerId
})

beforeEach(() => {
  const db = getDb()
  db.prepare('DELETE FROM order_items').run()
  db.prepare('DELETE FROM orders').run()
  db.prepare('DELETE FROM expenses').run()
})

describe('which shift a moment closes', () => {
  it('two shifts: the night shift keeps its date past midnight', () => {
    updateSettings({
      shifts_per_day: 2, shift1_start: '09:00', shift1_end: '17:00',
      shift2_start: '17:00', shift2_end: '03:00',
    } as never)

    const w = closingWindowAt(at(2026, 9, 14, 1, 30))
    expect(w.number).toBe(2)
    expect(w.start).toEqual(at(2026, 9, 13, 17))
    expect(w.scheduledEnd).toEqual(at(2026, 9, 14, 3))
    // Runs to the next shift's start, so nothing rung up after 03:00 is orphaned.
    expect(w.coverEnd).toEqual(at(2026, 9, 14, 9))
  })

  it('two shifts: mid-morning is the day shift, ending when the night one starts', () => {
    const w = closingWindowAt(at(2026, 9, 14, 11))
    expect(w.number).toBe(1)
    expect(hm(w.start)).toBe('09:00')
    expect(w.coverEnd).toEqual(at(2026, 9, 14, 17))
  })

  it('one shift: just after it ends, the close-out is still that shift', () => {
    updateSettings({ shifts_per_day: 1, shift1_start: '10:00', shift1_end: '04:00' } as never)

    const w = closingWindowAt(at(2026, 9, 14, 4, 20))
    expect(w.start).toEqual(at(2026, 9, 13, 10))
    expect(w.scheduledEnd).toEqual(at(2026, 9, 14, 4))
    expect(w.coverEnd).toEqual(at(2026, 9, 14, 10))
  })

  it('a named shift on a named day', () => {
    updateSettings({
      shifts_per_day: 2, shift1_start: '09:00', shift1_end: '17:00',
      shift2_start: '17:00', shift2_end: '03:00',
    } as never)
    const w = closingWindowOn('2026-09-13', 2)
    expect(w.start).toEqual(at(2026, 9, 13, 17))
    expect(w.scheduledEnd).toEqual(at(2026, 9, 14, 3))
  })
})

describe('what the close-out contains', () => {
  beforeEach(() => {
    updateSettings({
      shifts_per_day: 2, shift1_start: '09:00', shift1_end: '17:00',
      shift2_start: '17:00', shift2_end: '03:00',
    } as never)
  })

  it('every invoice in the shift hours, whoever rang it up — and none from the other shift', () => {
    order('2026-09-13 12:00:00', 100, ownerId)                       // day shift
    order('2026-09-13 18:00:00', 200, ownerId)                       // night, owner
    order('2026-09-13 23:30:00', 300, cashierId, { payment: 'card' }) // night, cashier
    order('2026-09-14 01:15:00', 50, cashierId)                      // night, past midnight
    order('2026-09-14 02:00:00', 999, cashierId, { status: 'voided' })
    order('2026-09-14 09:30:00', 70, ownerId)                        // next day shift

    const night = getClosingReport({ date: '2026-09-13', shiftNumber: 2 }, at(2026, 9, 14, 12))
    expect(night.orderCount).toBe(3)
    expect(night.revenue).toBe(550)
    expect(night.cashSales).toBe(250)
    expect(night.cardSales).toBe(300)
    expect(night.voidedCount).toBe(1)
    expect(night.invoices).toHaveLength(4) // the voided one is listed, struck through
    expect(night.isOpen).toBe(false)

    const day = getClosingReport({ date: '2026-09-13', shiftNumber: 1 }, at(2026, 9, 14, 12))
    expect(day.revenue).toBe(100)
  })

  it('every expense in the shift hours, whoever recorded it, comes off the drawer', () => {
    order('2026-09-13 18:00:00', 500, cashierId)
    expense('2026-09-13 19:00:00', 40, cashierId)
    expense('2026-09-13 22:00:00', 60, ownerId)   // recorded by somebody else — still counts
    expense('2026-09-13 10:00:00', 999, ownerId)  // the day shift's

    const r = getClosingReport({ date: '2026-09-13', shiftNumber: 2 }, at(2026, 9, 14, 12))
    expect(r.expenses).toHaveLength(2)
    expect(r.expensesTotal).toBe(100)
    expect(r.outgoingsTotal).toBe(100)
    expect(r.expectedCash).toBe(400)
  })

  it('with no date it is the shift running now, and says it is still open', () => {
    order('2026-09-13 18:00:00', 120, cashierId)
    const r = getClosingReport({}, at(2026, 9, 13, 20))
    expect(r.shiftNumber).toBe(2)
    expect(r.shiftDate).toBe('2026-09-13')
    expect(r.revenue).toBe(120)
    expect(r.isOpen).toBe(true)
  })
})

describe('the finance report for one shift', () => {
  beforeEach(() => {
    updateSettings({
      shifts_per_day: 2, shift1_start: '09:00', shift1_end: '17:00',
      shift2_start: '17:00', shift2_end: '03:00',
    } as never)
  })

  it('counts the night shift across midnight, and nothing from the shifts either side', () => {
    order('2026-09-13 12:00:00', 100, ownerId)
    order('2026-09-13 18:00:00', 200, ownerId)
    order('2026-09-14 01:15:00', 50, cashierId)   // next calendar day, same shift
    order('2026-09-14 09:30:00', 70, ownerId)
    expense('2026-09-13 19:00:00', 40, cashierId)
    expense('2026-09-13 10:00:00', 999, ownerId)

    const r = getFinanceReport('', '', closingWindowOn('2026-09-13', 2))
    expect(r.revenue).toBe(250)
    expect(r.orderCount).toBe(2)
    expect(r.expensesTotal).toBe(40)
    expect(r.netProfit).toBe(210)
    expect(r.shift).toMatchObject({
      number: 2, date: '2026-09-13',
      startedAt: '2026-09-13 17:00', endsAt: '2026-09-14 03:00', isOpen: false,
    })

    // The same day by the calendar is a different answer — which is the point.
    const day = getFinanceReport('2026-09-13', '2026-09-13')
    expect(day.revenue).toBe(300)
    expect(day.shift).toBeUndefined()
  })
})
