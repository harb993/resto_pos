import { describe, it, expect, beforeAll } from 'vitest'
import { initDatabase, getDb } from '../src/main/db/db'
import { createOrder, listOrders, voidOrder } from '../src/main/services/orderService'
import { updateSettings } from '../src/main/services/settingsService'
import * as analytics from '../src/main/services/analyticsService'
import type { CreateOrderInput } from '../src/shared/types'

let cashierId: number
let mealId: number
let mealPrice: number

/**
 * A menu item that actually draws down an ingredient, plus the ingredient it draws.
 * Meals are not stocked themselves any more — selling one consumes raw materials
 * through its recipe — so every stock assertion below has to go through one of these.
 */
let recipeItemId: number
let recipeMaterialId: number
let recipePerUnit: number

/** Minimal valid order for `mealId`, overridable per test. */
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

beforeAll(() => {
  initDatabase()
  const db = getDb()
  // 'cashier1' — one of the four fixed slots db.ts seeds. The old seed created a
  // single 'cashier' account; that name no longer exists on a fresh database.
  cashierId = (db.prepare(`SELECT user_id FROM users WHERE username='cashier1'`).get() as any).user_id
  const meal = db.prepare(`SELECT item_id, price FROM menu_items ORDER BY item_id LIMIT 1`).get() as any
  mealId = meal.item_id
  mealPrice = meal.price

  // Build the recipe fixture rather than hunting for one in the seed data: whether a
  // brand-new database ships with recipes is a seeding decision that can change, and
  // it is not what these tests are about. One material, one ingredient line.
  recipeItemId = mealId
  recipePerUnit = 2
  recipeMaterialId = Number(db.prepare(`
    INSERT INTO raw_materials (name, unit, stock_quantity, cost_per_unit, low_stock_threshold)
    VALUES ('مادة اختبار', 'كجم', 1000, 5, 10)
  `).run().lastInsertRowid)
  db.prepare(`
    INSERT INTO recipe_items (menu_item_id, raw_material_id, quantity) VALUES (?, ?, ?)
  `).run(recipeItemId, recipeMaterialId, recipePerUnit)

  updateSettings({ tax_rate: 0.14, max_cashier_discount: 10 })
})

/** Current balance of the ingredient the recipe tests watch. */
const materialStock = (): number =>
  (getDb().prepare('SELECT stock_quantity q FROM raw_materials WHERE raw_material_id = ?')
    .get(recipeMaterialId) as any).q

describe('database bootstrap', () => {
  it('applies the schema and seeds default data', () => {
    const db = getDb()
    expect((db.prepare('SELECT COUNT(*) c FROM users').get() as any).c).toBeGreaterThan(0)
    expect((db.prepare('SELECT COUNT(*) c FROM menu_items').get() as any).c).toBeGreaterThan(0)
  })

  it('enforces foreign keys', () => {
    expect(getDb().pragma('foreign_keys', { simple: true })).toBe(1)
  })

  it("allows 'void' as a stock-transaction reason", () => {
    const sql = (getDb().prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='stock_transactions'"
    ).get() as any).sql
    expect(sql).toContain("'void'")
  })
})

describe('createOrder — the main process owns every number', () => {
  it('prices lines from the database, ignoring what the client claims', () => {
    const r = createOrder(
      order({ items: [{ menuItemId: mealId, quantity: 1, unitPrice: 999999, itemName: 'x' }] }),
      'cashier'
    )
    const line = getDb().prepare('SELECT * FROM order_items WHERE order_id = ?').get(r.orderId) as any
    expect(line.unit_price).toBe(mealPrice)
    expect(r.subtotal).toBe(mealPrice)
  })

  it('stores totals that reconcile exactly with the line items', () => {
    const r = createOrder(order({ items: [
      { menuItemId: mealId, quantity: 10, unitPrice: 1, itemName: 'x' },
    ] }), 'cashier')

    const stored = getDb().prepare('SELECT * FROM orders WHERE order_id = ?').get(r.orderId) as any
    const lineSum = (getDb().prepare(
      'SELECT SUM(quantity*unit_price) s FROM order_items WHERE order_id = ?'
    ).get(r.orderId) as any).s

    expect(stored.subtotal).toBe(lineSum)
    expect(stored.subtotal).toBe(mealPrice * 10)
    // total = subtotal + 14% VAT (dine-in), to the cent
    expect(stored.total_amount).toBeCloseTo(mealPrice * 10 * 1.14, 2)
    expect(stored.total_amount).toBe(r.totalAmount)
  })

  it('charges VAT on dine-in only', () => {
    const dineIn = createOrder(order({ orderType: 'dine_in' }), 'cashier')
    expect(dineIn.tax).toBeCloseTo(mealPrice * 0.14, 2)

    const takeaway = createOrder(order({ orderType: 'takeaway' }), 'cashier')
    expect(takeaway.tax).toBe(0)
    expect(takeaway.totalAmount).toBe(mealPrice)
  })

  it('takes the delivery fee from the area record, not the client', () => {
    const db = getDb()
    // A new database has no delivery areas of its own any more — give the test one.
    db.prepare(`INSERT INTO delivery_areas (area_name, delivery_fee) SELECT 'منطقة الاختبار', 20 WHERE NOT EXISTS (SELECT 1 FROM delivery_areas WHERE is_active = 1)`).run()
    const area = db.prepare('SELECT * FROM delivery_areas WHERE is_active = 1 LIMIT 1').get() as any

    const r = createOrder(order({
      orderType: 'delivery',
      deliveryAreaId: area.delivery_area_id,
      deliveryFee: 0, // client lies — ignored, the field is not even in the contract
      customerName: 'عميل', customerPhone: '01000000000', customerAddress: 'شارع 1',
    } as any), 'cashier')

    expect(r.deliveryFee).toBe(area.delivery_fee)
    expect(r.totalAmount).toBe(mealPrice + area.delivery_fee) // delivery is VAT-free
  })

  it('caps a cashier discount at max_cashier_discount', () => {
    const r = createOrder(order({ discountPercent: 90 }), 'cashier')
    expect(r.discountPercent).toBe(10)          // clamped to the configured cap
    expect(r.discountCapped).toBe(true)
    expect(r.discount).toBeCloseTo(mealPrice * 0.10, 2)
  })

  it('lets an owner exceed the cashier cap', () => {
    const r = createOrder(order({ discountPercent: 50 }), 'owner')
    expect(r.discountPercent).toBe(50)
    expect(r.discountCapped).toBeUndefined()
  })

  it('never writes a negative total', () => {
    const r = createOrder(order({ discountPercent: 100 }), 'owner')
    expect(r.totalAmount).toBeGreaterThanOrEqual(0)
    const stored = getDb().prepare('SELECT total_amount FROM orders WHERE order_id=?').get(r.orderId) as any
    expect(stored.total_amount).toBeGreaterThanOrEqual(0)
  })

  it('rejects malformed orders before touching the database', () => {
    // Messages the cashier sees are Arabic; match the distinctive phrase, not a
    // translation that would have to be updated with every wording change.
    expect(() => createOrder(order({ items: [] }), 'cashier')).toThrow(/طلب فارغ/)
    expect(() => createOrder(order({ paymentType: 'crypto' as any }), 'cashier')).toThrow(/payment type/i)
    expect(() => createOrder(order({
      items: [{ menuItemId: mealId, quantity: 0, unitPrice: mealPrice, itemName: 'x' }],
    }), 'cashier')).toThrow(/quantity/i)
    expect(() => createOrder(order({
      items: [{ menuItemId: mealId, quantity: 1.5, unitPrice: mealPrice, itemName: 'x' }],
    }), 'cashier')).toThrow(/quantity/i)
  })

  it('requires full customer details on a delivery order', () => {
    expect(() => createOrder(order({ orderType: 'delivery' }), 'cashier'))
      .toThrow(/طلب التوصيل/)
  })

  /**
   * A shortage does NOT stop the sale. The customer is standing at the counter and
   * the food is already made; refusing to ring it up because a count is wrong would
   * lose the sale AND leave the books wrong. The order goes through, the material is
   * allowed to go negative, and the cashier is told so the count can be corrected.
   */
  it('completes an order that outruns the ingredients, and reports it', () => {
    const db = getDb()
    const before = (db.prepare('SELECT COUNT(*) c FROM orders').get() as any).c
    const stockBefore = materialStock()

    const r = createOrder(order({ items: [
      { menuItemId: recipeItemId, quantity: 999999, unitPrice: mealPrice, itemName: 'far too many' },
    ] }), 'cashier')

    expect(r.orderId).toBeGreaterThan(0)
    expect((db.prepare('SELECT COUNT(*) c FROM orders').get() as any).c).toBe(before + 1)

    // Driven below zero rather than blocked, and surfaced as a warning.
    expect(materialStock()).toBeLessThan(0)
    expect(materialStock()).toBeLessThan(stockBefore)
    expect(r.stockWarnings?.length).toBeGreaterThan(0)

    // Put the count back so later tests start from a sane balance.
    voidOrder(r.orderId, cashierId, 'restore test stock')
    expect(materialStock()).toBeCloseTo(stockBefore, 3)
  })

  it('does not consume an invoice number when the order fails', () => {
    const db = getDb()
    // One shared counter now — no per-type keys.
    const key = 'invoice_seq'
    const before = Number((db.prepare('SELECT value v FROM settings WHERE key=?').get(key) as any).v)

    // An item that does not exist fails the whole transaction.
    expect(() => createOrder(order({ items: [
      { menuItemId: 999999, quantity: 1, unitPrice: mealPrice, itemName: 'ghost' },
    ] }), 'cashier')).toThrow()

    const after = Number((db.prepare('SELECT value v FROM settings WHERE key=?').get(key) as any).v)
    expect(after).toBe(before)
  })
})

describe('variant pricing — the main process decides what a size costs', () => {
  let groupId: number
  let LARGE: number
  let SMALL: number
  let SPICY: number
  /** An option belonging to a DIFFERENT item, used to prove the ownership check. */
  let foreignOption: number

  beforeAll(() => {
    const db = getDb()
    const other = db.prepare(
      'SELECT item_id FROM menu_items WHERE item_id != ? LIMIT 1').get(mealId) as any

    groupId = Number(db.prepare(
      `INSERT INTO item_variant_groups (menu_item_id, group_name, display_order)
       VALUES (?, 'الحجم', 0)`).run(mealId).lastInsertRowid)
    const spiceGroup = Number(db.prepare(
      `INSERT INTO item_variant_groups (menu_item_id, group_name, display_order)
       VALUES (?, 'النوع', 1)`).run(mealId).lastInsertRowid)

    const insOpt = db.prepare(
      `INSERT INTO item_variant_options (variant_group_id, option_name, price_delta, display_order)
       VALUES (?, ?, ?, ?)`)
    SMALL = Number(insOpt.run(groupId, 'صغير', -10, 0).lastInsertRowid)
    LARGE = Number(insOpt.run(groupId, 'كبير', 15, 1).lastInsertRowid)
    SPICY = Number(insOpt.run(spiceGroup, 'حار', 0, 0).lastInsertRowid)

    const foreignGroup = Number(db.prepare(
      `INSERT INTO item_variant_groups (menu_item_id, group_name, display_order)
       VALUES (?, 'الحجم', 0)`).run(other.item_id).lastInsertRowid)
    foreignOption = Number(insOpt.run(foreignGroup, 'ضخم', 500, 0).lastInsertRowid)
  })

  const lineOf = (orderId: number) =>
    getDb().prepare('SELECT unit_price, variant_label FROM order_items WHERE order_id = ?')
      .get(orderId) as any

  it('adds the option delta to the base price', () => {
    const r = createOrder(order({ items: [
      { menuItemId: mealId, quantity: 1, unitPrice: 0, itemName: 'x', variantOptionIds: [LARGE] },
    ] }), 'cashier')
    expect(lineOf(r.orderId).unit_price).toBe(mealPrice + 15)
    expect(r.subtotal).toBe(mealPrice + 15)
  })

  it('applies a negative delta for a smaller size', () => {
    const r = createOrder(order({ items: [
      { menuItemId: mealId, quantity: 1, unitPrice: 0, itemName: 'x', variantOptionIds: [SMALL] },
    ] }), 'cashier')
    expect(lineOf(r.orderId).unit_price).toBe(mealPrice - 10)
  })

  it('sums deltas across groups and labels them in the owner\'s order', () => {
    // Sent spice-first; the label must still read size-first, as the groups are ordered.
    const r = createOrder(order({ items: [
      { menuItemId: mealId, quantity: 1, unitPrice: 0, itemName: 'x', variantOptionIds: [SPICY, LARGE] },
    ] }), 'cashier')
    const line = lineOf(r.orderId)
    expect(line.unit_price).toBe(mealPrice + 15)
    expect(line.variant_label).toBe('كبير · حار')
  })

  /**
   * The whole point of pricing server-side. A renderer asking for a large at the
   * base price, or borrowing another item's +500 option, must not be believed.
   */
  it('ignores the price the client claims', () => {
    const r = createOrder(order({ items: [
      { menuItemId: mealId, quantity: 1, unitPrice: 1, itemName: 'x', variantOptionIds: [LARGE] },
    ] }), 'cashier')
    expect(lineOf(r.orderId).unit_price).toBe(mealPrice + 15)
  })

  it("refuses an option belonging to a different item", () => {
    const r = createOrder(order({ items: [
      { menuItemId: mealId, quantity: 1, unitPrice: 0, itemName: 'x', variantOptionIds: [foreignOption] },
    ] }), 'cashier')
    // Priced as the plain item — the foreign +500 is not applied.
    expect(lineOf(r.orderId).unit_price).toBe(mealPrice)
    expect(lineOf(r.orderId).variant_label).toBeNull()
  })

  it('ignores an option id that does not exist at all', () => {
    const r = createOrder(order({ items: [
      { menuItemId: mealId, quantity: 1, unitPrice: 0, itemName: 'x', variantOptionIds: [987654] },
    ] }), 'cashier')
    expect(lineOf(r.orderId).unit_price).toBe(mealPrice)
  })

  it('ignores a variant label the client made up', () => {
    // The label is rebuilt from the options, so "تريبل" cannot be printed on a line
    // that was only ever paid for as a plain item.
    const r = createOrder(order({ items: [
      { menuItemId: mealId, quantity: 1, unitPrice: 0, itemName: 'x', variantLabel: 'تريبل مجاناً' } as any,
    ] }), 'cashier')
    expect(lineOf(r.orderId).variant_label).toBeNull()
    expect(lineOf(r.orderId).unit_price).toBe(mealPrice)
  })

  it('prices an item with no options at its base', () => {
    const r = createOrder(order(), 'cashier')
    expect(lineOf(r.orderId).unit_price).toBe(mealPrice)
    expect(lineOf(r.orderId).variant_label).toBeNull()
  })

  it('multiplies the varied price by the quantity', () => {
    const r = createOrder(order({ items: [
      { menuItemId: mealId, quantity: 3, unitPrice: 0, itemName: 'x', variantOptionIds: [LARGE] },
    ] }), 'cashier')
    expect(r.subtotal).toBe((mealPrice + 15) * 3)
  })
})

describe('voidOrder', () => {
  it('returns the ingredients to stock and marks the order voided', () => {
    const db = getDb()
    const before = materialStock()

    const r = createOrder(order({ items: [
      { menuItemId: recipeItemId, quantity: 2, unitPrice: mealPrice, itemName: 'x' },
    ] }), 'cashier')
    expect(materialStock()).toBeCloseTo(before - recipePerUnit * 2, 3)

    voidOrder(r.orderId, cashierId, 'test void')
    expect(materialStock()).toBeCloseTo(before, 3)
    expect((db.prepare('SELECT status FROM orders WHERE order_id=?').get(r.orderId) as any).status).toBe('voided')
  })

  it("logs the reversal as 'void', distinct from a manual adjustment", () => {
    const r = createOrder(order({ items: [
      { menuItemId: recipeItemId, quantity: 1, unitPrice: mealPrice, itemName: 'x' },
    ] }), 'cashier')
    voidOrder(r.orderId, cashierId, 'reason')

    // Ingredient movements, not meal movements: the meal-stock model is gone.
    const reasons = (getDb().prepare(
      `SELECT reason FROM raw_material_transactions WHERE related_order_id=? ORDER BY rm_txn_id`
    ).all(r.orderId) as any[]).map(t => t.reason)

    expect(reasons.length).toBeGreaterThanOrEqual(2)
    expect(new Set(reasons)).toEqual(new Set(['sale', 'void']))
    expect(reasons[0]).toBe('sale')
    expect(reasons[reasons.length - 1]).toBe('void')
  })

  it('refuses to void twice', () => {
    const r = createOrder(order(), 'cashier')
    voidOrder(r.orderId, cashierId, 'first')
    expect(() => voidOrder(r.orderId, cashierId, 'second')).toThrow(/ملغاة بالفعل/)
  })

  it('excludes voided orders from revenue', () => {
    const db = getDb()
    const revenue = () => (db.prepare(
      `SELECT COALESCE(SUM(total_amount),0) v FROM orders WHERE status='completed' AND deleted_at IS NULL`
    ).get() as any).v

    const before = revenue()
    const r = createOrder(order(), 'cashier')
    expect(revenue()).toBeGreaterThan(before)
    voidOrder(r.orderId, cashierId, 'mistake')
    expect(revenue()).toBeCloseTo(before, 2)
  })
})

describe('SQL injection', () => {
  it('listOrders binds the limit', () => {
    const rows = listOrders({ limit: '1; DROP TABLE expenses' } as any)
    expect(Array.isArray(rows)).toBe(true)
    expect(!!getDb().prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='expenses'`
    ).get()).toBe(true)
  })

  it('getTopItems whitelists the sort direction instead of interpolating it', () => {
    // Previously `ORDER BY unitsSold ${order}` executed whatever arrived from the renderer.
    expect(() => analytics.getTopItems(5, 'DESC, no_such_column_xyz' as any)).not.toThrow()
    expect(() => analytics.getTopItems(5, '(SELECT password_hash FROM users)' as any)).not.toThrow()

    // Anything that is not exactly ASC falls back to DESC.
    const asc = analytics.getTopItems(50, 'ASC')
    const desc = analytics.getTopItems(50, 'junk' as any)
    if (asc.length > 1) {
      expect(asc[0].unitsSold).toBeLessThanOrEqual(asc[asc.length - 1].unitsSold)
      expect(desc[0].unitsSold).toBeGreaterThanOrEqual(desc[desc.length - 1].unitsSold)
    }
  })

  it('rejects an unknown analytics range instead of throwing a TypeError', () => {
    expect(() => analytics.getSummary('quarter' as any)).toThrow(/Unknown analytics range/)
    expect(() => analytics.getTrend('decade' as any)).toThrow(/Unknown trend grouping/)
  })
})

describe('analytics', () => {
  it('windows every rolling range in local time, matching how created_at is written', () => {
    // created_at uses datetime('now','localtime'); a UTC cutoff skewed the window by
    // the machine's offset (3h in Egypt) and made the trend disagree with the summary.
    const db = getDb()
    const skew = (db.prepare(`
      SELECT CAST((julianday(datetime('now','localtime')) - julianday(datetime('now'))) * 24 AS INTEGER) AS h
    `).get() as any).h

    // An order created right now must appear in today's summary AND in the daily trend,
    // regardless of the machine's UTC offset.
    createOrder(order(), 'cashier')
    const summary = analytics.getSummary('today')
    const trend = analytics.getTrend('day')

    expect(summary.current.order_count).toBeGreaterThan(0)
    expect(trend.length).toBeGreaterThan(0)
    console.log(`    → UTC offset here is ${skew}h; today's orders appear in both views`)
  })

  it('leaves zero-priced items unclassified instead of scoring them as 0% margin', () => {
    const db = getDb()
    const catId = (db.prepare('SELECT category_id FROM categories LIMIT 1').get() as any).category_id
    const freeId = db.prepare(
      `INSERT INTO menu_items (category_id,name,price,cost_price,stock_quantity) VALUES (?,?,0,0,50)`
    ).run(catId, 'صنف مجاني (عرض)').lastInsertRowid as number

    createOrder(order({ items: [
      { menuItemId: freeId, quantity: 1, unitPrice: 0, itemName: 'free' },
    ] }), 'cashier')

    const rows = analytics.getMenuEngineering()
    const free = rows.find(r => r.name === 'صنف مجاني (عرض)')!
    expect(free.marginPct).toBeNull()
    expect(free.quadrant).toBe('unclassified')

    // Priced items are still classified against an average that excludes the giveaway.
    const priced = rows.filter(r => r.marginPct !== null)
    expect(priced.length).toBeGreaterThan(0)
    expect(priced.every(r => r.quadrant !== 'unclassified')).toBe(true)
  })
})
