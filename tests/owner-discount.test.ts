import { describe, it, expect, beforeAll } from 'vitest'
import { initDatabase, getDb } from '../src/main/db/db'
import { createOrder } from '../src/main/services/orderService'

/**
 * The 30% discount is the owner's: the till offers it only on the owner's account, and
 * the main process holds a cashier to their configured cap whatever is sent.
 */
let ownerId: number
let cashierId: number
let mealId: number

beforeAll(() => {
  initDatabase()
  const db = getDb()
  ownerId = (db.prepare(`SELECT user_id FROM users WHERE role='owner'`).get() as any).user_id
  cashierId = (db.prepare(`SELECT user_id FROM users WHERE role='cashier' LIMIT 1`).get() as any).user_id
  mealId = (db.prepare(`SELECT item_id FROM menu_items ORDER BY item_id LIMIT 1`).get() as any).item_id
  db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('max_cashier_discount', '20')`).run()
})

const sell = (by: number, role: 'owner' | 'cashier') => createOrder({
  cashierId: by,
  items: [{ menuItemId: mealId, quantity: 1 }],
  paymentType: 'cash',
  orderType: 'takeaway',
  discountPercent: 30,
} as any, role)

describe('30% discount', () => {
  it('goes through on the owner account', () => {
    const r = sell(ownerId, 'owner')
    expect(r.discountPercent).toBe(30)
    expect(r.discountCapped).toBeFalsy()
  })

  it('is held to the cap for a cashier', () => {
    const r = sell(cashierId, 'cashier')
    expect(r.discountPercent).toBe(20)
    expect(r.discountCapped).toBe(true)
  })
})
