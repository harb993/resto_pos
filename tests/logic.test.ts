import { describe, it, expect, beforeAll } from 'vitest'
import Database from 'better-sqlite3'
import { initDatabase, getDb } from '../src/main/db/db'
import { createOrder } from '../src/main/services/orderService'
import { updateSettings } from '../src/main/services/settingsService'
import type { CreateOrderInput } from '../src/shared/types'

/**
 * Logic, not arithmetic.
 *
 * The money suite asks whether the sums add up. These ask whether the sums are the
 * RIGHT sums — the cases where every figure reconciles with every other figure and
 * the answer is still wrong. Both of the first two here were real, and both had been
 * reconciling perfectly the whole time.
 */

const cents = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

let cashierId: number
let mealId: number
const TAX = 0.14

function order(over: Partial<CreateOrderInput> = {}): CreateOrderInput {
  return {
    cashierId, paymentType: 'cash', orderType: 'dine_in', discountPercent: 0,
    items: [{ menuItemId: mealId, quantity: 1, unitPrice: 100, itemName: 'x' }],
    ...over,
  }
}

beforeAll(() => {
  initDatabase()
  const db = getDb()
  cashierId = (db.prepare(`SELECT user_id FROM users WHERE username='cashier1'`).get() as any).user_id
  // A round 100.00 item, so the expected VAT is obvious by eye rather than derived.
  mealId = Number(db.prepare(`
    INSERT INTO menu_items (category_id, name, price, cost_price, stock_quantity, is_active)
    SELECT category_id, 'صنف مئة جنيه', 100, 30, 0, 1 FROM categories LIMIT 1
  `).run().lastInsertRowid)
  updateSettings({ tax_rate: TAX, max_cashier_discount: 100 })
})

describe('VAT is charged on what the customer actually pays', () => {
  /**
   * The bug: VAT was computed on the menu price and the discount taken off
   * afterwards, so a discounted bill was taxed on money nobody paid. Every total
   * still reconciled — subtotal + tax − discount + delivery — which is why no
   * arithmetic check ever caught it.
   */
  it('taxes the discounted amount, not the menu price', () => {
    const r = createOrder(order({ discountPercent: 10 }), 'owner')
    expect(cents(r.subtotal)).toBe(100)
    expect(cents(r.discount)).toBe(10)
    expect(cents(r.tax)).toBe(12.60)      // 14% of 90, not of 100
    expect(cents(r.totalAmount)).toBe(102.60)
  })

  it('charges no VAT at all when the food is given away', () => {
    const r = createOrder(order({ discountPercent: 100 }), 'owner')
    expect(cents(r.tax)).toBe(0)
    expect(cents(r.totalAmount)).toBe(0)
  })

  it('is unchanged when there is no discount', () => {
    const r = createOrder(order({ discountPercent: 0 }), 'owner')
    expect(cents(r.tax)).toBe(14)
    expect(cents(r.totalAmount)).toBe(114)
  })

  it('holds across a range of discounts', () => {
    for (const pct of [1, 7, 12.5, 33, 50, 99]) {
      const r = createOrder(order({ discountPercent: pct }), 'owner')
      const taxable = cents(100 - cents(pct))
      expect(cents(r.tax), `${pct}% off`).toBe(cents(taxable * TAX))
      expect(cents(r.totalAmount), `${pct}% off`).toBe(cents(taxable + cents(taxable * TAX)))
    }
  })

  it('still never charges VAT on takeaway or delivery, discounted or not', () => {
    expect(cents(createOrder(order({ orderType: 'takeaway', discountPercent: 10 }), 'owner').tax)).toBe(0)
  })

  it('the stored row agrees with what the customer was told', () => {
    const r = createOrder(order({ discountPercent: 25 }), 'owner')
    const row = getDb().prepare('SELECT * FROM orders WHERE order_id=?').get(r.orderId) as any
    expect(cents(row.tax)).toBe(cents(75 * TAX))
    expect(cents(row.total_amount)).toBe(cents(75 + 75 * TAX))
    // and the invariant every other suite checks still holds
    expect(cents(row.total_amount)).toBe(
      cents(row.subtotal + row.tax - row.discount + (row.delivery_fee ?? 0)))
  })
})

describe('the week the dashboard means by "this week"', () => {
  /**
   * SQLite's `weekday N` only moves the date FORWARD, and does nothing when it is
   * already on that weekday. So `'weekday 1','-7 days'` lands on the Monday of the
   * current week from Tuesday to Sunday — and on the PREVIOUS Monday when run on a
   * Monday. Every Monday, "this week" quietly included the whole of last week.
   *
   * `'-6 days','weekday 1'` goes back first and then forward, which lands on the
   * right Monday on all seven days.
   */
  const db = new Database(':memory:')
  const monday = (today: string, expr: string) =>
    (db.prepare(`SELECT date(?, ${expr}) v`).get(today) as any).v

  const WEEK = [
    ['2026-09-07', 'Mon'], ['2026-09-08', 'Tue'], ['2026-09-09', 'Wed'],
    ['2026-09-10', 'Thu'], ['2026-09-11', 'Fri'], ['2026-09-12', 'Sat'],
    ['2026-09-13', 'Sun'],
  ] as const

  it.each(WEEK)('%s (%s) reports the week beginning Monday 2026-09-07', (day) => {
    expect(monday(day, `'-6 days','weekday 1'`)).toBe('2026-09-07')
  })

  it('the old expression was right on six days and wrong on Monday', () => {
    for (const [day] of WEEK.slice(1)) {
      expect(monday(day, `'weekday 1','-7 days'`)).toBe('2026-09-07')
    }
    // The seventh day is the one that was broken.
    expect(monday('2026-09-07', `'weekday 1','-7 days'`)).toBe('2026-08-31')
  })

  it('last week sits immediately before this week, with no gap and no overlap', () => {
    for (const [day] of WEEK) {
      const curStart = monday(day, `'-6 days','weekday 1'`)
      const prevStart = monday(day, `'-13 days','weekday 1'`)
      const gap = (db.prepare('SELECT julianday(?) - julianday(?) v').get(curStart, prevStart) as any).v
      expect(gap, `on ${day}`).toBe(7)
    }
  })

  it('is the expression the service actually uses', async () => {
    const src = await import('node:fs').then(fs =>
      fs.readFileSync('src/main/services/analyticsService.ts', 'utf8'))
    // Only the SQL lines — the comment above them quotes the broken expression on
    // purpose, to explain what it did.
    const sql = src.split('\n').filter(l => l.includes('SELECT COUNT(*)')).join('\n')
    expect(sql).toContain(`'-6 days','weekday 1'`)
    expect(sql).not.toContain(`'weekday 1','-7 days'`)
    expect(sql).not.toContain(`'weekday 1','-14 days'`)
  })
})

describe('costs and prices are sane', () => {
  it('flags any active item sold below what it costs to make', () => {
    /**
     * Not a code defect — a data one the system has no guard against. Selling under
     * cost is always allowed (a loss-leader is a real decision), but it should never
     * be a surprise, and nothing in the app currently says so.
     */
    const losers = getDb().prepare(`
      SELECT mi.name, mi.price,
             COALESCE(SUM(ri.quantity * rm.cost_per_unit), mi.cost_price) AS cost
      FROM menu_items mi
      LEFT JOIN recipe_items ri ON ri.menu_item_id = mi.item_id
      LEFT JOIN raw_materials rm ON rm.raw_material_id = ri.raw_material_id
      WHERE mi.is_active = 1
      GROUP BY mi.item_id
      HAVING cost > mi.price + 0.005
    `).all() as any[]
    // Seed data must not ship at a loss. Anything the owner adds later is their call.
    expect(losers, `items priced under cost: ${JSON.stringify(losers)}`).toEqual([])
  })

  it('a prep conversion carries the cost through to the output material', () => {
    const bad = getDb().prepare(`
      SELECT s.name src, s.cost_per_unit scost, pc.yield_quantity y, o.name out, o.cost_per_unit ocost
      FROM prep_conversions pc
      JOIN raw_materials s ON s.raw_material_id = pc.source_material_id
      JOIN raw_materials o ON o.raw_material_id = pc.output_material_id
      WHERE pc.yield_quantity > 0
        AND ABS(o.cost_per_unit - (s.cost_per_unit / pc.yield_quantity)) > 0.01
    `).all() as any[]
    expect(bad, `prep output costed inconsistently: ${JSON.stringify(bad)}`).toEqual([])
  })
})
