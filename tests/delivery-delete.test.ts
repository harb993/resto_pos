import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../src/main/db/db'
import {
  upsertArea, upsertDriver, listAreas, listDrivers, deleteArea, deleteDriver, settleDriver,
  assignDriver, setDeliveryStatus,
} from '../src/main/services/deliveryService'
import { createOrder } from '../src/main/services/orderService'

/**
 * Removing a zone or a driver.
 *
 * Same rule the menu uses: history decides. A zone nothing was delivered to is
 * deleted; one that past invoices point at is retired, because an order records the
 * zone it went to and the fee charged for it, and erasing the zone would change what
 * those deliveries appear to have cost.
 *
 * A driver adds one more rule that a menu item does not have: he can be holding the
 * shop's money. Removing him then would take a debt off the screen without taking it
 * off the books.
 */

let ownerId: number
let itemId: number

beforeAll(() => {
  initDatabase()
  const db = getDb()
  ownerId = (db.prepare(`SELECT user_id FROM users WHERE role='owner'`).get() as any).user_id
  const catId = Number(db.prepare(`INSERT INTO categories (name, display_order) VALUES ('x',1)`).run().lastInsertRowid)
  itemId = Number(db.prepare(
    `INSERT INTO menu_items (category_id,name,price,cost_price) VALUES (?,'برجر',100,40)`
  ).run(catId).lastInsertRowid)
})

beforeEach(() => {
  const db = getDb()
  db.prepare('DELETE FROM order_items').run()
  db.prepare('UPDATE orders SET settlement_id = NULL').run()
  db.prepare('DELETE FROM driver_settlements').run()
  db.prepare('DELETE FROM orders').run()
})

const deliver = (areaId: number, driverId?: number, payment: 'cash' | 'card' = 'cash') =>
  createOrder({
    cashierId: ownerId,
    items: [{ menuItemId: itemId, quantity: 1 }],
    paymentType: payment,
    orderType: 'delivery',
    customerName: 'أحمد', customerPhone: '0100', customerAddress: 'شارع 9',
    deliveryAreaId: areaId, driverId,
  } as any, 'owner')

describe('deleting a delivery zone', () => {
  it('deletes one nothing was ever delivered to', () => {
    const area = upsertArea('منطقة جديدة', 20, 1)
    const res = deleteArea(area.delivery_area_id)

    expect(res.action).toBe('deleted')
    expect(listAreas().find(a => a.delivery_area_id === area.delivery_area_id)).toBeUndefined()
  })

  it('retires one that past invoices used, and keeps those invoices intact', () => {
    const area = upsertArea('المعادي', 25, 1)
    const order = deliver(area.delivery_area_id)

    const res = deleteArea(area.delivery_area_id)
    expect(res.action).toBe('deactivated')
    expect(res.message).toContain('1 فاتورة')

    const still = listAreas().find(a => a.delivery_area_id === area.delivery_area_id)
    expect(still).toBeDefined()
    expect(still!.is_active).toBe(0)

    // The order still points at it, with the fee it was charged.
    const row = getDb().prepare('SELECT delivery_area_id, delivery_fee FROM orders WHERE order_id = ?')
      .get(order.orderId) as any
    expect(row.delivery_area_id).toBe(area.delivery_area_id)
    expect(row.delivery_fee).toBe(25)
    expect((getDb().pragma('foreign_key_check') as unknown[]).length).toBe(0)
  })

  it('refuses a zone that does not exist', () => {
    expect(() => deleteArea(999999)).toThrow('غير موجودة')
  })
})

describe('deleting a driver', () => {
  it('deletes one who never carried anything', () => {
    const d = upsertDriver('سائق جديد', '0100', 1)
    expect(deleteDriver(d.driver_id).action).toBe('deleted')
    expect(listDrivers().find(x => x.driver_id === d.driver_id)).toBeUndefined()
  })

  it('REFUSES while an order is still out with him', () => {
    const area = upsertArea('وسط البلد', 15, 1)
    const d = upsertDriver('محمود', '0101', 1)
    const order = deliver(area.delivery_area_id, d.driver_id)
    assignDriver(order.orderId, d.driver_id, ownerId) // now 'out'

    expect(() => deleteDriver(d.driver_id)).toThrow(/ما زال جارياً/)
    expect(listDrivers().find(x => x.driver_id === d.driver_id)).toBeDefined()
  })

  it('REFUSES while he is still holding cash for delivered orders', () => {
    const area = upsertArea('الزمالك', 30, 1)
    const d = upsertDriver('طارق', '0104', 1)
    const order = deliver(area.delivery_area_id, d.driver_id)
    assignDriver(order.orderId, d.driver_id, ownerId)
    setDeliveryStatus(order.orderId, 'delivered', ownerId)

    // The money is his to hand over — he cannot simply be removed from the screen.
    expect(() => deleteDriver(d.driver_id)).toThrow(/لم يُسلَّم/)
    expect(listDrivers().find(x => x.driver_id === d.driver_id)).toBeDefined()
  })

  it('retires him once he has settled up', () => {
    const area = upsertArea('الدقي', 25, 1)
    const d = upsertDriver('سيد', '0102', 1)
    const order = deliver(area.delivery_area_id, d.driver_id)
    assignDriver(order.orderId, d.driver_id, ownerId)
    setDeliveryStatus(order.orderId, 'delivered', ownerId)

    settleDriver(d.driver_id, ownerId, [order.orderId], null)

    const res = deleteDriver(d.driver_id)
    expect(res.action).toBe('deactivated')

    const still = listDrivers().find(x => x.driver_id === d.driver_id)
    expect(still!.is_active).toBe(0)
    // The hand-over record survives — it is the shop's proof of what he paid in.
    expect((getDb().prepare('SELECT COUNT(*) AS c FROM driver_settlements WHERE driver_id = ?')
      .get(d.driver_id) as any).c).toBe(1)
    expect((getDb().pragma('foreign_key_check') as unknown[]).length).toBe(0)
  })

  it('does not count a CARD order as cash he is holding', () => {
    const area = upsertArea('مدينة نصر', 20, 1)
    const d = upsertDriver('كريم', '0103', 1)
    const order = deliver(area.delivery_area_id, d.driver_id, 'card')
    assignDriver(order.orderId, d.driver_id, ownerId)
    setDeliveryStatus(order.orderId, 'delivered', ownerId)

    // The customer paid the machine, so there is nothing for him to hand over.
    const res = deleteDriver(d.driver_id)
    expect(res.action).toBe('deactivated')
  })

  it('refuses a driver that does not exist', () => {
    expect(() => deleteDriver(999999)).toThrow('غير موجود')
  })
})

describe('a DELETED invoice must not keep either of them alive', () => {
  /**
   * An invoice that has been deleted is out of every report and every total — it is
   * not history any more. Letting it pin a zone in the picker, or a driver in the
   * list, means one mistyped test delivery is permanent.
   */
  const softDelete = (orderId: number) =>
    getDb().prepare(
      `UPDATE orders SET deleted_at = datetime('now','localtime'), deleted_by = ? WHERE order_id = ?`
    ).run(ownerId, orderId)

  it('deletes a zone whose only order was deleted', () => {
    const area = upsertArea('منطقة تجريبية', 20, 1)
    const order = deliver(area.delivery_area_id)
    softDelete(order.orderId)

    const res = deleteArea(area.delivery_area_id)
    expect(res.action).toBe('deleted')
    expect(listAreas().find(a => a.delivery_area_id === area.delivery_area_id)).toBeUndefined()

    // The deleted invoice simply no longer names a zone.
    const row = getDb().prepare('SELECT delivery_area_id FROM orders WHERE order_id = ?')
      .get(order.orderId) as any
    expect(row.delivery_area_id).toBeNull()
    expect((getDb().pragma('foreign_key_check') as unknown[]).length).toBe(0)
  })

  it('deletes a driver whose only order — and its hand-over — were deleted', () => {
    const area = upsertArea('منطقة تجريبية 2', 20, 1)
    const d = upsertDriver('سائق تجريبي', '0109', 1)
    const order = deliver(area.delivery_area_id, d.driver_id)
    assignDriver(order.orderId, d.driver_id, ownerId)
    setDeliveryStatus(order.orderId, 'delivered', ownerId)
    settleDriver(d.driver_id, ownerId, [order.orderId], null)
    softDelete(order.orderId)

    const res = deleteDriver(d.driver_id)
    expect(res.action).toBe('deleted')
    expect(listDrivers().find(x => x.driver_id === d.driver_id)).toBeUndefined()
    expect((getDb().pragma('foreign_key_check') as unknown[]).length).toBe(0)
  })

  it('still retires one whose order is LIVE, even beside a deleted one', () => {
    const area = upsertArea('منطقة حية', 20, 1)
    const d = upsertDriver('سائق حقيقي', '0110', 1)

    const scrapped = deliver(area.delivery_area_id, d.driver_id)
    assignDriver(scrapped.orderId, d.driver_id, ownerId)
    setDeliveryStatus(scrapped.orderId, 'delivered', ownerId)
    softDelete(scrapped.orderId)

    const real = deliver(area.delivery_area_id, d.driver_id)
    assignDriver(real.orderId, d.driver_id, ownerId)
    setDeliveryStatus(real.orderId, 'delivered', ownerId)
    settleDriver(d.driver_id, ownerId, [real.orderId], null)

    expect(deleteDriver(d.driver_id).action).toBe('deactivated')
    expect(deleteArea(area.delivery_area_id).action).toBe('deactivated')
  })
})
