import { getDb } from '../db/db'
import { getSettings } from './settingsService'
import type { SalesProductsReport } from '../../shared/types'

/**
 * «Sales Products» — everything the shop sold in a period, grouped by section.
 *
 * The finance screen answers "did we make money". This answers a different question,
 * the one asked at the end of a week with a supplier on the phone: HOW MANY. How many
 * 4-piece meals, how many colas, how many breads did that take.
 *
 * Deliberately not the same list as `topItemsByProfit`: that one is ranked by profit
 * and cut at twelve, which is the wrong shape entirely for counting. Here nothing is
 * left out and the order is the menu's own — section by section, the way the person
 * reading it thinks about the kitchen.
 *
 * Two halves:
 *
 *   المنتجات   what was sold, by section, with a total per section and one for the day
 *   الخامات    what those sales took out of the store, which is the re-ordering list
 */

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

function round3(n: number): number {
  return Math.round((n + Number.EPSILON) * 1000) / 1000
}

const LIVE_ORDERS = `o.status = 'completed' AND o.deleted_at IS NULL`

export function getSalesProductsReport(start: string, end: string): SalesProductsReport {
  const db = getDb()
  const settings = getSettings()

  const rows = db.prepare(`
    SELECT
      COALESCE(c.name, 'بدون قسم')                  AS category,
      COALESCE(c.display_order, 9999)               AS category_order,
      mi.name                                       AS name,
      SUM(oi.quantity)                              AS qty,
      COALESCE(SUM(oi.quantity * oi.unit_price), 0) AS total,
      COALESCE(SUM(oi.quantity * oi.unit_cost), 0)  AS cost
    FROM order_items oi
    JOIN orders o      ON o.order_id = oi.order_id
    JOIN menu_items mi ON mi.item_id = oi.menu_item_id
    LEFT JOIN categories c ON c.category_id = mi.category_id
    WHERE ${LIVE_ORDERS} AND date(o.created_at) BETWEEN ? AND ?
    GROUP BY mi.item_id
    ORDER BY category_order, c.name, mi.name
  `).all(start, end) as any[]

  // Grouped in one pass. Insertion order follows the ORDER BY above, so the sections
  // come out in the same sequence they appear on the POS.
  const groups = new Map<string, SalesProductsReport['groups'][number]>()
  for (const r of rows) {
    let g = groups.get(r.category)
    if (!g) {
      g = { category: r.category, quantity: 0, total: 0, items: [] }
      groups.set(r.category, g)
    }
    g.items.push({
      name: r.name,
      quantity: r.qty,
      unit: 'each',
      total: round2(r.total),
      cost: round2(r.cost),
    })
    g.quantity += r.qty
    g.total = round2(g.total + r.total)
  }

  // What those sales consumed. 'void' rows are positive — stock handed back when an
  // invoice was cancelled — so summing both reasons nets a cancelled sale back out.
  const materials = db.prepare(`
    SELECT rm.name, rm.unit,
      COALESCE(SUM(-t.change_amount), 0)                    AS quantity,
      COALESCE(SUM(-t.change_amount) * rm.cost_per_unit, 0) AS cost
    FROM raw_material_transactions t
    JOIN raw_materials rm ON rm.raw_material_id = t.raw_material_id
    WHERE t.reason IN ('sale', 'void') AND date(t.created_at) BETWEEN ? AND ?
    GROUP BY rm.raw_material_id
    HAVING quantity > 0
    ORDER BY quantity DESC, rm.name
  `).all(start, end) as any[]

  const orderCount = (db.prepare(`
    SELECT COUNT(*) AS c FROM orders o
    WHERE ${LIVE_ORDERS} AND date(o.created_at) BETWEEN ? AND ?
  `).get(start, end) as any).c

  const list = [...groups.values()]

  return {
    period: { start, end },
    storeName: settings.business_name || 'المطعم',
    currency: settings.currency_symbol || 'ج.م',
    orderCount,
    totalQuantity: list.reduce((t, g) => t + g.quantity, 0),
    grandTotal: round2(list.reduce((t, g) => t + g.total, 0)),
    groups: list,
    materials: materials.map(m => ({
      name: m.name,
      unit: m.unit,
      quantity: round3(m.quantity),
      cost: round2(m.cost),
    })),
  }
}
