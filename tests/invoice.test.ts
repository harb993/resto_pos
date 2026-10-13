import { describe, it, expect, beforeAll } from 'vitest'
import { initDatabase, getDb } from '../src/main/db/db'
import { createOrder, getInvoiceCounters } from '../src/main/services/orderService'
import type { CreateOrderInput } from '../src/shared/types'

let cashierId: number
let mealId: number
let mealPrice: number

function order(over: Partial<CreateOrderInput> = {}): CreateOrderInput {
  return {
    cashierId,
    paymentType: 'cash',
    orderType: 'dine_in',
    discountPercent: 0,
    items: [{ menuItemId: mealId, quantity: 1, unitPrice: mealPrice, itemName: 'x' }],
    ...over,
  }
}

beforeAll(() => {
  initDatabase()
  const db = getDb()
  cashierId = (db.prepare(`SELECT user_id FROM users WHERE username='cashier1'`).get() as any).user_id
  const meal = db.prepare(`SELECT item_id, price FROM menu_items ORDER BY item_id LIMIT 1`).get() as any
  mealId = meal.item_id
  mealPrice = meal.price
})

describe('one padded invoice counter for every order type', () => {
  it('issues 0001, 0002, 0003 … across dine-in, takeaway and delivery alike', () => {
    // A new database has no delivery areas of its own any more — give the test one.
    getDb().prepare(`INSERT INTO delivery_areas (area_name, delivery_fee) SELECT 'منطقة الاختبار', 20 WHERE NOT EXISTS (SELECT 1 FROM delivery_areas WHERE is_active = 1)`).run()
    const area = getDb().prepare('SELECT * FROM delivery_areas WHERE is_active = 1 LIMIT 1').get() as any
    const issued = [
      createOrder(order({ orderType: 'dine_in' }), 'cashier'),
      createOrder(order({ orderType: 'takeaway' }), 'cashier'),
      createOrder(order({
        orderType: 'delivery',
        deliveryAreaId: area.delivery_area_id,
        customerName: 'عميل', customerPhone: '01000000000', customerAddress: 'شارع 1',
      } as any), 'cashier'),
      createOrder(order({ orderType: 'takeaway' }), 'cashier'),
    ]

    // Four digits, no prefix, and one unbroken run — the type never gets its own series.
    for (const r of issued) expect(r.invoiceNumber).toMatch(/^\d{4}$/)
    const nums = issued.map(r => Number(r.invoiceNumber))
    expect(nums).toEqual([nums[0], nums[0] + 1, nums[0] + 2, nums[0] + 3])

    // The order type is still recorded — it just no longer drives the numbering.
    const types = issued.map(r =>
      (getDb().prepare('SELECT order_type t FROM orders WHERE order_id=?').get(r.orderId) as any).t)
    expect(types).toEqual(['dine_in', 'takeaway', 'delivery', 'takeaway'])
  })

  it('exposes a single counter to settings, with no prefix', () => {
    const counters = getInvoiceCounters()
    expect(counters).toHaveLength(1)
    expect(counters[0].prefix).toBe('')
  })
})
