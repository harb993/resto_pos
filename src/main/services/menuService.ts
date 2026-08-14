import { getDb } from '../db/db'
import log from 'electron-log/main'
import type { Category, MenuItem, MenuItemInput } from '../../shared/types'

export function listCategories(): Category[] {
  const db = getDb()
  return db.prepare('SELECT * FROM categories ORDER BY display_order, name').all() as Category[]
}

export function upsertCategory(name: string, displayOrder: number, categoryId?: number): Category {
  const db = getDb()

  if (categoryId) {
    db.prepare('UPDATE categories SET name = ?, display_order = ? WHERE category_id = ?')
      .run(name, displayOrder, categoryId)
    log.info(`[Menu] Category updated: ${name} (id: ${categoryId})`)
    return db.prepare('SELECT * FROM categories WHERE category_id = ?').get(categoryId) as Category
  } else {
    const result = db.prepare('INSERT INTO categories (name, display_order) VALUES (?, ?)')
      .run(name, displayOrder)
    const newId = result.lastInsertRowid as number
    log.info(`[Menu] Category created: ${name} (id: ${newId})`)
    return db.prepare('SELECT * FROM categories WHERE category_id = ?').get(newId) as Category
  }
}

export function deleteCategory(categoryId: number): void {
  const db = getDb()
  // Check if any menu items reference this category
  const items = db.prepare('SELECT COUNT(*) as count FROM menu_items WHERE category_id = ?').get(categoryId) as { count: number }
  if (items.count > 0) {
    throw new Error('Cannot delete category — it still has menu items. Move or delete them first.')
  }
  db.prepare('DELETE FROM categories WHERE category_id = ?').run(categoryId)
  log.info(`[Menu] Category deleted: ${categoryId}`)
}

export function listMenuItems(includeInactive = false): MenuItem[] {
  const db = getDb()
  const sql = `
    SELECT mi.*, c.name as category_name
    FROM menu_items mi
    JOIN categories c ON c.category_id = mi.category_id
    ${includeInactive ? '' : 'WHERE mi.is_active = 1'}
    ORDER BY c.display_order, c.name, mi.name
  `
  return db.prepare(sql).all() as MenuItem[]
}

export function getMenuItem(itemId: number): MenuItem | undefined {
  const db = getDb()
  return db.prepare(`
    SELECT mi.*, c.name as category_name
    FROM menu_items mi
    JOIN categories c ON c.category_id = mi.category_id
    WHERE mi.item_id = ?
  `).get(itemId) as MenuItem | undefined
}

export function upsertMenuItem(input: MenuItemInput): MenuItem {
  const db = getDb()

  if (input.item_id) {
    db.prepare(`
      UPDATE menu_items
      SET category_id = ?, name = ?, price = ?, cost_price = ?,
          description = ?, image_path = ?, is_active = ?,
          stock_quantity = ?, updated_at = datetime('now','localtime')
      WHERE item_id = ?
    `).run(
      input.category_id, input.name, input.price, input.cost_price,
      input.description || null, input.image_path || null,
      input.is_active ?? 1, input.stock_quantity ?? 0,
      input.item_id
    )
    log.info(`[Menu] Item updated: ${input.name} (id: ${input.item_id})`)
    return getMenuItem(input.item_id)!
  } else {
    const result = db.prepare(`
      INSERT INTO menu_items (category_id, name, price, cost_price, description, image_path, is_active, stock_quantity)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.category_id, input.name, input.price, input.cost_price,
      input.description || null, input.image_path || null,
      input.is_active ?? 1, input.stock_quantity ?? 0
    )
    const newId = result.lastInsertRowid as number
    log.info(`[Menu] Item created: ${input.name} (id: ${newId})`)
    return getMenuItem(newId)!
  }
}

export function setMenuItemActive(itemId: number, isActive: boolean): void {
  const db = getDb()
  db.prepare(`UPDATE menu_items SET is_active = ?, updated_at = datetime('now','localtime') WHERE item_id = ?`)
    .run(isActive ? 1 : 0, itemId)
  log.info(`[Menu] Item ${itemId} ${isActive ? 'activated' : '86\'d'}`)
}

export function deleteMenuItem(itemId: number): void {
  const db = getDb()
  // Soft delete — just deactivate
  setMenuItemActive(itemId, false)
}
