import type Database from 'better-sqlite3'
import log from 'electron-log/main'
import { STARTER_MENU, PLACEHOLDER_MENU, CASHIER_ONLY } from './starterShop'

/**
 * Bring a till that opened with the made-up starter menu onto the shop's real one.
 *
 * The first أبو الدهب builds seeded an invented menu, because the real one did not
 * exist yet. A till that has already been installed carries that menu in its own
 * database, so shipping the real menu as the starter would change nothing there: the
 * starter only ever seeds an EMPTY menu. This runs once on every till, and:
 *
 *   1. takes out each invented dish that is still exactly as it was shipped — same
 *      section, name and price, no cost, recipe or questions of its own — provided it
 *      has never been sold. One that HAS been sold is switched off instead: deleting it
 *      would take the sale out of the books.
 *   2. removes the invented sections that are left empty;
 *   3. adds every section and dish of the real menu that is not already there, by
 *      name, sending each new section to its kitchen printer.
 *
 * Anything the owner made or changed is left exactly as it is — an edited invented
 * dish, a dish of their own, a price they set on a real dish they typed in themselves.
 * On a database that started from the real menu (every new till) it finds nothing to
 * do and only records that it has run.
 */

export const MENU_UPGRADE_KEY = 'menu_upgraded_to_shop_menu'

export interface MenuUpgradeResult {
  ran: boolean
  /** Invented dishes taken out. */
  removed: number
  /** Invented dishes that had been sold, switched off rather than deleted. */
  retired: number
  categoriesRemoved: number
  categoriesAdded: number
  itemsAdded: number
}

export function upgradeToShopMenu(db: Database.Database): MenuUpgradeResult {
  const result: MenuUpgradeResult = {
    ran: false, removed: 0, retired: 0, categoriesRemoved: 0, categoriesAdded: 0, itemsAdded: 0,
  }

  const done = db.prepare('SELECT value FROM settings WHERE key = ?').get(MENU_UPGRADE_KEY) as
    | { value: string }
    | undefined
  if (done?.value === '1') return result

  const realNames = new Set(STARTER_MENU.map(c => c.name))

  const placeholderRows = db.prepare(`
    SELECT mi.item_id, mi.price, mi.cost_price, mi.description
    FROM menu_items mi JOIN categories c ON c.category_id = mi.category_id
    WHERE c.name = ? AND mi.name = ?
  `)
  const count = (sql: string) => db.prepare(sql)
  const hasRecipe = count('SELECT 1 FROM recipe_items WHERE menu_item_id = ?')
  const hasOwnQuestions = count('SELECT 1 FROM item_variant_groups WHERE menu_item_id = ?')
  const hasConversion = count(
    'SELECT 1 FROM stock_conversions WHERE source_inventory_id = ? OR output_inventory_id = ?'
  )
  const wasSold = count('SELECT 1 FROM order_items WHERE menu_item_id = ?')
  const hasStockHistory = count('SELECT 1 FROM stock_transactions WHERE menu_item_id = ?')
  const retire = db.prepare(
    `UPDATE menu_items SET is_active = 0, updated_at = datetime('now','localtime') WHERE item_id = ?`
  )
  const remove = db.prepare('DELETE FROM menu_items WHERE item_id = ?')

  const categoryNamed = db.prepare('SELECT category_id FROM categories WHERE name = ?')
  const itemsIn = db.prepare('SELECT COUNT(*) AS n FROM menu_items WHERE category_id = ?')
  const questionsOn = db.prepare('SELECT COUNT(*) AS n FROM item_variant_groups WHERE category_id = ?')
  const dropCategory = db.prepare('DELETE FROM categories WHERE category_id = ?')

  const printerNamed = db.prepare('SELECT printer_id FROM printers WHERE name = ?')
  const insertCategory = db.prepare(
    'INSERT INTO categories (name, display_order, printer_id) VALUES (?, ?, ?)'
  )
  const itemNamed = db.prepare(
    'SELECT item_id, description FROM menu_items WHERE category_id = ? AND name = ?'
  )
  const describe = db.prepare('UPDATE menu_items SET description = ? WHERE item_id = ?')
  const insertItem = db.prepare(`
    INSERT INTO menu_items (category_id, name, price, cost_price, description, stock_quantity, is_active, display_order)
    VALUES (?, ?, ?, 0, ?, 0, 1, ?)
  `)

  db.transaction(() => {
    // ---- 1. The invented dishes nobody has touched ----
    for (const cat of PLACEHOLDER_MENU) {
      for (const item of cat.items) {
        const rows = placeholderRows.all(cat.name, item.name) as {
          item_id: number; price: number; cost_price: number; description: string | null
        }[]
        for (const row of rows) {
          const untouched =
            row.price === item.price &&
            !(row.cost_price > 0) &&
            (row.description ?? '') === (item.description ?? '') &&
            !hasRecipe.get(row.item_id) &&
            !hasOwnQuestions.get(row.item_id) &&
            !hasConversion.get(row.item_id, row.item_id)
          if (!untouched) continue

          if (wasSold.get(row.item_id) || hasStockHistory.get(row.item_id)) {
            retire.run(row.item_id)
            result.retired++
          } else {
            remove.run(row.item_id)
            result.removed++
          }
        }
      }
    }

    // ---- 2. The invented sections that are now empty ----
    for (const cat of PLACEHOLDER_MENU) {
      if (realNames.has(cat.name)) continue // the real menu has a section by this name
      const row = categoryNamed.get(cat.name) as { category_id: number } | undefined
      if (!row) continue
      const items = (itemsIn.get(row.category_id) as { n: number }).n
      const questions = (questionsOn.get(row.category_id) as { n: number }).n
      if (items > 0 || questions > 0) continue
      forgetCategoryOnPrinters(db, row.category_id)
      dropCategory.run(row.category_id)
      result.categoriesRemoved++
    }

    // ---- 3. The real menu, wherever it is missing ----
    STARTER_MENU.forEach((cat, c) => {
      let row = categoryNamed.get(cat.name) as { category_id: number } | undefined
      if (!row) {
        // A kitchen the owner has renamed leaves the section automatic rather than
        // pointing at nothing; they choose it on the categories screen.
        const printerId = cat.printer === CASHIER_ONLY
          ? 0
          : ((printerNamed.get(cat.printer) as { printer_id: number } | undefined)?.printer_id ?? null)
        const id = insertCategory.run(cat.name, c + 1, printerId).lastInsertRowid as number
        row = { category_id: id }
        result.categoriesAdded++
      }

      cat.items.forEach((item, i) => {
        const existing = itemNamed.get(row!.category_id, item.name) as
          | { item_id: number; description: string | null }
          | undefined
        if (existing) {
          // Theirs — price and all. Only a missing «what it comes with» is filled in.
          if (!existing.description && item.description) describe.run(item.description, existing.item_id)
          return
        }
        insertItem.run(row!.category_id, item.name, item.price, item.description ?? null, i + 1)
        result.itemsAdded++
      })
    })

    // The real sections in the order the menu prints them, then anything else the
    // shop has, in the order it already had. Only when this changed the menu — an
    // arrangement the owner made on a till already on the real menu is theirs.
    if (result.categoriesAdded > 0 || result.categoriesRemoved > 0) {
      const all = db.prepare('SELECT category_id, name FROM categories ORDER BY display_order, name')
        .all() as { category_id: number; name: string }[]
      const ordered = [
        ...STARTER_MENU.map(c => all.find(a => a.name === c.name)).filter(Boolean),
        ...all.filter(a => !realNames.has(a.name)),
      ] as { category_id: number }[]
      const place = db.prepare('UPDATE categories SET display_order = ? WHERE category_id = ?')
      ordered.forEach((cat, i) => place.run(i + 1, cat.category_id))
    }

    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(MENU_UPGRADE_KEY, '1')
  })()

  result.ran = true
  if (result.removed || result.retired || result.categoriesAdded || result.itemsAdded) {
    log.info(
      `[Menu] Moved onto the shop's menu: ${result.removed} invented dish(es) removed, ` +
      `${result.retired} switched off (already sold), ${result.categoriesRemoved} empty section(s) removed, ` +
      `${result.categoriesAdded} section(s) and ${result.itemsAdded} dish(es) added`,
    )
  }
  return result
}

/** The same clean-up deleting a category does: a printer must not filter on a dead id. */
function forgetCategoryOnPrinters(db: Database.Database, categoryId: number): void {
  const rows = db.prepare(
    "SELECT printer_id, category_ids FROM printers WHERE category_ids IS NOT NULL AND category_ids != ''"
  ).all() as { printer_id: number; category_ids: string }[]
  const update = db.prepare('UPDATE printers SET category_ids = ? WHERE printer_id = ?')
  for (const row of rows) {
    try {
      const ids = JSON.parse(row.category_ids)
      if (!Array.isArray(ids)) continue
      const kept = ids.map(Number).filter(id => Number.isFinite(id) && id !== categoryId)
      if (kept.length !== ids.length) update.run(kept.length ? JSON.stringify(kept) : null, row.printer_id)
    } catch { /* a malformed list already means "everything" */ }
  }
}
