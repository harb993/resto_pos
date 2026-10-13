import { describe, it, expect, beforeAll } from 'vitest'
import { initDatabase, getDb } from '../src/main/db/db'
import { getFinanceReport } from '../src/main/services/financeService'
import { createOrder, voidOrder } from '../src/main/services/orderService'

/**
 * "How much of everything did we sell, and what did that eat off the shelf?"
 *
 * Two questions the profit table could not answer: it is ranked by profit and cut at
 * twelve, so the long tail is invisible — and it counts MEALS, not the bread, cola and
 * pieces of chicken inside them. The shelf is what gets re-ordered.
 */

let ownerId: number
let meal: number
let cola: number
let today: string

beforeAll(() => {
  initDatabase()
  const db = getDb()
  ownerId = (db.prepare(`SELECT user_id FROM users WHERE role='owner'`).get() as any).user_id

  const cat = Number(db.prepare(`INSERT INTO categories (name, display_order) VALUES ('وجبات',1)`)
    .run().lastInsertRowid)

  // A meal with a recipe: it is one line on the invoice but four things off the shelf.
  meal = Number(db.prepare(
    `INSERT INTO menu_items (category_id,name,price,cost_price) VALUES (?,'وجبة ربع فراخ',100,40)`
  ).run(cat).lastInsertRowid)
  // A can, sold as itself with no recipe at all.
  cola = Number(db.prepare(
    `INSERT INTO menu_items (category_id,name,price,cost_price) VALUES (?,'بيبسي',20,10)`
  ).run(cat).lastInsertRowid)

  const material = (name: string, unit: string, cost: number) => Number(db.prepare(
    `INSERT INTO raw_materials (name,unit,stock_quantity,cost_per_unit) VALUES (?,?,1000,?)`
  ).run(name, unit, cost).lastInsertRowid)

  const chicken = material('قطع فراخ', 'قطعة', 11)
  const bread = material('عيش', 'رغيف', 1.5)
  const rice = material('أرز', 'كجم', 30)

  const recipe = db.prepare(
    `INSERT INTO recipe_items (menu_item_id, raw_material_id, quantity) VALUES (?,?,?)`
  )
  recipe.run(meal, chicken, 2)     // 2 pieces of chicken per meal
  recipe.run(meal, bread, 1)       // 1 bread
  recipe.run(meal, rice, 0.15)     // 150g rice

  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  today = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
})

const sell = (itemId: number, qty: number) =>
  createOrder({
    cashierId: ownerId,
    items: [{ menuItemId: itemId, quantity: qty }],
    paymentType: 'cash',
    orderType: 'takeaway',
  } as any, 'owner')

describe('every item sold, by quantity', () => {
  it('lists each item with the number actually sold', () => {
    sell(meal, 3)
    sell(meal, 2)
    sell(cola, 4)

    const r = getFinanceReport(today, today)
    const byName = Object.fromEntries(r.itemsSold.map(i => [i.name, i]))
    console.log('itemsSold:', JSON.stringify(r.itemsSold))

    expect(byName['وجبة ربع فراخ'].units).toBe(5)
    expect(byName['بيبسي'].units).toBe(4)
    expect(byName['وجبة ربع فراخ'].revenue).toBeCloseTo(500)
  })

  it('names the category each one belongs to', () => {
    const r = getFinanceReport(today, today)
    expect(r.itemsSold.every(i => i.category === 'وجبات')).toBe(true)
  })

  it('is ordered by quantity, busiest first', () => {
    const units = getFinanceReport(today, today).itemsSold.map(i => i.units)
    expect([...units].sort((a, b) => b - a)).toEqual(units)
  })

  it('includes an item the top-twelve profit table would have cut', () => {
    // The point of the list: nothing is left out of it.
    const r = getFinanceReport(today, today)
    expect(r.itemsSold.length).toBeGreaterThanOrEqual(2)
    expect(r.itemsSold.map(i => i.name)).toContain('بيبسي')
  })
})

describe('what those sales consumed off the shelf', () => {
  it('reports the raw materials inside the meals, not the meals', () => {
    const r = getFinanceReport(today, today)
    const byName = Object.fromEntries(r.materialsUsed.map(m => [m.name, m]))
    console.log('materialsUsed:', JSON.stringify(r.materialsUsed))

    // 5 meals × 2 pieces = 10 pieces of chicken, 5 bread, 750g rice.
    expect(byName['قطع فراخ'].quantity).toBeCloseTo(10)
    expect(byName['قطع فراخ'].unit).toBe('قطعة')
    expect(byName['عيش'].quantity).toBeCloseTo(5)
    expect(byName['أرز'].quantity).toBeCloseTo(0.75)
  })

  it('values them at cost', () => {
    const byName = Object.fromEntries(
      getFinanceReport(today, today).materialsUsed.map(m => [m.name, m])
    )
    expect(byName['قطع فراخ'].cost).toBeCloseTo(110)  // 10 × 11
    expect(byName['عيش'].cost).toBeCloseTo(7.5)       // 5 × 1.5
  })

  it('leaves out an item that has no recipe — it consumes no raw material', () => {
    const names = getFinanceReport(today, today).materialsUsed.map(m => m.name)
    expect(names).not.toContain('بيبسي')
  })

  it('takes a cancelled invoice back out again', () => {
    const before = getFinanceReport(today, today).materialsUsed
      .find(m => m.name === 'قطع فراخ')!.quantity

    const order = sell(meal, 1)                       // +2 pieces
    voidOrder(order.orderId, ownerId, 'اختبار')       // …and hand them back

    const after = getFinanceReport(today, today).materialsUsed
      .find(m => m.name === 'قطع فراخ')!.quantity

    console.log('chicken pieces before/after a voided sale:', before, after)
    expect(after).toBeCloseTo(before)
  })

  it('is ordered by quantity, heaviest use first', () => {
    const q = getFinanceReport(today, today).materialsUsed.map(m => m.quantity)
    expect([...q].sort((a, b) => b - a)).toEqual(q)
  })
})
