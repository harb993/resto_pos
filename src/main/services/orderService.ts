import { getDb } from '../db/db'
import log from 'electron-log/main'
import { getSettings } from './settingsService'
import { stamp as shiftStamp } from './shiftService'
import { currentWorkWindow } from './workShiftService'
import type {
  CreateOrderInput, CreateOrderResult, Order, OrderItem, OrderType, PaymentType, UserRole,
  ReturnedStockLine,
} from '../../shared/types'

const ORDER_TYPES: OrderType[] = ['dine_in', 'takeaway', 'delivery']
const PAYMENT_TYPES: PaymentType[] = ['cash', 'card']

/** Money is stored as REAL; round every computed figure so float noise never reaches the till. */
function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

/** Raw material quantities are fractional (0.15 kg of flour) — keep 3 decimals. */
function round3(n: number): number {
  return Math.round((n + Number.EPSILON) * 1000) / 1000
}

/**
 * ONE invoice number for the whole day, whatever kind of order it is.
 *
 * There used to be three separate counters with DI-/TA-/DL- prefixes, so the shop
 * issued three number ones every morning and "invoice 7" meant nothing without also
 * knowing which type it was. Now the day runs 1, 2, 3… across the counter, and the
 * order TYPE is still printed on the ticket — صالة / تيك أواي / دليفري — it simply is
 * not part of the number any more.
 *
 * Invoices already issued keep the numbers they were given. Nothing rewrites history.
 */
const INVOICE_COUNTER_KEY = 'invoice_seq'

/** The number the day goes back to every morning. */
const INVOICE_START_KEY = 'invoice_start'

const ORDER_TYPE_LABELS: Record<OrderType, string> = {
  dine_in: 'صالة',
  takeaway: 'تيك أواي',
  delivery: 'دليفري',
}

/**
 * Which SHIFT the counter currently belongs to — the moment that shift started.
 *
 * (The key keeps its old name; it used to hold a calendar date. A value left over from
 * then simply reads as "a different shift" and rolls the counter over once.)
 */
const INVOICE_DAY_KEY = 'invoice_seq_day'

/**
 * The shift running now, as the hours in the settings define it.
 *
 * Numbering follows the shift, not the calendar: a night shift that trades through
 * midnight keeps one run of numbers instead of starting again at 0001 half-way through
 * the evening, and the close-out for a shift lists one unbroken sequence.
 */
function currentShift(): { key: string; from: string; to: string } {
  const w = currentWorkWindow(new Date())
  return { key: shiftStamp(w.start), from: shiftStamp(w.start), to: shiftStamp(w.coverEnd) }
}


function readSetting(key: string, fallback: string): string {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    { value: string } | undefined
  return row?.value ?? fallback
}

function writeSetting(key: string, value: string): void {
  getDb().prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value)
}

/**
 * Every shift starts at 0001.
 *
 * This used to be a number the owner chose in the settings. It is fixed now: a shift's
 * invoices count from one, so the last number on the close-out IS how many were rung
 * up, and no shift's numbering depends on a setting somebody changed last month.
 */
function configuredStart(): number {
  return 1
}

/**
 * Put the counter back to the owner's starting number when a new shift begins.
 *
 * Invoice numbers run per shift: each shift starts again from the number the owner
 * set, so a number on its own does not identify one invoice — the shift does.
 * Nothing here rewrites an issued invoice; only the counter for the next one moves.
 *
 * The reset never goes BELOW what has already been issued this shift. On the day the shop
 * moves from the old per-type numbering to this one, invoices may already exist with
 * higher numbers, and handing the next customer a number lower than one already given
 * out would make the day impossible to reconcile.
 *
 * Returns true when it actually rolled over.
 */
function rolloverIfNewDay(): boolean {
  const shift = currentShift().key
  if (readSetting(INVOICE_DAY_KEY, '') === shift) return false

  // The counter holds the LAST number used, so one below the configured start.
  const from = Math.max(configuredStart() - 1, highestIssuedToday())
  writeSetting(INVOICE_COUNTER_KEY, String(from))
  writeSetting(INVOICE_DAY_KEY, shift)
  log.info(`[Order] Invoice numbering reset for the shift that began ${shift} — next is ${from + 1}`)
  return true
}

/**
 * The highest number issued in the CURRENT SHIFT, across every order type.
 *
 * Reads the trailing digits of whatever format the number is in, so an invoice from
 * before the single-counter change — `TA-000012` — still counts as 12 rather than
 * being ignored and letting the counter hand 12 out a second time.
 */
function highestIssuedToday(): number {
  const rows = getDb().prepare(`
    SELECT invoice_number FROM orders
    WHERE invoice_number IS NOT NULL AND created_at >= ? AND created_at < ?
  `).all(currentShift().from, currentShift().to) as { invoice_number: string }[]

  let highest = 0
  for (const r of rows) {
    const digits = /(\d+)\s*$/.exec(r.invoice_number)
    const n = digits ? parseInt(digits[1], 10) : NaN
    if (Number.isFinite(n) && n > highest) highest = n
  }
  return highest
}

// Prepared statements (lazy-initialized), together with the connection they belong to.
// A statement is owned by one connection, so the moment the database underneath is
// swapped — signing into the showcase account, or restoring a backup — the cached set
// is stale and every use of it would throw. Keeping the connection alongside makes the
// cache correct itself instead.
let stmts: ReturnType<typeof prepareStatements> | null = null
let stmtsFor: unknown = null

function prepareStatements() {
  const db = getDb()
  return {
    insertOrder: db.prepare(`
      INSERT INTO orders (cashier_id, subtotal, tax, discount, total_amount, payment_type,
        order_type, customer_name, customer_phone, customer_address, delivery_area_id,
        delivery_fee, driver_id, delivery_status, dispatched_at, invoice_number, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    getInvoiceCounter: db.prepare(`SELECT value FROM settings WHERE key = ?`),
    setInvoiceCounter: db.prepare(`UPDATE settings SET value = ? WHERE key = ?`),
    insertOrderItem: db.prepare(`
      INSERT INTO order_items (order_id, menu_item_id, quantity, unit_price, unit_cost, variant_label)
      VALUES (?, ?, ?, ?, ?, ?)
    `),
    getMenuItem: db.prepare(`
      SELECT * FROM menu_items WHERE item_id = ? AND is_active = 1
    `),
    deductStock: db.prepare(`
      UPDATE menu_items SET stock_quantity = stock_quantity - ? WHERE item_id = ?
    `),
    logStockTxn: db.prepare(`
      INSERT INTO stock_transactions (menu_item_id, change_amount, reason, related_order_id, created_by)
      VALUES (?, ?, 'sale', ?, ?)
    `),
    getDeliveryArea: db.prepare(`
      SELECT delivery_area_id, delivery_fee FROM delivery_areas WHERE delivery_area_id = ? AND is_active = 1
    `),
    getDriver: db.prepare(`
      SELECT driver_id FROM delivery_drivers WHERE driver_id = ? AND is_active = 1
    `),
    voidOrder: db.prepare(`
      UPDATE orders SET status = 'voided', voided_by = ?, void_reason = ? WHERE order_id = ?
    `),
    restoreStock: db.prepare(`
      UPDATE menu_items SET stock_quantity = stock_quantity + ? WHERE item_id = ?
    `),
    softDelete: db.prepare(`
      UPDATE orders SET deleted_at = datetime('now','localtime'), deleted_by = ? WHERE order_id = ?
    `),

    // ---- Recipe-based (raw material) stock ----
    getRecipe: db.prepare(`
      SELECT ri.raw_material_id, ri.quantity, rm.name, rm.unit, rm.cost_per_unit
      FROM recipe_items ri
      JOIN raw_materials rm ON rm.raw_material_id = ri.raw_material_id
      WHERE ri.menu_item_id = ?
    `),
    deductMaterial: db.prepare(`
      UPDATE raw_materials SET stock_quantity = round(stock_quantity - ?, 3) WHERE raw_material_id = ?
    `),
    restoreMaterial: db.prepare(`
      UPDATE raw_materials SET stock_quantity = round(stock_quantity + ?, 3) WHERE raw_material_id = ?
    `),
    logMaterialTxn: db.prepare(`
      INSERT INTO raw_material_transactions (raw_material_id, change_amount, reason, related_order_id, created_by)
      VALUES (?, ?, ?, ?, ?)
    `),
    getMaterialBalance: db.prepare(`
      SELECT name, unit, stock_quantity FROM raw_materials WHERE raw_material_id = ?
    `),
    getOrderMaterialUsage: db.prepare(`
      SELECT raw_material_id, change_amount FROM raw_material_transactions
      WHERE related_order_id = ? AND reason = 'sale'
    `),
  }
}

interface RecipeLine {
  raw_material_id: number
  quantity: number
  name: string
  unit: string
  cost_per_unit: number
}

function getStmts() {
  const db = getDb()
  if (!stmts || stmtsFor !== db) {
    stmts = prepareStatements()
    stmtsFor = db
  }
  return stmts
}

/**
 * Turn the chosen variant options into a price adjustment and the label that goes on
 * the receipt and the kitchen ticket.
 *
 * The join back to `item_variant_groups` is the security of the whole feature: an
 * option only counts if it belongs to a group belonging to THIS menu item. Without
 * it a renderer could send the option id of some other item's "صغير" — or any id at
 * all — and be charged its delta. Unknown or foreign ids are ignored rather than
 * rejected, so a stale cart left open across a menu edit still rings up at the
 * current base price instead of refusing the sale at the counter.
 *
 * Options are read back in the owner's display order, not the order the renderer
 * happened to send them, so "كبير · حار" always reads the same way round.
 */
function priceVariants(
  menuItemId: number,
  optionIds: number[] | undefined,
): { delta: number; label: string | null } {
  const ids = (optionIds ?? []).map(Number).filter(Number.isInteger)
  if (ids.length === 0) return { delta: 0, label: null }

  const db = getDb()
  const placeholders = ids.map(() => '?').join(',')

  // An option counts only if it belongs to a group this item actually asks: one of
  // its OWN groups, or one of its category's — and the category's only when the item
  // has not opted out. That join is the security of the whole feature; without it a
  // renderer could send the option id of a different item's "كبير" and be charged its
  // delta, or claim "تريبل" on something priced as a single.
  const rows = db.prepare(`
    SELECT o.option_name, o.price_delta
    FROM item_variant_options o
    JOIN item_variant_groups g ON g.variant_group_id = o.variant_group_id
    JOIN menu_items mi ON mi.item_id = ?
    WHERE o.variant_option_id IN (${placeholders})
      AND (
        g.menu_item_id = mi.item_id
        OR (g.category_id = mi.category_id AND mi.inherit_category_variants = 1)
      )
    ORDER BY g.category_id IS NULL, g.display_order, g.variant_group_id,
             o.display_order, o.variant_option_id
  `).all(menuItemId, ...ids) as { option_name: string; price_delta: number }[]

  if (rows.length === 0) return { delta: 0, label: null }

  const delta = rows.reduce((sum, r) => sum + (Number(r.price_delta) || 0), 0)
  return { delta, label: rows.map(r => r.option_name).join(' · ') }
}

/**
 * What the next invoice number will be for each order type, plus the highest one
 * already issued. The Settings screen shows both so the owner can see what they are
 * changing away from.
 */
export function getInvoiceCounters(): {
  orderType: OrderType
  label: string
  prefix: string
  nextNumber: number
  highestIssued: number
  startNumber: number
}[] {
  const s = getStmts()
  rolloverIfNewDay() // so the screen shows this shift's numbering, not the last one's

  const row = s.getInvoiceCounter.get(INVOICE_COUNTER_KEY) as { value: string } | undefined
  const counter = row ? parseInt(row.value, 10) || 0 : 0

  // Still an array, because that is what the IPC contract and the settings screen
  // expect — but there is only ever ONE counter now, covering every order type.
  return [{
    orderType: 'dine_in',
    label: 'كل الفواتير',
    prefix: '',
    nextNumber: counter + 1,
    // What actually exists today — the counter is only what will be used next.
    highestIssued: highestIssuedToday(),
    startNumber: configuredStart(),
  }]
}

/**
 * Set the number each shift's first invoice will carry.
 *
 * This is the number the type goes back to every morning, so it is stored as the
 * standing start — not as a one-off nudge to the counter. It also takes effect today,
 * unless invoices have already gone out today at or above it: reissuing a number
 * already handed to a customer this morning would make the day impossible to
 * reconcile. Tomorrow it applies regardless.
 */
export function setInvoiceStart(_orderType: OrderType, nextNumber: number): void {
  const s = getStmts()

  const next = Number(nextNumber)
  if (!Number.isInteger(next) || next < 1) {
    throw new Error('رقم البداية يجب أن يكون رقماً صحيحاً أكبر من صفر')
  }
  if (next > 999_999) {
    throw new Error('رقم البداية أكبر من الحد المسموح (999999)')
  }

  rolloverIfNewDay()
  writeSetting(INVOICE_START_KEY, String(next))

  const highest = highestIssuedToday()
  if (next <= highest) {
    log.info(
      `[Order] Invoice start set to ${next}; applies from the next shift ` +
      `(${highest} already issued this shift)`
    )
    return
  }

  // The counter holds the LAST number used, so store one below the requested next.
  s.setInvoiceCounter.run(String(next - 1), INVOICE_COUNTER_KEY)
  log.info(`[Order] Invoice start set to ${next}`)
}

/**
 * Atomically bump the next invoice number — one sequence for the whole day.
 * Must be called inside the same transaction as the order insert.
 *
 * The order type is no longer part of the number. It is still recorded on the order
 * and printed on the ticket; it just does not split the numbering into three.
 */
function nextInvoiceNumber(): string {
  const s = getStmts()

  // First sale of a new day starts again from the owner's configured number.
  rolloverIfNewDay()

  const row = s.getInvoiceCounter.get(INVOICE_COUNTER_KEY) as { value: string } | undefined
  const nextSeq = (row ? parseInt(row.value, 10) : 0) + 1
  s.setInvoiceCounter.run(String(nextSeq), INVOICE_COUNTER_KEY)
  // Padded to four digits — 0001, 0042 — so every invoice of the day is the same
  // width on the paper and in a list. Past four digits it simply grows.
  return String(nextSeq).padStart(4, '0')
}

/**
 * Create an order — THE critical path.
 *
 * Every monetary figure is computed HERE, from the database: line prices and costs
 * come from `menu_items`, the VAT rate and the discount cap from `settings`, and the
 * delivery fee from `delivery_areas`. The renderer only says *what* was ordered and
 * *what discount was requested*; it never gets to say what anything costs. That keeps
 * `orders.total_amount` — which every report and dashboard sums — in agreement with
 * `order_items` by construction.
 *
 * The whole thing is one transaction: order + line items + stock deductions + the
 * invoice counter bump. If anything throws, all of it rolls back.
 */
export function createOrder(input: CreateOrderInput, actorRole: UserRole): CreateOrderResult {
  const db = getDb()
  const s = getStmts()

  // ---- Validate the request before touching the database ----
  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw new Error('لا يمكن إتمام طلب فارغ — أضف صنفاً أولاً')
  }
  const orderType: OrderType = ORDER_TYPES.includes(input.orderType) ? input.orderType : 'dine_in'
  if (!PAYMENT_TYPES.includes(input.paymentType)) {
    throw new Error(`Unknown payment type: ${input.paymentType}`)
  }
  for (const line of input.items) {
    if (!Number.isInteger(line.quantity) || line.quantity <= 0) {
      throw new Error(`Invalid quantity for item ${line.menuItemId}: ${line.quantity}`)
    }
  }
  if (orderType === 'delivery') {
    if (!input.customerName?.trim() || !input.customerPhone?.trim() || !input.customerAddress?.trim()) {
      throw new Error('طلب التوصيل يحتاج اسم العميل ورقم الهاتف والعنوان')
    }
    if (!input.deliveryAreaId) throw new Error('اختر منطقة التوصيل أولاً')
  }

  const settings = getSettings()

  const run = db.transaction((): CreateOrderResult => {
    // ---- 1. Price every line from the DB, and deduct stock ----
    // Collected first so the totals are known before the order row is written.
    const priced: {
      line: typeof input.items[number]
      price: number
      cost: number
      recipe: RecipeLine[]
      variantLabel: string | null
    }[] = []
    let subtotal = 0

    for (const line of input.items) {
      const menuItem = s.getMenuItem.get(line.menuItemId) as any
      if (!menuItem) {
        throw new Error('أحد الأصناف لم يعد متاحاً — امسح السلة وأعد الطلب')
      }

      // ---- Variants decide the price, and the main process decides the variants ----
      //
      // A large fries and a triple burger cost more than the base item, so the chosen
      // options are looked up here and their deltas added. Each option is checked to
      // belong to THIS item, so a renderer cannot borrow a cheap option from another
      // item — or send a label saying "تريبل" while paying for a single.
      const { delta, label } = priceVariants(line.menuItemId, line.variantOptionIds)

      // Stock lives on raw materials, not on finished meals — the restaurant stocks
      // chickens, buns and packaging, never "4-piece meals". So an item with a recipe
      // draws its ingredients down (allowed to go negative: a miscount warns, it must
      // never stop service), and an item with no recipe yet is simply not stock-tracked
      // and always sellable. The Menu screen flags those so they can be given a recipe.
      const recipe = s.getRecipe.all(line.menuItemId) as RecipeLine[]

      // Cost follows the recipe, so profit reporting tracks ingredient prices instead
      // of a manually-typed number that drifts.
      //
      // …but only once those ingredients actually HAVE prices. A recipe exists to
      // drive stock, and it is perfectly normal to record "this meal uses 2 pieces of
      // chicken and 2 breads" long before anybody has costed a bread — that is exactly
      // the state a shop is in the moment it imports its recipes. Taking the recipe
      // total regardless would read that as "this meal costs nothing" and report the
      // whole sale as profit. So a recipe that prices to zero falls back to the costed
      // figure on the item, and the shop's margins keep meaning something while the
      // inventory is filled in.
      const recipeCost = round2(recipe.reduce((sum, r) => sum + r.quantity * r.cost_per_unit, 0))
      const cost = recipeCost > 0 ? recipeCost : menuItem.cost_price

      // Never below zero: a mis-keyed negative delta must not make an item pay out.
      const price = round2(Math.max(0, menuItem.price + delta))

      subtotal += price * line.quantity
      priced.push({ line, price, cost, recipe, variantLabel: label })
    }
    subtotal = round2(subtotal)

    // ---- 2. Delivery fee: from the area record, never from the client ----
    let deliveryFee = 0
    let deliveryAreaId: number | null = null
    let driverId: number | null = null
    if (orderType === 'delivery') {
      const area = s.getDeliveryArea.get(input.deliveryAreaId) as any
      if (!area) throw new Error('منطقة التوصيل غير متاحة — اختر منطقة أخرى')
      deliveryAreaId = area.delivery_area_id
      deliveryFee = round2(area.delivery_fee)

      if (input.driverId) {
        const driver = s.getDriver.get(input.driverId) as any
        if (!driver) throw new Error('السائق غير متاح — اختر سائقاً آخر')
        driverId = driver.driver_id
      }
    }

    // ---- 3. Discount: a percentage request, clamped to the configured cap ----
    let discountPercent = Number(input.discountPercent) || 0
    if (!Number.isFinite(discountPercent) || discountPercent < 0) discountPercent = 0

    const cap = Number.isFinite(settings.max_cashier_discount) ? settings.max_cashier_discount : 100
    // The cap is the *cashier* limit; owners and accountants may override it.
    const maxPercent = actorRole === 'cashier' ? Math.min(cap, 100) : 100
    const discountCapped = discountPercent > maxPercent
    if (discountCapped) {
      log.warn(`[Order] Discount ${discountPercent}% requested by ${actorRole}, capped to ${maxPercent}%`)
      discountPercent = maxPercent
    }
    const discount = round2((subtotal * discountPercent) / 100)

    // ---- 4. VAT applies to dine-in only, at the configured rate ----
    //
    // Charged on what the customer actually pays — subtotal LESS the discount — not on
    // the menu price. VAT is a tax on the consideration given; discount the food and
    // the taxable amount falls with it. Computing it on the undiscounted subtotal, as
    // this used to, overcharged the customer on every discounted dine-in bill and
    // overstated the VAT owed: a 100 order at 10% off was taxed 14.00 instead of 12.60.
    const taxable = Math.max(0, subtotal - discount)
    const tax = orderType === 'dine_in' ? round2(taxable * settings.tax_rate) : 0
    const totalAmount = round2(Math.max(0, subtotal + tax - discount + deliveryFee))

    // ---- 5. Write the order ----
    //
    // A delivery order starts its journey the moment it is rung up — and it starts
    // in the KITCHEN. Nothing can be on a bike before it is cooked, so a new order is
    // 'preparing' even when the cashier already knows which driver will take it; that
    // driver is simply recorded against it in advance and the order goes 'out' when
    // somebody says it has left.
    const deliveryStatus = orderType === 'delivery' ? 'preparing' : null

    const invoiceNumber = nextInvoiceNumber()
    const result = s.insertOrder.run(
      input.cashierId,
      subtotal,
      tax,
      discount,
      totalAmount,
      input.paymentType,
      orderType,
      input.customerName?.trim() || null,
      input.customerPhone?.trim() || null,
      input.customerAddress?.trim() || null,
      deliveryAreaId,
      deliveryFee,
      driverId,
      deliveryStatus,
      null, // dispatched_at — stamped when it actually leaves, not when it is ordered
      invoiceNumber,
      input.notes?.trim() || null,
    )
    const orderId = result.lastInsertRowid as number

    // ---- 6. Write the lines and move the stock ----
    // Materials touched here are re-read afterwards to report any that went negative.
    const touchedMaterials = new Set<number>()

    for (const { line, price, cost, recipe, variantLabel } of priced) {
      // Price AT TIME OF SALE, so later menu edits never rewrite history.
      s.insertOrderItem.run(orderId, line.menuItemId, line.quantity, price, cost, variantLabel)

      if (recipe.length > 0) {
        for (const ing of recipe) {
          const used = round3(ing.quantity * line.quantity)
          s.deductMaterial.run(used, ing.raw_material_id)
          // Logged against the order so a void can reverse exactly what was consumed,
          // even if the recipe is edited in between.
          s.logMaterialTxn.run(ing.raw_material_id, -used, 'sale', orderId, input.cashierId)
          touchedMaterials.add(ing.raw_material_id)
        }
      }
      // No recipe → nothing to draw down. Meals themselves are not stocked.
    }

    // Warn on anything now at or below zero. Checked after all deductions so an
    // ingredient used by two different lines is judged on its final balance.
    const stockWarnings: string[] = []
    for (const materialId of touchedMaterials) {
      const m = s.getMaterialBalance.get(materialId) as
        { name: string; unit: string; stock_quantity: number } | undefined
      if (m && m.stock_quantity <= 0) {
        stockWarnings.push(`${m.name}: ${round3(m.stock_quantity)} ${m.unit}`)
      }
    }
    if (stockWarnings.length > 0) {
      log.warn(`[Order] #${orderId} drove materials to/below zero — ${stockWarnings.join(' | ')}`)
    }

    log.info(
      `[Order] Created #${orderId} (${invoiceNumber}) — ${priced.length} lines, ` +
      `subtotal ${subtotal}, tax ${tax}, discount ${discount} (${discountPercent}%), ` +
      `delivery ${deliveryFee}, total ${totalAmount}, type ${orderType}`
    )

    return {
      orderId, invoiceNumber, subtotal, tax, discount, discountPercent, deliveryFee, totalAmount,
      ...(discountCapped ? { discountCapped: true } : {}),
      ...(stockWarnings.length > 0 ? { stockWarnings } : {}),
    }
  })

  return run()
}

/**
 * Void an order — restores stock and marks the order as voided.
 * Returns what went back to stock so the screen can show it.
 */
export function voidOrder(orderId: number, voidedBy: number, reason: string): ReturnedStockLine[] {
  const db = getDb()
  const s = getStmts()

  const run = db.transaction((): ReturnedStockLine[] => {
    // Get the order and its items
    const order = db.prepare('SELECT * FROM orders WHERE order_id = ? AND deleted_at IS NULL').get(orderId) as any
    if (!order) throw new Error('الفاتورة غير موجودة')
    if (order.status === 'voided') throw new Error('الفاتورة ملغاة بالفعل')

    const returned = returnOrderStock(orderId, voidedBy)

    // Mark order as voided
    s.voidOrder.run(voidedBy, reason, orderId)

    log.info(`[Order] Voided order #${orderId} by user ${voidedBy}: ${reason}`)
    return returned
  })

  return run()
}

/**
 * Give back everything an order consumed.
 *
 * Works by replaying the order's OWN 'sale' rows in reverse rather than re-deriving
 * from the recipe: a recipe edited between the sale and the reversal must not change
 * how much is returned, and a line either moved menu-item stock or raw materials,
 * never both — replaying the log keeps that straight automatically.
 *
 * Idempotent. An order that was voided (stock already returned) and is then deleted
 * must not be credited a second time, so a previous reversal short-circuits this.
 *
 * Logged as 'void' — NOT 'adjustment' — so the audit trail tells a reversed sale
 * apart from a manual stock correction.
 *
 * Must be called inside a transaction.
 */
function returnOrderStock(orderId: number, userId: number): ReturnedStockLine[] {
  const db = getDb()
  const s = getStmts()

  const alreadyReturned =
    db.prepare(`SELECT 1 FROM stock_transactions WHERE related_order_id = ? AND reason = 'void' LIMIT 1`)
      .get(orderId) ||
    db.prepare(`SELECT 1 FROM raw_material_transactions WHERE related_order_id = ? AND reason = 'void' LIMIT 1`)
      .get(orderId)

  if (alreadyReturned) {
    log.info(`[Order] Stock for #${orderId} was already returned — not crediting twice`)
    return []
  }

  // What went back, so the screen can say so instead of the owner having to go and
  // check a number that may still be showing a cached value.
  const returned: ReturnedStockLine[] = []

  const logReversal = db.prepare(`
    INSERT INTO stock_transactions (menu_item_id, change_amount, reason, related_order_id, created_by)
    VALUES (?, ?, 'void', ?, ?)
  `)
  const itemSales = db.prepare(`
    SELECT st.menu_item_id, st.change_amount, mi.name
    FROM stock_transactions st
    JOIN menu_items mi ON mi.item_id = st.menu_item_id
    WHERE st.related_order_id = ? AND st.reason = 'sale'
  `).all(orderId) as { menu_item_id: number; change_amount: number; name: string }[]

  for (const sale of itemSales) {
    const giveBack = -sale.change_amount // recorded as a negative on sale
    s.restoreStock.run(giveBack, sale.menu_item_id)
    logReversal.run(sale.menu_item_id, giveBack, orderId, userId)
    returned.push({ name: sale.name, unit: 'قطعة', quantity: round3(giveBack) })
  }

  const logMaterialReversal = db.prepare(`
    INSERT INTO raw_material_transactions (raw_material_id, change_amount, reason, related_order_id, created_by)
    VALUES (?, ?, 'void', ?, ?)
  `)
  const materialSales = db.prepare(`
    SELECT t.raw_material_id, t.change_amount, rm.name, rm.unit
    FROM raw_material_transactions t
    JOIN raw_materials rm ON rm.raw_material_id = t.raw_material_id
    WHERE t.related_order_id = ? AND t.reason = 'sale'
  `).all(orderId) as { raw_material_id: number; change_amount: number; name: string; unit: string }[]

  for (const sale of materialSales) {
    const giveBack = -sale.change_amount
    s.restoreMaterial.run(giveBack, sale.raw_material_id)
    logMaterialReversal.run(sale.raw_material_id, giveBack, orderId, userId)
    returned.push({ name: sale.name, unit: sale.unit, quantity: round3(giveBack) })
  }

  if (returned.length > 0) {
    log.info(`[Order] Returned stock for #${orderId} — ${returned.length} line(s)`)
  }
  return returned
}

/**
 * Soft-delete an order — hides it from all lists and reports, and RETURNS ITS STOCK.
 *
 * Deleting used to only hide the row, which quietly left the ingredients written off
 * against a sale that no longer counts anywhere: the money vanished from the reports
 * but the stock never came back.
 *
 * Owner-only. The row stays in the database for the audit trail.
 */
export function softDeleteOrder(orderId: number, deletedBy: number): ReturnedStockLine[] {
  const db = getDb()
  const s = getStmts()

  const run = db.transaction((): ReturnedStockLine[] => {
    const order = db.prepare('SELECT * FROM orders WHERE order_id = ?').get(orderId) as any
    if (!order) throw new Error('الفاتورة غير موجودة')
    if (order.deleted_at) throw new Error('الفاتورة محذوفة بالفعل')

    // A voided order already had its stock returned; returnOrderStock knows that
    // and will not credit it again.
    const returned = returnOrderStock(orderId, deletedBy)

    s.softDelete.run(deletedBy, orderId)
    log.info(`[Order] Soft-deleted order #${orderId} by user ${deletedBy}`)
    return returned
  })

  return run()
}

/**
 * List orders with optional filters.
 */
export function listOrders(filters: {
  cashierId?: number
  status?: string
  dateFrom?: string
  dateTo?: string
  limit?: number
  orderType?: string
  /**
   * Deleted invoices are hidden by default — that is what deleting one is for. The
   * owner still has to be able to look at what was removed, so 'only' asks for
   * exactly those and 'all' shows both together.
   */
  deleted?: 'exclude' | 'only' | 'all'
} = {}): Order[] {
  const db = getDb()
  const conditions: string[] = []
  const params: any[] = []

  if (filters.deleted === 'only') conditions.push('o.deleted_at IS NOT NULL')
  else if (filters.deleted !== 'all') conditions.push('o.deleted_at IS NULL')

  if (filters.cashierId) {
    conditions.push('o.cashier_id = ?')
    params.push(filters.cashierId)
  }
  if (filters.status) {
    conditions.push('o.status = ?')
    params.push(filters.status)
  }
  if (filters.dateFrom) {
    conditions.push('o.created_at >= ?')
    params.push(filters.dateFrom)
  }
  if (filters.dateTo) {
    conditions.push('o.created_at <= ?')
    params.push(filters.dateTo)
  }
  if (filters.orderType) {
    conditions.push('o.order_type = ?')
    params.push(filters.orderType)
  }

  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : ''
  const limit = Number.isInteger(filters.limit) && (filters.limit as number) > 0 ? (filters.limit as number) : 200
  params.push(limit)

  const orders = db.prepare(`
    SELECT o.*, u.full_name as cashier_name,
      da.area_name, dd.full_name as driver_name, ds.settled_at,
      du.full_name AS deleted_by_name, vu.full_name AS voided_by_name
    FROM orders o
    JOIN users u ON u.user_id = o.cashier_id
    LEFT JOIN delivery_areas da ON da.delivery_area_id = o.delivery_area_id
    LEFT JOIN delivery_drivers dd ON dd.driver_id = o.driver_id
    LEFT JOIN driver_settlements ds ON ds.settlement_id = o.settlement_id
    LEFT JOIN users du ON du.user_id = o.deleted_by
    LEFT JOIN users vu ON vu.user_id = o.voided_by
    ${where}
    ORDER BY o.created_at DESC
    LIMIT ?
  `).all(...params) as Order[]

  return orders
}

/**
 * Get a single order with its items.
 */
export function getOrderWithItems(orderId: number): Order | null {
  const db = getDb()
  const order = db.prepare(`
    SELECT o.*, u.full_name as cashier_name,
      da.area_name, dd.full_name as driver_name, ds.settled_at,
      du.full_name AS deleted_by_name, vu.full_name AS voided_by_name
    FROM orders o
    JOIN users u ON u.user_id = o.cashier_id
    LEFT JOIN delivery_areas da ON da.delivery_area_id = o.delivery_area_id
    LEFT JOIN delivery_drivers dd ON dd.driver_id = o.driver_id
    LEFT JOIN driver_settlements ds ON ds.settlement_id = o.settlement_id
    LEFT JOIN users du ON du.user_id = o.deleted_by
    LEFT JOIN users vu ON vu.user_id = o.voided_by
    WHERE o.order_id = ?
  `).get(orderId) as Order | undefined

  if (!order) return null

  order.items = db.prepare(`
    SELECT oi.*, mi.name as item_name
    FROM order_items oi
    JOIN menu_items mi ON mi.item_id = oi.menu_item_id
    WHERE oi.order_id = ?
  `).all(orderId) as OrderItem[]

  return order
}
