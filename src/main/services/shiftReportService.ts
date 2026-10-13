import { getDb } from '../db/db'
import { listWorkShifts } from './workShiftService'
import { periodMoney } from './moneyService'
import type { ShiftReport } from '../../shared/types'

/**
 * Everything that happened during one work session — the close-out ("Z") report.
 *
 * Scoped by BOTH the person and the time window: orders that cashier rang up between
 * their sign-in and sign-out. Two cashiers overlapping on the same till therefore get
 * separate, correct reports rather than one lump.
 *
 * A session still open is measured up to now, so the report can be read mid-shift.
 */

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

export function getShiftReport(shiftId: number): ShiftReport {
  const db = getDb()

  const shift = db.prepare(`
    SELECT s.*, u.full_name AS cashier_name, u.slot AS cashier_slot, u.username
    FROM shifts s JOIN users u ON u.user_id = s.cashier_id
    WHERE s.shift_id = ?
  `).get(shiftId) as any
  if (!shift) throw new Error(`الوردية ${shiftId} غير موجودة`)

  const isOpen = !shift.ended_at
  // An open shift is reported up to this moment.
  const from = shift.started_at ?? `${shift.shift_date} 00:00:00`
  const to = shift.ended_at ?? new Date().toLocaleString('sv-SE').replace('T', ' ')

  return buildReport(shift, isOpen, from, to, shift.cashier_id)
}

/**
 * The same sheet for the SHOP's shift rather than one person's session: every invoice
 * and every payment out between the shift opening and the next one opening, whoever
 * was at the till.
 */
export function getWorkShiftReport(workShiftId: number): ShiftReport {
  const ws = listWorkShifts(500).find(s => s.workShiftId === workShiftId)
  if (!ws) throw new Error(`الوردية ${workShiftId} غير موجودة`)

  const cashiers = getDb().prepare(`
    SELECT DISTINCT u.full_name FROM orders o JOIN users u ON u.user_id = o.cashier_id
    WHERE o.created_at >= ? AND o.created_at < ? AND o.deleted_at IS NULL
  `).all(ws.from, ws.to) as { full_name: string }[]

  const report = buildReport({
    shift_id: ws.workShiftId,
    cashier_id: 0,
    cashier_name: cashiers.map(c => c.full_name).join('، ') || '—',
    cashier_slot: null,
    username: 'كل الكاشير',
    shift_date: ws.date,
    shift_number: ws.shiftNumber,
    started_at: `${ws.openedAt}:00`,
    ended_at: ws.isOpen ? null : `${ws.endsAt}:00`,
    start_time: ws.openedAt.slice(11),
    end_time: ws.endsAt.slice(11),
  }, ws.isOpen, ws.from, ws.to, null)
  return { ...report, workShiftId: ws.workShiftId, shiftName: ws.name }
}

/**
 * `cashier` null means everybody. The upper bound is exclusive for the shop's shift —
 * the next shift starts on that very second — and inclusive for a session, as it
 * always was.
 */
function buildReport(shift: any, isOpen: boolean, from: string, to: string, cashier: number | null): ShiftReport {
  const db = getDb()
  const upper = cashier === null ? '<' : '<='
  const args = [cashier, cashier, from, to]
  const scoped = (who: string, when: string) =>
    `(? IS NULL OR ${who} = ?) AND ${when} >= ? AND ${when} ${upper} ?`

  const LIVE = `${scoped('o.cashier_id', 'o.created_at')}
                AND o.status = 'completed' AND o.deleted_at IS NULL`

  // ---- Every figure with money in it ----
  //
  // From the one place that defines them (moneyService), so this sheet, the close-out
  // and the finance screen cannot disagree about what a shift earned. What follows in
  // this function is only the LISTS behind those figures.
  const m = periodMoney({ from, to, inclusiveEnd: cashier !== null, cashierId: cashier })

  const byOrderType = db.prepare(`
    SELECT o.order_type AS type, COUNT(*) AS orders, COALESCE(SUM(o.total_amount), 0) AS total
    FROM orders o WHERE ${LIVE} GROUP BY o.order_type
  `).all(...args) as any[]

  // ---- Every invoice rung up in the session ----
  const invoices = db.prepare(`
    SELECT o.order_id, o.invoice_number, o.created_at, o.order_type, o.payment_type,
           o.subtotal, o.tax, o.discount, o.delivery_fee, o.total_amount, o.status,
           o.customer_name,
           (SELECT COALESCE(SUM(oi.quantity), 0) FROM order_items oi WHERE oi.order_id = o.order_id) AS item_count
    FROM orders o
    WHERE ${scoped('o.cashier_id', 'o.created_at')} AND o.deleted_at IS NULL
    ORDER BY o.created_at
  `).all(...args) as any[]

  const voided = db.prepare(`
    SELECT COUNT(*) AS c, COALESCE(SUM(o.total_amount), 0) AS v
    FROM orders o
    WHERE ${scoped('o.cashier_id', 'o.created_at')}
      AND o.status = 'voided' AND o.deleted_at IS NULL
  `).get(...args) as any

  // ---- What was sold ----
  const items = db.prepare(`
    SELECT mi.name, SUM(oi.quantity) AS units,
           COALESCE(SUM(oi.quantity * oi.unit_price), 0) AS revenue
    FROM order_items oi
    JOIN orders o ON o.order_id = oi.order_id
    JOIN menu_items mi ON mi.item_id = oi.menu_item_id
    WHERE ${LIVE}
    GROUP BY mi.item_id ORDER BY units DESC
  `).all(...args) as any[]

  // ---- Money spent during the session by this person ----
  const expenses = db.prepare(`
    SELECT e.expense_date, e.category, e.description, e.amount, e.created_at
    FROM expenses e
    WHERE ${scoped('e.recorded_by', 'e.created_at')}
    ORDER BY e.created_at
  `).all(...args) as any[]

  // ---- Wages and suppliers paid during it ----
  //
  // These were missing altogether: a wage handed over from the drawer at the end of
  // the night was on the salaries screen and nowhere on the shift's own sheet, so the
  // drawer never agreed with the report on any night somebody was paid.
  const salaries = db.prepare(`
    SELECT sa.amount, sa.created_at, w.full_name AS worker_name
    FROM salaries sa JOIN workers w ON w.worker_id = sa.worker_id
    WHERE ${scoped('sa.created_by', 'sa.created_at')}
    ORDER BY sa.created_at
  `).all(...args) as any[]

  const supplierPayments = db.prepare(`
    SELECT sp.amount, sp.method, sp.created_at, s.name AS supplier_name
    FROM supplier_payments sp JOIN suppliers s ON s.supplier_id = sp.supplier_id
    WHERE ${scoped('sp.created_by', 'sp.created_at')}
    ORDER BY sp.created_at
  `).all(...args) as any[]

  // ---- Stock that moved, so shortages can be traced to a shift ----
  const stockMoves = db.prepare(`
    SELECT rm.name, rm.unit, t.reason,
           ROUND(SUM(t.change_amount), 3) AS change_amount
    FROM raw_material_transactions t
    JOIN raw_materials rm ON rm.raw_material_id = t.raw_material_id
    WHERE ${scoped('t.created_by', 't.created_at')}
      AND t.reason IN ('restock', 'waste', 'adjustment', 'prep_in', 'prep_out')
    GROUP BY rm.raw_material_id, t.reason
    ORDER BY rm.name
  `).all(...args) as any[]

  const hours = shift.started_at
    ? round2((new Date(shift.ended_at ?? new Date().toLocaleString('sv-SE')).getTime() - new Date(from).getTime()) / 3_600_000)
    : 0

  return {
    shiftId: shift.shift_id,
    cashierId: shift.cashier_id,
    cashierName: shift.cashier_name,
    cashierSlot: shift.cashier_slot,
    username: shift.username,
    shiftDate: shift.shift_date,
    shiftNumber: shift.shift_number,
    startedAt: shift.started_at,
    endedAt: shift.ended_at,
    startTime: shift.start_time,
    endTime: shift.end_time,
    isOpen,
    hoursWorked: hours,

    orderCount: m.orderCount,
    revenue: m.revenue,
    subtotal: m.subtotal,
    tax: m.tax,
    discount: m.discount,
    deliveryFees: m.deliveryFees,
    averageOrder: m.orderCount > 0 ? round2(m.revenue / m.orderCount) : 0,
    netSales: m.netSales,
    cogs: m.cogs,
    grossProfit: m.grossProfit,
    operatingExpenses: m.operatingExpenses,
    ingredientPurchases: m.ingredientPurchases,
    wasteValue: m.wasteValue,
    netProfit: m.netProfit,

    cashSales: m.cashSales,
    cardSales: m.cardSales,
    cashOrders: m.cashOrders,
    cardOrders: m.cardOrders,
    driverCashOut: m.driverCashOut,
    driverCashPending: m.driverCashPending,
    settlementsReceived: m.settlementsReceived,
    expectedCash: m.expectedCash,

    voidedCount: voided.c,
    voidedValue: round2(voided.v),

    byOrderType: byOrderType.map(t => ({
      type: t.type,
      label: orderTypeLabel(t.type),
      orders: t.orders,
      total: round2(t.total),
    })),

    invoices: invoices.map(i => ({
      orderId: i.order_id,
      invoiceNumber: i.invoice_number,
      time: String(i.created_at).slice(11, 16),
      createdAt: i.created_at,
      orderType: i.order_type,
      orderTypeLabel: orderTypeLabel(i.order_type),
      paymentType: i.payment_type,
      itemCount: i.item_count,
      subtotal: round2(i.subtotal),
      tax: round2(i.tax),
      discount: round2(i.discount),
      deliveryFee: round2(i.delivery_fee ?? 0),
      total: round2(i.total_amount),
      status: i.status,
      customerName: i.customer_name,
    })),

    items: items.map(i => ({
      name: i.name,
      units: i.units,
      revenue: round2(i.revenue),
    })),

    expenses: expenses.map(e => ({
      time: String(e.created_at).slice(11, 16),
      category: categoryLabel(e.category),
      description: e.description || '—',
      amount: round2(e.amount),
    })),
    expensesTotal: m.expensesTotal,

    salaries: salaries.map(s => ({
      time: String(s.created_at).slice(11, 16), workerName: s.worker_name, amount: round2(s.amount),
    })),
    salariesTotal: m.salariesTotal,
    supplierPayments: supplierPayments.map(s => ({
      time: String(s.created_at).slice(11, 16),
      supplierName: s.supplier_name,
      method: s.method,
      amount: round2(s.amount),
    })),
    supplierPaymentsTotal: m.supplierPaymentsTotal,
    supplierCashTotal: m.supplierCashTotal,

    stockMoves: stockMoves.map(m => ({
      name: m.name,
      unit: m.unit,
      reason: reasonLabel(m.reason),
      change: m.change_amount,
    })),
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

function categoryLabel(category: string): string {
  switch (category) {
    case 'ingredients': return 'مكونات وخامات'
    case 'utilities': return 'كهرباء ومياه وغاز'
    case 'maintenance': return 'صيانة'
    case 'delivery': return 'توصيل'
    default: return 'أخرى'
  }
}

function reasonLabel(reason: string): string {
  switch (reason) {
    case 'restock': return 'توريد'
    case 'waste': return 'هالك'
    case 'adjustment': return 'تسوية'
    case 'prep_in': return 'ناتج تجهيز'
    case 'prep_out': return 'مستهلك في التجهيز'
    default: return reason
  }
}
