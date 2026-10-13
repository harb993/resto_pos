import { getDb } from '../db/db'
import type { Customer, CustomerOrder } from '../../shared/types'

/**
 * The delivery client book.
 *
 * Built by grouping delivery orders on the phone number rather than kept as its own
 * table. That means it can never drift out of step with what was actually sold, it
 * covers every delivery order ever taken including those from before this existed,
 * and there is no second copy of a customer's details to go stale.
 *
 * The phone number is the identity: it is what the cashier asks for first, and it is
 * the one field a repeat customer always gives the same way.
 *
 * One addition: customers CARRIED OVER from other books (the `customers` table). A
 * shop that starts its books again leaves its invoices behind, and would otherwise
 * lose every customer with them. Those rows hold who the customer is and what they had
 * ordered up to then; whatever they order here is added on top, and the moment they do
 * order, the details on that newest order are the ones shown.
 */

const LIVE = `o.status = 'completed' AND o.deleted_at IS NULL
              AND o.order_type = 'delivery'
              AND o.customer_phone IS NOT NULL AND TRIM(o.customer_phone) != ''`

/**
 * Every customer once, with their figures: the orders in this database plus whatever
 * was carried over. Used as a sub-select so searching and counting read the same book.
 */
const BOOK = `
  SELECT
    b.phone AS phone,
    -- The details from their most recent order are the ones worth showing; a customer
    -- who has not ordered here yet shows what was carried over.
    COALESCE((SELECT o2.customer_name FROM orders o2
               WHERE o2.customer_phone = b.phone AND o2.customer_name IS NOT NULL
               ORDER BY o2.created_at DESC LIMIT 1), c.name)            AS name,
    COALESCE((SELECT o2.customer_address FROM orders o2
               WHERE o2.customer_phone = b.phone AND o2.customer_address IS NOT NULL
               ORDER BY o2.created_at DESC LIMIT 1), c.address)         AS address,
    COALESCE((SELECT o2.delivery_area_id FROM orders o2
               WHERE o2.customer_phone = b.phone AND o2.delivery_area_id IS NOT NULL
               ORDER BY o2.created_at DESC LIMIT 1), c.delivery_area_id) AS delivery_area_id,
    COALESCE(l.n, 0) + COALESCE(c.prior_orders, 0)                       AS order_count,
    ROUND(COALESCE(l.spent, 0) + COALESCE(c.prior_spent, 0), 2)          AS total_spent,
    COALESCE(l.last_at, c.last_order_at, c.created_at)                   AS last_order_at,
    COALESCE(c.first_order_at, l.first_at, c.created_at)                 AS first_order_at
  FROM (
    SELECT o.customer_phone AS phone FROM orders o WHERE ${LIVE}
    UNION
    SELECT phone FROM customers
  ) b
  LEFT JOIN (
    SELECT o.customer_phone AS phone, COUNT(*) AS n, SUM(o.total_amount) AS spent,
           MAX(o.created_at) AS last_at, MIN(o.created_at) AS first_at
    FROM orders o WHERE ${LIVE} GROUP BY o.customer_phone
  ) l ON l.phone = b.phone
  LEFT JOIN customers c ON c.phone = b.phone`

export function listCustomers(filters: { search?: string; limit?: number } = {}): Customer[] {
  const db = getDb()
  const params: any[] = []

  let where = '1 = 1'
  if (filters.search && filters.search.trim()) {
    // Matches a partial phone, part of a name, or part of an address.
    const term = `%${filters.search.trim()}%`
    where = `(k.phone LIKE ? OR k.name LIKE ? OR k.address LIKE ?)`
    params.push(term, term, term)
  }

  const limit = Number.isInteger(filters.limit) && (filters.limit as number) > 0
    ? (filters.limit as number) : 300
  params.push(limit)

  return db.prepare(`
    SELECT k.*,
      (SELECT da.area_name FROM delivery_areas da
        WHERE da.delivery_area_id = k.delivery_area_id) AS area_name,
      CASE WHEN k.order_count > 0 THEN ROUND(k.total_spent / k.order_count, 2) ELSE 0 END AS average_order
    FROM (${BOOK}) k
    WHERE ${where}
    ORDER BY k.last_order_at DESC
    LIMIT ?
  `).all(...params) as Customer[]
}

/** One customer by phone — what the POS uses to fill the delivery form. */
export function getCustomerByPhone(phone: string): Customer | undefined {
  const clean = String(phone ?? '').trim()
  if (!clean) return undefined
  const rows = listCustomers({ search: clean, limit: 50 })
  // listCustomers matches partially; an exact phone match is what identifies them.
  return rows.find(r => r.phone === clean)
}

/** Everything a given customer has ordered, newest first. */
export function getCustomerOrders(phone: string, limit = 100): CustomerOrder[] {
  const db = getDb()
  const clean = String(phone ?? '').trim()
  if (!clean) return []

  const safeLimit = Number.isInteger(limit) && limit > 0 ? limit : 100

  return db.prepare(`
    SELECT o.order_id, o.invoice_number, o.created_at, o.total_amount, o.payment_type,
           o.status, o.customer_address, da.area_name,
           (SELECT COALESCE(SUM(oi.quantity), 0) FROM order_items oi WHERE oi.order_id = o.order_id) AS item_count,
           (SELECT GROUP_CONCAT(mi.name, ' · ')
              FROM order_items oi JOIN menu_items mi ON mi.item_id = oi.menu_item_id
             WHERE oi.order_id = o.order_id) AS items_summary
    FROM orders o
    LEFT JOIN delivery_areas da ON da.delivery_area_id = o.delivery_area_id
    WHERE o.customer_phone = ? AND o.deleted_at IS NULL AND o.order_type = 'delivery'
    ORDER BY o.created_at DESC
    LIMIT ?
  `).all(clean, safeLimit) as CustomerOrder[]
}

/** Headline numbers for the client book. */
export function getCustomerStats(): {
  totalCustomers: number
  repeatCustomers: number
  totalRevenue: number
} {
  const db = getDb()
  const row = db.prepare(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN k.order_count > 1 THEN 1 ELSE 0 END) AS repeats,
           ROUND(SUM(k.total_spent), 2) AS revenue
    FROM (${BOOK}) k
  `).get() as any

  return {
    totalCustomers: row.total ?? 0,
    repeatCustomers: row.repeats ?? 0,
    totalRevenue: row.revenue ?? 0,
  }
}
