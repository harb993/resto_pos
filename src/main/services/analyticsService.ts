import { getDb } from '../db/db'
import { listWorkShifts } from './workShiftService'
import type { TrendPoint, TopItem, MenuEngineeringItem, PeakHourCell, CategoryBreakdown } from '../../shared/types'

const ACTIVE_FILTER = "o.status='completed' AND o.deleted_at IS NULL"

/**
 * `orders.created_at` is written with datetime('now','localtime'), so every window
 * boundary must be built in local time too. Comparing a localtime column against a
 * bare datetime('now',...) — which SQLite evaluates in UTC — shifts the window by
 * the machine's UTC offset (3 hours in Egypt), which is how the summary cards and
 * the trend charts ended up disagreeing.
 */
function localCutoff(modifier: string): string {
  return `datetime('now','localtime',${modifier})`
}

export function getSummary(range: 'today' | 'week' | 'month' | 'shift') {
  const db = getDb()

  // The shift running now (or the last one), against the shift before it. A shift is
  // two moments rather than a date, so it is compared on timestamps.
  if (range === 'shift') {
    const [current, previous] = listWorkShifts(2)
    const sum = (s?: { from: string; to: string }) => s
      ? db.prepare(`
          SELECT COUNT(*) AS order_count, COALESCE(SUM(total_amount),0) AS revenue
          FROM orders o WHERE ${ACTIVE_FILTER} AND created_at >= ? AND created_at < ?
        `).get(s.from, s.to)
      : { order_count: 0, revenue: 0 }
    return { current: sum(current), previous: sum(previous), shift: current ?? null }
  }

  if (!['today', 'week', 'month'].includes(range)) {
    throw new Error(`Unknown analytics range: ${range}`)
  }
  const queries: Record<string, { current: string; previous: string }> = {
    today: {
      current: `SELECT COUNT(*) AS order_count, COALESCE(SUM(total_amount),0) AS revenue FROM orders o WHERE ${ACTIVE_FILTER} AND date(created_at)=date('now','localtime')`,
      previous: `SELECT COUNT(*) AS order_count, COALESCE(SUM(total_amount),0) AS revenue FROM orders o WHERE ${ACTIVE_FILTER} AND date(created_at)=date('now','localtime','-1 day')`,
    },
    /**
     * `'-6 days','weekday 1'` — go back six days, then forward to Monday — lands on
     * the Monday of the current week on EVERY day of the week.
     *
     * The obvious `'weekday 1','-7 days'` does not. SQLite's `weekday` modifier only
     * moves forward "if necessary", so on a Monday it stays put and the -7 then lands
     * on the PREVIOUS Monday: every Monday, "this week" silently included the whole of
     * last week as well, roughly doubling the figure, and "last week" showed the week
     * before that. The numbers looked fine for six days and lied on the seventh.
     */
    week: {
      current: `SELECT COUNT(*) AS order_count, COALESCE(SUM(total_amount),0) AS revenue FROM orders o WHERE ${ACTIVE_FILTER} AND date(created_at)>=date('now','localtime','-6 days','weekday 1')`,
      previous: `SELECT COUNT(*) AS order_count, COALESCE(SUM(total_amount),0) AS revenue FROM orders o WHERE ${ACTIVE_FILTER} AND date(created_at)>=date('now','localtime','-13 days','weekday 1') AND date(created_at)<date('now','localtime','-6 days','weekday 1')`,
    },
    month: {
      current: `SELECT COUNT(*) AS order_count, COALESCE(SUM(total_amount),0) AS revenue FROM orders o WHERE ${ACTIVE_FILTER} AND strftime('%Y-%m',created_at)=strftime('%Y-%m','now','localtime')`,
      previous: `SELECT COUNT(*) AS order_count, COALESCE(SUM(total_amount),0) AS revenue FROM orders o WHERE ${ACTIVE_FILTER} AND strftime('%Y-%m',created_at)=strftime('%Y-%m','now','localtime','-1 month')`,
    },
  }
  const q = queries[range]
  const current = db.prepare(q.current).get() as any
  const previous = db.prepare(q.previous).get() as any
  return { current, previous }
}

export function getTrend(groupBy: 'day' | 'week' | 'month'): TrendPoint[] {
  const db = getDb()
  const groupExpr = { day: "date(created_at)", week: "strftime('%Y-%W',created_at)", month: "strftime('%Y-%m',created_at)" }
  const rangeExpr = { day: "'-30 days'", week: "'-84 days'", month: "'-365 days'" }
  if (!(groupBy in groupExpr)) throw new Error(`Unknown trend grouping: ${groupBy}`)

  return db.prepare(`
    SELECT ${groupExpr[groupBy]} AS date, SUM(total_amount) AS revenue, COUNT(*) AS orderCount
    FROM orders o WHERE ${ACTIVE_FILTER} AND created_at >= ${localCutoff(rangeExpr[groupBy])}
    GROUP BY date ORDER BY date
  `).all() as TrendPoint[]
}

export function getTopItems(limit = 10, order: 'DESC' | 'ASC' = 'DESC'): TopItem[] {
  // `order` arrives from the renderer and lands in an ORDER BY, where it cannot be
  // bound as a parameter — so map it through a whitelist instead of interpolating it.
  const direction = String(order).toUpperCase() === 'ASC' ? 'ASC' : 'DESC'
  const safeLimit = Number.isInteger(limit) && limit > 0 && limit <= 500 ? limit : 10

  return getDb().prepare(`
    SELECT mi.name, SUM(oi.quantity) AS unitsSold, SUM(oi.quantity*oi.unit_price) AS revenue
    FROM order_items oi JOIN menu_items mi ON mi.item_id=oi.menu_item_id
    JOIN orders o ON o.order_id=oi.order_id
    WHERE ${ACTIVE_FILTER} AND o.created_at>=${localCutoff("'-30 days'")}
    GROUP BY mi.item_id ORDER BY unitsSold ${direction} LIMIT ?
  `).all(safeLimit) as TopItem[]
}

export function getMenuEngineering(): MenuEngineeringItem[] {
  const rows = getDb().prepare(`
    SELECT mi.name, SUM(oi.quantity) AS unitsSold,
      ROUND(AVG(oi.unit_price-oi.unit_cost),2) AS avgMargin,
      ROUND(100.0*AVG(oi.unit_price-oi.unit_cost)/NULLIF(AVG(oi.unit_price),0),1) AS marginPct
    FROM order_items oi JOIN menu_items mi ON mi.item_id=oi.menu_item_id
    JOIN orders o ON o.order_id=oi.order_id
    WHERE ${ACTIVE_FILTER} AND o.created_at>=${localCutoff("'-30 days'")}
    GROUP BY mi.item_id
  `).all() as MenuEngineeringItem[]

  if (rows.length === 0) return []

  // A giveaway item (price 0) yields marginPct = NULL from the NULLIF above.
  // JS coerces null to 0 in arithmetic, so including those rows would silently drag
  // the classification threshold down for the whole menu. Average over real margins
  // only, and leave the zero-priced rows unclassified rather than mislabelling them.
  const priced = rows.filter(r => r.marginPct !== null && Number.isFinite(r.marginPct))

  const avgSales = rows.reduce((s, r) => s + r.unitsSold, 0) / rows.length
  const avgMargin = priced.length > 0
    ? priced.reduce((s, r) => s + r.marginPct, 0) / priced.length
    : 0

  return rows.map(r => {
    if (r.marginPct === null || !Number.isFinite(r.marginPct)) {
      return { ...r, quadrant: 'unclassified' as const }
    }
    return {
      ...r,
      quadrant: r.unitsSold >= avgSales
        ? (r.marginPct >= avgMargin ? 'star' : 'plowhorse')
        : (r.marginPct >= avgMargin ? 'puzzle' : 'dog'),
    }
  })
}

export function getPeakHours(): PeakHourCell[] {
  return getDb().prepare(`
    SELECT CAST(strftime('%w',created_at) AS INTEGER) AS dayOfWeek,
      CAST(strftime('%H',created_at) AS INTEGER) AS hourOfDay,
      COUNT(*) AS orderCount, SUM(total_amount) AS revenue
    FROM orders o WHERE ${ACTIVE_FILTER} AND created_at>=${localCutoff("'-30 days'")}
    GROUP BY dayOfWeek, hourOfDay
  `).all() as PeakHourCell[]
}

export function getCategoryBreakdown(): CategoryBreakdown[] {
  return getDb().prepare(`
    SELECT c.name, SUM(oi.quantity*oi.unit_price) AS revenue
    FROM order_items oi JOIN menu_items mi ON mi.item_id=oi.menu_item_id
    JOIN categories c ON c.category_id=mi.category_id
    JOIN orders o ON o.order_id=oi.order_id
    WHERE ${ACTIVE_FILTER} AND o.created_at>=${localCutoff("'-30 days'")}
    GROUP BY c.category_id
  `).all() as CategoryBreakdown[]
}

export function getAverageOrderValue(): { date: string; avgOrderValue: number }[] {
  return getDb().prepare(`
    SELECT date(created_at) AS date, AVG(total_amount) AS avgOrderValue
    FROM orders o WHERE ${ACTIVE_FILTER} AND created_at>=${localCutoff("'-30 days'")}
    GROUP BY date ORDER BY date
  `).all() as any[]
}
