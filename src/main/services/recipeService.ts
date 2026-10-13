import { getDb } from '../db/db'
import log from 'electron-log/main'
import type { RecipeItem, RecipeLineInput } from '../../shared/types'

/**
 * The ingredient list for one unit of a menu item, with each material's current
 * cost and stock joined in so the UI can price and warn without a second query.
 */
export function getRecipe(menuItemId: number): RecipeItem[] {
  return getDb().prepare(`
    SELECT ri.*, rm.name as material_name, rm.unit, rm.cost_per_unit, rm.stock_quantity
    FROM recipe_items ri
    JOIN raw_materials rm ON rm.raw_material_id = ri.raw_material_id
    WHERE ri.menu_item_id = ?
    ORDER BY rm.name
  `).all(menuItemId) as RecipeItem[]
}

/** Ingredient cost of one unit of a menu item. Zero when the item has no recipe. */
export function getRecipeCost(menuItemId: number): number {
  const row = getDb().prepare(`
    SELECT COALESCE(SUM(ri.quantity * rm.cost_per_unit), 0) as cost
    FROM recipe_items ri
    JOIN raw_materials rm ON rm.raw_material_id = ri.raw_material_id
    WHERE ri.menu_item_id = ?
  `).get(menuItemId) as { cost: number }
  return Math.round(row.cost * 100) / 100
}

/** Menu item ids that have at least one ingredient — used to pick the deduction path. */
export function getMenuItemIdsWithRecipes(): Set<number> {
  const rows = getDb().prepare('SELECT DISTINCT menu_item_id FROM recipe_items')
    .all() as { menu_item_id: number }[]
  return new Set(rows.map(r => r.menu_item_id))
}

/**
 * Replace a menu item's whole recipe in one transaction.
 *
 * Passing an empty list clears the recipe, which deliberately drops the item back
 * to the simple menu_items.stock_quantity model rather than leaving it unsellable.
 *
 * The menu item's cost_price is recalculated from the ingredients so profit
 * reporting follows supplier prices automatically.
 */
export function setRecipe(menuItemId: number, lines: RecipeLineInput[]): RecipeItem[] {
  const db = getDb()

  const item = db.prepare('SELECT item_id, name FROM menu_items WHERE item_id = ?')
    .get(menuItemId) as { item_id: number; name: string } | undefined
  if (!item) throw new Error('الصنف غير موجود')

  const clean = (lines ?? []).map(l => {
    const rawMaterialId = Number(l.rawMaterialId)
    const quantity = Number(l.quantity)
    if (!Number.isInteger(rawMaterialId) || rawMaterialId <= 0) {
      throw new Error('كل مكوّن يجب أن يشير إلى مادة خام')
    }
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new Error('كمية كل مكوّن يجب أن تكون أكبر من صفر')
    }
    return { rawMaterialId, quantity }
  })

  // A duplicated material would violate the UNIQUE index mid-transaction; catching it
  // here gives the owner a message they can act on instead of a constraint error.
  const seen = new Set<number>()
  for (const l of clean) {
    if (seen.has(l.rawMaterialId)) {
      throw new Error('نفس المادة الخام مكررة — اجمع الكميات في سطر واحد')
    }
    seen.add(l.rawMaterialId)
  }

  const txn = db.transaction(() => {
    db.prepare('DELETE FROM recipe_items WHERE menu_item_id = ?').run(menuItemId)

    const insert = db.prepare(
      'INSERT INTO recipe_items (menu_item_id, raw_material_id, quantity) VALUES (?, ?, ?)'
    )
    for (const l of clean) insert.run(menuItemId, l.rawMaterialId, l.quantity)

    // Keep cost_price in step with the recipe. An item whose recipe was just cleared
    // keeps whatever cost was typed manually, so profit history is not wiped.
    //
    // Nor is it wiped by attaching ingredients that have no prices yet: a recipe of
    // unpriced materials sums to 0, and writing that would say the dish is free. See
    // refreshAllRecipeCosts — that is exactly how this menu lost all 61 of its costs.
    if (clean.length > 0) {
      const cost = getRecipeCost(menuItemId)
      if (cost > 0) {
        db.prepare('UPDATE menu_items SET cost_price = ?, updated_at = datetime(\'now\',\'localtime\') WHERE item_id = ?')
          .run(cost, menuItemId)
      }
    }

    log.info(`[Recipe] "${item.name}" now has ${clean.length} ingredient(s)`)
    return getRecipe(menuItemId)
  })

  return txn()
}

/**
 * Recalculate cost_price for every menu item that has a recipe.
 * Called after raw material costs change so profit reporting stays truthful.
 *
 * A recipe whose materials carry no prices is SKIPPED, not costed at zero.
 *
 * That distinction wiped this restaurant's entire menu. Every dish had its cost from
 * «ملخص الريسبى» — 67.73, 117.08, 126 — then recipes were linked to 32 raw materials
 * that had not been priced yet. Saving one material called this, every recipe summed
 * to 0, and all 61 dishes were written back as costing NOTHING. The profit column then
 * read 100% on every line, and the figure the menu had been priced against was gone.
 *
 * An unpriced material means "we have not entered this yet", never "it is free". Until
 * a real price exists, the cost already on the dish is the better answer.
 */
export function refreshAllRecipeCosts(): number {
  const db = getDb()
  const res = db.prepare(`
    UPDATE menu_items
    SET cost_price = (
      SELECT ROUND(SUM(ri.quantity * rm.cost_per_unit), 2)
      FROM recipe_items ri
      JOIN raw_materials rm ON rm.raw_material_id = ri.raw_material_id
      WHERE ri.menu_item_id = menu_items.item_id
    ),
    updated_at = datetime('now','localtime')
    WHERE item_id IN (
      SELECT ri.menu_item_id
      FROM recipe_items ri
      JOIN raw_materials rm ON rm.raw_material_id = ri.raw_material_id
      GROUP BY ri.menu_item_id
      HAVING SUM(ri.quantity * rm.cost_per_unit) > 0
    )
  `).run()

  if (res.changes > 0) log.info(`[Recipe] Recalculated cost for ${res.changes} menu item(s)`)
  return res.changes
}
