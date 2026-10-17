import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../src/main/db/db'
import { importMenuCatalog } from '../src/main/services/menuImportService'
import { importRecipeCatalog, previewRecipeCatalog } from '../src/main/services/recipeImportService'
import { CATALOG_MATERIALS, CATALOG_RECIPES } from '../src/main/services/recipeCatalog'
import { createOrder } from '../src/main/services/orderService'
import { getFinanceReport } from '../src/main/services/financeService'

/**
 * Giving every dish its ingredients, so a sale draws the store down.
 *
 * The delicate part is what this must NOT do. The workbook costs dishes, not
 * ingredients, so the materials arrive priced at zero — and a naive costing rule would
 * read that as "this meal costs nothing" and report the whole sale as profit. The
 * margins have to survive the import untouched and only improve as the store is
 * priced up.
 */

let ownerId: number
let today: string

beforeAll(() => {
  initDatabase()
  ownerId = (getDb().prepare(`SELECT user_id FROM users WHERE role='owner'`).get() as any).user_id
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  today = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
})

beforeEach(() => {
  const db = getDb()
  db.prepare('DELETE FROM order_items').run()
  db.prepare('DELETE FROM raw_material_transactions').run()
  db.prepare('DELETE FROM orders').run()
})

const itemNamed = (name: string) =>
  getDb().prepare('SELECT item_id, cost_price FROM menu_items WHERE name = ?').get(name) as
    { item_id: number; cost_price: number }

const sell = (itemId: number, qty = 1) =>
  createOrder({
    cashierId: ownerId, items: [{ menuItemId: itemId, quantity: qty }],
    paymentType: 'cash', orderType: 'takeaway',
  } as any, 'owner')

describe('the catalogue itself', () => {
  it('every recipe line names a material the catalogue defines', () => {
    const known = new Set(CATALOG_MATERIALS.map(m => m.name))
    const unknown: string[] = []
    for (const [dish, lines] of Object.entries(CATALOG_RECIPES)) {
      for (const [material] of lines) if (!known.has(material)) unknown.push(`${dish} → ${material}`)
    }
    expect(unknown).toEqual([])
  })

  it('never uses a quantity of zero or less', () => {
    for (const [dish, lines] of Object.entries(CATALOG_RECIPES)) {
      for (const [material, qty] of lines) {
        expect(qty, `${dish} → ${material}`).toBeGreaterThan(0)
      }
    }
  })

  it('names no material twice within one dish', () => {
    for (const [dish, lines] of Object.entries(CATALOG_RECIPES)) {
      const names = lines.map(l => l[0])
      expect(new Set(names).size, dish).toBe(names.length)
    }
  })
})

describe('importing onto a menu that is not there yet', () => {
  // An empty menu, rather than whatever the till starts with: the shop's own starter
  // menu shares the odd name with this catalogue («بطاطس»).
  beforeAll(() => {
    for (const t of ['item_variant_options', 'item_variant_groups', 'menu_items', 'categories']) {
      getDb().prepare(`DELETE FROM ${t}`).run()
    }
  })

  it('skips every dish rather than inventing menu items with no price', () => {
    const before = (getDb().prepare('SELECT COUNT(*) AS c FROM menu_items').get() as any).c

    const res = importRecipeCatalog()

    expect(res.itemsLinked).toBe(0)
    expect(res.itemsSkipped).toBe(Object.keys(CATALOG_RECIPES).length)
    // A recipe must never conjure a dish onto the POS — it would have no price.
    expect((getDb().prepare('SELECT COUNT(*) AS c FROM menu_items').get() as any).c).toBe(before)
  })

  it('still creates the materials, so the store can be priced up in advance', () => {
    expect((getDb().prepare('SELECT COUNT(*) AS c FROM raw_materials').get() as any).c)
      .toBe(CATALOG_MATERIALS.length)
  })
})

describe('importing onto the real menu', () => {
  beforeAll(() => {
    importMenuCatalog()
  })

  it('links the dishes and reuses the materials it already created', () => {
    const res = importRecipeCatalog()
    console.log('import:', JSON.stringify({
      created: res.materialsCreated, reused: res.materialsReused,
      linked: res.itemsLinked, skipped: res.itemsSkipped,
    }))
    expect(res.itemsLinked).toBeGreaterThan(40)
    expect(res.materialsCreated).toBe(0)      // the previous run made them
    expect(res.materialsReused).toBe(CATALOG_MATERIALS.length)
  })

  it('gives a 4-piece meal exactly what the sheet says it is made of', () => {
    const item = itemNamed('وجبة 4 قطعة بروستيد')
    const lines = getDb().prepare(`
      SELECT rm.name, ri.quantity FROM recipe_items ri
      JOIN raw_materials rm ON rm.raw_material_id = ri.raw_material_id
      WHERE ri.menu_item_id = ? ORDER BY rm.name
    `).all(item.item_id) as any[]

    const got = Object.fromEntries(lines.map(l => [l.name, l.quantity]))
    console.log('وجبة 4 قطعة بروستيد =', JSON.stringify(got))
    expect(got['قطعة بروستيد']).toBe(4)
    expect(got['خبز']).toBe(3)
    expect(got['بطاطس']).toBe(0.1)
    expect(got['كلوسلو']).toBe(1)
    expect(got['تغليف']).toBe(1)
  })

  it('does not run twice over a dish the owner has already described', () => {
    const again = importRecipeCatalog()
    expect(again.itemsLinked).toBe(0)
    expect(again.itemsAlreadyHadRecipe).toBeGreaterThan(40)
  })

  it('rewrites them when explicitly told to', () => {
    const forced = importRecipeCatalog({ replaceExisting: true })
    expect(forced.itemsLinked).toBeGreaterThan(40)
    expect(forced.itemsAlreadyHadRecipe).toBe(0)
  })
})

describe('what the import must not break', () => {
  it('leaves the meal cost alone while the ingredients are still unpriced', () => {
    // THE regression this guards. Materials are at 0, so a recipe total of 0 must
    // fall back to the workbook's costed figure rather than reporting pure profit.
    const item = itemNamed('وجبة 4 قطعة بروستيد')
    expect(item.cost_price).toBeGreaterThan(0)

    const order = sell(item.item_id)
    console.log('cost charged with unpriced ingredients:', order.cost ?? 'n/a')

    const line = getDb().prepare('SELECT unit_cost FROM order_items WHERE order_id = ?')
      .get(order.orderId) as any
    expect(line.unit_cost).toBeCloseTo(item.cost_price)
  })

  it('switches to the recipe once the ingredients ARE priced', () => {
    const db = getDb()
    db.prepare(`UPDATE raw_materials SET cost_per_unit = 19 WHERE name = 'قطعة بروستيد'`).run()
    db.prepare(`UPDATE raw_materials SET cost_per_unit = 4  WHERE name = 'خبز'`).run()

    const item = itemNamed('وجبة 4 قطعة بروستيد')
    const order = sell(item.item_id)

    const line = getDb().prepare('SELECT unit_cost FROM order_items WHERE order_id = ?')
      .get(order.orderId) as any
    // 4 × 19 + 3 × 4 = 88, everything else still at 0.
    expect(line.unit_cost).toBeCloseTo(88)

    db.prepare(`UPDATE raw_materials SET cost_per_unit = 0`).run()
  })

  it('draws the ingredients out of stock when a meal sells', () => {
    const item = itemNamed('وجبة 4 قطعة بروستيد')
    sell(item.item_id, 3)

    const r = getFinanceReport(today, today)
    const used = Object.fromEntries(r.materialsUsed.map(m => [m.name, m.quantity]))
    console.log('materialsUsed after 3 meals:', JSON.stringify(used))

    expect(used['قطعة بروستيد']).toBeCloseTo(12)   // 3 × 4
    expect(used['خبز']).toBeCloseTo(9)             // 3 × 3
    expect(used['بطاطس']).toBeCloseTo(0.3)         // 3 × 0.1
  })
})

describe('the preview shown before anything is written', () => {
  it('reports what will happen', () => {
    const p = previewRecipeCatalog()
    console.log('preview:', JSON.stringify({
      materials: p.materials, recipes: p.recipes, onMenu: p.onMenu,
      missing: p.missing.length, needingCost: p.materialsNeedingCost,
    }))
    expect(p.materials).toBe(CATALOG_MATERIALS.length)
    expect(p.recipes).toBe(Object.keys(CATALOG_RECIPES).length)
    expect(p.onMenu).toBeGreaterThan(40)
    expect(p.materialsNeedingCost).toBeGreaterThan(0) // nothing priced yet
  })
})
