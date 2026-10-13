import { getDb } from '../db/db'
import log from 'electron-log/main'
import type { DeletableKind, DeleteImpact, DeleteResult } from '../../shared/types'

/**
 * Deleting things that other records point at.
 *
 * Two rules decide what happens, and the owner is shown which one applies BEFORE
 * anything is touched:
 *
 *   Nothing depends on it   →  delete it for real. Recipe lines and stock go with it,
 *                              which genuinely returns things to how they were before
 *                              the thing was ever created.
 *
 *   Past invoices use it    →  deactivate instead. Hidden from the POS and every
 *                              picker, while old invoices keep the cost captured on
 *                              them and past profit figures stay true.
 *
 * `force` overrides the second rule and erases it anyway. That is gated on the owner
 * password at the IPC layer, because it rewrites history: line items lose the item
 * they referred to and previously-reported profit changes.
 */

const KINDS: DeletableKind[] = ['category', 'menuItem', 'rawMaterial']

export function getDeleteImpact(kind: DeletableKind, id: number): DeleteImpact {
  const db = getDb()
  if (!KINDS.includes(kind)) throw new Error(`نوع غير معروف: ${kind}`)

  const blockers: string[] = []   // history — cannot delete cleanly
  const cascades: string[] = []   // will be removed along with it

  if (kind === 'category') {
    const row = db.prepare('SELECT name FROM categories WHERE category_id = ?').get(id) as any
    if (!row) throw new Error('القسم غير موجود')

    const items = db.prepare(
      'SELECT COUNT(*) AS c FROM menu_items WHERE category_id = ?'
    ).get(id) as { c: number }

    // Questions set on the category itself — "عادي / حار", "صغير / وسط / كبير".
    // They point AT the category, so they have to go with it; leaving them behind is
    // what used to make an otherwise clean delete fail on a foreign key.
    const groups = db.prepare(
      'SELECT COUNT(*) AS c FROM item_variant_groups WHERE category_id = ?'
    ).get(id) as { c: number }

    // A category is only ever blocked by its items' own history.
    const sold = db.prepare(`
      SELECT COUNT(DISTINCT oi.menu_item_id) AS c
      FROM order_items oi JOIN menu_items mi ON mi.item_id = oi.menu_item_id
      WHERE mi.category_id = ?
    `).get(id) as { c: number }

    if (items.c > 0) cascades.push(`${items.c} صنف داخل القسم`)
    if (groups.c > 0) cascades.push(`${groups.c} مجموعة اختيارات على القسم`)
    if (sold.c > 0) blockers.push(`${sold.c} صنف تم بيعه في فواتير سابقة`)

    return {
      kind, id, name: row.name,
      canHardDelete: blockers.length === 0,
      blockers, cascades,
      recommendation: blockers.length === 0 ? 'delete' : 'deactivate',
      // Categories have no is_active column, so there is nothing to deactivate.
      supportsDeactivate: false,
    }
  }

  if (kind === 'menuItem') {
    const row = db.prepare('SELECT name FROM menu_items WHERE item_id = ?').get(id) as any
    if (!row) throw new Error('الصنف غير موجود')

    const sold = db.prepare(
      'SELECT COUNT(*) AS c FROM order_items WHERE menu_item_id = ?'
    ).get(id) as { c: number }
    const recipe = db.prepare(
      'SELECT COUNT(*) AS c FROM recipe_items WHERE menu_item_id = ?'
    ).get(id) as { c: number }
    const stockTxns = db.prepare(
      'SELECT COUNT(*) AS c FROM stock_transactions WHERE menu_item_id = ?'
    ).get(id) as { c: number }

    if (recipe.c > 0) cascades.push(`${recipe.c} مكوّن في وصفة الصنف`)
    if (sold.c > 0) blockers.push(`${sold.c} سطر في فواتير سابقة`)
    if (stockTxns.c > 0) blockers.push(`${stockTxns.c} حركة مخزون قديمة`)

    return {
      kind, id, name: row.name,
      canHardDelete: blockers.length === 0,
      blockers, cascades,
      recommendation: blockers.length === 0 ? 'delete' : 'deactivate',
      supportsDeactivate: true,
    }
  }

  // rawMaterial
  const row = db.prepare('SELECT name FROM raw_materials WHERE raw_material_id = ?').get(id) as any
  if (!row) throw new Error('المادة الخام غير موجودة')

  const usedIn = db.prepare(
    'SELECT COUNT(*) AS c FROM recipe_items WHERE raw_material_id = ?'
  ).get(id) as { c: number }
  const preps = db.prepare(`
    SELECT COUNT(*) AS c FROM prep_conversions
    WHERE source_material_id = ? OR output_material_id = ?
  `).get(id, id) as { c: number }
  // Movements tied to a real invoice are history; opening stock and manual
  // adjustments are not, so they never block a delete.
  const invoiceMoves = db.prepare(`
    SELECT COUNT(*) AS c FROM raw_material_transactions
    WHERE raw_material_id = ? AND related_order_id IS NOT NULL
  `).get(id) as { c: number }

  if (usedIn.c > 0) cascades.push(`${usedIn.c} صنف يستخدم هذه المادة في مكوناته`)
  if (preps.c > 0) cascades.push(`${preps.c} عملية تجهيز مرتبطة بها`)
  if (invoiceMoves.c > 0) blockers.push(`${invoiceMoves.c} حركة مخزون على فواتير سابقة`)

  return {
    kind, id, name: row.name,
    canHardDelete: blockers.length === 0,
    blockers, cascades,
    recommendation: blockers.length === 0 ? 'delete' : 'deactivate',
    supportsDeactivate: true,
  }
}

export function deleteEntity(
  kind: DeletableKind,
  id: number,
  opts: { force?: boolean } = {}
): DeleteResult {
  const db = getDb()
  const impact = getDeleteImpact(kind, id)

  // Blocked and not forced → hide it instead, and say so.
  if (!impact.canHardDelete && !opts.force) {
    if (!impact.supportsDeactivate) {
      throw new Error(
        `لا يمكن حذف "${impact.name}" — ${impact.blockers.join('، ')}. ` +
        `احذف أو انقل الأصناف المرتبطة أولاً.`
      )
    }
    const table = kind === 'menuItem' ? 'menu_items' : 'raw_materials'
    const key = kind === 'menuItem' ? 'item_id' : 'raw_material_id'
    db.prepare(`UPDATE ${table} SET is_active = 0 WHERE ${key} = ?`).run(id)
    log.info(`[Delete] Deactivated ${kind} #${id} (${impact.name}) — has history`)
    return {
      action: 'deactivated',
      name: impact.name,
      message: `تم إيقاف "${impact.name}" بدلاً من حذفه للحفاظ على صحة الفواتير والتقارير السابقة.`,
    }
  }

  const run = db.transaction((): DeleteResult => {
    if (kind === 'category') {
      // Take the items with it — each one cleaned up the same way.
      const items = db.prepare('SELECT item_id FROM menu_items WHERE category_id = ?')
        .all(id) as { item_id: number }[]
      for (const it of items) hardDeleteMenuItem(it.item_id)
      // The category's OWN variant groups. These are the rows that made a delete fail
      // with a bare "FOREIGN KEY constraint failed": item_variant_groups.category_id
      // points at the row being removed, and nothing above deletes them.
      db.prepare(
        'DELETE FROM item_variant_options WHERE variant_group_id IN ' +
        '(SELECT variant_group_id FROM item_variant_groups WHERE category_id = ?)'
      ).run(id)
      db.prepare('DELETE FROM item_variant_groups WHERE category_id = ?').run(id)
      // A kitchen printer routed to this category would keep a dangling id in its JSON
      // list, which silently narrows it to nothing. Drop the id from every printer.
      forgetCategoryOnPrinters(id)
      db.prepare('DELETE FROM categories WHERE category_id = ?').run(id)
      log.warn(`[Delete] Category #${id} (${impact.name}) permanently deleted with ${items.length} item(s)`)
      return {
        action: 'deleted', name: impact.name,
        message: `تم حذف القسم "${impact.name}"${items.length ? ` و${items.length} صنف بداخله` : ''} نهائياً.`,
      }
    }

    if (kind === 'menuItem') {
      hardDeleteMenuItem(id)
      log.warn(`[Delete] Menu item #${id} (${impact.name}) permanently deleted`)
      return {
        action: 'deleted', name: impact.name,
        message: `تم حذف الصنف "${impact.name}" نهائياً.`,
      }
    }

    // rawMaterial — remove what points at it, then the material and its movements.
    db.prepare('DELETE FROM recipe_items WHERE raw_material_id = ?').run(id)
    db.prepare('DELETE FROM prep_conversions WHERE source_material_id = ? OR output_material_id = ?')
      .run(id, id)
    db.prepare('DELETE FROM raw_material_transactions WHERE raw_material_id = ?').run(id)
    db.prepare('DELETE FROM raw_materials WHERE raw_material_id = ?').run(id)
    log.warn(`[Delete] Raw material #${id} (${impact.name}) permanently deleted`)
    return {
      action: 'deleted', name: impact.name,
      message: `تم حذف المادة الخام "${impact.name}" نهائياً مع كل حركاتها.`,
    }
  })

  return run()
}

/**
 * Remove a menu item and everything that only exists because of it.
 * Order lines are left alone — they carry the price and cost captured at sale time,
 * which is what keeps old invoices readable.
 */
function hardDeleteMenuItem(itemId: number): void {
  const db = getDb()
  db.prepare('DELETE FROM recipe_items WHERE menu_item_id = ?').run(itemId)
  db.prepare('DELETE FROM item_variant_options WHERE variant_group_id IN ' +
             '(SELECT variant_group_id FROM item_variant_groups WHERE menu_item_id = ?)').run(itemId)
  db.prepare('DELETE FROM item_variant_groups WHERE menu_item_id = ?').run(itemId)
  db.prepare('DELETE FROM stock_transactions WHERE menu_item_id = ?').run(itemId)
  // The old meal-stock yield table still points at menu items on any database that
  // ever had one. Left behind it fails the delete on a foreign key, exactly as the
  // category's variant groups did.
  db.prepare(
    'DELETE FROM stock_conversions WHERE source_inventory_id = ? OR output_inventory_id = ?'
  ).run(itemId, itemId)
  db.prepare('DELETE FROM order_items WHERE menu_item_id = ?').run(itemId)
  db.prepare('DELETE FROM menu_items WHERE item_id = ?').run(itemId)
}

/**
 * Remove a category id from every kitchen printer's routing list.
 *
 * `printers.category_ids` is a JSON array, not a foreign key, so nothing stops it
 * naming a category that no longer exists — and a station left pointing at a deleted
 * category prints nothing at all while looking correctly configured.
 */
export function forgetCategoryOnPrinters(categoryId: number): void {
  const db = getDb()
  const rows = db.prepare(
    "SELECT printer_id, category_ids FROM printers WHERE category_ids IS NOT NULL AND category_ids != ''"
  ).all() as { printer_id: number; category_ids: string }[]

  const update = db.prepare('UPDATE printers SET category_ids = ? WHERE printer_id = ?')
  for (const row of rows) {
    let ids: number[]
    try {
      const parsed = JSON.parse(row.category_ids)
      if (!Array.isArray(parsed)) continue
      ids = parsed.map(Number).filter(Number.isFinite)
    } catch {
      continue // not something we wrote — leave it alone
    }
    if (!ids.includes(categoryId)) continue
    const left = ids.filter(i => i !== categoryId)
    update.run(left.length ? JSON.stringify(left) : null, row.printer_id)
    if (left.length === 0) {
      // Both NULL and an empty list read as "everything" to the print router, so a
      // station that was routed to this category alone now prints every ticket. Said
      // out loud, because it is a change to what comes out of a printer.
      log.warn(
        `[Delete] Printer #${row.printer_id} was routed only to the deleted category — ` +
        `it now prints every ticket until it is re-routed`
      )
    }
  }
}
