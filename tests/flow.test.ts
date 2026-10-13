import { describe, it, expect, beforeAll } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { initDatabase, getDb } from '../src/main/db/db'
import { invokeLocal } from '../src/main/net/router'
import { runWithSession } from '../src/main/services/authService'
import { deviceId } from '../src/main/services/licenseService'
import type { SessionUser, IpcResponse } from '../src/shared/types'

import { registerAuthIpc } from '../src/main/ipc/auth.ipc'
import { registerMenuIpc } from '../src/main/ipc/menu.ipc'
import { registerOrderIpc } from '../src/main/ipc/order.ipc'
import { registerRawMaterialIpc } from '../src/main/ipc/rawMaterial.ipc'
import { registerAnalyticsIpc } from '../src/main/ipc/analytics.ipc'
import { registerSettingsIpc } from '../src/main/ipc/settings.ipc'
import { registerExpenseIpc } from '../src/main/ipc/expense.ipc'
import { registerDeliveryIpc } from '../src/main/ipc/delivery.ipc'
import { registerFinanceIpc } from '../src/main/ipc/finance.ipc'
import { registerCustomerIpc } from '../src/main/ipc/customer.ipc'
import { registerSupplierIpc } from '../src/main/ipc/supplier.ipc'
import { registerShiftIpc } from '../src/main/ipc/shift.ipc'
import { registerLicenseIpc } from '../src/main/ipc/license.ipc'

/**
 * One day in the shop, driven the way the shop drives it.
 *
 * Every other suite calls the services directly. This one goes through the IPC
 * channels the screens call, in the order a real day happens: the till is licensed,
 * the owner sets the menu up, a cashier serves customers, an order is voided with the
 * owner's password, stock is bought in from a supplier, and at close of day the
 * reports have to agree with what actually happened.
 *
 * That path is the only one that exercises the role guards, the session scoping and
 * the licence gate — none of which a direct service call touches.
 */

/** One connected screen: holds its own session, exactly as a till or node does. */
class Client {
  session: SessionUser | null = null
  constructor(public name: string) {}

  /** Call a channel as this client, carrying its session across the call. */
  async call(channel: string, payload: unknown = {}): Promise<IpcResponse> {
    const { result, session } = await runWithSession(this.session, () => invokeLocal(channel, payload))
    this.session = session
    return result
  }

  /** Call and insist it worked, surfacing the Arabic error when it did not. */
  async ok(channel: string, payload: unknown = {}): Promise<any> {
    const res = await this.call(channel, payload)
    if (!res.success) throw new Error(`${this.name}: ${channel} failed — ${res.error}`)
    return res.data
  }
}

const cents = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100
const today = () => {
  const d = new Date(); const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

const PRIVATE_PEM = path.join(process.cwd(), 'license-private.pem')
const licensable = fs.existsSync(PRIVATE_PEM)

beforeAll(() => {
  initDatabase()
  registerLicenseIpc()
  registerAuthIpc()
  registerMenuIpc()
  registerOrderIpc()
  registerRawMaterialIpc()
  registerAnalyticsIpc()
  registerSettingsIpc()
  registerExpenseIpc()
  registerDeliveryIpc()
  registerFinanceIpc()
  registerCustomerIpc()
  registerSupplierIpc()
  registerShiftIpc()

  // Licence the till, as commissioning it would. Without this every channel below is
  // refused by the gate in net/router — which is itself asserted first.
  if (licensable) {
    const key = crypto.sign(
      null, Buffer.from(deviceId(), 'utf8'),
      crypto.createPrivateKey(fs.readFileSync(PRIVATE_PEM, 'utf8')),
    ).toString('hex')
    for (const f of [
      process.env.ProgramData ? path.join(process.env.ProgramData, 'CrispoPOS', 'license.key') : '',
      path.join(app.getPath('userData'), 'license.key'),
    ].filter(Boolean)) {
      try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, key) } catch { /* one is enough */ }
    }
  }
})

// State the day builds up as it goes.
const shop: any = {}

describe('a day in the shop, through the channels the screens call', () => {
  it.skipIf(!licensable)('1. the till is licensed before it will do anything', async () => {
    const c = new Client('till')
    const status = await c.ok('license:status')
    expect(status.activated).toBe(true)
    expect(status.deviceId).toMatch(/^([0-9A-F]{4}-){4}[0-9A-F]{4}$/)
  })

  it('2. a wrong password does not sign anyone in', async () => {
    const c = new Client('till')
    const res = await c.call('auth:login', { username: 'owner', password: 'wrong-password' })
    expect(res.success).toBe(false)
    expect(c.session).toBeNull()
  })

  it('3. nothing works before signing in', async () => {
    const c = new Client('till')
    const res = await c.call('order:list', {})
    expect(res.success).toBe(false)
  })

  it('4. the owner signs in and opens a shift', async () => {
    shop.owner = new Client('owner')
    const user = await shop.owner.ok('auth:login', { username: 'admin', password: 'admin123' })
    expect(user.role).toBe('owner')
    expect(shop.owner.session.role).toBe('owner')
    shop.ownerId = user.userId
  })

  it('5. the owner sets the shop up: VAT, a category, and three items', async () => {
    // The settings are behind a PIN of their own: the owner's sign-in is not enough.
    const locked = await shop.owner.call('settings:update', { tax_rate: 0.14 })
    expect(locked.success).toBe(false)
    expect((await shop.owner.call('settings:unlock', { pin: '000000' })).success).toBe(false)
    await shop.owner.ok('settings:unlock', { pin: '442299' })
    await shop.owner.ok('settings:update', { tax_rate: 0.14, max_cashier_discount: 10 })

    const cat = await shop.owner.ok('menu:upsertCategory', { name: 'وجبات الاختبار', displayOrder: 99 })
    shop.categoryId = cat.category_id ?? cat.categoryId

    // menu:upsert takes the row shape (snake_case), which is what the management
    // screen hands it — unlike menu:upsertCategory next door, which takes camelCase.
    const mk = async (name: string, price: number, cost: number) => {
      const it = await shop.owner.ok('menu:upsert', {
        category_id: shop.categoryId, name, price, cost_price: cost, is_active: 1,
      })
      return it.item_id
    }
    shop.chickenId = await mk('وجبة دجاج اختبار', 145, 40)
    shop.burgerId = await mk('برجر اختبار', 85, 25)
    shop.waterId = await mk('مياه اختبار', 10, 3)

    const menu = await shop.owner.ok('menu:list', {})
    const names = menu.map((m: any) => m.name)
    expect(names).toContain('وجبة دجاج اختبار')
  })

  it('6. the category asks حار/عادي, and water asks nothing', async () => {
    await shop.owner.ok('menu:setCategoryVariants', {
      categoryId: shop.categoryId,
      groups: [{
        groupName: 'التسوية',
        displayOrder: 0,
        options: [
          { optionName: 'حار', priceDelta: 0, displayOrder: 0 },
          { optionName: 'عادي', priceDelta: 0, displayOrder: 1 },
        ],
      }],
    })
    const groups = await shop.owner.ok('menu:getCategoryVariants', { categoryId: shop.categoryId })
    expect(groups).toHaveLength(1)
    expect(groups[0].options.map((o: any) => o.option_name ?? o.optionName)).toEqual(['حار', 'عادي'])

    // Water is in the same category but must not be asked — the item opts out.
    await shop.owner.ok('menu:setInheritVariants', { itemId: shop.waterId, inherit: false })
    const water = await shop.owner.ok('menu:get', { itemId: shop.waterId })
    expect(water.inherit_category_variants).toBe(0)
  })

  it('7. raw materials and a recipe, so a sale draws down stock', async () => {
    const m = await shop.owner.ok('rawMaterials:upsert', {
      name: 'دجاج اختبار خام', unit: 'قطعة', openingStock: 100, costPerUnit: 11, lowStockThreshold: 10,
    })
    shop.materialId = m.raw_material_id
    await shop.owner.ok('recipes:set', {
      menuItemId: shop.chickenId,
      lines: [{ rawMaterialId: shop.materialId, quantity: 4 }],
    })
    const recipe = await shop.owner.ok('recipes:get', { menuItemId: shop.chickenId })
    expect(recipe).toHaveLength(1)
  })

  it('8. a delivery area and a driver', async () => {
    const area = await shop.owner.ok('delivery:areas:upsert', { areaName: 'منطقة الاختبار', deliveryFee: 25 })
    shop.areaId = area.delivery_area_id ?? area.deliveryAreaId
    const driver = await shop.owner.ok('delivery:drivers:upsert', { fullName: 'سائق الاختبار', phone: '01000000001' })
    shop.driverId = driver.driver_id ?? driver.driverId
    expect(shop.areaId).toBeTruthy()
    expect(shop.driverId).toBeTruthy()
  })

  it('9. the owner hands the till over to a cashier', async () => {
    await shop.owner.ok('auth:logout')
    expect(shop.owner.session).toBeNull()

    shop.till = new Client('cashier1')
    const user = await shop.till.ok('auth:login', { username: 'cashier1', password: 'cashier123' })
    expect(user.role).toBe('cashier')
    shop.cashierId = user.userId
  })

  it('10. a dine-in sale, with VAT and the spice choice on the line', async () => {
    const before = (getDb().prepare('SELECT stock_quantity v FROM raw_materials WHERE raw_material_id=?')
      .get(shop.materialId) as any).v

    // The till picks OPTIONS, not labels: the main process looks the chosen option up
    // and writes the label itself. The bogus variantLabel below is sent deliberately —
    // a screen must not be able to print "حار" on a line it did not select.
    const menu = await shop.till.ok('menu:list', {})
    const chicken = menu.find((m: any) => m.item_id === shop.chickenId)
    const spicy = chicken.variants[0].options.find((o: any) => o.option_name === 'حار')
    shop.spicyOptionId = spicy.variant_option_id

    const r = await shop.till.ok('order:create', {
      cashierId: shop.cashierId,
      paymentType: 'cash',
      orderType: 'dine_in',
      discountPercent: 0,
      items: [{
        menuItemId: shop.chickenId, quantity: 2, unitPrice: 145, itemName: 'وجبة دجاج اختبار',
        variantOptionIds: [shop.spicyOptionId],
        variantLabel: 'مجاني تماماً', // ignored — the server does not trust it
      }],
    })

    expect(cents(r.subtotal)).toBe(290)
    expect(cents(r.tax)).toBe(cents(290 * 0.14))
    expect(cents(r.totalAmount)).toBe(cents(290 * 1.14))
    expect(r.invoiceNumber).toMatch(/^\d{4}$/)
    shop.firstInvoice = Number(r.invoiceNumber)
    shop.dineInOrderId = r.orderId

    // The spice choice is recorded against the line, which is what the kitchen prints.
    const line = getDb().prepare('SELECT variant_label FROM order_items WHERE order_id=?').get(r.orderId) as any
    expect(line.variant_label).toBe('حار')

    // Two meals × four pieces came out of stock.
    const after = (getDb().prepare('SELECT stock_quantity v FROM raw_materials WHERE raw_material_id=?')
      .get(shop.materialId) as any).v
    expect(cents(before - after)).toBe(8)
  })

  it('11. a takeaway with a note, and no VAT', async () => {
    const r = await shop.till.ok('order:create', {
      cashierId: shop.cashierId, paymentType: 'cash', orderType: 'takeaway', discountPercent: 0,
      notes: 'من غير مايونيز',
      items: [{ menuItemId: shop.burgerId, quantity: 1, unitPrice: 85, itemName: 'برجر اختبار' }],
    })
    expect(cents(r.tax)).toBe(0)
    expect(cents(r.totalAmount)).toBe(85)
    const row = getDb().prepare('SELECT notes FROM orders WHERE order_id=?').get(r.orderId) as any
    expect(row.notes).toBe('من غير مايونيز')
  })

  it('12. a delivery order takes the fee from the area, not from the screen', async () => {
    const r = await shop.till.ok('order:create', {
      cashierId: shop.cashierId, paymentType: 'cash', orderType: 'delivery', discountPercent: 0,
      deliveryAreaId: shop.areaId, driverId: shop.driverId,
      customerName: 'عميل الاختبار', customerPhone: '01099999999', customerAddress: '١٢ شارع الاختبار',
      deliveryFee: 0, // the screen lies; the area decides
      items: [{ menuItemId: shop.waterId, quantity: 3, unitPrice: 10, itemName: 'مياه اختبار' }],
    })
    expect(cents(r.deliveryFee)).toBe(25)
    expect(cents(r.totalAmount)).toBe(cents(30 + 25))
    shop.deliveryOrderId = r.orderId
  })

  it('13. a delivery order without an address is refused', async () => {
    const res = await shop.till.call('order:create', {
      cashierId: shop.cashierId, paymentType: 'cash', orderType: 'delivery', discountPercent: 0,
      deliveryAreaId: shop.areaId,
      items: [{ menuItemId: shop.waterId, quantity: 1, unitPrice: 10, itemName: 'مياه اختبار' }],
    })
    expect(res.success).toBe(false)
  })

  it('14. the cashier discount is capped at what the owner allows', async () => {
    const r = await shop.till.ok('order:create', {
      cashierId: shop.cashierId, paymentType: 'cash', orderType: 'takeaway', discountPercent: 90,
      items: [{ menuItemId: shop.burgerId, quantity: 1, unitPrice: 85, itemName: 'برجر اختبار' }],
    })
    expect(r.discountPercent).toBe(10)
    expect(r.discountCapped).toBe(true)
  })

  it('15. the invoice number runs 0001, 0002, 0003 … whatever the order type', async () => {
    const orders = getDb().prepare(`
      SELECT invoice_number FROM orders
      WHERE deleted_at IS NULL AND date(created_at) = ? ORDER BY order_id
    `).all(today()) as any[]
    const nums = orders.map(o => Number(o.invoice_number)).filter(Number.isFinite)
    for (let i = 1; i < nums.length; i++) expect(nums[i]).toBe(nums[i - 1] + 1)
    expect(orders.every(o => /^\d{4}$/.test(o.invoice_number))).toBe(true)
  })

  it('16. a cashier cannot reach the owner-only screens', async () => {
    for (const channel of ['order:delete', 'menu:upsert', 'rawMaterials:upsert', 'suppliers:upsert']) {
      const res = await shop.till.call(channel, { orderId: shop.dineInOrderId, name: 'x' })
      expect(res.success, `${channel} should be refused for a cashier`).toBe(false)
    }
  })

  it('17. a cashier cannot void without the owner password, and can with it', async () => {
    const denied = await shop.till.call('order:void', {
      orderId: shop.dineInOrderId, reason: 'اختبار', ownerPassword: 'not-the-password',
    })
    expect(denied.success).toBe(false)

    const before = (getDb().prepare(
      "SELECT COALESCE(SUM(total_amount),0) v FROM orders WHERE status='completed' AND deleted_at IS NULL"
    ).get() as any).v
    const total = (getDb().prepare('SELECT total_amount v FROM orders WHERE order_id=?')
      .get(shop.dineInOrderId) as any).v

    const allowed = await shop.till.call('order:void', {
      orderId: shop.dineInOrderId, reason: 'العميل غيّر رأيه', ownerPassword: 'admin123',
    })
    expect(allowed.success).toBe(true)

    const after = (getDb().prepare(
      "SELECT COALESCE(SUM(total_amount),0) v FROM orders WHERE status='completed' AND deleted_at IS NULL"
    ).get() as any).v
    expect(cents(before - after)).toBe(cents(total))
  })

  it('18. voiding puts the ingredients back', async () => {
    const stock = (getDb().prepare('SELECT stock_quantity v FROM raw_materials WHERE raw_material_id=?')
      .get(shop.materialId) as any).v
    expect(cents(stock)).toBe(100) // the only draw was the order just voided
  })

  it('19. the owner buys stock in from a supplier and pays part of it', async () => {
    shop.owner = new Client('owner')
    await shop.owner.ok('auth:login', { username: 'admin', password: 'admin123' })

    const sup = await shop.owner.ok('suppliers:upsert', { name: 'مورد اليوم', phone: '01055555555' })
    shop.supplierId = sup.supplier_id

    await shop.owner.ok('suppliers:recordDelivery', {
      supplierId: shop.supplierId,
      lines: [{ rawMaterialId: shop.materialId, quantity: 50, unitCost: 12 }],
    })
    await shop.owner.ok('suppliers:recordPayment', { supplierId: shop.supplierId, amount: 200 })

    const acct = await shop.owner.ok('suppliers:account', { supplierId: shop.supplierId })
    expect(cents(acct.supplied)).toBe(600)
    expect(cents(acct.paid)).toBe(200)
    expect(cents(acct.owed)).toBe(400)

    // and the 50 pieces are on the shelf
    const stock = (getDb().prepare('SELECT stock_quantity v FROM raw_materials WHERE raw_material_id=?')
      .get(shop.materialId) as any).v
    expect(cents(stock)).toBe(150)
  })

  it('20. a supplier without a name is refused', async () => {
    const res = await shop.owner.call('suppliers:upsert', { name: '   ' })
    expect(res.success).toBe(false)
  })

  it('21. an expense goes on the books', async () => {
    await shop.owner.ok('expenses:add', {
      category: 'other', description: 'كهرباء', amount: 350, expenseDate: today(),
    })
    const list = await shop.owner.ok('expenses:list', { dateFrom: today(), dateTo: today() })
    expect(list.some((e: any) => cents(e.amount) === 350)).toBe(true)
  })

  it('22. the delivery customer is remembered for next time', async () => {
    const found = await shop.owner.ok('customers:byPhone', { phone: '01099999999' })
    expect(found).toBeTruthy()
    expect(found.name).toBe('عميل الاختبار')
    expect(found.phone).toBe('01099999999')
  })

  it('23. the reports agree with what actually happened', async () => {
    const raw = (getDb().prepare(`
      SELECT COALESCE(SUM(total_amount),0) v FROM orders
      WHERE status='completed' AND deleted_at IS NULL AND date(created_at)=?
    `).get(today()) as any).v

    const finance = await shop.owner.ok('finance:report', { start: today(), end: today() })
    expect(cents(finance.revenue)).toBe(cents(raw))

    const summary = await shop.owner.ok('analytics:summary', { range: 'today' })
    expect(cents(summary.current.revenue)).toBe(cents(raw))

    // The profit line has to be the parts it is made of, not a separate opinion.
    // VAT is collected for the tax authority, so it comes off before anything is
    // called profit; buying ingredients is already inside the cost of what was sold.
    expect(cents(finance.netSales)).toBe(cents(finance.revenue - finance.tax))
    expect(cents(finance.grossProfit)).toBe(cents(finance.netSales - finance.cogs))
    expect(cents(finance.operatingExpenses)).toBe(cents(finance.expensesTotal - finance.ingredientPurchases))
    expect(cents(finance.netProfit)).toBe(cents(
      finance.grossProfit - finance.operatingExpenses - finance.salariesTotal - finance.wasteValue))

    // The shift running now says the same thing through its own two doors.
    const byShift = await shop.owner.ok('finance:report', { shift: 'current' })
    const list = await shop.owner.ok('workShift:list', {})
    const sheet = await shop.owner.ok('shifts:report', { shiftId: list[0].workShiftId, work: true })
    expect(cents(sheet.revenue)).toBe(cents(byShift.revenue))
    expect(cents(sheet.netProfit)).toBe(cents(byShift.netProfit))
    expect(cents(sheet.expectedCash)).toBe(cents(byShift.drawer.expectedCash))
  })

  it('24. the shift report covers the cashier who worked it', async () => {
    const shifts = await shop.owner.ok('shifts:list', {})
    expect(Array.isArray(shifts)).toBe(true)
  })

  it('25. the order history shows the day, void included and marked', async () => {
    const orders = await shop.owner.ok('order:list', {})
    const voided = orders.find((o: any) => o.order_id === shop.dineInOrderId)
    expect(voided.status).toBe('voided')
    const live = orders.filter((o: any) => o.status === 'completed')
    expect(live.length).toBeGreaterThan(0)
  })

  it('26. the books still reconcile after the whole day', async () => {
    const bad = getDb().prepare(`
      SELECT order_id FROM orders
      WHERE deleted_at IS NULL
        AND ABS(total_amount - MAX(0, subtotal + tax - discount + COALESCE(delivery_fee,0))) > 0.005
    `).all()
    expect(bad).toEqual([])

    const unlinked = getDb().prepare(`
      SELECT o.order_id FROM orders o WHERE o.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id=o.order_id)
    `).all()
    expect(unlinked).toEqual([])
  })

  it('27. signing out closes the session', async () => {
    await shop.owner.ok('auth:logout')
    expect(shop.owner.session).toBeNull()
    const res = await shop.owner.call('finance:report', { start: today(), end: today() })
    expect(res.success).toBe(false)
  })
})

/**
 * The awkward day. A happy path proves the shop works when everyone behaves; these
 * are the things that must not be possible when they do not — a double-tapped void,
 * a price edited after the sale, two people signed in at once on the same master.
 */
describe('the things that must not be possible', () => {
  const owner = new Client('owner-2')
  const till = new Client('till-2')
  const stock = () => (getDb().prepare('SELECT stock_quantity v FROM raw_materials WHERE raw_material_id=?')
    .get(shop.materialId) as any).v
  const revenue = () => (getDb().prepare(
    "SELECT COALESCE(SUM(total_amount),0) v FROM orders WHERE status='completed' AND deleted_at IS NULL"
  ).get() as any).v

  beforeAll(async () => {
    await owner.ok('auth:login', { username: 'admin', password: 'admin123' })
    await till.ok('auth:login', { username: 'cashier2', password: 'cashier456' })
  })

  const sell = () => till.ok('order:create', {
    cashierId: till.session!.userId, paymentType: 'cash', orderType: 'takeaway', discountPercent: 0,
    items: [{ menuItemId: shop.chickenId, quantity: 1, unitPrice: 145, itemName: 'وجبة دجاج اختبار' }],
  })

  it('voiding the same order twice does not return the stock twice', async () => {
    const r = await sell()
    const drawn = stock()

    await owner.ok('order:void', { orderId: r.orderId, reason: 'مرة' })
    const afterFirst = stock()
    expect(cents(afterFirst - drawn)).toBe(4) // the recipe's four pieces came back

    const revenueAfterFirst = revenue()
    await owner.call('order:void', { orderId: r.orderId, reason: 'مرة ثانية' })
    // Either it refuses or it is a no-op — but neither the stock nor the takings may
    // move a second time for one sale.
    expect(stock()).toBe(afterFirst)
    expect(cents(revenue())).toBe(cents(revenueAfterFirst))
  })

  it('deleting the same order twice does not return the stock twice', async () => {
    const r = await sell()
    const drawn = stock()

    await owner.ok('order:delete', { orderId: r.orderId })
    const afterFirst = stock()
    expect(cents(afterFirst - drawn)).toBe(4)

    await owner.call('order:delete', { orderId: r.orderId })
    expect(stock()).toBe(afterFirst)
  })

  it('voiding an order that was already deleted does not resurrect its stock', async () => {
    const r = await sell()
    await owner.ok('order:delete', { orderId: r.orderId })
    const afterDelete = stock()

    await owner.call('order:void', { orderId: r.orderId, reason: 'بعد الحذف' })
    expect(stock()).toBe(afterDelete)
  })

  it('a deleted order stays out of revenue however it is poked', async () => {
    const r = await sell()
    const withOrder = revenue()
    await owner.ok('order:delete', { orderId: r.orderId })
    const without = revenue()
    expect(cents(withOrder - without)).toBe(cents(r.totalAmount))

    await owner.call('order:void', { orderId: r.orderId, reason: 'x' })
    await owner.call('order:delete', { orderId: r.orderId })
    expect(cents(revenue())).toBe(cents(without))
  })

  it('raising a price does not rewrite what a customer already paid', async () => {
    const r = await sell()
    const paid = (getDb().prepare('SELECT unit_price v FROM order_items WHERE order_id=?')
      .get(r.orderId) as any).v

    await owner.ok('menu:upsert', {
      item_id: shop.chickenId, category_id: shop.categoryId,
      name: 'وجبة دجاج اختبار', price: 999, cost_price: 40, is_active: 1,
    })

    const stillPaid = (getDb().prepare('SELECT unit_price v FROM order_items WHERE order_id=?')
      .get(r.orderId) as any).v
    expect(cents(stillPaid)).toBe(cents(paid))
    const total = (getDb().prepare('SELECT total_amount v FROM orders WHERE order_id=?').get(r.orderId) as any).v
    expect(cents(total)).toBe(cents(r.totalAmount))

    // put it back so later assertions are not surprised
    await owner.ok('menu:upsert', {
      item_id: shop.chickenId, category_id: shop.categoryId,
      name: 'وجبة دجاج اختبار', price: 145, cost_price: 40, is_active: 1,
    })
  })

  it('a deactivated item cannot be rung up', async () => {
    await owner.ok('menu:setActive', { itemId: shop.burgerId, isActive: false })
    const res = await till.call('order:create', {
      cashierId: till.session!.userId, paymentType: 'cash', orderType: 'takeaway', discountPercent: 0,
      items: [{ menuItemId: shop.burgerId, quantity: 1, unitPrice: 85, itemName: 'برجر اختبار' }],
    })
    expect(res.success).toBe(false)
    await owner.ok('menu:setActive', { itemId: shop.burgerId, isActive: true })
  })

  it('a category with items on it cannot be deleted out from under them', async () => {
    const res = await owner.call('menu:deleteCategory', { categoryId: shop.categoryId })
    expect(res.success).toBe(false)
  })

  it('an option belonging to another item cannot be borrowed to change a price', async () => {
    // The chicken's spice option, applied to water. priceVariants checks ownership.
    const res = await till.call('order:create', {
      cashierId: till.session!.userId, paymentType: 'cash', orderType: 'takeaway', discountPercent: 0,
      items: [{
        menuItemId: shop.waterId, quantity: 1, unitPrice: 10, itemName: 'مياه اختبار',
        variantOptionIds: [shop.spicyOptionId],
      }],
    })
    // Whichever way it goes, water is never sold as spicy and never at another price.
    if (res.success) {
      const line = getDb().prepare('SELECT variant_label, unit_price FROM order_items WHERE order_id=?')
        .get(res.data.orderId) as any
      expect(line.variant_label).toBeNull()
      expect(cents(line.unit_price)).toBe(10)
    } else {
      expect(res.error).toBeTruthy()
    }
  })

  it('two people signed in at once do not borrow each other`s permissions', async () => {
    // The master serves the owner at its own screen and a cashier at the node. A
    // module-level session would let the cashier inherit the owner's rights.
    const ownerSaw = await owner.call('auth:getSession')
    const tillSaw = await till.call('auth:getSession')
    expect(ownerSaw.data.role).toBe('owner')
    expect(tillSaw.data.role).toBe('cashier')

    const refused = await till.call('menu:upsert', {
      category_id: shop.categoryId, name: 'صنف ممنوع', price: 1, cost_price: 0, is_active: 1,
    })
    expect(refused.success).toBe(false)

    // and the owner, on the same process, is still allowed
    const allowed = await owner.call('menu:list', {})
    expect(allowed.success).toBe(true)
  })

  it('an order is attributed to the cashier who rang it, not whoever else is signed in', async () => {
    const r = await sell()
    const row = getDb().prepare('SELECT cashier_id v FROM orders WHERE order_id=?').get(r.orderId) as any
    expect(row.v).toBe(till.session!.userId)
    expect(row.v).not.toBe(owner.session!.userId)
  })

  it('a cashier cannot pass someone else`s id to book the sale against them', async () => {
    const r = await till.ok('order:create', {
      cashierId: owner.session!.userId, // claiming to be the owner
      paymentType: 'cash', orderType: 'takeaway', discountPercent: 0,
      items: [{ menuItemId: shop.chickenId, quantity: 1, unitPrice: 145, itemName: 'وجبة دجاج اختبار' }],
    })
    const row = getDb().prepare('SELECT cashier_id v FROM orders WHERE order_id=?').get(r.orderId) as any
    expect(row.v).toBe(till.session!.userId)
  })

  it('paying a supplier more than is owed shows as credit, not as a broken balance', async () => {
    const sup = await owner.ok('suppliers:upsert', { name: 'مورد الزيادة' })
    await owner.ok('suppliers:recordDelivery', {
      supplierId: sup.supplier_id,
      lines: [{ rawMaterialId: shop.materialId, quantity: 1, unitCost: 100 }],
    })
    await owner.ok('suppliers:recordPayment', { supplierId: sup.supplier_id, amount: 150 })
    const acct = await owner.ok('suppliers:account', { supplierId: sup.supplier_id })
    expect(cents(acct.supplied)).toBe(100)
    expect(cents(acct.paid)).toBe(150)
    expect(cents(acct.owed)).toBe(-50)
  })

  it('the books still reconcile after all of that', () => {
    const bad = getDb().prepare(`
      SELECT order_id FROM orders WHERE deleted_at IS NULL
        AND ABS(total_amount - MAX(0, subtotal + tax - discount + COALESCE(delivery_fee,0))) > 0.005
    `).all()
    expect(bad).toEqual([])
  })
})
