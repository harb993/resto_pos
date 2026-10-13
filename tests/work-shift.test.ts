import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../src/main/db/db'
import { updateSettings } from '../src/main/services/settingsService'
import {
  tickWorkShift, getWorkShiftStatus, startWorkShiftManually, listWorkShifts,
  requireOpenWorkShift, workShiftWindow,
} from '../src/main/services/workShiftService'
import { getWorkShiftReport } from '../src/main/services/shiftReportService'
import { getClosingReport } from '../src/main/services/closingService'
import { getFinanceReport } from '../src/main/services/financeService'
import { createOrder } from '../src/main/services/orderService'

/**
 * The shop runs by the SHIFT.
 *
 * A shift ends at the time the owner set and the next begins at the time the owner
 * set — or sooner, if the owner starts one by hand in between. Every invoice, expense
 * and wage belongs to exactly one shift, and every report of a shift says the same
 * thing about it.
 *
 * The first block is the afternoon this was reported from: one shift a day ending at
 * 17:50, a wage typed in two seconds after it ended, and a sale rung up a minute later.
 */

let ownerId: number
let cashierId: number
let mealId: number
let mealPrice: number
let workerId: number

const at = (d: number, h: number, min = 0, s = 0) => new Date(2026, 9, d, h, min, s) // October 2026

const order = (createdAt: string, o: {
  subtotal: number; tax?: number; cost?: number; payment?: string
  type?: string; driverId?: number | null; status?: string
}) => {
  const db = getDb()
  const tax = o.tax ?? 0
  const id = db.prepare(`
    INSERT INTO orders (cashier_id, order_type, payment_type, subtotal, tax, discount, total_amount,
                        status, driver_id, created_at)
    VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
  `).run(cashierId, o.type ?? 'takeaway', o.payment ?? 'cash', o.subtotal, tax, o.subtotal + tax,
    o.status ?? 'completed', o.driverId ?? null, createdAt).lastInsertRowid as number
  db.prepare(`
    INSERT INTO order_items (order_id, menu_item_id, quantity, unit_price, unit_cost)
    VALUES (?, ?, 1, ?, ?)
  `).run(id, mealId, o.subtotal, o.cost ?? 0)
  return id
}

const expense = (createdAt: string, amount: number, category = 'utilities') =>
  getDb().prepare(`
    INSERT INTO expenses (category, description, amount, recorded_by, expense_date, created_at)
    VALUES (?, 'اختبار', ?, ?, ?, ?)
  `).run(category, amount, ownerId, createdAt.slice(0, 10), createdAt)

const salary = (createdAt: string, amount: number) =>
  getDb().prepare(`
    INSERT INTO salaries (worker_id, amount, pay_period_start, pay_period_end, paid_on, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(workerId, amount, createdAt.slice(0, 10), createdAt.slice(0, 10), createdAt.slice(0, 10), ownerId, createdAt)

beforeAll(() => {
  initDatabase()
  const db = getDb()
  ownerId = (db.prepare(`SELECT user_id FROM users WHERE role='owner'`).get() as any).user_id
  cashierId = (db.prepare(`SELECT user_id FROM users WHERE username='cashier1'`).get() as any).user_id
  const meal = db.prepare(`SELECT item_id, price FROM menu_items ORDER BY item_id LIMIT 1`).get() as any
  mealId = meal.item_id
  mealPrice = meal.price
  workerId = db.prepare(`INSERT INTO workers (full_name, daily_wage) VALUES ('سعد', 300)`)
    .run().lastInsertRowid as number
})

beforeEach(() => {
  const db = getDb()
  tickWorkShift() // makes sure the table exists before it is emptied
  for (const t of ['order_items', 'orders', 'expenses', 'salaries', 'driver_settlements', 'work_shifts']) {
    db.prepare(`DELETE FROM ${t}`).run()
  }
})

describe('one shift a day, 09:00 to 17:50 — the reported afternoon', () => {
  beforeEach(() => {
    updateSettings({ shifts_per_day: 1, shift1_start: '09:00', shift1_end: '17:50' } as never)
  })

  it('opens at its start time, by itself', () => {
    const status = getWorkShiftStatus(at(12, 10))
    expect(status.open).toMatchObject({
      openedAt: '2026-10-12 09:00', endsAt: '2026-10-12 17:50', isOpen: true, manual: false,
    })
  })

  it('ends at its end time, by itself, and the till then refuses a sale', () => {
    tickWorkShift(at(12, 10))
    expect(getWorkShiftStatus(at(12, 17, 49)).open).not.toBeNull()

    const after = getWorkShiftStatus(at(12, 17, 51))
    expect(after.open).toBeNull()
    expect(after.last).toMatchObject({ endsAt: '2026-10-12 17:50', isOpen: false })
    expect(after.next).toMatchObject({ startsAt: '2026-10-13 09:00' })

    expect(() => requireOpenWorkShift(at(12, 17, 51))).toThrow(/لا توجد وردية مفتوحة/)
  })

  it('the owner can start an extra shift, which lasts until the next start time', () => {
    tickWorkShift(at(12, 10))
    tickWorkShift(at(12, 17, 51))

    const extra = startWorkShiftManually(ownerId, at(12, 17, 51))
    expect(extra).toMatchObject({
      name: 'إضافية', manual: true, isOpen: true,
      openedAt: '2026-10-12 17:51', endsAt: '2026-10-13 09:00',
    })
    expect(() => startWorkShiftManually(ownerId, at(12, 18))).toThrow(/وردية مفتوحة بالفعل/)

    // Still running late at night; at 09:00 the regular shift takes over by itself.
    expect(getWorkShiftStatus(at(12, 23)).open?.manual).toBe(true)
    const morning = getWorkShiftStatus(at(13, 9, 0))
    expect(morning.open).toMatchObject({ openedAt: '2026-10-13 09:00', manual: false })
    expect(listWorkShifts()).toHaveLength(3)
  })

  it('a wage typed in just after the shift ended is on THAT shift — not on none', () => {
    tickWorkShift(at(12, 10))
    order('2026-10-12 12:00:00', { subtotal: 1000, tax: 140, cost: 400 })
    expense('2026-10-12 13:00:00', 100)
    tickWorkShift(at(12, 17, 51))
    salary('2026-10-12 17:50:02', 300) // two seconds after 17:50

    startWorkShiftManually(ownerId, at(12, 17, 51))
    order('2026-10-12 18:00:00', { subtotal: 200 })

    const [extra, day] = listWorkShifts()
    const first = getWorkShiftReport(day.workShiftId)
    expect(first.salariesTotal).toBe(300)
    expect(first.salaries).toHaveLength(1)
    expect(first.orderCount).toBe(1)

    const second = getWorkShiftReport(extra.workShiftId)
    expect(second.salariesTotal).toBe(0)
    expect(second.revenue).toBe(200)
  })
})

describe('two shifts that hand over to each other', () => {
  beforeEach(() => {
    updateSettings({
      shifts_per_day: 2, shift1_start: '09:00', shift1_end: '17:00',
      shift2_start: '17:00', shift2_end: '01:00',
    } as never)
  })

  it('the evening shift starts the moment the day shift ends — nobody is asked', () => {
    tickWorkShift(at(12, 10))
    const evening = getWorkShiftStatus(at(12, 17, 0))
    expect(evening.open).toMatchObject({ shiftNumber: 2, openedAt: '2026-10-12 17:00', endsAt: '2026-10-13 01:00' })
    expect(listWorkShifts()[1]).toMatchObject({ shiftNumber: 1, endsAt: '2026-10-12 17:00', isOpen: false })
  })

  it('after the night shift there is a gap until morning', () => {
    tickWorkShift(at(12, 18))
    const night = getWorkShiftStatus(at(13, 1, 30))
    expect(night.open).toBeNull()
    expect(night.next).toMatchObject({ shiftNumber: 1, startsAt: '2026-10-13 09:00' })
  })
})

describe('a till switched on for the first time between shifts', () => {
  it('opens a shift at once rather than sitting dead until the next start time', () => {
    updateSettings({ shifts_per_day: 1, shift1_start: '10:00', shift1_end: '04:00' } as never)
    const status = getWorkShiftStatus(at(12, 5, 0))
    expect(status.open).toMatchObject({ openedAt: '2026-10-12 05:00', endsAt: '2026-10-12 10:00' })
  })
})

describe('the money of a shift — one answer, wherever it is asked', () => {
  let shiftId: number

  beforeEach(() => {
    updateSettings({ shifts_per_day: 1, shift1_start: '09:00', shift1_end: '17:50' } as never)
    tickWorkShift(at(12, 10))
    shiftId = listWorkShifts()[0].workShiftId
  })

  it('VAT is not profit, and buying ingredients is not charged twice', () => {
    order('2026-10-12 12:00:00', { subtotal: 1000, tax: 140, cost: 400 })
    expense('2026-10-12 13:00:00', 100, 'utilities')
    expense('2026-10-12 13:30:00', 300, 'ingredients')
    salary('2026-10-12 14:00:00', 150)

    const r = getWorkShiftReport(shiftId)
    expect(r.revenue).toBe(1140)
    expect(r.netSales).toBe(1000)        // 1140 − 140 VAT
    expect(r.grossProfit).toBe(600)      // − 400 cost of what was sold
    expect(r.operatingExpenses).toBe(100) // the 300 of ingredients is inside that 400
    expect(r.ingredientPurchases).toBe(300)
    expect(r.netProfit).toBe(350)        // 600 − 100 − 150

    // The drawer is the other question: everything paid out really left it.
    expect(r.expectedCash).toBe(1140 - 100 - 300 - 150)
  })

  it('the shift report, the finance screen and the close-out slip all agree', () => {
    order('2026-10-12 12:00:00', { subtotal: 1000, tax: 140, cost: 400 })
    order('2026-10-12 12:30:00', { subtotal: 500, cost: 200, payment: 'card' })
    expense('2026-10-12 13:00:00', 100)
    salary('2026-10-12 14:00:00', 150)

    const sheet = getWorkShiftReport(shiftId)
    const finance = getFinanceReport('', '', workShiftWindow(shiftId))
    const slip = getClosingReport({ workShiftId: shiftId }, at(12, 15))

    expect(finance.revenue).toBe(sheet.revenue)
    expect(finance.netSales).toBe(sheet.netSales)
    expect(finance.grossProfit).toBe(sheet.grossProfit)
    expect(finance.netProfit).toBe(sheet.netProfit)
    expect(finance.drawer?.expectedCash).toBe(sheet.expectedCash)

    expect(slip.revenue).toBe(sheet.revenue)
    expect(slip.cashSales).toBe(sheet.cashSales)
    expect(slip.expectedCash).toBe(sheet.expectedCash)
    expect(slip.salariesTotal).toBe(150)
    // Card money never reaches the drawer.
    expect(sheet.expectedCash).toBe(1140 - 100 - 150)
  })

  it('cash out with a delivery driver is not in the drawer until he pays it in', () => {
    const db = getDb()
    const driverId = db.prepare(`INSERT INTO delivery_drivers (full_name) VALUES ('طيار')`).run().lastInsertRowid as number
    order('2026-10-12 12:00:00', { subtotal: 300 })
    const delivery = order('2026-10-12 12:10:00', { subtotal: 500, type: 'delivery', driverId })

    let r = getWorkShiftReport(shiftId)
    expect(r.cashSales).toBe(800)
    expect(r.driverCashOut).toBe(500)
    expect(r.driverCashPending).toBe(500)
    expect(r.expectedCash).toBe(300)

    // He comes back and puts it on the counter.
    const settlementId = db.prepare(`
      INSERT INTO driver_settlements (driver_id, order_count, total_amount, settled_by, settled_at)
      VALUES (?, 1, 500, ?, '2026-10-12 13:00:00')
    `).run(driverId, ownerId).lastInsertRowid
    db.prepare('UPDATE orders SET settlement_id = ? WHERE order_id = ?').run(settlementId, delivery)

    r = getWorkShiftReport(shiftId)
    expect(r.settlementsReceived).toBe(500)
    expect(r.driverCashPending).toBe(0)
    expect(r.expectedCash).toBe(800)
  })

  it('a voided invoice is in nobody\'s money', () => {
    order('2026-10-12 12:00:00', { subtotal: 300 })
    order('2026-10-12 12:05:00', { subtotal: 900, status: 'voided' })
    const r = getWorkShiftReport(shiftId)
    expect(r.revenue).toBe(300)
    expect(r.voidedCount).toBe(1)
    expect(r.expectedCash).toBe(300)
  })
})

describe('invoice numbers count each shift separately', () => {
  const sale = () => createOrder({
    cashierId, paymentType: 'cash', orderType: 'takeaway', discountPercent: 0,
    items: [{ menuItemId: mealId, quantity: 1, unitPrice: mealPrice, itemName: 'x' }],
  } as any, 'cashier').invoiceNumber

  it('a new shift starts again at 0001', () => {
    const db = getDb()
    tickWorkShift() // the shift running right now, whatever the hour
    expect(sale()).toBe('0001')
    expect(sale()).toBe('0002')

    // That shift ends and another begins: move what happened an hour into the past
    // and open a fresh shift now.
    db.prepare(`UPDATE orders SET created_at = datetime('now','localtime','-1 hour')`).run()
    db.prepare(`
      UPDATE work_shifts SET opened_at = datetime('now','localtime','-2 hours'),
                             closed_at = datetime('now','localtime','-10 minutes')
    `).run()
    db.prepare(`INSERT INTO work_shifts (shift_number, opened_at, opened_by) VALUES (1, datetime('now','localtime','-5 minutes'), ?)`)
      .run(ownerId)

    expect(sale()).toBe('0001')
    expect(sale()).toBe('0002')

    // And each shift's own report lists its own run of numbers.
    const [second, first] = listWorkShifts()
    expect(getWorkShiftReport(first.workShiftId).invoices.map(i => i.invoiceNumber)).toEqual(['0001', '0002'])
    expect(getWorkShiftReport(second.workShiftId).invoices.map(i => i.invoiceNumber)).toEqual(['0001', '0002'])
  })
})
