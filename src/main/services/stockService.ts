import { getDb } from '../db/db'
import log from 'electron-log/main'
import type { StockTransaction } from '../../shared/types'

export function restockItem(
  menuItemId: number, quantity: number,
  reason: 'restock' | 'waste' | 'adjustment', userId: number
): void {
  const db = getDb()
  const txn = db.transaction(() => {
    const change = reason === 'waste' ? -Math.abs(quantity) : Math.abs(quantity)
    db.prepare('UPDATE menu_items SET stock_quantity = stock_quantity + ? WHERE item_id = ?')
      .run(change, menuItemId)
    db.prepare('INSERT INTO stock_transactions (menu_item_id, change_amount, reason, created_by) VALUES (?,?,?,?)')
      .run(menuItemId, change, reason, userId)
    log.info(`[Stock] ${reason}: item ${menuItemId}, change: ${change}`)
  })
  txn()
}

export function getLowStockItems(threshold = 5): any[] {
  return getDb().prepare(`
    SELECT mi.item_id, mi.name, mi.stock_quantity, c.name as category_name
    FROM menu_items mi JOIN categories c ON c.category_id = mi.category_id
    WHERE mi.is_active = 1 AND mi.stock_quantity <= ?
    ORDER BY mi.stock_quantity ASC
  `).all(threshold)
}

export function getStockHistory(menuItemId?: number, limit = 100): StockTransaction[] {
  const db = getDb()
  const base = `SELECT st.*, mi.name as item_name, u.full_name as created_by_name
    FROM stock_transactions st
    JOIN menu_items mi ON mi.item_id = st.menu_item_id
    JOIN users u ON u.user_id = st.created_by`
  if (menuItemId) {
    return db.prepare(`${base} WHERE st.menu_item_id = ? ORDER BY st.created_at DESC LIMIT ?`)
      .all(menuItemId, limit) as StockTransaction[]
  }
  return db.prepare(`${base} ORDER BY st.created_at DESC LIMIT ?`).all(limit) as StockTransaction[]
}
