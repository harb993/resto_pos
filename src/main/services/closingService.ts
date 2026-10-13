import { getDb } from '../db/db'
import { closingWindowOn, stamp } from './shiftService'
import { currentWorkWindow, workShiftWindow } from './workShiftService'
import { periodMoney, round2 } from './moneyService'
import type { ClosingReport } from '../../shared/types'

/**
 * «تقفيل الوردية» — the till's close-out slip for one shift.
 *
 * This is the piece of paper the person closing the till counts the drawer against, so
 * it is about CASH: what was taken, what was paid out, what should be in the drawer.
 * It deliberately says nothing about profit — that is on the owner's shift report —
 * because this one is printed and handled by whoever is at the counter.
 *
 * Every figure comes from moneyService, the same place the shift report and the
 * finance screen get theirs, so the slip and the screens cannot disagree. It covers
 * the whole shop for the shift: every invoice, whoever rang it up, and every pound
 * that went out — expenses, wages and suppliers alike.
 */

const p2 = (n: number) => String(n).padStart(2, '0')
const clock = (d: Date) => `${p2(d.getHours())}:${p2(d.getMinutes())}`
const ymd = (d: Date) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`

export function getClosingReport(
  opts: { workShiftId?: number; date?: string; shiftNumber?: number } = {},
  now = new Date(),
): ClosingReport {
  const db = getDb()

  // A shift that was actually opened, by id; failing that the one running now. The
  // date-and-number form reads the hours straight from the settings, for books from
  // before shifts were opened and closed.
  const window = opts.workShiftId
    ? workShiftWindow(opts.workShiftId)
    : opts.date
      ? closingWindowOn(opts.date, opts.shiftNumber ?? 1)
      : currentWorkWindow(now)

  const from = stamp(window.start)
  const to = stamp(window.coverEnd)
  const m = periodMoney({ from, to })

  // Half-open, so an invoice on the stroke of the handover belongs to one shift only.
  const args = [from, to]
  const inWindow = (alias: string) => `${alias}.created_at >= ? AND ${alias}.created_at < ?`
  const LIVE = `${inWindow('o')} AND o.status = 'completed' AND o.deleted_at IS NULL`

  const byOrderType = db.prepare(`
    SELECT o.order_type AS type, COUNT(*) AS orders, COALESCE(SUM(o.total_amount), 0) AS total
    FROM orders o WHERE ${LIVE} GROUP BY o.order_type
  `).all(...args) as any[]

  const byCashier = db.prepare(`
    SELECT u.full_name AS name, COUNT(*) AS orders, COALESCE(SUM(o.total_amount), 0) AS total
    FROM orders o JOIN users u ON u.user_id = o.cashier_id
    WHERE ${LIVE} GROUP BY o.cashier_id ORDER BY total DESC
  `).all(...args) as any[]

  const invoices = db.prepare(`
    SELECT o.order_id, o.invoice_number, o.created_at, o.order_type, o.payment_type,
           o.total_amount, o.status, u.full_name AS cashier_name
    FROM orders o JOIN users u ON u.user_id = o.cashier_id
    WHERE ${inWindow('o')} AND o.deleted_at IS NULL
    ORDER BY o.created_at, o.order_id
  `).all(...args) as any[]

  const voided = db.prepare(`
    SELECT COUNT(*) AS c, COALESCE(SUM(o.total_amount), 0) AS v
    FROM orders o
    WHERE ${inWindow('o')} AND o.status = 'voided' AND o.deleted_at IS NULL
  `).get(...args) as any

  const expenses = db.prepare(`
    SELECT e.category, e.description, e.amount, e.created_at, u.full_name AS recorded_by
    FROM expenses e JOIN users u ON u.user_id = e.recorded_by
    WHERE ${inWindow('e')}
    ORDER BY e.created_at, e.expense_id
  `).all(...args) as any[]

  const supplierPayments = db.prepare(`
    SELECT sp.amount, sp.method, sp.created_at, s.name AS supplier_name
    FROM supplier_payments sp JOIN suppliers s ON s.supplier_id = sp.supplier_id
    WHERE ${inWindow('sp')}
    ORDER BY sp.created_at, sp.supplier_payment_id
  `).all(...args) as any[]

  const salaries = db.prepare(`
    SELECT sa.amount, sa.created_at, w.full_name AS worker_name
    FROM salaries sa JOIN workers w ON w.worker_id = sa.worker_id
    WHERE ${inWindow('sa')}
    ORDER BY sa.created_at, sa.salary_id
  `).all(...args) as any[]

  const time = (createdAt: unknown) => String(createdAt).slice(11, 16)

  return {
    shiftNumber: window.number,
    shiftName: window.name,
    shiftDate: ymd(window.start),
    from,
    to,
    startTime: clock(window.start),
    endTime: clock(window.scheduledEnd),
    isOpen: now.getTime() < window.scheduledEnd.getTime(),

    orderCount: m.orderCount,
    revenue: m.revenue,
    subtotal: m.subtotal,
    tax: m.tax,
    discount: m.discount,
    deliveryFees: m.deliveryFees,
    cashSales: m.cashSales,
    cardSales: m.cardSales,
    cashOrders: m.cashOrders,
    cardOrders: m.cardOrders,
    voidedCount: voided.c,
    voidedValue: round2(voided.v),

    byOrderType: byOrderType.map(t => ({
      type: t.type, label: orderTypeLabel(t.type), orders: t.orders, total: round2(t.total),
    })),
    byCashier: byCashier.map(c => ({ name: c.name, orders: c.orders, total: round2(c.total) })),

    invoices: invoices.map(i => ({
      orderId: i.order_id,
      invoiceNumber: i.invoice_number,
      time: time(i.created_at),
      orderTypeLabel: orderTypeLabel(i.order_type),
      paymentType: i.payment_type,
      total: round2(i.total_amount),
      status: i.status,
      cashierName: i.cashier_name,
    })),

    expenses: expenses.map(e => ({
      time: time(e.created_at),
      category: categoryLabel(e.category),
      description: e.description || '—',
      amount: round2(e.amount),
      recordedBy: e.recorded_by,
    })),
    expensesTotal: m.expensesTotal,
    supplierPayments: supplierPayments.map(s => ({
      time: time(s.created_at),
      supplierName: s.supplier_name,
      method: s.method,
      amount: round2(s.amount),
    })),
    supplierPaymentsTotal: m.supplierPaymentsTotal,
    supplierCashTotal: m.supplierCashTotal,
    salaries: salaries.map(s => ({
      time: time(s.created_at), workerName: s.worker_name, amount: round2(s.amount),
    })),
    salariesTotal: m.salariesTotal,

    outgoingsTotal: round2(m.expensesTotal + m.supplierPaymentsTotal + m.salariesTotal),
    driverCashOut: m.driverCashOut,
    driverCashPending: m.driverCashPending,
    settlementsReceived: m.settlementsReceived,
    expectedCash: m.expectedCash,
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
