import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../src/main/db/db'
import { upgradeToShopMenu, MENU_UPGRADE_KEY } from '../src/main/db/menuUpgrade'
import { STARTER_MENU, PLACEHOLDER_MENU, CASHIER_ONLY } from '../src/main/db/starterShop'
import { createOrder } from '../src/main/services/orderService'

/**
 * A till installed before the shop's real menu existed opened on an invented one. The
 * next build moves it onto the real menu, without losing anything the owner made.
 */

let ownerId: number

const db = () => getDb()
const n = (sql: string, ...args: unknown[]) => (db().prepare(sql).get(...args) as { n: number }).n
const categories = () =>
  (db().prepare('SELECT name FROM categories ORDER BY display_order').all() as { name: string }[]).map(r => r.name)
const item = (cat: string, name: string) => db().prepare(`
  SELECT mi.* FROM menu_items mi JOIN categories c ON c.category_id = mi.category_id
  WHERE c.name = ? AND mi.name = ?`).get(cat, name) as any
const printerOf = (cat: string) => {
  const row = db().prepare(`
    SELECT c.printer_id, p.name FROM categories c LEFT JOIN printers p ON p.printer_id = c.printer_id
    WHERE c.name = ?`).get(cat) as { printer_id: number | null; name: string | null }
  return row.printer_id === 0 ? 'none' : row.name
}

/** The database a till had after its first launch on the earlier build. */
function oldTill(): void {
  const d = db()
  for (const t of ['order_items', 'stock_transactions', 'raw_material_transactions', 'orders',
    'recipe_items', 'item_variant_options', 'item_variant_groups', 'menu_items', 'categories']) {
    d.prepare(`DELETE FROM ${t}`).run()
  }
  d.prepare('DELETE FROM settings WHERE key = ?').run(MENU_UPGRADE_KEY)
  const printer = d.prepare('SELECT printer_id FROM printers WHERE name = ?')
  const cat = d.prepare('INSERT INTO categories (name, display_order, printer_id) VALUES (?, ?, ?)')
  const dish = d.prepare(`
    INSERT INTO menu_items (category_id, name, price, cost_price, description, stock_quantity, is_active, display_order)
    VALUES (?, ?, ?, 0, ?, 0, 1, ?)`)
  PLACEHOLDER_MENU.forEach((c, ci) => {
    const pid = c.printer === CASHIER_ONLY ? 0 : (printer.get(c.printer) as any)?.printer_id ?? null
    const id = cat.run(c.name, ci + 1, pid).lastInsertRowid
    c.items.forEach((it, i) => dish.run(id, it.name, it.price, it.description ?? null, i + 1))
  })
}

const sell = (itemId: number) =>
  createOrder({
    cashierId: ownerId, items: [{ menuItemId: itemId, quantity: 1 }],
    paymentType: 'cash', orderType: 'takeaway',
  } as any, 'owner')

const realItemCount = STARTER_MENU.reduce((s, c) => s + c.items.length, 0)

beforeAll(() => {
  initDatabase()
  ownerId = (db().prepare(`SELECT user_id FROM users WHERE role='owner'`).get() as any).user_id
})

describe('a new till', () => {
  it('starts on the real menu, and the upgrade finds nothing to do', () => {
    expect(n('SELECT COUNT(*) AS n FROM menu_items')).toBe(realItemCount)
    expect(categories()).toEqual(STARTER_MENU.map(c => c.name))
    expect(upgradeToShopMenu(db()).ran).toBe(false)      // already recorded at launch
  })
})

describe('a till still on the invented menu', () => {
  beforeEach(oldTill)

  it('ends up on exactly the real menu', () => {
    const r = upgradeToShopMenu(db())
    expect(r.removed).toBe(PLACEHOLDER_MENU.reduce((s, c) => s + c.items.length, 0))
    expect(r.retired).toBe(0)
    expect(categories()).toEqual(STARTER_MENU.map(c => c.name))
    expect(n('SELECT COUNT(*) AS n FROM menu_items')).toBe(realItemCount)
    expect(item('وجبات الفراخ - شواية', 'فرخة شواية').price).toBe(400)
  })

  it('sends every new section to its kitchen', () => {
    upgradeToShopMenu(db())
    expect(printerOf('الكشري')).toBe('كشري وطواجن')
    expect(printerOf('الطواجن المكرونة')).toBe('كشري وطواجن')
    expect(printerOf('الكفتة')).toBe('شاورما ومشويات')
    expect(printerOf('قسم الغربي')).toBe('شاورما ومشويات')
    expect(printerOf('المشروبات والحلويات')).toBe('none')
  })

  it('keeps the section the two menus share, now holding only the real dishes', () => {
    upgradeToShopMenu(db())
    const names = (db().prepare(`
      SELECT mi.name FROM menu_items mi JOIN categories c ON c.category_id = mi.category_id
      WHERE c.name = 'إضافات الكشري' ORDER BY mi.display_order`).all() as any[]).map(r => r.name)
    expect(names).toEqual(STARTER_MENU.find(c => c.name === 'إضافات الكشري')!.items.map(i => i.name))
    expect(printerOf('إضافات الكشري')).toBe('كشري وطواجن')
  })

  it('switches off an invented dish that was sold, rather than deleting the sale', () => {
    const sold = item('كشري', 'كشري كبير')
    sell(sold.item_id)
    const r = upgradeToShopMenu(db())
    expect(r.retired).toBe(1)
    expect(item('كشري', 'كشري كبير').is_active).toBe(0)
    expect(n('SELECT COUNT(*) AS n FROM order_items WHERE menu_item_id = ?', sold.item_id)).toBe(1)
  })

  it('keeps an invented dish the owner changed', () => {
    db().prepare('UPDATE menu_items SET price = 65 WHERE name = ?').run('كشري كبير')
    upgradeToShopMenu(db())
    const kept = item('كشري', 'كشري كبير')
    expect(kept.price).toBe(65)
    expect(kept.is_active).toBe(1)
    expect(categories()).toContain('كشري')                 // its section stays with it
    expect(categories().slice(0, STARTER_MENU.length)).toEqual(STARTER_MENU.map(c => c.name))
  })

  it('keeps a dish of the owner\'s own', () => {
    const cat = (db().prepare(`SELECT category_id FROM categories WHERE name = 'مشويات'`).get() as any).category_id
    db().prepare(`INSERT INTO menu_items (category_id, name, price) VALUES (?, 'طرب ضاني', 220)`).run(cat)
    upgradeToShopMenu(db())
    expect(item('مشويات', 'طرب ضاني').price).toBe(220)
  })

  it('does not duplicate a real dish the owner already typed in, nor change its price', () => {
    const cat = db().prepare(`INSERT INTO categories (name, display_order) VALUES ('الكشري', 99)`).run().lastInsertRowid
    db().prepare(`INSERT INTO menu_items (category_id, name, price) VALUES (?, 'كشري سوبر', 32)`).run(cat)
    upgradeToShopMenu(db())
    expect(n(`SELECT COUNT(*) AS n FROM menu_items WHERE name = 'كشري سوبر'`)).toBe(1)
    expect(item('الكشري', 'كشري سوبر').price).toBe(32)
    expect(item('الكشري', 'كشري أبو الدهب').price).toBe(60)
  })

  it('fills in what a meal comes with when the owner left it blank', () => {
    const cat = db().prepare(`INSERT INTO categories (name, display_order) VALUES ('الكفتة', 99)`).run().lastInsertRowid
    db().prepare(`INSERT INTO menu_items (category_id, name, price) VALUES (?, '1 كيلو كفتة', 600)`).run(cat)
    upgradeToShopMenu(db())
    expect(item('الكفتة', '1 كيلو كفتة').description).toBe('مع: أرز بسمتي + بطاطس + طحينة + عيش + مخلل')
  })

  it('takes a removed section off a printer that was routed to it', () => {
    const old = (db().prepare(`SELECT category_id FROM categories WHERE name = 'حلويات'`).get() as any).category_id
    db().prepare(`UPDATE printers SET category_ids = ? WHERE name = 'كشري وطواجن'`).run(JSON.stringify([old, 999]))
    upgradeToShopMenu(db())
    const list = (db().prepare(`SELECT category_ids FROM printers WHERE name = 'كشري وطواجن'`).get() as any).category_ids
    expect(JSON.parse(list)).toEqual([999])
    db().prepare(`UPDATE printers SET category_ids = NULL`).run()
  })

  it('runs once: a real dish the owner deletes afterwards stays deleted', () => {
    upgradeToShopMenu(db())
    db().prepare(`DELETE FROM menu_items WHERE name = 'كاستر'`).run()
    expect(upgradeToShopMenu(db()).ran).toBe(false)
    initDatabase()                                          // and again on the next launch
    expect(n(`SELECT COUNT(*) AS n FROM menu_items WHERE name = 'كاستر'`)).toBe(0)
  })
})

describe('the free add-on', () => {
  it('sells at 0 and still reaches the kitchen ticket', () => {
    oldTill()
    upgradeToShopMenu(db())
    const free = item('إضافات الكشري', 'دقة + شطة')
    const koshary = item('الكشري', 'كشري سوبر')
    const res: any = createOrder({
      cashierId: ownerId,
      items: [{ menuItemId: koshary.item_id, quantity: 1 }, { menuItemId: free.item_id, quantity: 1 }],
      paymentType: 'cash', orderType: 'takeaway',
    } as any, 'owner')
    const lines = db().prepare('SELECT unit_price FROM order_items WHERE order_id = ? ORDER BY order_item_id')
      .all(res.orderId) as { unit_price: number }[]
    expect(lines.map(l => l.unit_price)).toEqual([30, 0])
  })
})
