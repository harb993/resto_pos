import { getDb } from '../db/db'
import log from 'electron-log/main'
import { CATALOG_MATERIALS, CATALOG_RECIPES, type RecipeLine } from './recipeCatalog'
import type { RecipeImportResult } from '../../shared/types'

/**
 * Give every dish on the menu its ingredients, so a sale draws the store down.
 *
 * Until this is run the restaurant stocks nothing: a meal sells, the money is recorded
 * and the shelf quietly empties with no trace. Afterwards a sale of one 4-piece meal
 * takes four pieces of chicken, three breads, a hundred grams of potato, a coleslaw, a
 * pickle and a box out of stock — and the sales report can say what the week actually
 * consumed instead of only what it sold.
 *
 * Safe to press twice. Materials are matched by name, so anything the owner has
 * already created and priced is reused rather than duplicated, and a second run
 * changes nothing unless `replaceExisting` is on.
 *
 * ── What it does NOT do ──
 *
 * It does not invent costs. The workbook costs dishes, not ingredients, and its totals
 * do not decompose into per-unit prices — see the note in recipeCatalog.ts. New
 * materials therefore arrive at 0, and `createOrder` goes on costing those dishes from
 * the workbook's costed figure until real prices are entered. So margins do not move
 * on the day this is pressed; they start improving as the store is priced up.
 *
 * It does not touch stock levels either. Opening quantities are a count somebody has
 * to do, not something an import can know.
 */
export function importRecipeCatalog(
  opts: { replaceExisting?: boolean } = {},
): RecipeImportResult {
  const db = getDb()
  const replace = opts.replaceExisting === true

  const result: RecipeImportResult = {
    materialsCreated: 0,
    materialsReused: 0,
    itemsLinked: 0,
    itemsSkipped: 0,
    itemsAlreadyHadRecipe: 0,
    materialsWithoutCost: 0,
    missingItems: [],
  }

  const findMaterial = db.prepare('SELECT raw_material_id, cost_per_unit FROM raw_materials WHERE name = ?')
  const insertMaterial = db.prepare(`
    INSERT INTO raw_materials (name, unit, stock_quantity, cost_per_unit, low_stock_threshold, is_active)
    VALUES (?, ?, 0, 0, ?, 1)
  `)
  const findItem = db.prepare('SELECT item_id FROM menu_items WHERE name = ?')
  const countRecipe = db.prepare('SELECT COUNT(*) AS c FROM recipe_items WHERE menu_item_id = ?')
  const clearRecipe = db.prepare('DELETE FROM recipe_items WHERE menu_item_id = ?')
  const insertLine = db.prepare(`
    INSERT OR IGNORE INTO recipe_items (menu_item_id, raw_material_id, quantity) VALUES (?, ?, ?)
  `)

  const run = db.transaction(() => {
    // ---- 1. Every material the recipes refer to ----
    const materialIds = new Map<string, number>()

    for (const m of CATALOG_MATERIALS) {
      const existing = findMaterial.get(m.name) as { raw_material_id: number; cost_per_unit: number } | undefined
      if (existing) {
        materialIds.set(m.name, existing.raw_material_id)
        result.materialsReused++
        if (!existing.cost_per_unit) result.materialsWithoutCost++
        continue
      }
      const id = Number(insertMaterial.run(m.name, m.unit, m.lowStock).lastInsertRowid)
      materialIds.set(m.name, id)
      result.materialsCreated++
      result.materialsWithoutCost++ // created at 0 — see the note above
    }

    // ---- 2. Link each dish to what it is made of ----
    for (const [itemName, lines] of Object.entries(CATALOG_RECIPES)) {
      const item = findItem.get(itemName) as { item_id: number } | undefined
      if (!item) {
        // The menu has not been imported, or this dish was renamed. Skipped rather
        // than created: inventing a menu item from a recipe would put a dish on the
        // POS with no price.
        result.itemsSkipped++
        result.missingItems.push(itemName)
        continue
      }

      const already = (countRecipe.get(item.item_id) as { c: number }).c
      if (already > 0 && !replace) {
        // Somebody has already described this dish — possibly more accurately than
        // the sheet does. Left alone.
        result.itemsAlreadyHadRecipe++
        continue
      }
      if (already > 0) clearRecipe.run(item.item_id)

      for (const [materialName, qty] of lines as RecipeLine[]) {
        const materialId = materialIds.get(materialName)
        if (!materialId) continue // cannot happen: every line names a catalogue material
        insertLine.run(item.item_id, materialId, qty)
      }
      result.itemsLinked++
    }
  })

  run()

  log.info(
    `[Recipes] Imported — ${result.materialsCreated} material(s) created, ` +
    `${result.materialsReused} reused, ${result.itemsLinked} dish(es) linked, ` +
    `${result.itemsAlreadyHadRecipe} left alone, ${result.itemsSkipped} not on the menu`
  )

  return result
}

/** What the confirmation dialog shows BEFORE anything is written. */
export function previewRecipeCatalog(): {
  materials: number
  recipes: number
  onMenu: number
  missing: string[]
  materialsNeedingCost: number
} {
  const db = getDb()
  const findItem = db.prepare('SELECT item_id FROM menu_items WHERE name = ?')
  const findMaterial = db.prepare('SELECT cost_per_unit FROM raw_materials WHERE name = ?')

  const missing: string[] = []
  let onMenu = 0
  for (const name of Object.keys(CATALOG_RECIPES)) {
    if (findItem.get(name)) onMenu++
    else missing.push(name)
  }

  let needingCost = 0
  for (const m of CATALOG_MATERIALS) {
    const row = findMaterial.get(m.name) as { cost_per_unit: number } | undefined
    if (!row || !row.cost_per_unit) needingCost++
  }

  return {
    materials: CATALOG_MATERIALS.length,
    recipes: Object.keys(CATALOG_RECIPES).length,
    onMenu,
    missing,
    materialsNeedingCost: needingCost,
  }
}
