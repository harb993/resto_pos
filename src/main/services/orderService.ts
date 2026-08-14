import { getDb } from '../db/db'
import log from 'electron-log/main'
import type { CreateOrderInput, Order, OrderItem } from '../../shared/types'

// Prepared statements (lazy-initialized)
let stmts: ReturnType<typeof prepareStatements> | null = null

function prepareStatements() {
  const db = getDb()
  return {
    insertOrder: db.prepare(`
      INSERT INTO orders (cashier_id, subtotal, tax, discount, total_amount, payment_type)
      VALUES (?, ?, ?, ?, ?, ?)
    `),
    insertOrderItem: db.prepare(`
      INSERT INTO order_items (order_id, menu_item_id, quantity, unit_price, unit_cost)
      VALUES (?, ?, ?, ?, ?)
    `),
    getMenuItem: db.prepare(`
      SELECT * FROM menu_items WHERE item_id = ? AND is_active = 1
    `),
    deductStock: db.prepare(`
      UPDATE menu_items SET stock_quantity = stock_quantity - ? WHERE item_id = ?
    `),
    logStockTxn: db.prepare(`
      INSERT INTO stock_transactions (menu_item_id, change_amount, reason, related_order_id, created_by)
      VALUES (?, ?, 'sale', ?, ?)
    `),
    voidOrder: db.prepare(`
      UPDATE orders SET status = 'voided', voided_by = ?, void_reason = ? WHERE order_id = ?
    `),
    restoreStock: db.prepare(`
      UPDATE menu_items SET stock_quantity = stock_quantity + ? WHERE item_id = ?
    `),
  }
}

function getStmts() {
  if (!stmts) stmts = prepareStatements()
  return stmts
}

/**
 * Create an order — THE critical path.
 * Everything inside the transaction is atomic: order + order_items + stock deductions.
 * If ANYTHING fails, the entire thing rolls back — no partial state.
 */
export function createOrder(input: CreateOrderInput): { orderId: number } {
  const db = getDb()
  const s = getStmts()

  const run = db.transaction(() => {
    // 1. Insert the order
    const result = s.insertOrder.run(
      input.cashierId,
      input.subtotal,
      input.tax,
      input.discount,
      input.totalAmount,
      input.paymentType
    )
    const orderId = result.lastInsertRowid as number

    // 2. Insert each line item + deduct stock
    for (const line of input.items) {
      const menuItem = s.getMenuItem.get(line.menuItemId) as any
      if (!menuItem) {
        throw new Error(`Menu item ${line.menuItemId} not found or inactive`)
      }

      // Check stock
      if (menuItem.stock_quantity < line.quantity) {
        throw new Error(
          `Not enough stock for "${menuItem.name}" (available: ${menuItem.stock_quantity}, requested: ${line.quantity})`
        )
      }

      // Insert order item with price AT TIME OF SALE
      s.insertOrderItem.run(
        orderId,
        line.menuItemId,
        line.quantity,
        menuItem.price,
        menuItem.cost_price
      )

      // Deduct stock
      s.deductStock.run(line.quantity, line.menuItemId)

      // Audit trail
      s.logStockTxn.run(line.menuItemId, -line.quantity, orderId, input.cashierId)
    }

    log.info(`[Order] Created order #${orderId} — ${input.items.length} items, total: ${input.totalAmount}`)
    return orderId
  })

  const orderId = run()
  return { orderId }
}

/**
 * Void an order — restores stock and marks the order as voided.
 */
export function voidOrder(orderId: number, voidedBy: number, reason: string): void {
  const db = getDb()
  const s = getStmts()

  const run = db.transaction(() => {
    // Get the order and its items
    const order = db.prepare('SELECT * FROM orders WHERE order_id = ?').get(orderId) as any
    if (!order) throw new Error('Order not found')
    if (order.status === 'voided') throw new Error('Order is already voided')

    const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(orderId) as any[]

    // Restore stock for each item
    for (const item of items) {
      s.restoreStock.run(item.quantity, item.menu_item_id)
      // Audit trail for the reversal
      db.prepare(`
        INSERT INTO stock_transactions (menu_item_id, change_amount, reason, related_order_id, created_by)
        VALUES (?, ?, 'adjustment', ?, ?)
      `).run(item.menu_item_id, item.quantity, orderId, voidedBy)
    }

    // Mark order as voided
    s.voidOrder.run(voidedBy, reason, orderId)

    log.info(`[Order] Voided order #${orderId} by user ${voidedBy}: ${reason}`)
  })

  run()
}

/**
 * List orders with optional filters.
 */
export function listOrders(filters: {
  cashierId?: number
  status?: string
  dateFrom?: string
  dateTo?: string
  limit?: number
} = {}): Order[] {
  const db = getDb()
  const conditions: string[] = []
  const params: any[] = []

  if (filters.cashierId) {
    conditions.push('o.cashier_id = ?')
    params.push(filters.cashierId)
  }
  if (filters.status) {
    conditions.push('o.status = ?')
    params.push(filters.status)
  }
  if (filters.dateFrom) {
    conditions.push('o.created_at >= ?')
    params.push(filters.dateFrom)
  }
  if (filters.dateTo) {
    conditions.push('o.created_at <= ?')
    params.push(filters.dateTo)
  }

  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : ''
  const limit = filters.limit ? `LIMIT ${filters.limit}` : 'LIMIT 200'

  const orders = db.prepare(`
    SELECT o.*, u.full_name as cashier_name
    FROM orders o
    JOIN users u ON u.user_id = o.cashier_id
    ${where}
    ORDER BY o.created_at DESC
    ${limit}
  `).all(...params) as Order[]

  return orders
}

/**
 * Get a single order with its items.
 */
export function getOrderWithItems(orderId: number): Order | null {
  const db = getDb()
  const order = db.prepare(`
    SELECT o.*, u.full_name as cashier_name
    FROM orders o
    JOIN users u ON u.user_id = o.cashier_id
    WHERE o.order_id = ?
  `).get(orderId) as Order | undefined

  if (!order) return null

  order.items = db.prepare(`
    SELECT oi.*, mi.name as item_name
    FROM order_items oi
    JOIN menu_items mi ON mi.item_id = oi.menu_item_id
    WHERE oi.order_id = ?
  `).all(orderId) as OrderItem[]

  return order
}
