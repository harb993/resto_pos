import { getDb } from '../db/db'
import { getSettings } from './settingsService'
import type { CostingReport } from '../../shared/types'

/**
 * «التكلفة المبدئية مقابل التكلفة الفعلية» — the plan against the shelf.
 *
 * Every dish on this menu was costed once, in «ملخص الريسبى», and its selling price
 * was set against that figure. Then the world moved: chicken went up, a supplier
 * changed, the cost of a bread is not what it was when the sheet was written.
 *
 * Two numbers per dish, therefore, and they answer different questions:
 *
 *   التكلفة المبدئية   the sheet's «تكلفة الخامات والتغليف» — ingredients plus
 *                      packaging, after its safety margin. The plan the price was set
 *                      against, and the thing being measured FROM. It moves only when
 *                      the owner edits it on the menu screen, never on its own.
 *   التكلفة الفعلية    what its ingredients cost TODAY, priced from the store at
 *                      today's supplier prices. Moves whenever a price is entered.
 *
 * The gap between them is the answer to the only question that matters here: is this
 * dish still making what it was supposed to make? A meal priced at 210 against a
 * planned cost of 117 was meant to earn 93. If its ingredients now come to 140, it is
 * earning 70 and nobody has been told.
 *
 * A dish with no recipe, or whose ingredients are not priced yet, has no actual cost
 * to compare — reported honestly as "not costed" rather than as a saving.
 */

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

export function getCostingReport(): CostingReport {
  const db = getDb()
  const currency = getSettings().currency_symbol || 'ج.م'

  const rows = db.prepare(`
    SELECT
      mi.item_id, mi.name, mi.price, mi.baseline_cost, mi.is_active,
      COALESCE(c.name, 'بدون قسم') AS category,
      COALESCE(c.display_order, 9999) AS category_order,
      (SELECT COUNT(*) FROM recipe_items ri WHERE ri.menu_item_id = mi.item_id) AS recipe_lines,
      -- Today's cost of what goes in it. A recipe line pointing at an unpriced
      -- material contributes 0, which is why priced_lines is counted alongside it:
      -- a half-priced recipe must not read as a cheap dish.
      (SELECT COALESCE(SUM(ri.quantity * rm.cost_per_unit), 0)
         FROM recipe_items ri
         JOIN raw_materials rm ON rm.raw_material_id = ri.raw_material_id
        WHERE ri.menu_item_id = mi.item_id) AS actual_cost,
      (SELECT COUNT(*)
         FROM recipe_items ri
         JOIN raw_materials rm ON rm.raw_material_id = ri.raw_material_id
        WHERE ri.menu_item_id = mi.item_id AND rm.cost_per_unit > 0) AS priced_lines
    FROM menu_items mi
    LEFT JOIN categories c ON c.category_id = mi.category_id
    ORDER BY category_order, c.name, mi.display_order, mi.name
  `).all() as any[]

  const items = rows.map(r => {
    const baseline = round2(r.baseline_cost)
    // Costed only when there IS a recipe and every line of it has a price. Anything
    // else would be comparing the plan against a number that is mostly zeroes.
    const costed = r.recipe_lines > 0 && r.priced_lines === r.recipe_lines
    const actual = costed ? round2(r.actual_cost) : null

    return {
      itemId: r.item_id,
      name: r.name,
      category: r.category,
      isActive: !!r.is_active,
      price: round2(r.price),
      baselineCost: baseline,
      actualCost: actual,
      /** What the sheet said this dish would earn. */
      plannedProfit: baseline > 0 ? round2(r.price - baseline) : null,
      /** What it earns at today's ingredient prices. */
      actualProfit: actual === null ? null : round2(r.price - actual),
      /** Positive means it costs MORE than planned. */
      drift: actual === null || baseline === 0 ? null : round2(actual - baseline),
      driftPct: actual === null || baseline === 0
        ? null
        : round2(((actual - baseline) / baseline) * 100),
      recipeLines: r.recipe_lines,
      pricedLines: r.priced_lines,
    }
  })

  const comparable = items.filter(i => i.drift !== null)
  const overPlan = comparable.filter(i => (i.drift ?? 0) > 0)

  return {
    currency,
    items,
    /** How much of the menu can actually be compared yet. */
    totalItems: items.length,
    comparedItems: comparable.length,
    notCostedItems: items.length - comparable.length,
    /** Dishes now costing more than the sheet said. */
    overPlanCount: overPlan.length,
    /** Average drift across what can be compared — the menu's overall slippage. */
    averageDriftPct: comparable.length === 0
      ? 0
      : round2(comparable.reduce((t, i) => t + (i.driftPct ?? 0), 0) / comparable.length),
  }
}
