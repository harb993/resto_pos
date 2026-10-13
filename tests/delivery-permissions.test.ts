import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import { initDatabase, getDb } from '../src/main/db/db'
import { createOrder } from '../src/main/services/orderService'
import * as delivery from '../src/main/services/deliveryService'
import { registerDeliveryIpc } from '../src/main/ipc/delivery.ipc'
import { registerAuthIpc } from '../src/main/ipc/auth.ipc'
import { invokeLocal } from '../src/main/net/router'
import { login, logout } from '../src/main/services/authService'
import type { CreateOrderInput } from '../src/shared/types'

/**
 * Who is allowed to take cash off a driver.
 *
 * This was owner-and-accountant only, on the reasoning that money changing hands
 * deserves a senior signature. In a real shop it is the cashier standing at the
 * counter at 1am when the driver walks back in, and the owner is at home. The rule
 * did not add control — it meant the cash went in the drawer and the screen was never
 * updated, so within a day the system's idea of who owed what had drifted away from
 * the truth, which is the exact failure the delivery centre exists to prevent.
 *
 * What replaces it is the record, and that is what these tests are really about: the
 * settlement has to name whoever actually took the money.
 */

let cashierId: number
let mealId: number
let mealPrice: number
let areaId: number
let driverId: number

const ADMIN_PASSWORD = 'admin123'
const CASHIER_PASSWORD = 'cashier123'

function deliveredCashOrder(): number {
  const input: CreateOrderInput = {
    cashierId,
    paymentType: 'cash',
    orderType: 'delivery',
    discountPercent: 0,
    customerName: 'عميل',
    customerPhone: '01000000000',
    customerAddress: 'شارع ١',
    deliveryAreaId: areaId,
    driverId,
    items: [{ menuItemId: mealId, quantity: 1, unitPrice: mealPrice, itemName: 'x' }],
  }
  const id = createOrder(input, 'cashier').orderId
  delivery.setDeliveryStatus(id, 'delivered', cashierId)
  return id
}

beforeAll(() => {
  initDatabase()
  registerAuthIpc()
  registerDeliveryIpc()
  const db = getDb()
  cashierId = (db.prepare(`SELECT user_id FROM users WHERE username='cashier1'`).get() as any).user_id
  const meal = db.prepare(`SELECT item_id, price FROM menu_items ORDER BY item_id LIMIT 1`).get() as any
  mealId = meal.item_id
  mealPrice = meal.price
  areaId = (db.prepare(`SELECT delivery_area_id FROM delivery_areas ORDER BY delivery_area_id LIMIT 1`)
    .get() as any).delivery_area_id
})

beforeEach(() => {
  const db = getDb()
  db.prepare('DELETE FROM raw_material_transactions').run()
  db.prepare('DELETE FROM stock_transactions').run()
  db.prepare('DELETE FROM order_items').run()
  db.prepare('DELETE FROM orders').run()
  db.prepare('DELETE FROM driver_settlements').run()
  db.prepare('DELETE FROM delivery_drivers').run()
  driverId = Number(db.prepare(
    `INSERT INTO delivery_drivers (full_name, phone) VALUES ('أحمد', '0100')`
  ).run().lastInsertRowid)
})

afterEach(() => { logout() })

describe('taking cash from a driver', () => {
  it('lets the CASHIER do it — they are who is actually at the counter', () => {
    const orderId = deliveredCashOrder()
    const owedBefore = delivery.driverBalances().find(d => d.driver_id === driverId)!.cashOwed
    expect(owedBefore).toBeGreaterThan(0)

    const signedIn = login('cashier1', CASHIER_PASSWORD)
    expect(signedIn.success).toBe(true)
    expect(signedIn.user!.role).toBe('cashier')

    return invokeLocal('delivery:settle', { driverId }).then(res => {
      expect(res.success).toBe(true)
      // And the debt is actually gone, not merely reported as settled.
      expect(delivery.driverBalances().find(d => d.driver_id === driverId)!.cashOwed).toBe(0)
      expect(delivery.settlementOrders((res.data as any).settlement_id).map((o: any) => o.order_id))
        .toContain(orderId)
    })
  })

  it('records WHO took it, which is the control that replaced the permission', async () => {
    deliveredCashOrder()
    login('cashier1', CASHIER_PASSWORD)

    const res = await invokeLocal('delivery:settle', { driverId })
    expect(res.success).toBe(true)

    // The owner reads this back in «سجل التحصيل». A settlement that could not say who
    // took the money would make the cashier's access a genuine hole rather than a
    // recorded action.
    const [settlement] = delivery.listSettlements({ driverId })
    expect(settlement.settled_by).toBe(cashierId)
  })

  it('still lets the owner do it', async () => {
    deliveredCashOrder()
    login('admin', ADMIN_PASSWORD)

    const res = await invokeLocal('delivery:settle', { driverId })
    expect(res.success).toBe(true)
  })

  it('refuses when nobody is signed in at all', async () => {
    deliveredCashOrder()
    logout()

    const res = await invokeLocal('delivery:settle', { driverId })
    expect(res.success).toBe(false)
  })
})
