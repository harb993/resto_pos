import { getDb } from '../db/db'
import { getSupplierTotals } from './supplierService'
import { stamp, type ClosingWindow } from './shiftService'
import { profitFigures, periodMoney } from './moneyService'
import type { FinanceReport, LedgerEntry } from '../../shared/types'

/**
 * The accountant's view of the business for a date range.
 *
 * Two separate things live here, and they are deliberately NOT added together:
 *
 *   The P&L      Sales − VAT = Net sales; − COGS = Gross profit; then − operating
 *                expenses − salaries − waste = Net. The definitions are moneyService's,
 *                shared with the shift report and the close-out, so the three agree.
 *                COGS comes from the cost captured on each line AT THE TIME OF SALE,
 *                so it stays correct even after supplier prices change.
 *
 *   The ledger   Every expense and every salary payment as individual rows — the
 *                "where did the money go" list.
 *
 * Stock purchases are reported separately and left OUT of the profit maths: the
 * ingredients that were actually sold are already counted in COGS, and most owners
 * also log the supplier invoice as an expense. Adding restocks on top would count
 * the same pound twice.
 */

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

/** Materials are measured in kilos and litres, where 2dp loses real quantities. */
function round3(n: number): number {
  return Math.round((n + Number.EPSILON) * 1000) / 1000
}

/** Orders that count as real trade: completed, not voided, not deleted. */
const LIVE_ORDERS = `o.status = 'completed' AND o.deleted_at IS NULL`

export function getFinanceReport(start: string, end: string, shift?: ClosingWindow): FinanceReport {
  const db = getDb()

  /*
    Whole days, or one shift.

    A day is a calendar date; a shift is a pair of moments, and a night shift's second
    half falls on the next date. So with a shift the same queries run against exact
    timestamps instead — and against when a payment was RECORDED rather than the date
    written on it, because "what went out during this shift" is a question about the
    till, not about the paperwork.
  */
  const now = new Date()
  const p2 = (n: number) => String(n).padStart(2, '0')
  if (shift) {
    start = end = `${shift.start.getFullYear()}-${p2(shift.start.getMonth() + 1)}-${p2(shift.start.getDate())}`
  }
  const p = shift ? [stamp(shift.start), stamp(shift.coverEnd)] : [start, end]
  /** The period test for a timestamp column. */
  const on = (col: string) => shift ? `${col} >= ? AND ${col} < ?` : `date(${col}) BETWEEN ? AND ?`
  /** The same for a column holding a plain date, which a shift swaps for the record's own timestamp. */
  const onDate = (dateCol: string, stampCol: string) =>
    shift ? `${stampCol} >= ? AND ${stampCol} < ?` : `${dateCol} BETWEEN ? AND ?`

  // ---- Revenue ----
  const totals = db.prepare(`
    SELECT
      COUNT(*)                          AS order_count,
      COALESCE(SUM(o.subtotal), 0)      AS subtotal,
      COALESCE(SUM(o.tax), 0)           AS tax,
      COALESCE(SUM(o.discount), 0)      AS discount,
      COALESCE(SUM(o.delivery_fee), 0)  AS delivery_fees,
      COALESCE(SUM(o.total_amount), 0)  AS revenue
    FROM orders o
    WHERE ${LIVE_ORDERS} AND ${on('o.created_at')}
  `).get(...p) as any

  // Cost of what was actually sold, from the price captured on the line at sale time.
  const cogsRow = db.prepare(`
    SELECT COALESCE(SUM(oi.quantity * oi.unit_cost), 0) AS cogs
    FROM order_items oi JOIN orders o ON o.order_id = oi.order_id
    WHERE ${LIVE_ORDERS} AND ${on('o.created_at')}
  `).get(...p) as any

  const voided = db.prepare(`
    SELECT COUNT(*) AS c, COALESCE(SUM(total_amount), 0) AS v
    FROM orders o
    WHERE o.status = 'voided' AND o.deleted_at IS NULL AND ${on('o.created_at')}
  `).get(...p) as any

  // ---- Money out ----
  const expenseRows = db.prepare(`
    SELECT e.expense_id, e.expense_date AS date, e.category, e.description,
           e.amount, u.full_name AS recorded_by_name
    FROM expenses e JOIN users u ON u.user_id = e.recorded_by
    WHERE ${onDate('e.expense_date', 'e.created_at')}
    ORDER BY e.expense_date, e.expense_id
  `).all(...p) as any[]

  const salaryRows = db.prepare(`
    SELECT s.salary_id, COALESCE(s.paid_on, s.pay_period_end) AS date,
           w.full_name AS worker_name, s.amount,
           s.pay_period_start, s.pay_period_end, s.paid_on
    FROM salaries s JOIN workers w ON w.worker_id = s.worker_id
    WHERE ${onDate('COALESCE(s.paid_on, s.pay_period_end)', 's.created_at')}
    ORDER BY date, s.salary_id
  `).all(...p) as any[]

  const expensesTotal = round2(expenseRows.reduce((t, r) => t + r.amount, 0))
  const salariesTotal = round2(salaryRows.reduce((t, r) => t + r.amount, 0))
  // Buying ingredients leaves the drawer but not the profit — see moneyService.
  const ingredientPurchases = round2(
    expenseRows.filter(r => r.category === 'ingredients').reduce((t, r) => t + r.amount, 0))

  const revenue = round2(totals.revenue)
  const cogs = round2(cogsRow.cogs)

  // ---- Breakdowns ----
  const byOrderType = db.prepare(`
    SELECT o.order_type AS type, COUNT(*) AS orders, COALESCE(SUM(o.total_amount), 0) AS revenue
    FROM orders o
    WHERE ${LIVE_ORDERS} AND ${on('o.created_at')}
    GROUP BY o.order_type
  `).all(...p) as any[]

  const byPayment = db.prepare(`
    SELECT o.payment_type AS type, COUNT(*) AS orders, COALESCE(SUM(o.total_amount), 0) AS revenue
    FROM orders o
    WHERE ${LIVE_ORDERS} AND ${on('o.created_at')}
    GROUP BY o.payment_type
  `).all(...p) as any[]

  const expensesByCategory = db.prepare(`
    SELECT category, COUNT(*) AS count, COALESCE(SUM(amount), 0) AS total
    FROM expenses WHERE ${onDate('expense_date', 'created_at')}
    GROUP BY category ORDER BY total DESC
  `).all(...p) as any[]

  // Daily money in vs money out — the shape of the period at a glance.
  const daily = shift ? [{
    date: start, revenue, tax: round2(totals.tax), cogs, expenses: expensesTotal,
    op_expenses: round2(expensesTotal - ingredientPurchases), salaries: salariesTotal,
  }] : db.prepare(`
    SELECT d.date,
      COALESCE(s.revenue, 0)  AS revenue,
      COALESCE(s.tax, 0)      AS tax,
      COALESCE(s.cogs, 0)     AS cogs,
      COALESCE(e.expenses, 0) AS expenses,
      COALESCE(e.op_expenses, 0) AS op_expenses,
      COALESCE(w.salaries, 0) AS salaries
    FROM (
      SELECT DISTINCT date(created_at) AS date FROM orders
        WHERE date(created_at) BETWEEN ? AND ?
      UNION SELECT DISTINCT expense_date FROM expenses
        WHERE expense_date BETWEEN ? AND ?
      UNION SELECT DISTINCT COALESCE(paid_on, pay_period_end) FROM salaries
        WHERE COALESCE(paid_on, pay_period_end) BETWEEN ? AND ?
    ) d
    LEFT JOIN (
      SELECT date(o.created_at) AS date,
             SUM(o.total_amount) AS revenue,
             SUM(o.tax) AS tax,
             (SELECT COALESCE(SUM(oi.quantity * oi.unit_cost), 0)
                FROM order_items oi JOIN orders o2 ON o2.order_id = oi.order_id
               WHERE date(o2.created_at) = date(o.created_at)
                 AND o2.status = 'completed' AND o2.deleted_at IS NULL) AS cogs
      FROM orders o WHERE ${LIVE_ORDERS} GROUP BY date(o.created_at)
    ) s ON s.date = d.date
    LEFT JOIN (
      SELECT expense_date AS date, SUM(amount) AS expenses,
             SUM(CASE WHEN category <> 'ingredients' THEN amount ELSE 0 END) AS op_expenses
      FROM expenses GROUP BY expense_date
    ) e ON e.date = d.date
    LEFT JOIN (
      SELECT COALESCE(paid_on, pay_period_end) AS date, SUM(amount) AS salaries
      FROM salaries GROUP BY date
    ) w ON w.date = d.date
    ORDER BY d.date
  `).all(start, end, start, end, start, end) as any[]

  // Which items actually make money, rather than which simply sell a lot.
  const topItemsByProfit = db.prepare(`
    SELECT mi.name,
      SUM(oi.quantity)                                   AS units,
      COALESCE(SUM(oi.quantity * oi.unit_price), 0)      AS revenue,
      COALESCE(SUM(oi.quantity * oi.unit_cost), 0)       AS cost,
      COALESCE(SUM(oi.quantity * (oi.unit_price - oi.unit_cost)), 0) AS profit
    FROM order_items oi
    JOIN orders o ON o.order_id = oi.order_id
    JOIN menu_items mi ON mi.item_id = oi.menu_item_id
    WHERE ${LIVE_ORDERS} AND ${on('o.created_at')}
    GROUP BY mi.item_id ORDER BY profit DESC LIMIT 12
  `).all(...p) as any[]

  /**
   * EVERYTHING that was sold, by quantity — not the top twelve, and not ranked by
   * profit. "How many did we sell" is a different question from "what makes money",
   * and stock-taking needs the first one: every meal, every sandwich, every can.
   * Ordered by units so the answer reads the way it is asked.
   */
  const itemsSold = db.prepare(`
    SELECT mi.name, c.name AS category,
      SUM(oi.quantity)                                   AS units,
      COALESCE(SUM(oi.quantity * oi.unit_price), 0)      AS revenue,
      COALESCE(SUM(oi.quantity * oi.unit_cost), 0)       AS cost
    FROM order_items oi
    JOIN orders o ON o.order_id = oi.order_id
    JOIN menu_items mi ON mi.item_id = oi.menu_item_id
    LEFT JOIN categories c ON c.category_id = mi.category_id
    WHERE ${LIVE_ORDERS} AND ${on('o.created_at')}
    GROUP BY mi.item_id
    ORDER BY units DESC, mi.name
  `).all(...p) as any[]

  /**
   * What those sales actually ATE: the raw materials drawn out of stock — bread,
   * cola, pieces of chicken, rice, sauces, packaging.
   *
   * A meal is one line on an invoice but eight things off the shelf, and the shelf is
   * what has to be re-ordered. This is taken from the movement log rather than
   * recomputed from recipes, so it reflects what was really deducted at the time of
   * each sale even if a recipe has been edited since.
   *
   * 'void' rows are positive — stock handed back when an invoice was cancelled — so
   * summing both reasons nets a cancelled sale back out instead of leaving the
   * kitchen looking like it used ingredients it returned.
   *
   * Only items with a recipe appear. Anything sold on the simple stock model consumes
   * no raw material and so has nothing to show here; it is still in `itemsSold`.
   */
  const materialsUsed = db.prepare(`
    SELECT rm.name, rm.unit,
      COALESCE(SUM(-t.change_amount), 0)                      AS quantity,
      COALESCE(SUM(-t.change_amount) * rm.cost_per_unit, 0)   AS cost
    FROM raw_material_transactions t
    JOIN raw_materials rm ON rm.raw_material_id = t.raw_material_id
    WHERE t.reason IN ('sale', 'void')
      AND ${on('t.created_at')}
    GROUP BY rm.raw_material_id
    HAVING quantity > 0
    ORDER BY quantity DESC, rm.name
  `).all(...p) as any[]

  // Informational only — see the note at the top of this file.
  const stockPurchases = db.prepare(`
    SELECT COALESCE(SUM(t.change_amount * rm.cost_per_unit), 0) AS value
    FROM raw_material_transactions t
    JOIN raw_materials rm ON rm.raw_material_id = t.raw_material_id
    WHERE t.reason = 'restock' AND ${on('t.created_at')}
  `).get(...p) as any

  const wasteValue = db.prepare(`
    SELECT COALESCE(SUM(ABS(t.change_amount) * rm.cost_per_unit), 0) AS value
    FROM raw_material_transactions t
    JOIN raw_materials rm ON rm.raw_material_id = t.raw_material_id
    WHERE t.reason = 'waste' AND ${on('t.created_at')}
  `).get(...p) as any

  // ---- Profit: the one set of definitions, from moneyService ----
  const waste = round2(wasteValue.value)
  const pl = profitFigures({
    revenue, tax: round2(totals.tax), cogs,
    expensesTotal, ingredientPurchases, salariesTotal, wasteValue: waste,
  })
  // A shift has a drawer to count; a range of dates does not.
  const drawer = shift ? periodMoney({ from: p[0], to: p[1] }) : null

  // ---- The "every pound" ledger: expenses and salaries merged, newest last ----
  const ledger: LedgerEntry[] = [
    ...expenseRows.map(r => ({
      date: r.date as string,
      kind: 'expense' as const,
      label: r.description || categoryLabel(r.category),
      category: categoryLabel(r.category),
      amount: round2(r.amount),
      by: r.recorded_by_name as string,
    })),
    ...salaryRows.map(r => ({
      date: r.date as string,
      kind: 'salary' as const,
      label: `مرتب: ${r.worker_name}`,
      category: `${r.pay_period_start} → ${r.pay_period_end}`,
      amount: round2(r.amount),
      by: '',
    })),
  ].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))

  return {
    period: { start, end },
    shift: shift ? {
      number: shift.number,
      name: shift.name,
      date: start,
      startedAt: stamp(shift.start).slice(0, 16),
      endsAt: stamp(shift.scheduledEnd).slice(0, 16),
      isOpen: now.getTime() < shift.scheduledEnd.getTime(),
    } : undefined,
    revenue,
    subtotal: round2(totals.subtotal),
    tax: round2(totals.tax),
    discount: round2(totals.discount),
    deliveryFees: round2(totals.delivery_fees),
    orderCount: totals.order_count,
    averageOrder: totals.order_count > 0 ? round2(revenue / totals.order_count) : 0,
    netSales: pl.netSales,
    cogs,
    grossProfit: pl.grossProfit,
    grossMarginPct: pl.grossMarginPct,
    expensesTotal,
    ingredientPurchases,
    operatingExpenses: pl.operatingExpenses,
    salariesTotal,
    // Everything paid out, whether or not it counts against the profit.
    totalSpent: round2(expensesTotal + salariesTotal),
    netProfit: pl.netProfit,
    netMarginPct: pl.netMarginPct,
    drawer: drawer ? {
      cashSales: drawer.cashSales,
      driverCashOut: drawer.driverCashOut,
      driverCashPending: drawer.driverCashPending,
      settlementsReceived: drawer.settlementsReceived,
      supplierCashTotal: drawer.supplierCashTotal,
      expectedCash: drawer.expectedCash,
    } : undefined,
    voidedCount: voided.c,
    voidedValue: round2(voided.v),
    stockPurchaseValue: round2(stockPurchases.value),
    wasteValue: waste,
    /**
     * Suppliers. Reported beside the P&L, never inside it — see the note at the top
     * of this file. What the restaurant BOUGHT is not what it CONSUMED: the
     * ingredients actually sold are already in COGS, and a delivery bought today and
     * cooked next week would otherwise be charged against this week's profit twice.
     * `totalOwed` is likewise a balance, not a cost, and belongs nowhere near a
     * margin.
     */
    suppliers: getSupplierTotals(start, end),
    byOrderType: byOrderType.map(r => ({
      type: r.type,
      label: orderTypeLabel(r.type),
      orders: r.orders,
      revenue: round2(r.revenue),
    })),
    byPayment: byPayment.map(r => ({
      type: r.type,
      label: r.type === 'cash' ? 'نقدي' : 'بطاقة',
      orders: r.orders,
      revenue: round2(r.revenue),
    })),
    expensesByCategory: expensesByCategory.map(r => ({
      category: r.category,
      label: categoryLabel(r.category),
      count: r.count,
      total: round2(r.total),
    })),
    daily: daily.map(r => ({
      date: r.date,
      revenue: round2(r.revenue),
      cogs: round2(r.cogs),
      expenses: round2(r.expenses),
      salaries: round2(r.salaries),
      profit: round2(r.revenue - r.tax - r.cogs - r.op_expenses - r.salaries),
    })),
    topItemsByProfit: topItemsByProfit.map(r => ({
      name: r.name,
      units: r.units,
      revenue: round2(r.revenue),
      cost: round2(r.cost),
      profit: round2(r.profit),
      marginPct: r.revenue > 0 ? round2((r.profit / r.revenue) * 100) : 0,
    })),
    itemsSold: itemsSold.map(r => ({
      name: r.name,
      category: r.category || '—',
      units: r.units,
      revenue: round2(r.revenue),
      cost: round2(r.cost),
      profit: round2(r.revenue - r.cost),
    })),
    materialsUsed: materialsUsed.map(r => ({
      name: r.name,
      unit: r.unit,
      quantity: round3(r.quantity),
      cost: round2(r.cost),
    })),
    expenses: expenseRows.map(r => ({
      date: r.date,
      category: categoryLabel(r.category),
      description: r.description || '—',
      amount: round2(r.amount),
      recordedBy: r.recorded_by_name,
    })),
    salaries: salaryRows.map(r => ({
      workerName: r.worker_name,
      periodStart: r.pay_period_start,
      periodEnd: r.pay_period_end,
      paidOn: r.paid_on,
      amount: round2(r.amount),
    })),
    ledger,
  }
}

function categoryLabel(category: string): string {
  switch (category) {
    case 'ingredients': return 'مكونات وخامات'
    case 'utilities': return 'كهرباء ومياه وغاز'
    case 'maintenance': return 'صيانة'
    case 'delivery': return 'توصيل'
    default: return 'أخرى'
  }
}

function orderTypeLabel(type: string): string {
  switch (type) {
    case 'dine_in': return 'صالة'
    case 'takeaway': return 'تيك أواي'
    case 'delivery': return 'دليفري'
    default: return type
  }
}
