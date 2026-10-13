import { getDb } from '../db/db'
import log from 'electron-log/main'
import type {
  DeliveryArea, DeliveryDriver, DeliveryStatus, DeliverySummary,
  DriverBalance, DriverSettlement, Order,
} from '../../shared/types'

// ===== Delivery Areas =====

export function upsertArea(
  areaName: string,
  deliveryFee: number,
  isActive: number,
  areaId?: number
): DeliveryArea {
  const db = getDb()

  if (areaId) {
    db.prepare(`
      UPDATE delivery_areas SET area_name = ?, delivery_fee = ?, is_active = ?
      WHERE delivery_area_id = ?
    `).run(areaName, deliveryFee, isActive, areaId)
    log.info(`[Delivery] Updated area #${areaId}: ${areaName}`)
    return db.prepare('SELECT * FROM delivery_areas WHERE delivery_area_id = ?').get(areaId) as DeliveryArea
  } else {
    const result = db.prepare(`
      INSERT INTO delivery_areas (area_name, delivery_fee, is_active) VALUES (?, ?, ?)
    `).run(areaName, deliveryFee, isActive)
    const id = result.lastInsertRowid as number
    log.info(`[Delivery] Created area #${id}: ${areaName}`)
    return db.prepare('SELECT * FROM delivery_areas WHERE delivery_area_id = ?').get(id) as DeliveryArea
  }
}

export function listAreas(): DeliveryArea[] {
  return getDb().prepare('SELECT * FROM delivery_areas ORDER BY is_active DESC, area_name').all() as DeliveryArea[]
}

/**
 * Remove a delivery zone, or retire it when past invoices used it.
 *
 * Same rule the menu uses, because it is the same problem: an order records which
 * zone it went to, and the fee that was charged for it. Erasing a zone that old
 * orders point at would break that link and change what those deliveries appear to
 * have cost. So a zone with history is DEACTIVATED — gone from the POS and every
 * picker, while the invoices that used it stay readable — and only a zone nothing
 * has ever been delivered to is actually deleted.
 */
export function deleteArea(areaId: number): { action: 'deleted' | 'deactivated'; name: string; message: string } {
  const db = getDb()
  const area = db.prepare('SELECT area_name FROM delivery_areas WHERE delivery_area_id = ?')
    .get(areaId) as { area_name: string } | undefined
  if (!area) throw new Error('المنطقة غير موجودة')

  // Only orders that still COUNT. An invoice that has been deleted is no longer part
  // of the shop's history — it is excluded from every report and every total — so it
  // has no business keeping a zone alive that nothing real was delivered to. Left in,
  // a single mistyped test delivery pins a zone in the picker for ever.
  const used = (db.prepare(
    'SELECT COUNT(*) AS c FROM orders WHERE delivery_area_id = ? AND deleted_at IS NULL'
  ).get(areaId) as { c: number }).c

  if (used > 0) {
    db.prepare('UPDATE delivery_areas SET is_active = 0 WHERE delivery_area_id = ?').run(areaId)
    log.info(`[Delivery] Area #${areaId} (${area.area_name}) deactivated — ${used} order(s) used it`)
    return {
      action: 'deactivated',
      name: area.area_name,
      message: `تم إيقاف منطقة "${area.area_name}" بدلاً من حذفها — ${used} فاتورة سابقة مرتبطة بها. ` +
               `اختفت من نقطة البيع، والفواتير القديمة ظلت صحيحة.`,
    }
  }

  // A deleted invoice may still point here. Release it first, or the foreign key
  // refuses the delete with a message naming nothing anyone can act on.
  const remove = db.transaction(() => {
    db.prepare(
      'UPDATE orders SET delivery_area_id = NULL WHERE delivery_area_id = ? AND deleted_at IS NOT NULL'
    ).run(areaId)
    db.prepare('DELETE FROM delivery_areas WHERE delivery_area_id = ?').run(areaId)
  })
  remove()

  log.warn(`[Delivery] Area #${areaId} (${area.area_name}) deleted`)
  return {
    action: 'deleted',
    name: area.area_name,
    message: `تم حذف منطقة "${area.area_name}" نهائياً.`,
  }
}

// ===== Delivery Drivers =====

export function upsertDriver(
  fullName: string,
  phone: string | null,
  isActive: number,
  driverId?: number
): DeliveryDriver {
  const db = getDb()

  if (driverId) {
    db.prepare(`
      UPDATE delivery_drivers SET full_name = ?, phone = ?, is_active = ?
      WHERE driver_id = ?
    `).run(fullName, phone, isActive, driverId)
    log.info(`[Delivery] Updated driver #${driverId}: ${fullName}`)
    return db.prepare('SELECT * FROM delivery_drivers WHERE driver_id = ?').get(driverId) as DeliveryDriver
  } else {
    const result = db.prepare(`
      INSERT INTO delivery_drivers (full_name, phone, is_active) VALUES (?, ?, ?)
    `).run(fullName, phone, isActive)
    const id = result.lastInsertRowid as number
    log.info(`[Delivery] Created driver #${id}: ${fullName}`)
    return db.prepare('SELECT * FROM delivery_drivers WHERE driver_id = ?').get(id) as DeliveryDriver
  }
}

export function listDrivers(): DeliveryDriver[] {
  return getDb().prepare('SELECT * FROM delivery_drivers ORDER BY is_active DESC, full_name').all() as DeliveryDriver[]
}

/**
 * Remove a driver, or retire him when he has carried orders.
 *
 * A driver is not just a name on a list — orders point at him, and so do the cash
 * hand-overs he has made. Deleting one with history would orphan both, and the
 * settlement record is the shop's proof of what he paid in.
 *
 * Worse, it could hide money still owed. So a driver who is still holding cash for
 * unsettled orders cannot be removed at all until he has paid in: that is a debt, and
 * making it disappear from the screen does not make it disappear from the till.
 */
export function deleteDriver(driverId: number): { action: 'deleted' | 'deactivated'; name: string; message: string } {
  const db = getDb()
  const driver = db.prepare('SELECT full_name FROM delivery_drivers WHERE driver_id = ?')
    .get(driverId) as { full_name: string } | undefined
  if (!driver) throw new Error('السائق غير موجود')

  // Two different reasons he cannot go yet, and they call for different actions from
  // whoever reads the message.

  // 1. Money. Delivered, paid in cash, not yet handed over — that is a debt, and
  //    taking him off the screen would not take it off the books. Card orders never
  //    count: the customer paid the machine, so he is holding nothing for them.
  const owing = db.prepare(`
    SELECT COUNT(*) AS c, COALESCE(SUM(total_amount), 0) AS amount
    FROM orders
    WHERE driver_id = ? AND settlement_id IS NULL AND payment_type = 'cash'
      AND delivery_status = 'delivered'
      AND status = 'completed' AND deleted_at IS NULL
  `).get(driverId) as { c: number; amount: number }

  if (owing.c > 0) {
    throw new Error(
      `لا يمكن حذف "${driver.full_name}" — معه ${owing.c} طلب لم يُسلَّم تحصيلها ` +
      `(${owing.amount.toFixed(2)}). سوِّ حسابه أولاً من مركز الدليفري، ثم احذفه.`
    )
  }

  // 2. Work in hand. Orders that are still being cooked, waiting, or out on the road
  //    with him. Nothing is owed yet, but he is mid-job and removing him would leave
  //    those orders pointing at a driver nobody can pick from a list any more.
  const live = db.prepare(`
    SELECT COUNT(*) AS c FROM orders
    WHERE driver_id = ? AND delivery_status IN ('preparing','pending','out')
      AND status = 'completed' AND deleted_at IS NULL
  `).get(driverId) as { c: number }

  if (live.c > 0) {
    throw new Error(
      `لا يمكن حذف "${driver.full_name}" — معه ${live.c} طلب ما زال جارياً. ` +
      `أنهِ الطلبات أو انقلها لسائق آخر أولاً.`
    )
  }

  // History that still counts — see the note in deleteArea about deleted invoices.
  const orders = (db.prepare(
    'SELECT COUNT(*) AS c FROM orders WHERE driver_id = ? AND deleted_at IS NULL'
  ).get(driverId) as { c: number }).c

  // A hand-over covering nothing but deleted invoices is a receipt for money that is
  // no longer on the books, so it does not hold the driver either. One that covers a
  // live invoice does: it is the shop's proof of what he paid in.
  const settlements = (db.prepare(`
    SELECT COUNT(*) AS c FROM driver_settlements ds
    WHERE ds.driver_id = ?
      AND EXISTS (SELECT 1 FROM orders o
                   WHERE o.settlement_id = ds.settlement_id AND o.deleted_at IS NULL)
  `).get(driverId) as { c: number }).c

  if (orders > 0 || settlements > 0) {
    db.prepare('UPDATE delivery_drivers SET is_active = 0 WHERE driver_id = ?').run(driverId)
    log.info(`[Delivery] Driver #${driverId} (${driver.full_name}) deactivated — ${orders} order(s), ${settlements} settlement(s)`)
    return {
      action: 'deactivated',
      name: driver.full_name,
      message: `تم إيقاف "${driver.full_name}" بدلاً من حذفه — مرتبط بـ ${orders} طلب و${settlements} تسوية سابقة. ` +
               `لن يظهر في قوائم الاختيار، وسجل تسليماته محفوظ.`,
    }
  }

  // Nothing live points at him, but DELETED invoices still might — and so might the
  // hand-overs that covered nothing but those. Release both before the row goes, or
  // the foreign key refuses with a message naming nothing anyone can act on.
  const remove = db.transaction(() => {
    const stale = db.prepare(`
      SELECT ds.settlement_id FROM driver_settlements ds WHERE ds.driver_id = ?
    `).all(driverId) as { settlement_id: number }[]

    for (const s of stale) {
      db.prepare('UPDATE orders SET settlement_id = NULL WHERE settlement_id = ?').run(s.settlement_id)
      db.prepare('DELETE FROM driver_settlements WHERE settlement_id = ?').run(s.settlement_id)
    }
    db.prepare(
      'UPDATE orders SET driver_id = NULL WHERE driver_id = ? AND deleted_at IS NOT NULL'
    ).run(driverId)
    db.prepare('DELETE FROM delivery_drivers WHERE driver_id = ?').run(driverId)
  })
  remove()

  log.warn(`[Delivery] Driver #${driverId} (${driver.full_name}) deleted`)
  return {
    action: 'deleted',
    name: driver.full_name,
    message: `تم حذف "${driver.full_name}" نهائياً.`,
  }
}

// ===== The delivery centre =====
//
// Two questions are being answered here, and they are not the same question:
//
//   1. Where is the food?  — pending → out → delivered (or returned)
//   2. Where is the money? — the driver collected cash at the door; has he handed
//      it in yet?
//
// They are kept apart deliberately. An order can be delivered and unpaid-in for
// hours, which is normal and is exactly what the owner needs to see; and an order
// can be delivered with nothing owed at all, because the customer paid by card and
// the driver never touched the money.

/** Money is stored as REAL; round every total so float noise never reaches a screen. */
function round2(n: number): number {
  return Math.round(((n || 0) + Number.EPSILON) * 100) / 100
}

/**
 * The orders that count as real trading. A voided or deleted invoice is not a
 * delivery anybody has to chase, and its money is owed by nobody.
 */
const LIVE_ORDER = `o.order_type = 'delivery' AND o.deleted_at IS NULL AND o.status = 'completed'`

/** Cash the driver is holding for this order: nothing at all if it went on a card. */
const CASH_OWED = `CASE WHEN o.payment_type = 'cash' THEN o.total_amount ELSE 0 END`

/** The same set as LIVE_ORDER, but for orders that HAVE been deleted. */
const DELETED_ORDER = `o.order_type = 'delivery' AND o.deleted_at IS NOT NULL`

const SELECT_ORDER = `
  SELECT o.*, u.full_name AS cashier_name,
         da.area_name, dd.full_name AS driver_name,
         ds.settled_at,
         du.full_name AS deleted_by_name,
         vu.full_name AS voided_by_name
  FROM orders o
  JOIN users u ON u.user_id = o.cashier_id
  LEFT JOIN delivery_areas da ON da.delivery_area_id = o.delivery_area_id
  LEFT JOIN delivery_drivers dd ON dd.driver_id = o.driver_id
  LEFT JOIN driver_settlements ds ON ds.settlement_id = o.settlement_id
  LEFT JOIN users du ON du.user_id = o.deleted_by
  LEFT JOIN users vu ON vu.user_id = o.voided_by
`

const STATUSES: DeliveryStatus[] = ['preparing', 'pending', 'out', 'delivered', 'returned']

const STATUS_LABELS: Record<DeliveryStatus, string> = {
  preparing: 'قيد التحضير',
  pending: 'جاهز — في انتظار سائق',
  out: 'مع السائق',
  delivered: 'تم التسليم',
  returned: 'لم يُسلَّم',
}

/** Today, in the shape SQLite's date() produces. */
function todayStr(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export interface DeliveryFilters {
  /**
   * 'live' is the working view: everything not yet finished with.
   * 'deleted' is the opposite corner — invoices that were removed, which every
   * other view hides on purpose.
   */
  status?: DeliveryStatus | 'live' | 'all' | 'deleted'
  driverId?: number
  /** Inclusive dates on the order's own day, e.g. '2026-09-06'. */
  dateFrom?: string
  dateTo?: string
  /** Only what the driver has not yet paid in. */
  unsettledOnly?: boolean
  /** Phone number, customer name or invoice number. Searches the WHOLE history. */
  search?: string
  limit?: number
}

function whereFor(filters: DeliveryFilters): { sql: string; params: any[] } {
  // A deleted invoice is excluded from every other view by LIVE_ORDER, so asking for
  // deleted ones has to swap that predicate rather than add to it.
  const deletedView = filters.status === 'deleted'
  const conditions = [deletedView ? DELETED_ORDER : LIVE_ORDER]
  const params: any[] = []

  if (filters.status && filters.status !== 'all' && filters.status !== 'deleted') {
    if (filters.status === 'live') {
      // Still the shop's problem: nobody has taken it, or it is in the road.
      conditions.push(`o.delivery_status IN ('preparing','pending','out')`)
    } else {
      conditions.push('o.delivery_status = ?')
      params.push(filters.status)
    }
  }
  if (filters.driverId) {
    conditions.push('o.driver_id = ?')
    params.push(filters.driverId)
  }
  // Looking someone up by phone number means "find this customer", not "find this
  // customer inside the fortnight I happen to be looking at". A search therefore
  // ignores the period entirely — otherwise the answer to "does this number order
  // from us?" depends on a date box the person searching never touched.
  const term = filters.search?.trim()
  if (term) {
    // Digits only for a phone: 0100 123 4567, 0100-123-4567 and 01001234567 are the
    // same number, and the one written on the order is not the one being typed.
    const digits = term.replace(/\D/g, '')
    const like = `%${term}%`
    if (digits.length >= 3) {
      conditions.push(`(
        REPLACE(REPLACE(REPLACE(COALESCE(o.customer_phone,''), ' ', ''), '-', ''), '+', '') LIKE ?
        OR o.customer_name LIKE ?
        OR o.invoice_number LIKE ?
      )`)
      params.push(`%${digits}%`, like, like)
    } else {
      conditions.push(`(o.customer_name LIKE ? OR o.invoice_number LIKE ? OR o.customer_address LIKE ?)`)
      params.push(like, like, like)
    }
  }

  // The period bounds the FINISHED orders only. An order still pending or out is
  // unfinished work whatever day it was rung up on, so it stays on the board until
  // somebody deals with it — an order forgotten last night must not disappear
  // because the date rolled over, which is exactly when it needs to be seen.
  //
  // The deleted view ignores the period as well: "show me what was deleted" is a
  // question about the whole book, and a deleted invoice from last week is exactly
  // the one somebody is looking for.
  const bounded = !term && !deletedView
  const bounds: string[] = []
  if (filters.dateFrom && bounded) {
    bounds.push('date(o.created_at) >= ?')
    params.push(filters.dateFrom)
  }
  if (filters.dateTo && bounded) {
    bounds.push('date(o.created_at) <= ?')
    params.push(filters.dateTo)
  }
  if (bounds.length > 0) {
    conditions.push(`((${bounds.join(' AND ')}) OR o.delivery_status IN ('preparing','pending','out'))`)
  }
  if (filters.unsettledOnly) {
    conditions.push(`o.settlement_id IS NULL AND o.payment_type = 'cash' AND o.delivery_status = 'delivered'`)
  }

  return { sql: `WHERE ${conditions.join(' AND ')}`, params }
}

/**
 * The delivery orders themselves.
 *
 * Ordered oldest-first when looking at live ones — the order that has been waiting
 * longest is the one somebody needs to deal with — and newest-first otherwise,
 * which is how every other history in the app reads.
 */
export function listDeliveryOrders(filters: DeliveryFilters = {}): Order[] {
  const { sql, params } = whereFor(filters)
  const live = !filters.status || filters.status === 'live'
  const limit = Number.isInteger(filters.limit) && (filters.limit as number) > 0
    ? (filters.limit as number)
    : 300

  return getDb().prepare(`
    ${SELECT_ORDER}
    ${sql}
    ORDER BY o.created_at ${live ? 'ASC' : 'DESC'}
    LIMIT ?
  `).all(...params, limit) as Order[]
}

function readOrder(orderId: number): Order {
  const order = getDb().prepare(`${SELECT_ORDER} WHERE o.order_id = ?`).get(orderId) as Order | undefined
  if (!order) throw new Error('الطلب غير موجود')
  return order
}

/** Refuse politely on anything this screen has no business changing. */
function assertChangeable(order: Order): void {
  if (order.order_type !== 'delivery') throw new Error('هذا الطلب ليس طلب توصيل')
  if (order.deleted_at) throw new Error('الفاتورة محذوفة')
  if (order.status === 'voided') throw new Error('الفاتورة ملغاة — لا يمكن تعديل حالة التوصيل')
}

/**
 * Hand an order to a driver.
 *
 * Assigning a driver IS dispatching: nobody takes an order and leaves it on the
 * counter, and making the cashier press a second button to say so only produces a
 * screen full of orders that are "waiting" for a driver who left with them.
 *
 * That holds even while the kitchen still has it. The cashier who picks a driver on
 * a 'preparing' order is saying "this one is his and it has gone" — if it has not,
 * the driver is named on the order at the till instead, which records him without
 * moving the order anywhere.
 *
 * Re-assigning an order that is already out is allowed — the first driver came back
 * with it, or it went on the wrong bike — and it simply changes hands. An order that
 * has already been delivered does not: its money is attributed to whoever delivered
 * it, and moving that after the fact would move the debt too.
 */
export function assignDriver(orderId: number, driverId: number, actorId: number): Order {
  const db = getDb()
  const order = readOrder(orderId)
  assertChangeable(order)

  if (order.delivery_status === 'delivered') {
    throw new Error('الطلب تم تسليمه بالفعل — لا يمكن تغيير السائق بعد التسليم')
  }

  const driver = db.prepare(
    'SELECT driver_id, full_name FROM delivery_drivers WHERE driver_id = ? AND is_active = 1'
  ).get(driverId) as { driver_id: number; full_name: string } | undefined
  if (!driver) throw new Error('السائق غير متاح — اختر سائقاً آخر')

  db.prepare(`
    UPDATE orders
       SET driver_id = ?,
           delivery_status = 'out',
           dispatched_at = COALESCE(dispatched_at, datetime('now','localtime')),
           delivered_at = NULL
     WHERE order_id = ?
  `).run(driver.driver_id, orderId)

  log.info(`[Delivery] Order #${orderId} out with ${driver.full_name} (user ${actorId})`)
  return readOrder(orderId)
}

/**
 * Move an order along its journey.
 *
 * The one hard rule: an order whose cash has already been handed in cannot be moved
 * off 'delivered'. The money is in the till and counted; saying the order never
 * arrived would leave a settlement covering an order that, on paper, was never
 * delivered — and no way to tell which of the two records is the lie.
 */
export function setDeliveryStatus(orderId: number, status: DeliveryStatus, actorId: number): Order {
  const db = getDb()
  if (!STATUSES.includes(status)) throw new Error(`حالة غير معروفة: ${status}`)

  const order = readOrder(orderId)
  assertChangeable(order)

  if (order.settlement_id && status !== 'delivered') {
    throw new Error('تم تحصيل نقدية هذا الطلب من السائق — لا يمكن تغيير حالته')
  }
  if ((status === 'out' || status === 'delivered') && !order.driver_id) {
    throw new Error('اختر السائق أولاً')
  }

  db.prepare(`
    UPDATE orders
       SET delivery_status = ?,
           dispatched_at = CASE
             WHEN ? IN ('out','delivered') THEN COALESCE(dispatched_at, datetime('now','localtime'))
             ELSE dispatched_at END,
           -- Cleared on the way back out of 'delivered', so a mis-tap does not leave
           -- a delivery time on an order that is sitting on the counter again.
           delivered_at = CASE
             WHEN ? = 'delivered' THEN COALESCE(delivered_at, datetime('now','localtime'))
             ELSE NULL END
     WHERE order_id = ?
  `).run(status, status, status, orderId)

  log.info(`[Delivery] Order #${orderId} → ${STATUS_LABELS[status]} (user ${actorId})`)
  return readOrder(orderId)
}

/** Every driver, with what he is carrying and what he owes. */
export function driverBalances(filters: { dateFrom?: string; dateTo?: string } = {}): DriverBalance[] {
  const db = getDb()
  const from = filters.dateFrom ?? todayStr()
  const to = filters.dateTo ?? from

  // The period bounds the DELIVERED figures — a day's work — but never the money
  // owed. Cash from Tuesday that is still in a pocket on Thursday is still missing,
  // and a debt that disappears from the screen because the date moved on is worse
  // than no screen at all.
  return db.prepare(`
    SELECT d.driver_id, d.full_name, d.phone, d.is_active,

      COUNT(CASE WHEN o.delivery_status = 'out' THEN 1 END) AS outCount,
      COALESCE(SUM(CASE WHEN o.delivery_status = 'out' THEN o.total_amount END), 0) AS outValue,

      COUNT(CASE WHEN o.delivery_status = 'delivered' AND o.settlement_id IS NULL
                  AND o.payment_type = 'cash' THEN 1 END) AS unsettledCount,
      COALESCE(SUM(CASE WHEN o.delivery_status = 'delivered' AND o.settlement_id IS NULL
                        THEN ${CASH_OWED} END), 0) AS cashOwed,

      COUNT(CASE WHEN o.delivery_status = 'delivered'
                  AND date(o.created_at) BETWEEN @from AND @to THEN 1 END) AS deliveredCount,
      COALESCE(SUM(CASE WHEN o.delivery_status = 'delivered'
                        AND date(o.created_at) BETWEEN @from AND @to
                        THEN o.total_amount END), 0) AS deliveredValue,
      COUNT(CASE WHEN o.delivery_status = 'returned'
                  AND date(o.created_at) BETWEEN @from AND @to THEN 1 END) AS returnedCount,
      COALESCE(SUM(CASE WHEN o.delivery_status = 'delivered'
                        AND date(o.created_at) BETWEEN @from AND @to
                        THEN o.delivery_fee END), 0) AS feesCollected,

      (SELECT MAX(settled_at) FROM driver_settlements s WHERE s.driver_id = d.driver_id) AS lastSettledAt

    FROM delivery_drivers d
    LEFT JOIN orders o ON o.driver_id = d.driver_id AND ${LIVE_ORDER}
    GROUP BY d.driver_id
    ORDER BY cashOwed DESC, outCount DESC, d.is_active DESC, d.full_name
  `).all({ from, to }) as DriverBalance[]
}

/** The counters across the top of the screen. */
export function deliverySummary(filters: { dateFrom?: string; dateTo?: string } = {}): DeliverySummary {
  const db = getDb()
  const from = filters.dateFrom ?? todayStr()
  const to = filters.dateTo ?? from

  const period = db.prepare(`
    SELECT
      COUNT(CASE WHEN o.delivery_status = 'delivered' THEN 1 END) AS deliveredCount,
      COUNT(CASE WHEN o.delivery_status = 'returned'  THEN 1 END) AS returnedCount,
      COALESCE(SUM(CASE WHEN o.delivery_status = 'delivered' THEN o.total_amount END), 0) AS deliveredValue,
      COUNT(CASE WHEN o.delivery_status IS NULL THEN 1 END) AS untrackedCount
    FROM orders o
    WHERE ${LIVE_ORDER} AND date(o.created_at) BETWEEN ? AND ?
  `).get(from, to) as any

  // Outstanding cash is deliberately NOT bounded by the period — see driverBalances.
  const owed = db.prepare(`
    SELECT COUNT(*) AS unsettledCount, COALESCE(SUM(o.total_amount), 0) AS cashOwed
    FROM orders o
    WHERE ${LIVE_ORDER} AND o.delivery_status = 'delivered'
      AND o.payment_type = 'cash' AND o.settlement_id IS NULL AND o.driver_id IS NOT NULL
  `).get() as any

  // A live order from an earlier day is still outstanding work, whatever period the
  // owner is looking at, so those are counted regardless of the dates.
  const stillOut = db.prepare(`
    SELECT
      COUNT(CASE WHEN o.delivery_status = 'preparing' THEN 1 END) AS preparingCount,
      COUNT(CASE WHEN o.delivery_status = 'pending'   THEN 1 END) AS pendingCount,
      COUNT(CASE WHEN o.delivery_status = 'out'       THEN 1 END) AS outCount
    FROM orders o
    WHERE ${LIVE_ORDER} AND o.delivery_status IN ('preparing','pending','out')
  `).get() as any

  // Deleted invoices are counted over the whole book, not the period: the tab exists
  // to be able to find one, and nobody remembers which day it was deleted on.
  const deleted = db.prepare(`
    SELECT COUNT(*) AS c FROM orders o WHERE ${DELETED_ORDER}
  `).get() as any

  return {
    preparingCount: stillOut.preparingCount,
    pendingCount: stillOut.pendingCount,
    outCount: stillOut.outCount,
    deletedCount: deleted.c,
    deliveredCount: period.deliveredCount,
    returnedCount: period.returnedCount,
    deliveredValue: round2(period.deliveredValue),
    cashOwed: round2(owed.cashOwed),
    unsettledCount: owed.unsettledCount,
    untrackedCount: period.untrackedCount,
  }
}

/** What this driver still has to hand in, oldest first. */
export function unsettledOrders(driverId: number): Order[] {
  return getDb().prepare(`
    ${SELECT_ORDER}
    WHERE ${LIVE_ORDER} AND o.driver_id = ? AND o.delivery_status = 'delivered'
      AND o.payment_type = 'cash' AND o.settlement_id IS NULL
    ORDER BY o.created_at ASC
  `).all(driverId) as Order[]
}

/**
 * The driver puts the money on the counter and it is counted in.
 *
 * `orderIds` is for the half hand-over — a driver settling for five of the eight he
 * is holding, which happens whenever a shift ends mid-round. Omit it and everything
 * outstanding is taken in one go, which is the normal case.
 *
 * The whole thing is one transaction: the receipt and the stamps on the orders it
 * covers are the same fact, and a settlement recording money against orders that
 * were never marked paid-in would be worse than no record.
 */
export function settleDriver(
  driverId: number,
  actorId: number,
  opts: { orderIds?: number[]; note?: string } = {},
): DriverSettlement {
  const db = getDb()

  const driver = db.prepare(
    'SELECT driver_id, full_name FROM delivery_drivers WHERE driver_id = ?'
  ).get(driverId) as { driver_id: number; full_name: string } | undefined
  if (!driver) throw new Error('السائق غير موجود')

  const run = db.transaction((): DriverSettlement => {
    let outstanding = unsettledOrders(driverId)

    if (opts.orderIds && opts.orderIds.length > 0) {
      const wanted = new Set(opts.orderIds.map(Number))
      outstanding = outstanding.filter(o => wanted.has(o.order_id))
    }

    if (outstanding.length === 0) {
      throw new Error(`لا توجد مبالغ مستحقة على ${driver.full_name}`)
    }

    const total = round2(outstanding.reduce((sum, o) => sum + o.total_amount, 0))

    const res = db.prepare(`
      INSERT INTO driver_settlements (driver_id, order_count, total_amount, note, settled_by)
      VALUES (?, ?, ?, ?, ?)
    `).run(driverId, outstanding.length, total, opts.note?.trim() || null, actorId)
    const settlementId = res.lastInsertRowid as number

    const stamp = db.prepare('UPDATE orders SET settlement_id = ? WHERE order_id = ?')
    for (const o of outstanding) stamp.run(settlementId, o.order_id)

    log.info(
      `[Delivery] ${driver.full_name} settled ${outstanding.length} order(s) ` +
      `for ${total} — settlement #${settlementId} by user ${actorId}`
    )

    return getSettlement(settlementId)
  })

  return run()
}

function getSettlement(settlementId: number): DriverSettlement {
  return getDb().prepare(`
    SELECT s.*, d.full_name AS driver_name, u.full_name AS settled_by_name
    FROM driver_settlements s
    JOIN delivery_drivers d ON d.driver_id = s.driver_id
    LEFT JOIN users u ON u.user_id = s.settled_by
    WHERE s.settlement_id = ?
  `).get(settlementId) as DriverSettlement
}

/** The hand-over history — the answer to "when did he last pay in, and how much?" */
export function listSettlements(filters: { driverId?: number; limit?: number } = {}): DriverSettlement[] {
  const conditions: string[] = []
  const params: any[] = []
  if (filters.driverId) {
    conditions.push('s.driver_id = ?')
    params.push(filters.driverId)
  }
  const limit = Number.isInteger(filters.limit) && (filters.limit as number) > 0
    ? (filters.limit as number)
    : 100
  params.push(limit)

  return getDb().prepare(`
    SELECT s.*, d.full_name AS driver_name, u.full_name AS settled_by_name
    FROM driver_settlements s
    JOIN delivery_drivers d ON d.driver_id = s.driver_id
    LEFT JOIN users u ON u.user_id = s.settled_by
    ${conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''}
    ORDER BY s.settled_at DESC, s.settlement_id DESC
    LIMIT ?
  `).all(...params) as DriverSettlement[]
}

/** The orders one settlement covered, for the receipt view. */
export function settlementOrders(settlementId: number): Order[] {
  return getDb().prepare(`
    ${SELECT_ORDER}
    WHERE o.settlement_id = ?
    ORDER BY o.created_at ASC
  `).all(settlementId) as Order[]
}
