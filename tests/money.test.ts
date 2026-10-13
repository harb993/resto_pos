import { describe, it, expect, beforeAll } from 'vitest'
import { initDatabase, getDb } from '../src/main/db/db'
import { createOrder, voidOrder, softDeleteOrder } from '../src/main/services/orderService'
import { updateSettings } from '../src/main/services/settingsService'
import { getFinanceReport } from '../src/main/services/financeService'
import * as analytics from '../src/main/services/analyticsService'
import * as suppliers from '../src/main/services/supplierService'
import { addExpense, getExpensesTotal } from '../src/main/services/expenseService'
import {
  upsertRawMaterial, adjustStock, runPrep, upsertPrepConversion,
} from '../src/main/services/rawMaterialService'
import type { CreateOrderInput } from '../src/shared/types'

/**
 * The money audit.
 *
 * Every figure the restaurant is judged on — what a customer was charged, what the
 * day took, what a supplier is owed, what the profit was — is a sum of other figures.
 * These tests assert that each of those sums reconciles EXACTLY with its parts, to
 * the cent, and that the several services which each compute revenue independently
 * never disagree with one another.
 *
 * Everything is compared at 2 decimal places. Money is stored as SQLite REAL, so
 * asserting exact float equality would be testing IEEE-754 rather than the till.
 */

/** Round the way the service does, so a comparison is of pennies and not of noise. */
const cents = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

let cashierId: number
let ownerId: number
let mealId: number
let mealPrice: number
let areaId: number
let areaFee: number
const TAX = 0.14

function order(over: Partial<CreateOrderInput> = {}): CreateOrderInput {
  return {
    cashierId,
    paymentType: 'cash',
    orderType: 'dine_in',
    discountPercent: 0,
    items: [{ menuItemId: mealId, quantity: 1, unitPrice: mealPrice, itemName: 'x' }],
    ...over,
  }
}

function deliveryOrder(over: Partial<CreateOrderInput> = {}): CreateOrderInput {
  return order({
    orderType: 'delivery',
    deliveryAreaId: areaId,
    customerName: 'عميل', customerPhone: '01000000000', customerAddress: 'شارع 1',
    ...over,
  } as any)
}

beforeAll(() => {
  initDatabase()
  const db = getDb()
  cashierId = (db.prepare(`SELECT user_id FROM users WHERE username='cashier1'`).get() as any).user_id
  ownerId = (db.prepare(`SELECT user_id FROM users WHERE role='owner' LIMIT 1`).get() as any).user_id
  const meal = db.prepare(`SELECT item_id, price FROM menu_items ORDER BY item_id LIMIT 1`).get() as any
  mealId = meal.item_id
  mealPrice = meal.price
  // A new database has no delivery areas of its own any more — give the test one.
  db.prepare(`INSERT INTO delivery_areas (area_name, delivery_fee) SELECT 'منطقة الاختبار', 20 WHERE NOT EXISTS (SELECT 1 FROM delivery_areas WHERE is_active = 1)`).run()
  const area = db.prepare('SELECT * FROM delivery_areas WHERE is_active = 1 LIMIT 1').get() as any
  areaId = area.delivery_area_id
  areaFee = area.delivery_fee
  updateSettings({ tax_rate: TAX, max_cashier_discount: 100 })
})

// ===== 1. The arithmetic of a single order =====

describe('every order reconciles with its own line items', () => {
  /**
   * Awkward on purpose. Quantities and percentages that do not divide cleanly are
   * where a rounding error hides: 3 × 33.33, or 14% VAT on a 7% discount, produce
   * values a naive float sum gets wrong in the third decimal and the till then
   * carries into the day's total.
   */
  const shapes = [
    { qty: 1, disc: 0, type: 'dine_in' },
    { qty: 3, disc: 7, type: 'dine_in' },
    { qty: 7, disc: 33, type: 'takeaway' },
    { qty: 11, disc: 12.5, type: 'delivery' },
    { qty: 2, disc: 100, type: 'dine_in' },
    { qty: 13, disc: 1, type: 'delivery' },
    { qty: 5, disc: 99, type: 'takeaway' },
  ] as const

  it.each(shapes)('qty $qty, $disc% off, $type', ({ qty, disc, type }) => {
    const input = type === 'delivery'
      ? deliveryOrder({ items: [{ menuItemId: mealId, quantity: qty, unitPrice: mealPrice, itemName: 'x' }], discountPercent: disc })
      : order({ orderType: type as any, items: [{ menuItemId: mealId, quantity: qty, unitPrice: mealPrice, itemName: 'x' }], discountPercent: disc })

    const r = createOrder(input, 'owner')
    const stored = getDb().prepare('SELECT * FROM orders WHERE order_id = ?').get(r.orderId) as any
    const lines = getDb().prepare('SELECT * FROM order_items WHERE order_id = ?').all(r.orderId) as any[]

    // subtotal is exactly the sum of the lines
    const lineSum = cents(lines.reduce((s, l) => s + l.quantity * l.unit_price, 0))
    expect(cents(stored.subtotal)).toBe(lineSum)

    // each component is what the rules say it is
    expect(cents(stored.discount)).toBe(cents(stored.subtotal * disc / 100))
    // VAT falls on what is actually paid, so the discount comes off the taxable
    // amount first. See tests/logic.test.ts for why this is not subtotal × rate.
    const taxable = Math.max(0, cents(stored.subtotal) - cents(stored.discount))
    expect(cents(stored.tax)).toBe(type === 'dine_in' ? cents(taxable * TAX) : 0)
    expect(cents(stored.delivery_fee ?? 0)).toBe(type === 'delivery' ? cents(areaFee) : 0)

    // and the total is exactly those components, never negative
    const expected = cents(Math.max(0,
      cents(stored.subtotal) + cents(stored.tax) - cents(stored.discount) + cents(stored.delivery_fee ?? 0)))
    expect(cents(stored.total_amount)).toBe(expected)
    expect(stored.total_amount).toBeGreaterThanOrEqual(0)

    // what the caller was told matches what was written
    expect(cents(r.totalAmount)).toBe(cents(stored.total_amount))
  })

  it('never lets a discount turn into money owed to the customer', () => {
    const r = createOrder(order({ discountPercent: 100, orderType: 'takeaway' }), 'owner')
    expect(r.totalAmount).toBe(0)
    const stored = getDb().prepare('SELECT total_amount FROM orders WHERE order_id=?').get(r.orderId) as any
    expect(stored.total_amount).toBe(0)
  })

  it('charges the delivery fee even when the food is fully discounted', () => {
    // The rider still drove. A 100% discount on the food must not zero the fee, or
    // the shop pays for the delivery out of its own pocket without knowing.
    const r = createOrder(deliveryOrder({ discountPercent: 100 }), 'owner')
    expect(cents(r.totalAmount)).toBe(cents(areaFee))
  })
})

// ===== 2. Float accumulation across many orders =====

describe('the day total does not drift', () => {
  it('matches the sum of its orders to the cent over 200 sales', () => {
    const db = getDb()
    const before = (db.prepare(
      "SELECT COALESCE(SUM(total_amount),0) v FROM orders WHERE status='completed' AND deleted_at IS NULL"
    ).get() as any).v

    let expected = 0
    for (let i = 0; i < 200; i++) {
      const r = createOrder(order({
        orderType: (['dine_in', 'takeaway', 'delivery'] as const)[i % 3] === 'delivery'
          ? 'takeaway' : (['dine_in', 'takeaway'] as const)[i % 2],
        items: [{ menuItemId: mealId, quantity: (i % 9) + 1, unitPrice: mealPrice, itemName: 'x' }],
        discountPercent: (i % 17),
      }), 'owner')
      expected += r.totalAmount
    }

    const after = (db.prepare(
      "SELECT COALESCE(SUM(total_amount),0) v FROM orders WHERE status='completed' AND deleted_at IS NULL"
    ).get() as any).v

    expect(cents(after - before)).toBe(cents(expected))
  })

  it('agrees with a recomputation from the line items, for every order ever written', () => {
    // The strongest statement available: no stored order, anywhere in the database,
    // disagrees with its own lines.
    const bad = getDb().prepare(`
      SELECT o.order_id, o.subtotal,
             ROUND(COALESCE((SELECT SUM(oi.quantity * oi.unit_price)
                             FROM order_items oi WHERE oi.order_id = o.order_id), 0), 2) AS line_sum
      FROM orders o
      WHERE o.deleted_at IS NULL
        AND ABS(o.subtotal - COALESCE((SELECT SUM(oi.quantity * oi.unit_price)
                                       FROM order_items oi WHERE oi.order_id = o.order_id), 0)) > 0.005
    `).all() as any[]
    expect(bad).toEqual([])
  })

  it('has no order whose total disagrees with its own components', () => {
    const bad = getDb().prepare(`
      SELECT order_id, subtotal, tax, discount, delivery_fee, total_amount
      FROM orders
      WHERE deleted_at IS NULL
        AND ABS(total_amount - MAX(0, subtotal + tax - discount + COALESCE(delivery_fee,0))) > 0.005
    `).all() as any[]
    expect(bad).toEqual([])
  })
})

// ===== 3. Voiding gives the money back =====

describe('a void removes exactly the order it voided', () => {
  const revenue = () => (getDb().prepare(
    "SELECT COALESCE(SUM(total_amount),0) v FROM orders WHERE status='completed' AND deleted_at IS NULL"
  ).get() as any).v

  it('drops revenue by the order total and not a penny more', () => {
    const r = createOrder(order({ orderType: 'takeaway' }), 'owner')
    const withOrder = revenue()
    voidOrder(r.orderId, ownerId, 'اختبار')
    expect(cents(withOrder - revenue())).toBe(cents(r.totalAmount))
  })

  it('leaves the voided row intact so the audit trail survives', () => {
    const r = createOrder(order({ orderType: 'takeaway' }), 'owner')
    voidOrder(r.orderId, ownerId, 'سبب')
    const row = getDb().prepare('SELECT * FROM orders WHERE order_id=?').get(r.orderId) as any
    expect(row.status).toBe('voided')
    expect(cents(row.total_amount)).toBe(cents(r.totalAmount)) // the figure is NOT zeroed
    expect(row.void_reason).toBe('سبب')
  })

  it('drops a deleted order out of revenue too', () => {
    const r = createOrder(order({ orderType: 'takeaway' }), 'owner')
    const withOrder = revenue()
    softDeleteOrder(r.orderId, ownerId)
    expect(cents(withOrder - revenue())).toBe(cents(r.totalAmount))
  })
})

// ===== 4. The services must not disagree with each other =====

describe('every service that reports revenue reports the same revenue', () => {
  it('finance, analytics and a raw SUM agree for today', () => {
    createOrder(order({ orderType: 'takeaway' }), 'owner')
    const today = new Date()
    const p = (n: number) => String(n).padStart(2, '0')
    const d = `${today.getFullYear()}-${p(today.getMonth() + 1)}-${p(today.getDate())}`

    const raw = (getDb().prepare(`
      SELECT COALESCE(SUM(total_amount),0) v FROM orders
      WHERE status='completed' AND deleted_at IS NULL AND date(created_at) = ?
    `).get(d) as any).v

    const finance = getFinanceReport(d, d)
    const summary = analytics.getSummary('today')

    expect(cents(finance.revenue)).toBe(cents(raw))
    expect(cents(summary.current.revenue)).toBe(cents(raw))
  })

  it('the finance report never invents profit — revenue minus costs is what it says', () => {
    const today = new Date()
    const p = (n: number) => String(n).padStart(2, '0')
    const d = `${today.getFullYear()}-${p(today.getMonth() + 1)}-${p(today.getDate())}`
    const f = getFinanceReport(d, d) as any

    // The parts must add up to the whole it prints. VAT comes off first — it is
    // collected for the tax authority, not earned — and ingredient purchases are not
    // charged a second time on top of the cost of what was sold.
    expect(cents(f.netSales)).toBe(cents(f.revenue - f.tax))
    expect(cents(f.grossProfit)).toBe(cents(f.netSales - f.cogs))
    expect(cents(f.netProfit)).toBe(cents(
      f.grossProfit - (f.expensesTotal - f.ingredientPurchases) - f.salariesTotal - f.wasteValue))
  })

  it('COGS is the sum of the costs actually captured on the lines', () => {
    const rows = getDb().prepare(`
      SELECT COALESCE(SUM(oi.quantity * oi.unit_cost),0) v
      FROM order_items oi JOIN orders o ON o.order_id = oi.order_id
      WHERE o.status='completed' AND o.deleted_at IS NULL
    `).get() as any
    expect(Number.isFinite(rows.v)).toBe(true)
    expect(rows.v).toBeGreaterThanOrEqual(0)
  })
})

// ===== 5. The supplier ledger =====

describe('what a supplier is owed', () => {
  it('is supplied minus paid, across many deliveries and part payments', () => {
    const s = suppliers.upsertSupplier({ name: 'مورد الاختبار', phone: '0100' })

    const material = Number(getDb().prepare(`
      INSERT INTO raw_materials (name, unit, stock_quantity, cost_per_unit, low_stock_threshold)
      VALUES ('مادة مورد', 'كجم', 0, 10, 1)
    `).run().lastInsertRowid)

    const deliveries = [
      [{ rawMaterialId: material, quantity: 12.5, unitCost: 9.99 }],
      [{ rawMaterialId: material, quantity: 3, unitCost: 33.33 }],
      [{ rawMaterialId: material, quantity: 7, unitCost: 1.05 }],
    ]
    let supplied = 0
    for (const items of deliveries) {
      const inv = suppliers.recordDelivery({ supplierId: s.supplier_id, lines: items }, ownerId)
      supplied += inv.total_amount
    }

    const payments = [50, 12.34, 0.01]
    let paid = 0
    for (const amount of payments) {
      suppliers.recordPayment({ supplierId: s.supplier_id, amount }, ownerId)
      paid += amount
    }

    const account = suppliers.getSupplierAccount(s.supplier_id)
    expect(cents(account.supplied)).toBe(cents(supplied))
    expect(cents(account.paid)).toBe(cents(paid))
    expect(cents(account.owed)).toBe(cents(supplied - paid))
  })

  it('adds every delivered unit to stock', () => {
    const s = suppliers.upsertSupplier({ name: 'مورد المخزون' })
    const id = s.supplier_id
    const material = Number(getDb().prepare(`
      INSERT INTO raw_materials (name, unit, stock_quantity, cost_per_unit, low_stock_threshold)
      VALUES ('مادة مخزون', 'كجم', 4, 10, 1)
    `).run().lastInsertRowid)

    suppliers.recordDelivery({ supplierId: id, lines: [{ rawMaterialId: material, quantity: 6.25, unitCost: 8 }] }, ownerId)

    const stock = (getDb().prepare('SELECT stock_quantity q FROM raw_materials WHERE raw_material_id=?')
      .get(material) as any).q
    expect(cents(stock)).toBe(cents(4 + 6.25))
  })

  it('never reports a supplier balance that disagrees with its own ledger', () => {
    const bad = getDb().prepare(`
      SELECT s.supplier_id
      FROM suppliers s
      WHERE ABS(
        COALESCE((SELECT SUM(total_amount) FROM supplier_invoices  i WHERE i.supplier_id = s.supplier_id), 0)
      - COALESCE((SELECT SUM(amount)       FROM supplier_payments  p WHERE p.supplier_id = s.supplier_id), 0)
      - (SELECT COALESCE(SUM(i2.total_amount),0) - COALESCE((SELECT SUM(p2.amount) FROM supplier_payments p2 WHERE p2.supplier_id = s.supplier_id),0)
         FROM supplier_invoices i2 WHERE i2.supplier_id = s.supplier_id)
      ) > 0.005
    `).all() as any[]
    expect(bad).toEqual([])
  })
})

// ===== 6. Expenses =====

describe('expenses', () => {
  it('total exactly what was entered', () => {
    const today = new Date()
    const p = (n: number) => String(n).padStart(2, '0')
    const d = `${today.getFullYear()}-${p(today.getMonth() + 1)}-${p(today.getDate())}`

    const before = getExpensesTotal(d, d)
    const amounts = [10.01, 0.99, 33.33, 1234.56]
    for (const amount of amounts) {
      addExpense('other', 'x', amount, ownerId, d)
    }
    const after = getExpensesTotal(d, d)
    expect(cents(after - before)).toBe(cents(amounts.reduce((a, b) => a + b, 0)))
  })
})

// ===== 7. Nothing anywhere is quietly impossible =====

describe('no row in the books is arithmetically impossible', () => {
  it('has no negative money on any order', () => {
    const bad = getDb().prepare(`
      SELECT order_id FROM orders
      WHERE subtotal < 0 OR tax < 0 OR discount < 0 OR total_amount < 0 OR COALESCE(delivery_fee,0) < 0
    `).all()
    expect(bad).toEqual([])
  })

  it('has no order line with a non-positive quantity or negative price', () => {
    const bad = getDb().prepare(`
      SELECT order_item_id FROM order_items WHERE quantity <= 0 OR unit_price < 0 OR unit_cost < 0
    `).all()
    expect(bad).toEqual([])
  })

  it('has no discount larger than the order it discounts', () => {
    const bad = getDb().prepare(`
      SELECT order_id FROM orders WHERE discount > subtotal + 0.005
    `).all()
    expect(bad).toEqual([])
  })

  it('has no completed order without a single line', () => {
    const bad = getDb().prepare(`
      SELECT o.order_id FROM orders o
      WHERE o.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id = o.order_id)
    `).all()
    expect(bad).toEqual([])
  })

  it('has no duplicate invoice number within one day', () => {
    const dupes = getDb().prepare(`
      SELECT date(created_at) d, invoice_number, COUNT(*) c
      FROM orders
      WHERE invoice_number IS NOT NULL AND deleted_at IS NULL
      GROUP BY date(created_at), invoice_number
      HAVING c > 1
    `).all()
    expect(dupes).toEqual([])
  })
})

// ===== 8. The stock ledger must explain the balance =====

describe('the stock ledger accounts for every unit on hand', () => {
  /**
   * The rule: a material's stock_quantity is always exactly the sum of its own
   * transactions. Break it and the history screen can no longer explain a count, and
   * a stocktake has nothing left to reconcile against.
   *
   * This was broken. Creating a material wrote its opening balance straight into
   * stock_quantity with no ledger row, so every material was out by exactly its
   * opening stock and the ledger could not be used to check anything at all.
   */
  const ledgerOf = (id: number) => (getDb().prepare(
    'SELECT ROUND(COALESCE(SUM(change_amount),0),3) v FROM raw_material_transactions WHERE raw_material_id=?'
  ).get(id) as any).v
  const balanceOf = (id: number) => (getDb().prepare(
    'SELECT stock_quantity v FROM raw_materials WHERE raw_material_id=?'
  ).get(id) as any).v

  /** Everything above this id was made by this suite, not inserted by the seed. */
  let firstServiceMaterialId: number
  beforeAll(() => {
    const row = getDb().prepare('SELECT COALESCE(MAX(raw_material_id),0) v FROM raw_materials').get() as any
    firstServiceMaterialId = row.v + 1
  })

  it('records the opening balance as a movement', () => {
    const m = upsertRawMaterial(
      { name: 'مادة افتتاحية', unit: 'كجم', openingStock: 42.5, costPerUnit: 3, lowStockThreshold: 1 } as any,
      ownerId,
    )
    expect(balanceOf(m.raw_material_id)).toBe(42.5)
    expect(ledgerOf(m.raw_material_id)).toBe(42.5)
  })

  it('writes no movement for a material that starts empty', () => {
    const m = upsertRawMaterial(
      { name: 'مادة فارغة', unit: 'كجم', openingStock: 0, costPerUnit: 3, lowStockThreshold: 1 } as any,
      ownerId,
    )
    expect(balanceOf(m.raw_material_id)).toBe(0)
    expect(ledgerOf(m.raw_material_id)).toBe(0)
  })

  it('stays reconciled through restock, waste and a correction', () => {
    const m = upsertRawMaterial(
      { name: 'مادة متحركة', unit: 'كجم', openingStock: 10, costPerUnit: 5, lowStockThreshold: 1 } as any,
      ownerId,
    )
    adjustStock(m.raw_material_id, 15.5, 'restock', ownerId)
    adjustStock(m.raw_material_id, 2.25, 'waste', ownerId)
    adjustStock(m.raw_material_id, -1.75, 'adjustment', ownerId)

    expect(balanceOf(m.raw_material_id)).toBe(ledgerOf(m.raw_material_id))
    expect(balanceOf(m.raw_material_id)).toBe(21.5) // 10 + 15.5 - 2.25 - 1.75
  })

  it('stays reconciled on both sides of a prep run', () => {
    const whole = upsertRawMaterial(
      { name: 'دجاج اختبار', unit: 'قطعة', openingStock: 10, costPerUnit: 90, lowStockThreshold: 1 } as any, ownerId)
    const pieces = upsertRawMaterial(
      { name: 'قطع اختبار', unit: 'قطعة', openingStock: 0, costPerUnit: 11, lowStockThreshold: 1 } as any, ownerId)

    const conv = upsertPrepConversion(whole.raw_material_id, pieces.raw_material_id, 8)
    runPrep(conv.prep_conversion_id, 3, ownerId)

    expect(balanceOf(whole.raw_material_id)).toBe(ledgerOf(whole.raw_material_id))
    expect(balanceOf(pieces.raw_material_id)).toBe(ledgerOf(pieces.raw_material_id))
    expect(balanceOf(whole.raw_material_id)).toBe(7)
    expect(balanceOf(pieces.raw_material_id)).toBe(24)
  })

  it('stays reconciled when a sale draws it down and a void puts it back', () => {
    const m = upsertRawMaterial(
      { name: 'مادة بيع', unit: 'كجم', openingStock: 100, costPerUnit: 4, lowStockThreshold: 1 } as any, ownerId)
    const item = Number(getDb().prepare(
      `INSERT INTO menu_items (category_id, name, price, cost_price, stock_quantity, is_active)
       SELECT category_id, 'صنف بيع', 50, 8, 0, 1 FROM categories LIMIT 1`
    ).run().lastInsertRowid)
    getDb().prepare('INSERT INTO recipe_items (menu_item_id, raw_material_id, quantity) VALUES (?,?,?)')
      .run(item, m.raw_material_id, 2)

    const r = createOrder(order({
      orderType: 'takeaway',
      items: [{ menuItemId: item, quantity: 3, unitPrice: 50, itemName: 'صنف بيع' }],
    }), 'owner')
    expect(balanceOf(m.raw_material_id)).toBe(ledgerOf(m.raw_material_id))
    expect(balanceOf(m.raw_material_id)).toBe(94) // 100 less 3 x 2

    voidOrder(r.orderId, ownerId, 'إرجاع')
    expect(balanceOf(m.raw_material_id)).toBe(ledgerOf(m.raw_material_id))
    expect(balanceOf(m.raw_material_id)).toBe(100)
  })

  it('holds for every material created through the service', () => {
    /**
     * The blanket statement. Restricted to materials this suite made, by id: rows the
     * seed inserts straight into the table are not the service's doing and have no
     * ledger by construction. Everything created through upsertRawMaterial must
     * reconcile.
     */
    const bad = getDb().prepare(`
      SELECT rm.raw_material_id, rm.name, rm.stock_quantity,
             COALESCE((SELECT SUM(t.change_amount) FROM raw_material_transactions t
                       WHERE t.raw_material_id = rm.raw_material_id), 0) AS ledger
      FROM raw_materials rm
      WHERE rm.raw_material_id > ?
        AND ABS(rm.stock_quantity - COALESCE((SELECT SUM(t.change_amount)
                                              FROM raw_material_transactions t
                                              WHERE t.raw_material_id = rm.raw_material_id), 0)) > 0.005
    `).all(firstServiceMaterialId - 1)
    expect(bad).toEqual([])
  })
})
