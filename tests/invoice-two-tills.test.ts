import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../src/main/db/db'
import { createOrder } from '../src/main/services/orderService'
import { invokeLocal } from '../src/main/net/router'
import { registerOrderIpc } from '../src/main/ipc/order.ipc'
import { login, logout } from '../src/main/services/authService'

/**
 * Two tills, ONE run of invoice numbers.
 *
 * A node till never opens a database. Every call its screen makes is forwarded to the
 * master, which runs the handler against the master's own books — so both tills draw
 * from the single `invoice_seq` counter, inside the same transaction that writes the
 * order. There is no second sequence to drift out of step with.
 *
 * These tests drive both paths on one database, the way it really happens: the
 * master's own sale calls the service directly, and the node's sale arrives through
 * `invokeLocal`, which is precisely the function masterLink calls when a node's
 * request comes down the wire.
 */

let ownerId: number
let cashierId: number
let itemId: number

beforeAll(() => {
  initDatabase()
  registerOrderIpc()
  const db = getDb()
  ownerId = (db.prepare(`SELECT user_id FROM users WHERE role = 'owner'`).get() as any).user_id
  cashierId = (db.prepare(`SELECT user_id FROM users WHERE slot = 'cashier2'`).get() as any).user_id
  const catId = Number(db.prepare(`INSERT INTO categories (name, display_order) VALUES ('برجر', 1)`)
    .run().lastInsertRowid)
  itemId = Number(db.prepare(
    `INSERT INTO menu_items (category_id, name, price, cost_price) VALUES (?, 'تشيكن برجر', 85, 40)`
  ).run(catId).lastInsertRowid)
})

beforeEach(() => {
  const db = getDb()
  db.prepare('DELETE FROM order_items').run()
  db.prepare('DELETE FROM orders').run()
  db.prepare(`UPDATE settings SET value = '0' WHERE key = 'invoice_seq'`).run()
  db.prepare(`DELETE FROM settings WHERE key = 'invoice_seq_day'`).run()
})

const sale = () => ({
  cashierId,
  items: [{ menuItemId: itemId, quantity: 1 }],
  paymentType: 'cash' as const,
  orderType: 'dine_in' as const,
})

/** A sale rung up at the master itself. */
function masterSale() {
  return createOrder({ ...sale(), cashierId: ownerId }, 'owner').invoiceNumber
}

/** A sale rung up at the NODE: forwarded, then run locally on the master. */
async function nodeSale(): Promise<string> {
  const res = await invokeLocal('order:create', sale())
  if (!res.success) throw new Error(res.error)
  return (res.data as any).invoiceNumber
}

describe('invoice numbering with a node till', () => {
  beforeEach(() => {
    logout()
    login('cashier2', 'cashier456') // the node's cashier, signed in on the master
  })

  it('gives the two tills one unbroken sequence', async () => {
    const issued: string[] = []
    // Interleaved, because that is what a lunch rush looks like.
    issued.push(masterSale())
    issued.push(await nodeSale())
    issued.push(await nodeSale())
    issued.push(masterSale())
    issued.push(await nodeSale())

    expect(issued).toEqual(['0001', '0002', '0003', '0004', '0005'])
  })

  it('never issues the same number twice', async () => {
    const issued: string[] = []
    for (let i = 0; i < 12; i++) {
      issued.push(i % 3 === 0 ? masterSale() : await nodeSale())
    }
    expect(new Set(issued).size).toBe(issued.length)
  })

  it('holds up when both tills fire at once', async () => {
    // The counter is bumped inside the order's own transaction, so concurrent
    // requests serialise rather than reading the same value and both claiming it.
    const numbers = await Promise.all([
      nodeSale(), nodeSale(), nodeSale(), nodeSale(), nodeSale(), nodeSale(),
    ])
    expect(new Set(numbers).size).toBe(6)
    expect([...numbers].sort()).toEqual(['0001', '0002', '0003', '0004', '0005', '0006'])
  })

  it('records both tills’ sales in the one set of books', async () => {
    masterSale()
    await nodeSale()

    const rows = getDb().prepare(
      'SELECT invoice_number, cashier_id FROM orders ORDER BY order_id'
    ).all() as any[]

    expect(rows).toHaveLength(2)
    expect(rows[0].cashier_id).toBe(ownerId)    // rung up at the master
    expect(rows[1].cashier_id).toBe(cashierId)  // rung up at the node
    expect(rows.map(r => r.invoice_number)).toEqual(['0001', '0002'])
  })

  it('carries one sequence across the order types, not three', async () => {
    const db = getDb()
    const areaId = (db.prepare(
      'SELECT delivery_area_id FROM delivery_areas WHERE is_active = 1 LIMIT 1'
    ).get() as any).delivery_area_id

    const takeaway = await invokeLocal('order:create', { ...sale(), orderType: 'takeaway' })
    const dineIn = masterSale()
    const delivery = await invokeLocal('order:create', {
      ...sale(), orderType: 'delivery',
      customerName: 'أحمد', customerPhone: '01000000000',
      customerAddress: 'شارع 9، المعادي', deliveryAreaId: areaId,
    })

    expect(takeaway.success, takeaway.error).toBe(true)
    expect(delivery.success, delivery.error).toBe(true)
    expect((takeaway.data as any).invoiceNumber).toBe('0001')
    expect(dineIn).toBe('0002')
    expect((delivery.data as any).invoiceNumber).toBe('0003')

    // The type is still recorded — it simply is not part of the number.
    expect((db.prepare('SELECT order_type FROM orders ORDER BY order_id').all() as any[])
      .map(r => r.order_type)).toEqual(['takeaway', 'dine_in', 'delivery'])
  })
})
