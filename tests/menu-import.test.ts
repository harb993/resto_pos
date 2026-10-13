import { describe, it, expect, beforeAll } from 'vitest'
import { initDatabase, getDb, clearAllBusinessData } from '../src/main/db/db'
import { importMenuCatalog } from '../src/main/services/menuImportService'
import { MENU_CATALOG, catalogItemCount } from '../src/main/services/menuCatalog'

/**
 * The costed menu from «ملخص الريسبى», loaded into the database.
 *
 * The property that matters is that pressing the button twice is not a mistake: a
 * restaurant that re-imports after adding a dish of its own must not end up with the
 * whole menu twice over, with its sales figures split between the two copies.
 */

const count = (sql: string, ...args: any[]) =>
  (getDb().prepare(sql).get(...args) as { c: number }).c

beforeAll(() => {
  initDatabase()
  // Start from an empty menu so the counts below are about the import and nothing
  // else. The full wipe, not the ordinary reset — that one keeps the menu on purpose.
  clearAllBusinessData({ keepMenuAndStock: false })
})

describe('the costed menu catalogue', () => {
  it('prices every dish above what it costs to make', () => {
    for (const cat of MENU_CATALOG) {
      for (const item of cat.items) {
        expect(item.price, `${item.name} needs a price`).toBeGreaterThan(0)
        expect(item.cost, `${item.name} cost cannot be negative`).toBeGreaterThanOrEqual(0)
        // The add-ons sheet gives no costs, so those are 0 by design; everything that
        // IS costed has to sell for more than it costs, or the sheet was mis-read.
        if (item.cost > 0) {
          expect(item.price, `${item.name} sells below cost`).toBeGreaterThan(item.cost)
        }
      }
    }
  })

  it('gives every dish a name of its own', () => {
    // The broasted and strips sheets both call a meal «وجبة 2قطعة», and two sandwich
    // sheets both have a «هوت دوج». On a kitchen ticket there is no sheet heading to
    // tell them apart, so the names carry their family.
    const names = MENU_CATALOG.flatMap(c => c.items.map(i => i.name))
    expect(new Set(names).size).toBe(names.length)
  })
})

describe('importing it', () => {
  it('creates every category and every dish on a fresh menu', () => {
    const result = importMenuCatalog()

    expect(result.categoriesCreated).toBe(MENU_CATALOG.length)
    expect(result.itemsCreated).toBe(catalogItemCount())
    expect(count('SELECT COUNT(*) AS c FROM menu_items')).toBe(catalogItemCount())

    // The add-ons come in uncosted and the import says so, rather than letting them
    // read as pure profit without anyone noticing.
    expect(result.itemsWithoutCost).toBeGreaterThan(0)
  })

  it('adds nothing the second time', () => {
    const again = importMenuCatalog()

    expect(again.categoriesCreated).toBe(0)
    expect(again.itemsCreated).toBe(0)
    expect(again.itemsUnchanged).toBe(catalogItemCount())
    expect(count('SELECT COUNT(*) AS c FROM menu_items')).toBe(catalogItemCount())
  })

  it('leaves a price the owner has changed alone', () => {
    const db = getDb()
    const item = db.prepare(`SELECT item_id FROM menu_items WHERE name = 'تشيكن برجر'`)
      .get() as { item_id: number }
    db.prepare('UPDATE menu_items SET price = 999 WHERE item_id = ?').run(item.item_id)

    importMenuCatalog()

    expect((db.prepare('SELECT price FROM menu_items WHERE item_id = ?').get(item.item_id) as any).price)
      .toBe(999)
  })

  it('puts the sheet’s price back when asked to', () => {
    const db = getDb()
    const before = db.prepare(`SELECT item_id FROM menu_items WHERE name = 'تشيكن برجر'`)
      .get() as { item_id: number }

    const result = importMenuCatalog({ replacePrices: true })
    expect(result.itemsUpdated).toBe(catalogItemCount())

    const after = db.prepare('SELECT price, cost_price FROM menu_items WHERE item_id = ?')
      .get(before.item_id) as { price: number; cost_price: number }
    expect(after.price).toBe(85)
    expect(after.cost_price).toBeCloseTo(40.43, 2)
    // The same row, not a second one beside it.
    expect(count(`SELECT COUNT(*) AS c FROM menu_items WHERE name = 'تشيكن برجر'`)).toBe(1)
  })

  it('moves a dish filed under the wrong category instead of cloning it', () => {
    const db = getDb()
    const stray = Number(db.prepare('INSERT INTO categories (name, display_order) VALUES (?, 99)')
      .run('قسم غلط').lastInsertRowid)
    const item = db.prepare(`SELECT item_id FROM menu_items WHERE name = 'مارينا كينج'`)
      .get() as { item_id: number }
    db.prepare('UPDATE menu_items SET category_id = ? WHERE item_id = ?').run(stray, item.item_id)

    importMenuCatalog()

    const burgers = db.prepare(`SELECT category_id FROM categories WHERE name = 'البرجر'`)
      .get() as { category_id: number }
    expect((db.prepare('SELECT category_id FROM menu_items WHERE item_id = ?').get(item.item_id) as any)
      .category_id).toBe(burgers.category_id)
    expect(count(`SELECT COUNT(*) AS c FROM menu_items WHERE name = 'مارينا كينج'`)).toBe(1)
  })
})
