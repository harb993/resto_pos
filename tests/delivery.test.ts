import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../src/main/db/db'
import { createOrder, voidOrder, softDeleteOrder } from '../src/main/services/orderService'
import * as delivery from '../src/main/services/deliveryService'
import type { CreateOrderInput, PaymentType } from '../src/shared/types'

/**
 * The delivery centre: where an order is, and — separately — whether the cash the
 * driver collected for it has reached the till.
 *
 * The money half is what these tests are really about. Getting a status wrong shows
 * up on a screen and someone fixes it; getting the settlement wrong means the shop
 * either loses money quietly or accuses a driver of keeping money he handed in.
 */

let cashierId: number
let ownerId: number
let mealId: number
let mealPrice: number
let areaId: number
let ahmed: number
let sayed: number

function order(over: Partial<CreateOrderInput> = {}): CreateOrderInput {
  return {
    cashierId,
    paymentType: 'cash',
    orderType: 'delivery',
    discountPercent: 0,
    customerName: 'عميل',
    customerPhone: '01000000000',
    customerAddress: 'شارع ١',
    deliveryAreaId: areaId,
    items: [{ menuItemId: mealId, quantity: 1, unitPrice: mealPrice, itemName: 'x' }],
    ...over,
  }
}

/** Ring up one delivery order and return its id. */
function sell(over: Partial<CreateOrderInput> = {}): number {
  return createOrder(order(over), 'cashier').orderId
}

/** Ring one up, hand it to a driver and mark it delivered — the everyday path. */
function deliver(driverId: number, payment: PaymentType = 'cash'): number {
  const id = sell({ driverId, paymentType: payment })
  delivery.setDeliveryStatus(id, 'delivered', cashierId)
  return id
}

/** Ring one up and take it through the kitchen to "ready". */
function ready(over: Partial<CreateOrderInput> = {}): number {
  const id = sell(over)
  delivery.setDeliveryStatus(id, 'pending', cashierId)
  return id
}

const owedBy = (driverId: number): number =>
  delivery.driverBalances().find(d => d.driver_id === driverId)!.cashOwed

const todayStr = (): string => {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

beforeAll(() => {
  initDatabase()
  const db = getDb()
  cashierId = (db.prepare(`SELECT user_id FROM users WHERE username='cashier1'`).get() as any).user_id
  ownerId = (db.prepare(`SELECT user_id FROM users WHERE role='owner' LIMIT 1`).get() as any).user_id
  const meal = db.prepare(`SELECT item_id, price FROM menu_items ORDER BY item_id LIMIT 1`).get() as any
  mealId = meal.item_id
  mealPrice = meal.price
  // A new database has no delivery areas of its own any more — give the test one.
  db.prepare(`INSERT INTO delivery_areas (area_name, delivery_fee) SELECT 'منطقة الاختبار', 20 WHERE NOT EXISTS (SELECT 1 FROM delivery_areas WHERE is_active = 1)`).run()
  areaId = (db.prepare(`SELECT delivery_area_id FROM delivery_areas ORDER BY delivery_area_id LIMIT 1`)
    .get() as any).delivery_area_id
})

beforeEach(() => {
  // Every test starts from an empty board: these assertions are about counts and
  // totals, and orders left behind by the previous test would leak into both.
  const db = getDb()
  db.prepare('DELETE FROM raw_material_transactions').run()
  db.prepare('DELETE FROM stock_transactions').run()
  db.prepare('DELETE FROM order_items').run()
  db.prepare('DELETE FROM orders').run()
  db.prepare('DELETE FROM driver_settlements').run()
  db.prepare('DELETE FROM delivery_drivers').run()
  ahmed = Number(db.prepare(
    `INSERT INTO delivery_drivers (full_name, phone) VALUES ('أحمد', '0100')`
  ).run().lastInsertRowid)
  sayed = Number(db.prepare(
    `INSERT INTO delivery_drivers (full_name, phone) VALUES ('سيد', '0111')`
  ).run().lastInsertRowid)
})

describe('an order starts tracked', () => {
  it('starts in the kitchen, not waiting for a driver', () => {
    const id = sell()
    const [o] = delivery.listDeliveryOrders({ status: 'preparing' })
    expect(o.order_id).toBe(id)
    expect(o.delivery_status).toBe('preparing')
    expect(o.dispatched_at).toBeNull()
    // Nothing is "waiting for a driver" until the kitchen says it is ready.
    expect(delivery.listDeliveryOrders({ status: 'pending' })).toHaveLength(0)
  })

  it('still starts in the kitchen when a driver is named at the counter', () => {
    // Naming him records who will take it. It does not put uncooked food on a bike.
    sell({ driverId: ahmed })
    const [o] = delivery.listDeliveryOrders({ status: 'preparing' })
    expect(o.delivery_status).toBe('preparing')
    expect(o.driver_name).toBe('أحمد')
    expect(o.dispatched_at).toBeNull()
  })

  it('moves kitchen → ready → out → delivered, stamping each step once', () => {
    const id = sell()
    expect(delivery.setDeliveryStatus(id, 'pending', cashierId).delivery_status).toBe('pending')

    const out = delivery.assignDriver(id, ahmed, cashierId)
    expect(out.delivery_status).toBe('out')
    expect(out.dispatched_at).toBeTruthy()

    const done = delivery.setDeliveryStatus(id, 'delivered', cashierId)
    expect(done.delivered_at).toBeTruthy()
    // The dispatch time is the one from when it actually left, not re-stamped.
    expect(done.dispatched_at).toBe(out.dispatched_at)
  })

  it('leaves dine-in and takeaway with no delivery status at all', () => {
    createOrder(order({ orderType: 'dine_in', deliveryAreaId: undefined, customerName: undefined,
      customerPhone: undefined, customerAddress: undefined }), 'cashier')
    createOrder(order({ orderType: 'takeaway', deliveryAreaId: undefined, customerName: undefined,
      customerPhone: undefined, customerAddress: undefined }), 'cashier')

    const statuses = (getDb().prepare(
      `SELECT delivery_status s FROM orders WHERE order_type != 'delivery'`
    ).all() as any[]).map(r => r.s)
    expect(statuses).toEqual([null, null])
    // And none of them can ever reach the delivery board.
    expect(delivery.listDeliveryOrders({ status: 'all' })).toHaveLength(0)
  })
})

describe('moving an order along', () => {
  it('assigning a driver dispatches it in one step', () => {
    const id = sell()
    const out = delivery.assignDriver(id, ahmed, cashierId)
    expect(out.delivery_status).toBe('out')
    expect(out.driver_id).toBe(ahmed)
    expect(out.dispatched_at).toBeTruthy()
  })

  it('refuses to dispatch or deliver with nobody carrying it', () => {
    const id = sell()
    expect(() => delivery.setDeliveryStatus(id, 'out', cashierId)).toThrow(/السائق/)
    expect(() => delivery.setDeliveryStatus(id, 'delivered', cashierId)).toThrow(/السائق/)
  })

  it('stamps the delivery time, and clears it again if the status is walked back', () => {
    const id = sell({ driverId: ahmed })
    expect(delivery.setDeliveryStatus(id, 'delivered', cashierId).delivered_at).toBeTruthy()
    // A mis-tap put it back on the road: it must not still claim a delivery time.
    expect(delivery.setDeliveryStatus(id, 'out', cashierId).delivered_at).toBeNull()
  })

  it('lets a driver hand an order back before delivery, but not after', () => {
    const undelivered = sell({ driverId: ahmed })
    expect(delivery.assignDriver(undelivered, sayed, cashierId).driver_id).toBe(sayed)

    const done = deliver(ahmed)
    expect(() => delivery.assignDriver(done, sayed, cashierId)).toThrow(/تم تسليمه/)
  })

  it('will not touch a voided invoice', () => {
    const id = sell({ driverId: ahmed })
    voidOrder(id, ownerId, 'اختبار')
    expect(() => delivery.setDeliveryStatus(id, 'delivered', cashierId)).toThrow(/ملغاة/)
  })
})

describe('what the driver owes', () => {
  it('counts delivered cash orders and nothing else', () => {
    const onTheRoad = sell()               // still out — not owed, it has not arrived
    delivery.assignDriver(onTheRoad, ahmed, cashierId)
    deliver(ahmed, 'card')                 // delivered, but the machine took the money
    const cash = deliver(ahmed, 'cash')    // this one, and only this one

    const total = (getDb().prepare('SELECT total_amount t FROM orders WHERE order_id = ?')
      .get(cash) as any).t

    const bal = delivery.driverBalances().find(d => d.driver_id === ahmed)!
    expect(bal.cashOwed).toBeCloseTo(total, 2)
    expect(bal.unsettledCount).toBe(1)
    // Both delivered orders are still his work for the day, card or not.
    expect(bal.deliveredCount).toBe(2)
    expect(bal.outCount).toBe(1)
  })

  it('keeps each driver’s money to himself', () => {
    deliver(ahmed)
    deliver(sayed)
    deliver(sayed)

    expect(delivery.unsettledOrders(ahmed)).toHaveLength(1)
    expect(delivery.unsettledOrders(sayed)).toHaveLength(2)
    expect(owedBy(sayed)).toBeCloseTo(owedBy(ahmed) * 2, 2)
  })

  it('drops a voided order out of the debt', () => {
    const id = deliver(ahmed)
    const before = owedBy(ahmed)
    expect(before).toBeGreaterThan(0)

    voidOrder(id, ownerId, 'العميل رفض الطلب')
    expect(owedBy(ahmed)).toBe(0)
  })
})

describe('counting the money in', () => {
  it('records the hand-over and clears the debt', () => {
    deliver(ahmed)
    deliver(ahmed)
    const owed = owedBy(ahmed)

    const settlement = delivery.settleDriver(ahmed, ownerId, { note: 'نهاية الوردية' })

    expect(settlement.order_count).toBe(2)
    expect(settlement.total_amount).toBeCloseTo(owed, 2)
    expect(settlement.driver_name).toBe('أحمد')
    expect(settlement.note).toBe('نهاية الوردية')
    expect(owedBy(ahmed)).toBe(0)
    expect(delivery.unsettledOrders(ahmed)).toHaveLength(0)
    expect(delivery.settlementOrders(settlement.settlement_id)).toHaveLength(2)
  })

  it('takes a part-payment and leaves the rest owing', () => {
    const first = deliver(ahmed)
    deliver(ahmed)
    const each = owedBy(ahmed) / 2

    const settlement = delivery.settleDriver(ahmed, ownerId, { orderIds: [first] })

    expect(settlement.order_count).toBe(1)
    expect(owedBy(ahmed)).toBeCloseTo(each, 2)
    expect(delivery.unsettledOrders(ahmed)).toHaveLength(1)
  })

  it('refuses to settle a driver who owes nothing, rather than filing an empty receipt', () => {
    expect(() => delivery.settleDriver(ahmed, ownerId)).toThrow(/لا توجد مبالغ مستحقة/)

    deliver(ahmed, 'card') // delivered, but nothing was ever collected
    expect(() => delivery.settleDriver(ahmed, ownerId)).toThrow(/لا توجد مبالغ مستحقة/)
  })

  it('never counts the same money twice', () => {
    deliver(ahmed)
    delivery.settleDriver(ahmed, ownerId)
    expect(() => delivery.settleDriver(ahmed, ownerId)).toThrow(/لا توجد مبالغ مستحقة/)
    expect(delivery.listSettlements({ driverId: ahmed })).toHaveLength(1)
  })

  it('will not let a settled order be un-delivered afterwards', () => {
    const id = deliver(ahmed)
    delivery.settleDriver(ahmed, ownerId)

    expect(() => delivery.setDeliveryStatus(id, 'returned', cashierId)).toThrow(/تم تحصيل نقدية/)
    expect(() => delivery.setDeliveryStatus(id, 'out', cashierId)).toThrow(/تم تحصيل نقدية/)
    // Still delivered, still settled — the two records still agree.
    const [o] = delivery.settlementOrders(
      delivery.listSettlements({ driverId: ahmed })[0].settlement_id
    )
    expect(o.order_id).toBe(id)
    expect(o.delivery_status).toBe('delivered')
  })
})

describe('looking a customer up', () => {
  it('finds them by phone however the number is punctuated', () => {
    const id = sell({ customerPhone: '01001234567', customerName: 'هبة رشدي' })

    for (const typed of ['01001234567', '0100 123 4567', '0100-123-4567', '1234567']) {
      const hits = delivery.listDeliveryOrders({ status: 'all', search: typed })
      expect(hits.map(o => o.order_id), `searching "${typed}"`).toEqual([id])
      expect(hits[0].customer_name).toBe('هبة رشدي')
    }
  })

  it('finds them by name or invoice number too', () => {
    const id = sell({ customerName: 'مصطفى سمير', customerPhone: '01555555555' })
    const invoice = (getDb().prepare('SELECT invoice_number n FROM orders WHERE order_id = ?')
      .get(id) as any).n

    expect(delivery.listDeliveryOrders({ status: 'all', search: 'مصطفى' })
      .map(o => o.order_id)).toEqual([id])
    expect(delivery.listDeliveryOrders({ status: 'all', search: invoice })
      .map(o => o.order_id)).toEqual([id])
  })

  it('searches the whole history, not the period on screen', () => {
    const id = sell({ customerPhone: '01099998888', driverId: ahmed })
    getDb().prepare(
      `UPDATE orders SET created_at = datetime('now','localtime','-40 days') WHERE order_id = ?`
    ).run(id)
    delivery.setDeliveryStatus(id, 'delivered', cashierId) // finished, so no live exemption

    const today = todayStr()
    // Nothing of his is inside the period being viewed...
    expect(delivery.listDeliveryOrders({ status: 'all', dateFrom: today, dateTo: today }))
      .toHaveLength(0)
    // ...but looking his number up still finds him, which is the point of searching.
    expect(delivery.listDeliveryOrders({
      status: 'all', dateFrom: today, dateTo: today, search: '01099998888',
    }).map(o => o.order_id)).toEqual([id])
  })

  it('does not match a different customer', () => {
    sell({ customerPhone: '01111111111', customerName: 'أ' })
    sell({ customerPhone: '01222222222', customerName: 'ب' })
    const hits = delivery.listDeliveryOrders({ status: 'all', search: '01111111111' })
    expect(hits).toHaveLength(1)
    expect(hits[0].customer_phone).toBe('01111111111')
  })
})

describe('deleted invoices', () => {
  it('are hidden from every normal view', () => {
    const kept = sell()
    const gone = sell()
    softDeleteOrder(gone, ownerId)

    for (const status of ['all', 'live', 'preparing'] as const) {
      expect(delivery.listDeliveryOrders({ status }).map(o => o.order_id),
        `status "${status}"`).toEqual([kept])
    }
    // ...and out of the counters, which is what deleting one is for.
    expect(delivery.deliverySummary().preparingCount).toBe(1)
  })

  it('have their own view, with who removed them and when', () => {
    const gone = sell({ customerName: 'عميل ملغي' })
    delivery.setDeliveryStatus(gone, 'pending', cashierId)
    softDeleteOrder(gone, ownerId)

    const [row] = delivery.listDeliveryOrders({ status: 'deleted' })
    expect(row.order_id).toBe(gone)
    expect(row.deleted_at).toBeTruthy()
    expect(row.deleted_by_name).toBeTruthy()
    expect(row.customer_name).toBe('عميل ملغي')
    // What it was when it was removed is still readable — an order deleted after it
    // went out is a different story from one deleted off the pass.
    expect(row.delivery_status).toBe('pending')
    expect(delivery.deliverySummary().deletedCount).toBe(1)
  })

  it('cannot be moved along afterwards', () => {
    const gone = sell({ driverId: ahmed })
    softDeleteOrder(gone, ownerId)
    expect(() => delivery.setDeliveryStatus(gone, 'delivered', cashierId)).toThrow(/محذوفة/)
    expect(() => delivery.assignDriver(gone, sayed, cashierId)).toThrow(/محذوفة/)
  })

  it('owe nobody any money', () => {
    const gone = deliver(ahmed)
    expect(owedBy(ahmed)).toBeGreaterThan(0)
    softDeleteOrder(gone, ownerId)
    expect(owedBy(ahmed)).toBe(0)
    expect(delivery.deliverySummary().cashOwed).toBe(0)
  })
})

describe('the board the owner looks at', () => {
  it('sums what is out and what is owed', () => {
    sell()                    // preparing
    ready()                   // cooked, waiting for a driver
    const outId = sell()      // out
    delivery.assignDriver(outId, ahmed, cashierId)
    deliver(sayed)            // delivered, cash — owed
    deliver(sayed, 'card')    // delivered, card — not owed

    const s = delivery.deliverySummary()
    expect(s.preparingCount).toBe(1)
    expect(s.pendingCount).toBe(1)
    expect(s.outCount).toBe(1)
    expect(s.deliveredCount).toBe(2)
    expect(s.unsettledCount).toBe(1)
    expect(s.cashOwed).toBeCloseTo(owedBy(sayed), 2)
  })

  it('shows outstanding cash even when the period has moved past it', () => {
    deliver(ahmed)
    // Yesterday's order, still unpaid this morning. Money that vanishes from the
    // screen because the date changed is money nobody ever chases.
    getDb().prepare(
      `UPDATE orders SET created_at = datetime('now','localtime','-2 days')`
    ).run()

    const today = delivery.deliverySummary()
    expect(today.deliveredCount).toBe(0)      // not today's work
    expect(today.cashOwed).toBeGreaterThan(0) // but still in his pocket
    expect(owedBy(ahmed)).toBeGreaterThan(0)
  })

  it('keeps yesterday’s unfinished order on the board, so it cannot be forgotten', () => {
    const stale = sell()
    delivery.assignDriver(stale, ahmed, cashierId)
    const done = deliver(sayed)
    getDb().prepare(
      `UPDATE orders SET created_at = datetime('now','localtime','-1 day') WHERE order_id IN (?, ?)`
    ).run(stale, done)

    const today = todayStr()
    const listed = delivery.listDeliveryOrders({ status: 'all', dateFrom: today, dateTo: today })

    // Still out — still the shop's problem, whatever the date filter says.
    expect(listed.map(o => o.order_id)).toEqual([stale])
    // And the counters agree with the list rather than contradicting it.
    expect(delivery.deliverySummary({ dateFrom: today, dateTo: today }).outCount).toBe(1)
  })

  it('counts orders from before tracking existed without claiming they were delivered', () => {
    const id = sell({ driverId: ahmed })
    // Exactly what an upgraded database looks like: a delivery order with no status.
    getDb().prepare('UPDATE orders SET delivery_status = NULL WHERE order_id = ?').run(id)

    const s = delivery.deliverySummary()
    expect(s.untrackedCount).toBe(1)
    expect(s.deliveredCount).toBe(0)
    expect(s.cashOwed).toBe(0)
    expect(owedBy(ahmed)).toBe(0)
  })
})
