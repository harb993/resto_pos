import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../src/main/db/db'
import { getSalesProductsReport } from '../src/main/services/salesProductsService'
import { importMenuCatalog } from '../src/main/services/menuImportService'
import { importRecipeCatalog } from '../src/main/services/recipeImportService'
import { createOrder, voidOrder } from '../src/main/services/orderService'

/**
 * «Sales Products» — the counting report.
 *
 * Not the profit table: that one is ranked by profit and cut at twelve, which is the
 * wrong shape for the question this answers. Here nothing is left out, the order is
 * the menu's own, and there is a total per section — because that is how the person
 * holding it reads the kitchen.
 */

let ownerId: number
let today: string

const itemNamed = (name: string) =>
  (getDb().prepare('SELECT item_id FROM menu_items WHERE name = ?').get(name) as any).item_id

const sell = (itemId: number, qty = 1) =>
  createOrder({
    cashierId: ownerId, items: [{ menuItemId: itemId, quantity: qty }],
    paymentType: 'cash', orderType: 'takeaway',
  } as any, 'owner')

beforeAll(() => {
  initDatabase()
  ownerId = (getDb().prepare(`SELECT user_id FROM users WHERE role='owner'`).get() as any).user_id
  importMenuCatalog()
  importRecipeCatalog()
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  today = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
})

beforeEach(() => {
  const db = getDb()
  db.prepare('DELETE FROM order_items').run()
  db.prepare('DELETE FROM raw_material_transactions').run()
  db.prepare('DELETE FROM orders').run()
})

describe('the report', () => {
  it('groups what was sold by section, with a total for each', () => {
    sell(itemNamed('وجبة 4 قطعة بروستيد'), 3)
    sell(itemNamed('تشيكن برجر'), 2)

    const r = getSalesProductsReport(today, today)
    console.log('groups:', JSON.stringify(r.groups.map(g => ({
      c: g.category, q: g.quantity, t: g.total,
    }))))

    const broasted = r.groups.find(g => g.category === 'وجبات البروستيد')!
    const burgers = r.groups.find(g => g.category === 'البرجر')!

    expect(broasted.quantity).toBe(3)
    expect(broasted.total).toBeCloseTo(630)   // 3 × 210
    expect(burgers.quantity).toBe(2)
    expect(burgers.total).toBeCloseTo(170)    // 2 × 85
  })

  it('adds the sections up to the grand total', () => {
    sell(itemNamed('وجبة 4 قطعة بروستيد'), 3)
    sell(itemNamed('تشيكن برجر'), 2)

    const r = getSalesProductsReport(today, today)
    const summed = r.groups.reduce((t, g) => t + g.total, 0)

    expect(r.grandTotal).toBeCloseTo(summed)
    expect(r.grandTotal).toBeCloseTo(800)
    expect(r.totalQuantity).toBe(5)
    expect(r.orderCount).toBe(2)
  })

  it('carries the store name and currency for the header', () => {
    const r = getSalesProductsReport(today, today)
    expect(r.storeName).toBeTruthy()
    expect(r.currency).toBeTruthy()
    expect(r.period).toEqual({ start: today, end: today })
  })

  it('reports the raw materials those sales consumed', () => {
    sell(itemNamed('وجبة 4 قطعة بروستيد'), 3)

    const r = getSalesProductsReport(today, today)
    const used = Object.fromEntries(r.materials.map(m => [m.name, m.quantity]))
    console.log('materials:', JSON.stringify(used))

    expect(used['قطعة بروستيد']).toBeCloseTo(12)
    expect(used['خبز']).toBeCloseTo(9)
    expect(used['بطاطس']).toBeCloseTo(0.3)
  })

  it('leaves a cancelled invoice out of both halves', () => {
    const item = itemNamed('تشيكن برجر')
    sell(item, 2)
    const scrapped = sell(item, 5)
    voidOrder(scrapped.orderId, ownerId, 'اختبار')

    const r = getSalesProductsReport(today, today)
    const burgers = r.groups.find(g => g.category === 'البرجر')!

    expect(burgers.quantity).toBe(2)          // the 5 are gone
    expect(r.totalQuantity).toBe(2)
    // …and so are the ingredients they took.
    const bun = r.materials.find(m => m.name === 'لقمة كيزر')
    expect(bun?.quantity ?? 0).toBeCloseTo(2)
  })

  it('is empty, not broken, for a period with no trade', () => {
    const r = getSalesProductsReport('2020-01-01', '2020-01-02')
    expect(r.groups).toEqual([])
    expect(r.materials).toEqual([])
    expect(r.grandTotal).toBe(0)
    expect(r.totalQuantity).toBe(0)
    expect(r.orderCount).toBe(0)
  })

  it('counts every item, with no cut-off', () => {
    // Twelve distinct dishes — the profit table would show exactly twelve and hide
    // the rest; this must show all of them.
    const names = [
      'وجبة 2 قطعة بروستيد', 'وجبة 3 قطعة بروستيد', 'وجبة 4 قطعة بروستيد',
      'وجبة 6 قطعة بروستيد', 'وجبة 8 قطعة بروستيد', 'وجبة 12 قطعة بروستيد',
      'تشيكن برجر', 'بيف برجر', 'AKM', 'بيج فاير', 'زنجر كريسبو', 'كريسبو تاور',
      'صوص رانش', 'كلوسلو',
    ]
    for (const n of names) sell(itemNamed(n), 1)

    const r = getSalesProductsReport(today, today)
    const listed = r.groups.flatMap(g => g.items.map(i => i.name))
    expect(listed.length).toBe(names.length)
    for (const n of names) expect(listed, n).toContain(n)
  })
})
