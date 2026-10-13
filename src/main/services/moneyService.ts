import { getDb } from '../db/db'

/**
 * The money for a period — worked out ONCE, here, for every screen and every report.
 *
 * There used to be three sets of sums: the shift sheet called revenue-minus-cost
 * "profit", the close-out called takings-minus-payments "net", and the finance screen
 * had a third figure again. Each was defensible alone and together they meant the same
 * shift showed three different results, which is the same as showing none. So the
 * definitions live in this file and nowhere else:
 *
 *   المبيعات            everything customers were charged          Σ total
 *   الضريبة             VAT inside that — collected FOR the tax authority, not earned
 *   صافي المبيعات       المبيعات − الضريبة
 *   تكلفة البضاعة       what the food sold cost, captured on each line at sale time
 *   مجمل الربح          صافي المبيعات − تكلفة البضاعة
 *   المصروفات التشغيلية  expenses, EXCEPT ingredient purchases (see below)
 *   المرتبات            wages paid out in the period
 *   الهالك              stock written off — bought, never sold, so in no invoice's cost
 *   صافي الربح          مجمل الربح − المصروفات التشغيلية − المرتبات − الهالك
 *
 * Why buying ingredients is not deducted from profit
 * --------------------------------------------------
 * Because it already is, one meal at a time. Every invoice line carries what that meal
 * cost to make, and «تكلفة البضاعة» is the sum of those. Taking the 5,000 paid for
 * chicken off the profit as well would charge the same chicken twice — once when it
 * was bought and again as it was sold. It still left the drawer, so it IS in the cash
 * figures below; it is only kept out of the profit.
 *
 * The drawer is a separate question
 * ---------------------------------
 * Profit asks what was earned. The drawer asks what should physically be in it:
 *
 *   cash sales rung up
 *   − cash that went out of the door with a delivery driver
 *   + what drivers paid in during the period
 *   − everything paid out: every expense, wages, suppliers paid in cash
 *
 * A delivery order's cash is in the driver's pocket until he settles, so counting it
 * on the night it was ordered made the drawer "short" by exactly the deliveries.
 */

export interface MoneyScope {
  /** `YYYY-MM-DD HH:MM:SS` */
  from: string
  to: string
  /** A cashier's session ends ON its last second; the shop's shift ends just before the next begins. */
  inclusiveEnd?: boolean
  /** Only what this user rang up, recorded or paid. Null = everybody. */
  cashierId?: number | null
}

export interface PeriodMoney {
  orderCount: number
  revenue: number
  subtotal: number
  tax: number
  discount: number
  deliveryFees: number
  netSales: number
  cogs: number
  grossProfit: number
  grossMarginPct: number

  cashSales: number
  cardSales: number
  cashOrders: number
  cardOrders: number

  /** Every expense recorded — what left the drawer. */
  expensesTotal: number
  /** The part of it that bought ingredients: out of the drawer, not out of the profit. */
  ingredientPurchases: number
  operatingExpenses: number
  salariesTotal: number
  supplierPaymentsTotal: number
  supplierCashTotal: number
  wasteValue: number

  netProfit: number
  netMarginPct: number

  /** Cash from this period's delivery orders that left with a driver. */
  driverCashOut: number
  /** The part of it no driver has paid in yet. */
  driverCashPending: number
  /** What drivers paid in during the period, whichever shift the orders were from. */
  settlementsReceived: number
  expectedCash: number
}

export function round2(n: number): number {
  return Math.round(((Number(n) || 0) + Number.EPSILON) * 100) / 100
}

const pct = (part: number, whole: number) => whole > 0 ? round2((part / whole) * 100) : 0

/** The profit arithmetic on its own, for a report that gathers its figures differently. */
export function profitFigures(p: {
  revenue: number; tax: number; cogs: number
  expensesTotal: number; ingredientPurchases: number
  salariesTotal: number; wasteValue: number
}) {
  const netSales = round2(p.revenue - p.tax)
  const grossProfit = round2(netSales - p.cogs)
  const operatingExpenses = round2(p.expensesTotal - p.ingredientPurchases)
  const netProfit = round2(grossProfit - operatingExpenses - p.salariesTotal - p.wasteValue)
  return {
    netSales,
    grossProfit,
    grossMarginPct: pct(grossProfit, netSales),
    operatingExpenses,
    netProfit,
    netMarginPct: pct(netProfit, netSales),
  }
}

export function periodMoney(scope: MoneyScope): PeriodMoney {
  const db = getDb()
  const who = scope.cashierId ?? null
  const upper = scope.inclusiveEnd ? '<=' : '<'
  const args = [who, who, scope.from, scope.to]
  /** "by this person (or anyone), inside the period" for a table's own two columns. */
  const within = (whoCol: string, whenCol: string) =>
    `(? IS NULL OR ${whoCol} = ?) AND ${whenCol} >= ? AND ${whenCol} ${upper} ?`

  const LIVE = `${within('o.cashier_id', 'o.created_at')}
                AND o.status = 'completed' AND o.deleted_at IS NULL`
  const one = (sql: string) => db.prepare(sql).get(...args) as any

  const t = one(`
    SELECT COUNT(*) AS order_count,
      COALESCE(SUM(o.subtotal), 0)     AS subtotal,
      COALESCE(SUM(o.tax), 0)          AS tax,
      COALESCE(SUM(o.discount), 0)     AS discount,
      COALESCE(SUM(o.delivery_fee), 0) AS delivery_fees,
      COALESCE(SUM(o.total_amount), 0) AS revenue,
      COALESCE(SUM(CASE WHEN o.payment_type = 'cash' THEN o.total_amount ELSE 0 END), 0) AS cash,
      COALESCE(SUM(CASE WHEN o.payment_type = 'card' THEN o.total_amount ELSE 0 END), 0) AS card,
      COALESCE(SUM(o.payment_type = 'cash'), 0) AS cash_orders,
      COALESCE(SUM(o.payment_type = 'card'), 0) AS card_orders,
      COALESCE(SUM(CASE WHEN o.payment_type = 'cash' AND o.order_type = 'delivery'
                         AND o.driver_id IS NOT NULL THEN o.total_amount ELSE 0 END), 0) AS driver_cash,
      COALESCE(SUM(CASE WHEN o.payment_type = 'cash' AND o.order_type = 'delivery'
                         AND o.driver_id IS NOT NULL AND o.settlement_id IS NULL
                        THEN o.total_amount ELSE 0 END), 0) AS driver_pending
    FROM orders o WHERE ${LIVE}
  `)

  const cogs = one(`
    SELECT COALESCE(SUM(oi.quantity * oi.unit_cost), 0) AS v
    FROM order_items oi JOIN orders o ON o.order_id = oi.order_id
    WHERE ${LIVE}
  `).v

  const e = one(`
    SELECT COALESCE(SUM(e.amount), 0) AS total,
           COALESCE(SUM(CASE WHEN e.category = 'ingredients' THEN e.amount ELSE 0 END), 0) AS ingredients
    FROM expenses e WHERE ${within('e.recorded_by', 'e.created_at')}
  `)

  const salaries = one(`
    SELECT COALESCE(SUM(sa.amount), 0) AS v
    FROM salaries sa WHERE ${within('sa.created_by', 'sa.created_at')}
  `).v

  const sp = one(`
    SELECT COALESCE(SUM(sp.amount), 0) AS total,
           COALESCE(SUM(CASE WHEN sp.method = 'cash' THEN sp.amount ELSE 0 END), 0) AS cash
    FROM supplier_payments sp WHERE ${within('sp.created_by', 'sp.created_at')}
  `)

  const waste = one(`
    SELECT COALESCE(SUM(ABS(t.change_amount) * rm.cost_per_unit), 0) AS v
    FROM raw_material_transactions t
    JOIN raw_materials rm ON rm.raw_material_id = t.raw_material_id
    WHERE ${within('t.created_by', 't.created_at')} AND t.reason = 'waste'
  `).v

  const settled = one(`
    SELECT COALESCE(SUM(ds.total_amount), 0) AS v
    FROM driver_settlements ds WHERE ${within('ds.settled_by', 'ds.settled_at')}
  `).v

  const figures = {
    revenue: round2(t.revenue),
    tax: round2(t.tax),
    cogs: round2(cogs),
    expensesTotal: round2(e.total),
    ingredientPurchases: round2(e.ingredients),
    salariesTotal: round2(salaries),
    wasteValue: round2(waste),
  }
  const cashSales = round2(t.cash)
  const driverCashOut = round2(t.driver_cash)
  const settlementsReceived = round2(settled)
  const supplierCashTotal = round2(sp.cash)

  return {
    orderCount: t.order_count,
    subtotal: round2(t.subtotal),
    discount: round2(t.discount),
    deliveryFees: round2(t.delivery_fees),
    ...figures,
    ...profitFigures(figures),

    cashSales,
    cardSales: round2(t.card),
    cashOrders: t.cash_orders,
    cardOrders: t.card_orders,

    supplierPaymentsTotal: round2(sp.total),
    supplierCashTotal,

    driverCashOut,
    driverCashPending: round2(t.driver_pending),
    settlementsReceived,
    expectedCash: round2(
      cashSales - driverCashOut + settlementsReceived
      - figures.expensesTotal - figures.salariesTotal - supplierCashTotal,
    ),
  }
}
