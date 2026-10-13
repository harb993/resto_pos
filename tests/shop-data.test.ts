import { describe, it, expect, beforeAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase, getDb } from '../src/main/db/db'
import { updateSettings, getSettings } from '../src/main/services/settingsService'
import {
  buildShopData, importShopData, parseShopData, exportShopDataTo, countShopData,
  type ShopDataPackage,
} from '../src/main/services/shopDataService'
import { listCustomers, getCustomerByPhone, getCustomerStats } from '../src/main/services/customerService'

/**
 * The shop's own data — menu, stock, customers, settings — out to a file and back.
 *
 * The case that matters is a restaurant starting fresh books: the invoices stay
 * behind, and everything somebody typed in to make the system THEIR restaurant has to
 * come across intact — including the customers, who until now existed only as phone
 * numbers on those invoices.
 */

let ownerId: number
let areaId: number
let mealId: number
let materialId: number
let pkg: ShopDataPackage

const PHONE = '01012345678'

const deliveryOrder = (createdAt: string, total: number, name = 'أم أحمد', address = 'مارينا 5 — فيلا 12') =>
  getDb().prepare(`
    INSERT INTO orders (cashier_id, order_type, payment_type, subtotal, tax, discount, total_amount, status,
                        customer_name, customer_phone, customer_address, delivery_area_id, created_at)
    VALUES (?, 'delivery', 'cash', ?, 0, 0, ?, 'completed', ?, ?, ?, ?, ?)
  `).run(ownerId, total, total, name, PHONE, address, areaId, createdAt)

beforeAll(() => {
  initDatabase()
  const db = getDb()
  ownerId = (db.prepare(`SELECT user_id FROM users WHERE role='owner'`).get() as any).user_id
  // A new database has no delivery areas of its own any more — give the test one.
  db.prepare(`INSERT INTO delivery_areas (area_name, delivery_fee) SELECT 'منطقة الاختبار', 20 WHERE NOT EXISTS (SELECT 1 FROM delivery_areas WHERE is_active = 1)`).run()
  areaId = (db.prepare(`SELECT delivery_area_id FROM delivery_areas LIMIT 1`).get() as any).delivery_area_id
  const meal = db.prepare(`SELECT item_id, category_id FROM menu_items ORDER BY item_id LIMIT 1`).get() as any
  mealId = meal.item_id

  // A shop that has been set up properly: stock, a recipe, a question, a printer.
  materialId = db.prepare(`
    INSERT INTO raw_materials (name, unit, stock_quantity, cost_per_unit, low_stock_threshold)
    VALUES ('قطعة بروستيد', 'قطعة', 12.5, 25, 20)
  `).run().lastInsertRowid as number
  const minus = db.prepare(`
    INSERT INTO raw_materials (name, unit, stock_quantity, cost_per_unit) VALUES ('خبز', 'رغيف', -7, 1.5)
  `).run().lastInsertRowid as number
  db.prepare(`INSERT INTO recipe_items (menu_item_id, raw_material_id, quantity) VALUES (?, ?, 4)`).run(mealId, materialId)
  db.prepare(`INSERT INTO recipe_items (menu_item_id, raw_material_id, quantity) VALUES (?, ?, 2)`).run(mealId, minus)
  const group = db.prepare(`INSERT INTO item_variant_groups (category_id, group_name) VALUES (?, 'النوع')`)
    .run(meal.category_id).lastInsertRowid
  db.prepare(`INSERT INTO item_variant_options (variant_group_id, option_name, price_delta) VALUES (?, 'حار', 5)`).run(group)
  // A new database comes with the shop's starter printers; this shop has just the one.
  db.prepare('UPDATE categories SET printer_id = NULL').run()
  db.prepare('DELETE FROM printers').run()
  db.prepare(`
    INSERT INTO printers (name, role, connection, host, port, category_ids)
    VALUES ('المطبخ', 'kitchen', 'network', '192.168.1.50', 9100, ?)
  `).run(JSON.stringify([meal.category_id]))

  updateSettings({
    business_name: 'كريسبو', tax_rate: 0, shifts_per_day: 1, shift1_name: 'يومي',
    shift1_start: '10:00', shift1_end: '06:00', print_font_scale: 130,
    net_mode: 'master', net_token: 'SECRET-TOKEN',
  } as never)

  // …and two delivery orders from the same customer, which is all a customer was.
  deliveryOrder('2026-09-20 21:00:00', 300)
  deliveryOrder('2026-10-05 22:30:00', 450)
  db.prepare(`INSERT INTO customer_notes (phone, note, created_by) VALUES (?, 'يفضّل الحار', ?)`).run(PHONE, ownerId)

  pkg = buildShopData()
})

describe('what an export holds', () => {
  it('the menu, the stock, the recipes, the questions and the printers', () => {
    const counts = countShopData(pkg)
    expect(counts.menuItems).toBeGreaterThan(0)
    expect(counts.rawMaterials).toBe(2)
    expect(counts.recipeLines).toBe(2)
    expect(pkg.variantGroups).toHaveLength(1)
    expect(pkg.variantOptions).toHaveLength(1)
    expect(pkg.printers).toHaveLength(1)
  })

  it('every customer, with their history to date', () => {
    expect(pkg.customers).toHaveLength(1)
    expect(pkg.customers[0]).toMatchObject({
      phone: PHONE, name: 'أم أحمد', orders: 2, spent: 750, deliveryAreaId: areaId,
      lastOrderAt: '2026-10-05 22:30:00',
    })
    expect(pkg.customerNotes).toHaveLength(1)
  })

  it('the shop\'s settings — and never this machine\'s link to the other till', () => {
    expect(pkg.settings.business_name).toBe('كريسبو')
    expect(pkg.settings.shift1_end).toBe('06:00')
    expect(pkg.settings.net_token).toBeUndefined()
    expect(pkg.settings.net_mode).toBeUndefined()
    expect(JSON.stringify(pkg)).not.toContain('SECRET-TOKEN')
    // No accounts either: a file that gets copied about must not carry passwords.
    expect(JSON.stringify(pkg)).not.toMatch(/password|pin_hash/i)
  })

  it('is written as a file the program reads back and a workbook a person can', async () => {
    const out = await exportShopDataTo(fs.mkdtempSync(path.join(os.tmpdir(), 'shop-data-')))
    expect(fs.existsSync(out.jsonPath)).toBe(true)
    expect(fs.existsSync(out.excelPath)).toBe(true)
    expect(parseShopData(JSON.parse(fs.readFileSync(out.jsonPath, 'utf8'))).customers).toHaveLength(1)

    const ExcelJS = require('exceljs')
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.readFile(out.excelPath)
    expect(wb.worksheets.map((w: any) => w.name)).toEqual([
      'القائمة', 'الخامات والمخزون', 'مكونات الأصناف', 'العملاء', 'مناطق التوصيل', 'الإعدادات',
    ])
    // A phone number must keep its leading zero.
    expect(wb.getWorksheet('العملاء').getRow(2).getCell(1).value).toBe(PHONE)
  })
})

describe('what an import does', () => {
  it('refuses anything that is not one of its own files', () => {
    expect(() => parseShopData(null)).toThrow()
    expect(() => parseShopData({ format: 'something-else' })).toThrow(/ليس ملف بيانات/)
    expect(() => parseShopData({ ...pkg, version: 99 })).toThrow(/إصدار/)
    expect(() => parseShopData({ ...pkg, menuItems: 'x' })).toThrow(/ناقص/)
    expect(() => parseShopData({ ...pkg, customers: [{ name: 'بلا رقم' }] })).toThrow(/رقم هاتف/)
  })

  it('refuses while there are invoices on the books', () => {
    expect(() => importShopData(pkg, ownerId)).toThrow(/صفّر النظام/)
  })

  it('on fresh books, brings the whole shop back exactly', () => {
    const db = getDb()
    // The books are started again, and in the meantime the shop has drifted.
    db.prepare('DELETE FROM orders').run()
    db.prepare('UPDATE menu_items SET price = 1').run()
    db.prepare('DELETE FROM recipe_items').run()
    db.prepare('DELETE FROM printers').run()
    db.prepare(`UPDATE raw_materials SET stock_quantity = 999`).run()
    updateSettings({ business_name: 'اسم مؤقت', shift1_end: '17:50' } as never)

    const counts = importShopData(JSON.parse(JSON.stringify(pkg)), ownerId)
    expect(counts.customers).toBe(1)

    const price = (id: number) => (db.prepare('SELECT price FROM menu_items WHERE item_id = ?').get(id) as any).price
    const original = pkg.menuItems.find(i => i.item_id === mealId)!
    expect(price(mealId)).toBe(original.price)

    // Recipes still point at the right dish and the right material.
    const recipe = db.prepare(`
      SELECT rm.name, r.quantity FROM recipe_items r JOIN raw_materials rm ON rm.raw_material_id = r.raw_material_id
      WHERE r.menu_item_id = ? ORDER BY rm.name
    `).all(mealId)
    expect(recipe).toEqual([{ name: 'خبز', quantity: 2 }, { name: 'قطعة بروستيد', quantity: 4 }])

    // The kitchen printer still names the category it cooks.
    const printer = db.prepare(`SELECT host, category_ids FROM printers`).get() as any
    expect(printer.host).toBe('192.168.1.50')
    expect(JSON.parse(printer.category_ids)).toEqual([original.category_id])

    const s = getSettings()
    expect(s.business_name).toBe('كريسبو')
    expect(s.shift1_end).toBe('06:00')
    expect(s.print_font_scale).toBe(130)
    // This machine's own link to the other till is left exactly as it was.
    expect(s.net_token).toBe('SECRET-TOKEN')
  })

  it('the shelf counts arrive as they were — short ones included — and the ledger explains each', () => {
    const db = getDb()
    const rows = db.prepare(`
      SELECT rm.name, rm.stock_quantity AS balance,
             (SELECT COALESCE(SUM(t.change_amount), 0) FROM raw_material_transactions t
               WHERE t.raw_material_id = rm.raw_material_id) AS movements
      FROM raw_materials rm ORDER BY rm.name
    `).all() as any[]
    expect(rows).toEqual([
      { name: 'خبز', balance: -7, movements: -7 },
      { name: 'قطعة بروستيد', balance: 12.5, movements: 12.5 },
    ])
  })

  it('the customers are still in the book, though their invoices are not', () => {
    const c = getCustomerByPhone(PHONE)!
    expect(c).toMatchObject({
      phone: PHONE, name: 'أم أحمد', address: 'مارينا 5 — فيلا 12', delivery_area_id: areaId,
      order_count: 2, total_spent: 750, average_order: 375, last_order_at: '2026-10-05 22:30:00',
    })
    expect(c.area_name).toBeTruthy()
    expect(listCustomers({ search: 'أحمد' })).toHaveLength(1)
    expect(getCustomerStats()).toMatchObject({ totalCustomers: 1, repeatCustomers: 1, totalRevenue: 750 })
    expect((getDb().prepare('SELECT note FROM customer_notes WHERE phone = ?').get(PHONE) as any).note).toBe('يفضّل الحار')
  })

  it('and when they order again, the new order is added on top — with its newer details', () => {
    deliveryOrder('2026-10-13 20:00:00', 250, 'أم أحمد', 'مارينا 2 — عمارة 3')
    const c = getCustomerByPhone(PHONE)!
    expect(c.order_count).toBe(3)
    expect(c.total_spent).toBe(1000)
    expect(c.address).toBe('مارينا 2 — عمارة 3')
    expect(c.last_order_at).toBe('2026-10-13 20:00:00')
    expect(c.first_order_at).toBe('2026-09-20 21:00:00')
    // Still one customer — the phone number is who they are.
    expect(listCustomers()).toHaveLength(1)
  })
})
