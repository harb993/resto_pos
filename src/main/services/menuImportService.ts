import { getDb } from '../db/db'
import log from 'electron-log/main'
import { MENU_CATALOG, type CatalogCategory } from './menuCatalog'
import type { MenuImportResult } from '../../shared/types'

/**
 * Load the costed menu from «ملخص الريسبى» into the database.
 *
 * Written to be run more than once without doing damage. Matching is by name within a
 * category, so a second run finds what the first one created rather than building a
 * duplicate menu beside it — which is what makes this safe to press again after the
 * owner has added a dish of their own, and safe to press again after a price change.
 *
 * `replacePrices` decides what happens to a dish that is already there:
 *
 *   off (default)  left exactly as it is. The owner has been running this menu and
 *                  may have adjusted a price at the till; the sheet does not get to
 *                  overwrite that behind their back.
 *   on             price, cost and components are brought back in line with the
 *                  sheet. This is the "the sheet has been re-costed, apply it" case.
 *
 * Nothing is ever deleted. A dish the restaurant has stopped selling is deactivated
 * from the menu screen, not removed by an import — and an import that could delete
 * would take the sales history of every removed dish with it.
 */
export function importMenuCatalog(
  opts: { replacePrices?: boolean } = {},
): MenuImportResult {
  const db = getDb()
  const replace = opts.replacePrices === true

  const result: MenuImportResult = {
    categoriesCreated: 0,
    itemsCreated: 0,
    itemsUpdated: 0,
    itemsUnchanged: 0,
    itemsWithoutCost: 0,
    categories: [],
  }

  const findCategory = db.prepare('SELECT category_id FROM categories WHERE name = ?')
  const insertCategory = db.prepare('INSERT INTO categories (name, display_order) VALUES (?, ?)')
  const nextOrder = db.prepare('SELECT COALESCE(MAX(display_order), 0) AS n FROM categories')

  const findItem = db.prepare(
    'SELECT item_id, price, cost_price, description FROM menu_items WHERE name = ? AND category_id = ?'
  )
  // An item of the same name sitting in ANOTHER category is the same dish that has
  // been filed differently, not a second dish. Moving it is better than creating a
  // twin that splits its sales figures in two.
  const findItemAnywhere = db.prepare('SELECT item_id, category_id FROM menu_items WHERE name = ?')

  /*
    The sheet's costed figure goes into BOTH columns, and they then diverge.

    `cost_price` is the working number — the owner may edit it, and once the store is
    priced up the recipe takes over. `baseline_cost` is the plan the shelf price was
    set against and never moves again, so «are we still making what we thought we
    would?» has something to be measured against.
  */
  const insertItem = db.prepare(`
    INSERT INTO menu_items (category_id, name, price, cost_price, baseline_cost, description, is_active, stock_quantity)
    VALUES (?, ?, ?, ?, ?, ?, 1, 0)
  `)
  const updateItem = db.prepare(`
    UPDATE menu_items
    SET category_id = ?, price = ?, cost_price = ?, baseline_cost = ?, description = ?,
        updated_at = datetime('now','localtime')
    WHERE item_id = ?
  `)

  const run = db.transaction(() => {
    let order = (nextOrder.get() as { n: number }).n

    for (const cat of MENU_CATALOG) {
      const existing = findCategory.get(cat.name) as { category_id: number } | undefined
      let categoryId: number
      if (existing) {
        categoryId = existing.category_id
      } else {
        categoryId = Number(insertCategory.run(cat.name, ++order).lastInsertRowid)
        result.categoriesCreated++
      }

      const summary = { name: cat.name, created: 0, updated: 0, unchanged: 0 }

      for (const item of cat.items) {
        if (item.cost <= 0) result.itemsWithoutCost++

        const here = findItem.get(item.name, categoryId) as
          | { item_id: number; price: number; cost_price: number; description: string | null }
          | undefined
        const elsewhere = here
          ? undefined
          : findItemAnywhere.get(item.name) as { item_id: number; category_id: number } | undefined

        const found = here ?? elsewhere
        if (!found) {
          insertItem.run(categoryId, item.name, item.price, item.cost, item.cost, item.description ?? null)
          result.itemsCreated++
          summary.created++
          continue
        }

        // Filed in the wrong category is worth fixing whatever `replacePrices` says —
        // it is where the dish lives, not what it charges.
        const misfiled = !here && elsewhere && elsewhere.category_id !== categoryId
        if (!replace && !misfiled) {
          result.itemsUnchanged++
          summary.unchanged++
          continue
        }

        const keep = here
        updateItem.run(
          categoryId,
          replace || !keep ? item.price : keep.price,
          replace || !keep ? item.cost : keep.cost_price,
          // The baseline always follows the SHEET, even when the owner's own price is
          // being kept: it is what the sheet costed this dish at, not what anyone has
          // since typed over it.
          item.cost,
          replace || !keep ? (item.description ?? null) : keep.description,
          found.item_id,
        )
        result.itemsUpdated++
        summary.updated++
      }

      result.categories.push(summary)
    }
  })

  run()

  log.info(
    `[Menu] Catalogue import: +${result.categoriesCreated} category(ies), ` +
    `+${result.itemsCreated} item(s), ${result.itemsUpdated} updated, ` +
    `${result.itemsUnchanged} left alone`
  )
  return result
}

/** Settings key recording that the one-off cost repair below has already run. */
const COSTS_RESTORED_KEY = 'catalog_costs_restored'

/**
 * Put the sheet's costs back on dishes that have lost them.
 *
 * This restaurant's menu came in from «ملخص الريسبى» fully costed, and then every one
 * of the 61 dishes was reading 0. The cause was recipes: 318 ingredient lines were
 * attached to 32 raw materials that had no prices entered, the recipe cost summed to
 * zero, and that zero was written over the sheet's figure as though the food were
 * free. `baseline_cost` was seeded from `cost_price` afterwards, so it inherited the
 * zeroes and the costing tab had nothing to compare.
 *
 * The leak is stopped in recipeService — an unpriced recipe is now skipped rather than
 * costed at nothing — but that does not bring back what was already overwritten. This
 * does, from the catalogue, which IS the sheet.
 *
 * Only ever fills in a MISSING figure. A dish that carries a cost keeps it, whether it
 * came from the sheet, the owner, or a properly priced recipe — this cannot overwrite
 * anybody's number. It runs once; after that a deliberate zero stays zero.
 */
export function restoreCatalogCosts(): { costs: number; baselines: number } {
  const db = getDb()

  const find = db.prepare('SELECT item_id, cost_price, baseline_cost FROM menu_items WHERE name = ?')
  const setCost = db.prepare(
    `UPDATE menu_items SET cost_price = ?, updated_at = datetime('now','localtime') WHERE item_id = ?`
  )
  const setBaseline = db.prepare('UPDATE menu_items SET baseline_cost = ? WHERE item_id = ?')

  let costs = 0
  let baselines = 0

  db.transaction(() => {
    for (const cat of MENU_CATALOG) {
      for (const item of cat.items) {
        if (item.cost <= 0) continue // the add-ons sheet prices but does not cost

        const row = find.get(item.name) as
          | { item_id: number; cost_price: number; baseline_cost: number }
          | undefined
        if (!row) continue // renamed or never imported — not ours to guess at

        if (!(row.cost_price > 0)) { setCost.run(item.cost, row.item_id); costs++ }
        if (!(row.baseline_cost > 0)) { setBaseline.run(item.cost, row.item_id); baselines++ }
      }
    }
  })()

  if (costs > 0 || baselines > 0) {
    log.info(`[Menu] Restored ${costs} cost(s) and ${baselines} baseline(s) from the recipe sheet`)
  }
  return { costs, baselines }
}

/** The repair above, once per database. Safe to call on every launch. */
export function restoreCatalogCostsOnce(): void {
  const db = getDb()
  const done = db.prepare('SELECT value FROM settings WHERE key = ?').get(COSTS_RESTORED_KEY) as
    | { value: string }
    | undefined
  if (done?.value === '1') return

  try {
    restoreCatalogCosts()
  } catch (err) {
    log.error('[Menu] Could not restore catalogue costs:', err)
    return // leave the marker unset so the next launch tries again
  }
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(COSTS_RESTORED_KEY, '1')
}

/** What the catalogue holds, without touching the database — for the confirm dialog. */
export function describeMenuCatalog(): { name: string; items: number }[] {
  return MENU_CATALOG.map((c: CatalogCategory) => ({ name: c.name, items: c.items.length }))
}
