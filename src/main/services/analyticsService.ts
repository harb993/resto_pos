import { getDb } from '../db/db'
import type { TrendPoint, TopItem, MenuEngineeringItem, PeakHourCell, CategoryBreakdown } from '../../shared/types'

export function getSummary(range: 'today' | 'week' | 'month') {
  const db = getDb()
  const queries: Record<string, { current: string; previous: string }> = {
    today: {
      current: `SELECT COUNT(*) AS order_count, COALESCE(SUM(total_amount),0) AS revenue FROM orders WHERE status='completed' AND date(created_at)=date('now','localtime')`,
      previous: `SELECT COUNT(*) AS order_count, COALESCE(SUM(total_amount),0) AS revenue FROM orders WHERE status='completed' AND date(created_at)=date('now','localtime','-1 day')`,
    },
    week: {
      current: `SELECT COUNT(*) AS order_count, COALESCE(SUM(total_amount),0) AS revenue FROM orders WHERE status='completed' AND date(created_at)>=date('now','localtime','weekday 1','-7 days')`,
      previous: `SELECT COUNT(*) AS order_count, COALESCE(SUM(total_amount),0) AS revenue FROM orders WHERE status='completed' AND date(created_at)>=date('now','localtime','weekday 1','-14 days') AND date(created_at)<date('now','localtime','weekday 1','-7 days')`,
    },
    month: {
      current: `SELECT COUNT(*) AS order_count, COALESCE(SUM(total_amount),0) AS revenue FROM orders WHERE status='completed' AND strftime('%Y-%m',created_at)=strftime('%Y-%m','now','localtime')`,
      previous: `SELECT COUNT(*) AS order_count, COALESCE(SUM(total_amount),0) AS revenue FROM orders WHERE status='completed' AND strftime('%Y-%m',created_at)=strftime('%Y-%m','now','localtime','-1 month')`,
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
  return db.prepare(`
    SELECT ${groupExpr[groupBy]} AS date, SUM(total_amount) AS revenue, COUNT(*) AS orderCount
    FROM orders WHERE status='completed' AND created_at >= datetime('now',${rangeExpr[groupBy]})
    GROUP BY date ORDER BY date
  `).all() as TrendPoint[]
}

export function getTopItems(limit = 10, order: 'DESC' | 'ASC' = 'DESC'): TopItem[] {
  return getDb().prepare(`
    SELECT mi.name, SUM(oi.quantity) AS unitsSold, SUM(oi.quantity*oi.unit_price) AS revenue
    FROM order_items oi JOIN menu_items mi ON mi.item_id=oi.menu_item_id
    JOIN orders o ON o.order_id=oi.order_id
    WHERE o.status='completed' AND o.created_at>=datetime('now','-30 days')
    GROUP BY mi.item_id ORDER BY unitsSold ${order} LIMIT ?
  `).all(limit) as TopItem[]
}

export function getMenuEngineering(): MenuEngineeringItem[] {
  const rows = getDb().prepare(`
    SELECT mi.name, SUM(oi.quantity) AS unitsSold,
      ROUND(AVG(oi.unit_price-oi.unit_cost),2) AS avgMargin,
      ROUND(100.0*AVG(oi.unit_price-oi.unit_cost)/NULLIF(AVG(oi.unit_price),0),1) AS marginPct
    FROM order_items oi JOIN menu_items mi ON mi.item_id=oi.menu_item_id
    JOIN orders o ON o.order_id=oi.order_id
    WHERE o.status='completed' AND o.created_at>=datetime('now','-30 days')
    GROUP BY mi.item_id
  `).all() as MenuEngineeringItem[]

  if (rows.length === 0) return []
  const avgSales = rows.reduce((s, r) => s + r.unitsSold, 0) / rows.length
  const avgMargin = rows.reduce((s, r) => s + r.marginPct, 0) / rows.length
  return rows.map(r => ({
    ...r,
    quadrant: r.unitsSold >= avgSales
      ? (r.marginPct >= avgMargin ? 'star' : 'plowhorse')
      : (r.marginPct >= avgMargin ? 'puzzle' : 'dog'),
  }))
}

export function getPeakHours(): PeakHourCell[] {
  return getDb().prepare(`
    SELECT CAST(strftime('%w',created_at) AS INTEGER) AS dayOfWeek,
      CAST(strftime('%H',created_at) AS INTEGER) AS hourOfDay,
      COUNT(*) AS orderCount, SUM(total_amount) AS revenue
    FROM orders WHERE status='completed' AND created_at>=datetime('now','-30 days')
    GROUP BY dayOfWeek, hourOfDay
  `).all() as PeakHourCell[]
}

export function getCategoryBreakdown(): CategoryBreakdown[] {
  return getDb().prepare(`
    SELECT c.name, SUM(oi.quantity*oi.unit_price) AS revenue
    FROM order_items oi JOIN menu_items mi ON mi.item_id=oi.menu_item_id
    JOIN categories c ON c.category_id=mi.category_id
    JOIN orders o ON o.order_id=oi.order_id
    WHERE o.status='completed' AND o.created_at>=datetime('now','-30 days')
    GROUP BY c.category_id
  `).all() as CategoryBreakdown[]
}

export function getAverageOrderValue(): { date: string; avgOrderValue: number }[] {
  return getDb().prepare(`
    SELECT date(created_at) AS date, AVG(total_amount) AS avgOrderValue
    FROM orders WHERE status='completed' AND created_at>=datetime('now','-30 days')
    GROUP BY date ORDER BY date
  `).all() as any[]
}
