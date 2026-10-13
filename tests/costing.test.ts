import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../src/main/db/db'
import { getCostingReport } from '../src/main/services/costingService'
import { importMenuCatalog } from '../src/main/services/menuImportService'
import { upsertMenuItem } from '../src/main/services/menuService'

/**
 * «التكلفة المبدئية مقابل الفعلية» — the plan against the shelf.
 *
 * Every dish was costed once in «ملخص الريسبى» and priced against that figure. Then
 * chicken went up. Two numbers, therefore, and they must not be allowed to become one:
 *
 *   baseline_cost   what the sheet costed it at. FIXED — it is what is being measured
 *                   from, so it cannot follow the thing it measures.
 *   actual cost     what its ingredients come to at today's supplier prices.
 *
 * The trap is a half-priced recipe. An item whose ingredients are mostly at 0 sums to
 * a small number, which reads as a bargain rather than as "we have not priced this
 * yet" — and would quietly report every such dish as hugely profitable.
 */

let categoryId: number

const item = (name: string, price: number, baseline: number) => Number(getDb().prepare(
  `INSERT INTO menu_items (category_id, name, price, cost_price, baseline_cost)
   VALUES (?, ?, ?, ?, ?)`
).run(categoryId, name, price, baseline, baseline).lastInsertRowid)

const material = (name: string, cost: number) => Number(getDb().prepare(
  `INSERT INTO raw_materials (name, unit, stock_quantity, cost_per_unit) VALUES (?, 'قطعة', 100, ?)`
).run(name, cost).lastInsertRowid)

const recipe = (itemId: number, materialId: number, qty: number) => getDb().prepare(
  'INSERT INTO recipe_items (menu_item_id, raw_material_id, quantity) VALUES (?,?,?)'
).run(itemId, materialId, qty)

const find = (name: string) => getCostingReport().items.find(i => i.name === name)!

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
    `INSERT INTO categories (name, display_order) VALUES ('وجبات', 1)`
  ).run().lastInsertRowid)
})

describe('a dish whose ingredients are priced', () => {
  it('reports the sheet cost and today’s cost side by side', () => {
    const meal = item('وجبة 4 قطعة بروستيد', 210, 117.08)
    const chicken = material('قطعة بروستيد', 19)
    const bread = material('خبز', 4)
    recipe(meal, chicken, 4)   // 76
    recipe(meal, bread, 3)     // 12

    const row = find('وجبة 4 قطعة بروستيد')
    console.log('costing:', JSON.stringify({
      baseline: row.baselineCost, actual: row.actualCost,
      drift: row.drift, driftPct: row.driftPct,
    }))

    expect(row.baselineCost).toBeCloseTo(117.08)
    expect(row.actualCost).toBeCloseTo(88)
    expect(row.drift).toBeCloseTo(-29.08)          // cheaper than planned
    expect(row.plannedProfit).toBeCloseTo(92.92)   // 210 − 117.08
    expect(row.actualProfit).toBeCloseTo(122)      // 210 − 88
  })

  it('flags a dish that now costs MORE than it was priced against', () => {
    const meal = item('وجبة', 210, 117.08)
    const chicken = material('قطعة بروستيد', 35)   // the price went up
    recipe(meal, chicken, 4)                        // 140

    const row = find('وجبة')
    expect(row.actualCost).toBeCloseTo(140)
    expect(row.drift).toBeCloseTo(22.92)
    expect(row.driftPct! > 0).toBe(true)
    expect(row.actualProfit).toBeCloseTo(70)        // not the 92.92 that was planned

    const report = getCostingReport()
    expect(report.overPlanCount).toBe(1)
  })
})

describe('a dish that cannot be compared yet', () => {
  it('says so when it has no recipe at all', () => {
    item('بيبسي', 20, 10)
    const row = find('بيبسي')

    expect(row.actualCost).toBeNull()
    expect(row.drift).toBeNull()
    expect(row.recipeLines).toBe(0)
    // The baseline is still known — it is the plan, recipe or not.
    expect(row.baselineCost).toBeCloseTo(10)
    expect(row.plannedProfit).toBeCloseTo(10)
  })

  it('says so when only SOME ingredients are priced', () => {
    // THE trap: 4 × 19 + 3 × 0 = 76 would read as a cheap dish rather than an
    // unfinished one, and report the shop as making far more than it is.
    const meal = item('وجبة', 210, 117.08)
    recipe(meal, material('قطعة بروستيد', 19), 4)
    recipe(meal, material('خبز', 0), 3)           // not priced yet

    const row = find('وجبة')
    console.log('half-priced recipe:', JSON.stringify({
      actual: row.actualCost, priced: row.pricedLines, lines: row.recipeLines,
    }))

    expect(row.actualCost).toBeNull()
    expect(row.drift).toBeNull()
    expect(row.pricedLines).toBe(1)
    expect(row.recipeLines).toBe(2)
  })

  it('counts towards "not costed" rather than towards the average', () => {
    const priced = item('وجبة', 210, 100)
    recipe(priced, material('قطعة', 20), 5)        // 100 — exactly on plan
    item('بيبسي', 20, 10)                          // no recipe

    const report = getCostingReport()
    console.log('summary:', JSON.stringify({
      total: report.totalItems, compared: report.comparedItems,
      notCosted: report.notCostedItems, avg: report.averageDriftPct,
    }))

    expect(report.totalItems).toBe(2)
    expect(report.comparedItems).toBe(1)
    expect(report.notCostedItems).toBe(1)
    expect(report.averageDriftPct).toBe(0)         // the one comparable dish is on plan
  })
})

describe('the baseline itself', () => {
  it('is written by the menu import, from the sheet', () => {
    getDb().prepare('DELETE FROM menu_items').run()
    getDb().prepare('DELETE FROM categories').run()
    importMenuCatalog()

    const meal = getDb().prepare(
      `SELECT cost_price, baseline_cost FROM menu_items WHERE name = 'وجبة 4 قطعة بروستيد'`
    ).get() as any

    console.log('imported:', JSON.stringify(meal))
    expect(meal.baseline_cost).toBeGreaterThan(0)
    expect(meal.baseline_cost).toBeCloseTo(meal.cost_price)
  })

  it('does NOT move when the working cost is edited', () => {
    const meal = item('وجبة', 210, 117.08)

    // The owner types a different cost, or a priced recipe takes over. Either way the
    // plan the price was set against has not changed.
    getDb().prepare('UPDATE menu_items SET cost_price = 150 WHERE item_id = ?').run(meal)

    expect(find('وجبة').baselineCost).toBeCloseTo(117.08)
  })

  it('does not move when supplier prices move', () => {
    const meal = item('وجبة', 210, 117.08)
    const chicken = material('قطعة بروستيد', 19)
    recipe(meal, chicken, 4)
    expect(find('وجبة').actualCost).toBeCloseTo(76)

    getDb().prepare('UPDATE raw_materials SET cost_per_unit = 25 WHERE raw_material_id = ?')
      .run(chicken)

    const row = find('وجبة')
    expect(row.actualCost).toBeCloseTo(100)        // followed the supplier
    expect(row.baselineCost).toBeCloseTo(117.08)   // did not
  })
})

describe('typing it in on the menu screen', () => {
  /**
   * The sheet is re-costed from time to time, and re-running the import is not always
   * what the owner wants — it would touch every dish. So «تكلفة خامات وتغليف» is a
   * field on the dish, the same as its price.
   */
  const base = { category_id: 0, name: '', price: 0, cost_price: 0 }

  it('is saved with a new dish', () => {
    const saved = upsertMenuItem({
      ...base, category_id: categoryId, name: 'وجبة بروستيد', price: 210,
      cost_price: 95, baseline_cost: 117.08,
    })
    expect(saved.baseline_cost).toBeCloseTo(117.08)
    expect(find('وجبة بروستيد').baselineCost).toBeCloseTo(117.08)
  })

  it('falls back to the cost when left blank on a new dish', () => {
    // Blank means "I have not costed this separately", not "this dish costs nothing" —
    // and a 0 would drop it out of the comparison entirely.
    const saved = upsertMenuItem({
      ...base, category_id: categoryId, name: 'بيبسي', price: 20, cost_price: 11,
    })
    expect(saved.baseline_cost).toBeCloseTo(11)
  })

  it('can be corrected afterwards', () => {
    const saved = upsertMenuItem({
      ...base, category_id: categoryId, name: 'وجبة', price: 210,
      cost_price: 95, baseline_cost: 117.08,
    })

    upsertMenuItem({
      item_id: saved.item_id, category_id: categoryId, name: 'وجبة', price: 210,
      cost_price: 95, baseline_cost: 130.5,
    })

    expect(find('وجبة').baselineCost).toBeCloseTo(130.5)
  })

  it('survives an edit that does not mention it', () => {
    // THE trap. A screen that edits a dish without offering the field sends no
    // baseline; written straight through, that zero would wipe the figure the finance
    // tab measures from and quietly drop the dish out of the report for good.
    const saved = upsertMenuItem({
      ...base, category_id: categoryId, name: 'وجبة', price: 210,
      cost_price: 95, baseline_cost: 117.08,
    })

    upsertMenuItem({
      item_id: saved.item_id, category_id: categoryId, name: 'وجبة',
      price: 225, cost_price: 95,          // a price rise, nothing else
    })

    const row = find('وجبة')
    expect(row.price).toBeCloseTo(225)
    expect(row.baselineCost, 'must not have been zeroed').toBeCloseTo(117.08)
  })

  it('can be deliberately set back to zero', () => {
    const saved = upsertMenuItem({
      ...base, category_id: categoryId, name: 'وجبة', price: 210,
      cost_price: 95, baseline_cost: 117.08,
    })

    upsertMenuItem({
      item_id: saved.item_id, category_id: categoryId, name: 'وجبة', price: 210,
      cost_price: 95, baseline_cost: 0,
    })

    // Explicit 0 is an answer — "this was never costed" — and is honoured.
    expect(find('وجبة').baselineCost).toBe(0)
  })
})
