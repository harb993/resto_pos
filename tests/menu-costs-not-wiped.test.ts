import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../src/main/db/db'
import { setRecipe, refreshAllRecipeCosts } from '../src/main/services/recipeService'
import { importMenuCatalog, restoreCatalogCosts } from '../src/main/services/menuImportService'

/**
 * An ingredient with no price entered does NOT mean the dish is free.
 *
 * This restaurant's menu arrived from «ملخص الريسبى» fully costed — 67.73، 117.08، 126 —
 * and then every one of its 61 dishes read 0. Recipes were the cause: 318 ingredient
 * lines pointing at 32 raw materials that nobody had priced yet. Saving any one of
 * those materials recalculated every recipe, each summed to zero, and the zero was
 * written straight over the sheet's figure.
 *
 * The damage was not only the cost column. Profit then showed 100% on every line, and
 * «التكلفة المبدئية» — seeded from the cost — inherited the zeroes, so the costing tab
 * had nothing left to measure from.
 */

let categoryId: number

const item = (name: string, price: number, cost: number) => Number(getDb().prepare(
  `INSERT INTO menu_items (category_id, name, price, cost_price, baseline_cost)
   VALUES (?, ?, ?, ?, ?)`
).run(categoryId, name, price, cost, cost).lastInsertRowid)

const material = (name: string, cost: number) => Number(getDb().prepare(
  `INSERT INTO raw_materials (name, unit, stock_quantity, cost_per_unit) VALUES (?, 'قطعة', 100, ?)`
).run(name, cost).lastInsertRowid)

const costOf = (itemId: number) => (getDb()
  .prepare('SELECT cost_price FROM menu_items WHERE item_id = ?').get(itemId) as any).cost_price

beforeAll(() => { initDatabase() })

beforeEach(() => {
  const db = getDb()
  db.prepare('DELETE FROM order_items').run()
  db.prepare('DELETE FROM recipe_items').run()
  db.prepare('DELETE FROM orders').run()
  db.prepare('DELETE FROM menu_items').run()
  db.prepare('DELETE FROM raw_materials').run()
  db.prepare('DELETE FROM categories').run()
  categoryId = Number(db.prepare(
    `INSERT INTO categories (name, display_order) VALUES ('وجبات البروستيد', 1)`
  ).run().lastInsertRowid)
})

describe('attaching a recipe of unpriced materials', () => {
  it('leaves the cost the dish already had', () => {
    const meal = item('وجبة 4 قطعة بروستيد', 210, 117.08)
    const chicken = material('قطعة بروستيد', 0)   // not priced yet
    const bread = material('خبز', 0)

    setRecipe(meal, [
      { rawMaterialId: chicken, quantity: 4 },
      { rawMaterialId: bread, quantity: 3 },
    ])

    expect(costOf(meal), 'the sheet figure must survive').toBeCloseTo(117.08)
  })

  it('takes over as soon as the materials ARE priced', () => {
    const meal = item('وجبة', 210, 117.08)
    const chicken = material('قطعة بروستيد', 19)
    setRecipe(meal, [{ rawMaterialId: chicken, quantity: 4 }])

    expect(costOf(meal)).toBeCloseTo(76)   // a real answer replaces the plan
  })
})

describe('saving a raw material', () => {
  it('does not zero every dish whose ingredients are unpriced', () => {
    // THE bug, exactly as it happened: a whole menu of costed dishes, recipes linked,
    // nothing priced, and one material saved.
    const meals = [
      item('وجبة 2 قطعة بروستيد', 105, 67.73),
      item('وجبة 3 قطعة بروستيد', 160, 87.68),
      item('وجبة 4 قطعة بروستيد', 210, 117.08),
    ]
    const chicken = material('قطعة بروستيد', 0)
    for (const m of meals) {
      getDb().prepare('INSERT INTO recipe_items (menu_item_id, raw_material_id, quantity) VALUES (?,?,?)')
        .run(m, chicken, 2)
    }

    refreshAllRecipeCosts()

    expect(costOf(meals[0])).toBeCloseTo(67.73)
    expect(costOf(meals[1])).toBeCloseTo(87.68)
    expect(costOf(meals[2])).toBeCloseTo(117.08)
  })

  it('still updates the dishes whose ingredients are priced', () => {
    const priced = item('وجبة مُسعَّرة', 210, 117.08)
    const unpriced = item('وجبة غير مُسعَّرة', 210, 117.08)

    const chicken = material('قطعة بروستيد', 19)
    const mystery = material('مادة بلا سعر', 0)
    const add = getDb().prepare(
      'INSERT INTO recipe_items (menu_item_id, raw_material_id, quantity) VALUES (?,?,?)'
    )
    add.run(priced, chicken, 4)
    add.run(unpriced, mystery, 4)

    refreshAllRecipeCosts()

    expect(costOf(priced), 'real prices win').toBeCloseTo(76)
    expect(costOf(unpriced), 'no prices, no change').toBeCloseTo(117.08)
  })
})

describe('putting back what was already lost', () => {
  it('restores cost and baseline from the sheet', () => {
    importMenuCatalog()

    // Reproduce the damage on the real menu.
    getDb().prepare('UPDATE menu_items SET cost_price = 0, baseline_cost = 0').run()

    const before = getDb().prepare(
      'SELECT COUNT(*) c FROM menu_items WHERE cost_price > 0'
    ).get() as any
    expect(before.c).toBe(0)

    const done = restoreCatalogCosts()
    console.log('restored:', JSON.stringify(done))

    const meal = getDb().prepare(
      `SELECT price, cost_price, baseline_cost FROM menu_items WHERE name = 'وجبة 4 قطعة بروستيد'`
    ).get() as any
    console.log('وجبة 4 قطعة بروستيد:', JSON.stringify(meal))

    expect(meal.cost_price).toBeCloseTo(117.08)
    expect(meal.baseline_cost).toBeCloseTo(117.08)
    expect(done.costs).toBeGreaterThan(40)
  })

  it('never overwrites a figure somebody has set', () => {
    importMenuCatalog()
    const name = 'وجبة 4 قطعة بروستيد'

    // The owner's own cost, and a baseline they corrected by hand.
    getDb().prepare('UPDATE menu_items SET cost_price = 145, baseline_cost = 130 WHERE name = ?')
      .run(name)

    restoreCatalogCosts()

    const meal = getDb().prepare(
      'SELECT cost_price, baseline_cost FROM menu_items WHERE name = ?'
    ).get(name) as any
    expect(meal.cost_price).toBeCloseTo(145)
    expect(meal.baseline_cost).toBeCloseTo(130)
  })

  it('leaves alone a dish the sheet never costed', () => {
    // The add-ons sheet prices its lines but does not cost them. A made-up figure there
    // would be worse than an honest blank.
    importMenuCatalog()
    getDb().prepare('UPDATE menu_items SET cost_price = 0, baseline_cost = 0').run()
    restoreCatalogCosts()

    const uncosted = getDb().prepare(`
      SELECT COUNT(*) c FROM menu_items WHERE cost_price = 0
    `).get() as any
    expect(uncosted.c, 'the uncosted add-ons stay blank').toBeGreaterThan(0)
  })
})
