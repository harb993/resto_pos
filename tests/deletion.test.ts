import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { initDatabase, getDb, clearAllBusinessData } from '../src/main/db/db'
import { getDeleteImpact, deleteEntity } from '../src/main/services/deletionService'
import * as menu from '../src/main/services/menuService'

/**
 * Deleting a category used to fail with a bare "FOREIGN KEY constraint failed".
 *
 * The cause was never the items — those were handled — but the questions set ON the
 * category. `item_variant_groups.category_id` points at the row being deleted, and
 * nothing removed those rows, so the very act of configuring a category ("this one
 * asks عادي / حار") made it undeletable, with an error that named nothing the owner
 * could act on.
 *
 * The same class of bug sat in the system reset: it emptied a hand-written list of
 * tables that had fallen behind the schema, and the supplier ledger it had never
 * heard of pointed at the raw materials it was deleting. SQLite rolled the whole
 * transaction back, so the owner pressed "reset", saw that error, and found every
 * record they had just tried to clear still there.
 */

const ownerId = (): number =>
  (getDb().prepare(`SELECT user_id FROM users WHERE role = 'owner'`).get() as any).user_id

function makeCategory(name: string): number {
  return Number(getDb().prepare('INSERT INTO categories (name, display_order) VALUES (?, 0)')
    .run(name).lastInsertRowid)
}

function makeItem(categoryId: number, name: string): number {
  return Number(getDb().prepare(
    `INSERT INTO menu_items (category_id, name, price, cost_price) VALUES (?, ?, 10, 4)`
  ).run(categoryId, name).lastInsertRowid)
}

/** The exact setup that used to make a category undeletable: one question on it. */
function askCategoryAQuestion(categoryId: number): number {
  const db = getDb()
  const groupId = Number(db.prepare(
    `INSERT INTO item_variant_groups (category_id, group_name, display_order) VALUES (?, 'النوع', 0)`
  ).run(categoryId).lastInsertRowid)
  db.prepare(
    `INSERT INTO item_variant_options (variant_group_id, option_name, price_delta, display_order)
     VALUES (?, 'عادي', 0, 0), (?, 'حار', 0, 1)`
  ).run(groupId, groupId)
  return groupId
}

beforeAll(() => { initDatabase() })

describe('deleting a category that has questions set on it', () => {
  it('deletes cleanly instead of failing on a foreign key', () => {
    const catId = makeCategory('قسم للحذف')
    const groupId = askCategoryAQuestion(catId)

    expect(() => deleteEntity('category', catId)).not.toThrow()

    const db = getDb()
    expect(db.prepare('SELECT 1 FROM categories WHERE category_id = ?').get(catId)).toBeUndefined()
    expect(db.prepare('SELECT 1 FROM item_variant_groups WHERE variant_group_id = ?').get(groupId))
      .toBeUndefined()
    // The answers go with the question — otherwise they are orphans nothing can reach.
    expect(db.prepare('SELECT COUNT(*) AS c FROM item_variant_options WHERE variant_group_id = ?')
      .get(groupId)).toEqual({ c: 0 })
  })

  it('says up front that the questions will go with it', () => {
    const catId = makeCategory('قسم بأسئلة')
    askCategoryAQuestion(catId)

    const impact = getDeleteImpact('category', catId)
    expect(impact.canHardDelete).toBe(true)
    expect(impact.cascades.some(c => c.includes('اختيارات'))).toBe(true)

    deleteEntity('category', catId)
  })

  it('takes its items, their questions and their recipes with it', () => {
    const db = getDb()
    const catId = makeCategory('قسم بأصناف')
    const itemId = makeItem(catId, 'صنف داخل القسم')

    const groupId = Number(db.prepare(
      `INSERT INTO item_variant_groups (menu_item_id, group_name, display_order) VALUES (?, 'الحجم', 0)`
    ).run(itemId).lastInsertRowid)
    db.prepare(
      `INSERT INTO item_variant_options (variant_group_id, option_name, price_delta) VALUES (?, 'كبير', 5)`
    ).run(groupId)

    deleteEntity('category', catId)

    expect(db.prepare('SELECT 1 FROM menu_items WHERE item_id = ?').get(itemId)).toBeUndefined()
    expect(db.prepare('SELECT 1 FROM item_variant_groups WHERE variant_group_id = ?').get(groupId))
      .toBeUndefined()
  })

  it('leaves no dangling category id in a kitchen printer routing list', () => {
    const db = getDb()
    const keep = makeCategory('قسم يبقى')
    const drop = makeCategory('قسم يُحذف')

    const printerId = Number(db.prepare(
      `INSERT INTO printers (name, role, connection, device_name, category_ids)
       VALUES ('مطبخ', 'kitchen', 'windows_raw', 'XP-80', ?)`
    ).run(JSON.stringify([keep, drop])).lastInsertRowid)

    deleteEntity('category', drop)

    const row = db.prepare('SELECT category_ids FROM printers WHERE printer_id = ?')
      .get(printerId) as { category_ids: string }
    expect(JSON.parse(row.category_ids)).toEqual([keep])

    db.prepare('DELETE FROM printers WHERE printer_id = ?').run(printerId)
    deleteEntity('category', keep)
  })

  it('is also fixed on the plain menu screen path, which has its own delete', () => {
    const catId = makeCategory('قسم فارغ بأسئلة')
    askCategoryAQuestion(catId)

    expect(() => menu.deleteCategory(catId)).not.toThrow()
    expect(getDb().prepare('SELECT 1 FROM categories WHERE category_id = ?').get(catId))
      .toBeUndefined()
  })

  it('still refuses to delete a category whose items have been sold', () => {
    const db = getDb()
    const catId = makeCategory('قسم له تاريخ')
    const itemId = makeItem(catId, 'صنف مُباع')

    const orderId = Number(db.prepare(
      `INSERT INTO orders (cashier_id, subtotal, tax, discount, total_amount, payment_type)
       VALUES (?, 10, 0, 0, 10, 'cash')`
    ).run(ownerId()).lastInsertRowid)
    db.prepare(
      `INSERT INTO order_items (order_id, menu_item_id, quantity, unit_price) VALUES (?, ?, 1, 10)`
    ).run(orderId, itemId)

    const impact = getDeleteImpact('category', catId)
    expect(impact.canHardDelete).toBe(false)
    // Categories cannot be deactivated, so the only honest answer is to refuse and
    // say what is in the way.
    expect(() => deleteEntity('category', catId)).toThrow(/فواتير سابقة/)

    // …and forcing it through still works, which is the escape hatch behind the
    // owner password.
    expect(() => deleteEntity('category', catId, { force: true })).not.toThrow()
  })
})

/**
 * A reset starts the BOOKS again — it does not set the shop up from scratch.
 *
 * The menu is weeks of work (every dish, its price, its cost, its ingredients, the
 * questions the till asks) and the stock figures are a physical count somebody walked
 * round the store room to take. Clearing those alongside the year's sales made a reset
 * too expensive to actually use, so the takings the owner wanted rid of stayed in the
 * books instead. Trading history goes; the shop stays.
 */
describe('resetting the system', () => {
  beforeEach(() => { initDatabase() })

  /** The trading history a reset is FOR, plus the supplier rows that used to break it. */
  function tradeAllDay(): { materialId: number; itemId: number; catId: number } {
    const db = getDb()
    const uid = ownerId()

    const catId = makeCategory('برجر')
    const itemId = makeItem(catId, 'تشيكن برجر')
    const materialId = Number(db.prepare(
      `INSERT INTO raw_materials (name, unit, stock_quantity, cost_per_unit) VALUES ('دجاج', 'كجم', 17.5, 90)`
    ).run().lastInsertRowid)
    db.prepare('INSERT INTO recipe_items (menu_item_id, raw_material_id, quantity) VALUES (?, ?, 0.25)')
      .run(itemId, materialId)

    const orderId = Number(db.prepare(
      `INSERT INTO orders (cashier_id, subtotal, tax, discount, total_amount, payment_type)
       VALUES (?, 85, 0, 0, 85, 'cash')`
    ).run(uid).lastInsertRowid)
    db.prepare('INSERT INTO order_items (order_id, menu_item_id, quantity, unit_price) VALUES (?, ?, 1, 85)')
      .run(orderId, itemId)
    db.prepare(
      `INSERT INTO raw_material_transactions (raw_material_id, change_amount, reason, related_order_id, created_by)
       VALUES (?, -0.25, 'sale', ?, ?)`
    ).run(materialId, orderId, uid)
    db.prepare(`INSERT INTO expenses (category, amount, recorded_by) VALUES ('utilities', 50, ?)`).run(uid)

    const supplierId = Number(db.prepare(
      `INSERT INTO suppliers (name, phone) VALUES ('مورد الدجاج', '0100')`
    ).run().lastInsertRowid)
    const invoiceId = Number(db.prepare(
      `INSERT INTO supplier_invoices (supplier_id, total_amount, created_by) VALUES (?, 900, ?)`
    ).run(supplierId, uid).lastInsertRowid)
    // This is the row that used to abort the whole reset: it points at raw_materials,
    // which the wipe deleted, while nothing deleted the row itself. SQLite rolled the
    // transaction back and the owner saw "FOREIGN KEY constraint failed" with every
    // record they had just tried to clear still in place.
    db.prepare(
      `INSERT INTO supplier_invoice_items (supplier_invoice_id, raw_material_id, quantity, unit_cost, line_total)
       VALUES (?, ?, 10, 90, 900)`
    ).run(invoiceId, materialId)
    db.prepare(`INSERT INTO supplier_payments (supplier_id, amount, created_by) VALUES (?, 500, ?)`)
      .run(supplierId, uid)

    return { materialId, itemId, catId }
  }

  const rows = (table: string) =>
    (getDb().prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as any).c

  it('clears the books even when the supplier ledger has rows in it', () => {
    tradeAllDay()

    expect(() => clearAllBusinessData()).not.toThrow()

    for (const table of [
      'orders', 'order_items', 'raw_material_transactions', 'expenses',
      'supplier_invoices', 'supplier_invoice_items', 'supplier_payments',
    ]) {
      expect(rows(table), `${table} should be empty`).toBe(0)
    }
  })

  it('keeps the menu exactly as it stood — dishes, prices, costs and recipes', () => {
    const { itemId, catId } = tradeAllDay()
    const db = getDb()
    db.prepare('UPDATE menu_items SET price = 95 WHERE item_id = ?').run(itemId)
    askCategoryAQuestion(catId)

    clearAllBusinessData()

    const item = db.prepare('SELECT name, price, category_id FROM menu_items WHERE item_id = ?')
      .get(itemId) as any
    expect(item).toBeDefined()
    expect(item.price).toBe(95) // the owner's own price, not the one it was created with
    expect(item.category_id).toBe(catId)
    expect(rows('recipe_items')).toBeGreaterThan(0)
    expect(rows('item_variant_groups')).toBeGreaterThan(0)
    expect(rows('item_variant_options')).toBeGreaterThan(0)
  })

  it('keeps the stock counts, and only starts the movement log again', () => {
    const { materialId } = tradeAllDay()

    clearAllBusinessData()

    const material = getDb().prepare(
      'SELECT name, stock_quantity FROM raw_materials WHERE raw_material_id = ?'
    ).get(materialId) as any
    expect(material).toBeDefined()
    // The count somebody walked round the store room to take survives; the ledger
    // underneath it does not, and the balance becomes the new opening position.
    expect(material.stock_quantity).toBe(17.5)
    expect(rows('raw_material_transactions')).toBe(0)
  })

  it('keeps the sign-ins, the settings and the printers', () => {
    const db = getDb()
    db.prepare(
      `INSERT INTO printers (name, role, connection, device_name) VALUES ('كاشير', 'receipt', 'windows_raw', 'XP-80')`
    ).run()

    clearAllBusinessData()

    expect(rows('users')).toBeGreaterThan(0)
    expect(rows('printers')).toBeGreaterThan(0)
    expect(rows('settings')).toBeGreaterThan(0)
  })

  it('leaves kitchen routing alone, because the categories it names are still there', () => {
    const db = getDb()
    const catId = makeCategory('قسم قبل التصفير')
    const printerId = Number(db.prepare(
      `INSERT INTO printers (name, role, connection, device_name, category_ids)
       VALUES ('مطبخ', 'kitchen', 'windows_raw', 'XP-80', ?)`
    ).run(JSON.stringify([catId])).lastInsertRowid)

    clearAllBusinessData()

    const row = db.prepare('SELECT category_ids FROM printers WHERE printer_id = ?')
      .get(printerId) as { category_ids: string | null }
    expect(JSON.parse(row.category_ids!)).toEqual([catId])
  })

  it('starts invoice numbering at 1 again', () => {
    tradeAllDay()
    getDb().prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('invoice_seq', '412')`).run()

    clearAllBusinessData()

    const seq = getDb().prepare(`SELECT value FROM settings WHERE key = 'invoice_seq'`).get() as any
    expect(seq.value).toBe('0')
  })

  it('a category deleted before a reset does not come back after it', () => {
    // The bug as the owner met it: delete a category, reset, and there it is again —
    // because the reset threw on a foreign key and rolled the whole thing back.
    const catId = makeCategory('قسم تجريبي')
    deleteEntity('category', catId)
    clearAllBusinessData()

    expect(getDb().prepare('SELECT 1 FROM categories WHERE category_id = ?').get(catId))
      .toBeUndefined()
  })

  it('still wipes the menu and stock too when handing the software to another shop', () => {
    // `--reset-data`, the commissioning step. One shop's dishes are of no use to the
    // next, so that path takes everything.
    tradeAllDay()

    clearAllBusinessData({ keepMenuAndStock: false })

    for (const table of ['categories', 'menu_items', 'raw_materials', 'recipe_items', 'suppliers']) {
      expect(rows(table), `${table} should be empty`).toBe(0)
    }
    expect(rows('users')).toBeGreaterThan(0)
  })
})
