import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../src/main/db/db'
import { upsertCategory, upsertMenuItem, listCategories } from '../src/main/services/menuService'
import { createOrder } from '../src/main/services/orderService'
import {
  upsertPrinter, deletePrinter, buildTicketOrder, stationItems,
} from '../src/main/services/printerService'
import type { PrinterInput } from '../src/shared/types'

/**
 * Choosing, on the categories screen, which printer a category's prep tickets come out of.
 *
 * The shop this was built for has no counter: the customer's receipt prints at the
 * till, and the food is split between two kitchens — «كشري وطواجن» and «شاورما
 * ومشويات». Each category is sent to one of them, and an order that has both kinds of
 * food puts each line on its own kitchen's printer and nowhere else.
 */

let ownerId: number
let receipt: number
let koshary: number
let grill: number

const printer = (input: Partial<PrinterInput> & Pick<PrinterInput, 'name' | 'role'>) =>
  upsertPrinter({ connection: 'windows_raw', deviceName: 'XP-80', ...input }).printer_id

const item = (categoryId: number, name: string) =>
  upsertMenuItem({ category_id: categoryId, name, price: 50, cost_price: 0 } as never).item_id

const sell = (...itemIds: number[]) =>
  createOrder({
    cashierId: ownerId,
    items: itemIds.map(menuItemId => ({ menuItemId, quantity: 1 })),
    paymentType: 'cash', orderType: 'takeaway',
  } as any, 'owner').orderId

const station = (printerId: number) =>
  getDb().prepare('SELECT * FROM printers WHERE printer_id = ?').get(printerId) as any

const namesFor = (printerId: number, orderId: number) =>
  stationItems(station(printerId), buildTicketOrder(orderId).items).map(i => i.name)

beforeAll(() => {
  initDatabase()
  ownerId = (getDb().prepare(`SELECT user_id FROM users WHERE role='owner'`).get() as any).user_id
})

beforeEach(() => {
  const db = getDb()
  for (const t of ['order_items', 'raw_material_transactions', 'orders', 'recipe_items',
    'item_variant_options', 'item_variant_groups', 'menu_items', 'categories', 'printers']) {
    db.prepare(`DELETE FROM ${t}`).run()
  }
  receipt = printer({ name: 'الكاشير', role: 'receipt' })
  koshary = printer({ name: 'كشري وطواجن', role: 'kitchen' })
  grill = printer({ name: 'شاورما ومشويات', role: 'kitchen' })
})

describe('a category sent to one kitchen', () => {
  it('prints there and only there', () => {
    const k = upsertCategory('كشري', 1, undefined, koshary).category_id
    const s = upsertCategory('شاورما', 2, undefined, grill).category_id
    const order = sell(item(k, 'كشري وسط'), item(s, 'ساندوتش شاورما فراخ'))

    expect(namesFor(koshary, order)).toEqual(['كشري وسط'])
    expect(namesFor(grill, order)).toEqual(['ساندوتش شاورما فراخ'])
  })

  it('carries the choice onto the ticket order', () => {
    const k = upsertCategory('كشري', 1, undefined, koshary).category_id
    const order = sell(item(k, 'كشري صغير'))
    expect(buildTicketOrder(order).items[0].categoryPrinterId).toBe(koshary)
  })

  it('wins over the other kitchen printing "everything"', () => {
    // The grill printer's own list is empty, which means all categories. A category
    // sent to the koshary kitchen must still not appear on it.
    const k = upsertCategory('طواجن', 1, undefined, koshary).category_id
    const order = sell(item(k, 'طاجن مكرونة باللحمة'))
    expect(namesFor(grill, order)).toEqual([])
  })

  it('wins over a printer list that names it', () => {
    const k = upsertCategory('كشري', 1, undefined, koshary).category_id
    upsertPrinter({
      printerId: grill, name: 'شاورما ومشويات', role: 'kitchen', connection: 'windows_raw',
      deviceName: 'XP-80', categoryIds: [k],
    })
    const order = sell(item(k, 'كشري كبير'))
    expect(namesFor(grill, order)).toEqual([])
    expect(namesFor(koshary, order)).toEqual(['كشري كبير'])
  })
})

describe('a category with no prep ticket', () => {
  it('reaches no kitchen at all', () => {
    const drinks = upsertCategory('مشروبات', 1, undefined, 0).category_id
    const order = sell(item(drinks, 'بيبسي'))
    expect(namesFor(koshary, order)).toEqual([])
    expect(namesFor(grill, order)).toEqual([])
  })
})

describe('a category left automatic', () => {
  it('follows the printers own lists, exactly as before', () => {
    const a = upsertCategory('حلويات', 1).category_id
    const b = upsertCategory('إضافات', 2).category_id
    upsertPrinter({
      printerId: koshary, name: 'كشري وطواجن', role: 'kitchen', connection: 'windows_raw',
      deviceName: 'XP-80', categoryIds: [a],
    })
    const order = sell(item(a, 'رز بلبن'), item(b, 'عيش'))

    expect(namesFor(koshary, order)).toEqual(['رز بلبن'])
    expect(namesFor(grill, order)).toEqual(['رز بلبن', 'عيش'])   // empty list = everything
  })
})

describe('saving a category', () => {
  it('keeps its printer when renamed by something that does not mention printers', () => {
    const id = upsertCategory('كشري', 1, undefined, koshary).category_id
    upsertCategory('الكشري', 1, id)
    expect(listCategories().find(c => c.category_id === id)!.printer_id).toBe(koshary)
  })

  it('can be put back to automatic', () => {
    const id = upsertCategory('كشري', 1, undefined, koshary).category_id
    upsertCategory('كشري', 1, id, null)
    expect(listCategories().find(c => c.category_id === id)!.printer_id).toBeNull()
  })

  it('refuses the receipt printer — it prints the whole order already', () => {
    expect(() => upsertCategory('كشري', 1, undefined, receipt)).toThrow()
  })

  it('refuses a printer that does not exist', () => {
    expect(() => upsertCategory('كشري', 1, undefined, 99999)).toThrow()
  })
})

describe('when the printer goes away', () => {
  it('deleting it puts its categories back to automatic', () => {
    const id = upsertCategory('شاورما', 1, undefined, grill).category_id
    deletePrinter(grill)
    expect(listCategories().find(c => c.category_id === id)!.printer_id).toBeNull()
  })

  it('turning it into a receipt printer does the same', () => {
    const id = upsertCategory('شاورما', 1, undefined, grill).category_id
    upsertPrinter({
      printerId: grill, name: 'شاورما ومشويات', role: 'receipt', connection: 'windows_raw', deviceName: 'XP-80',
    })
    expect(listCategories().find(c => c.category_id === id)!.printer_id).toBeNull()
  })

  it('leaves other printers categories alone', () => {
    const id = upsertCategory('كشري', 1, undefined, koshary).category_id
    deletePrinter(grill)
    expect(listCategories().find(c => c.category_id === id)!.printer_id).toBe(koshary)
  })
})

describe('an existing database', () => {
  it('has the column after migrating, and every category starts automatic', () => {
    const cols = (getDb().prepare(`PRAGMA table_info('categories')`).all() as { name: string }[])
      .map(c => c.name)
    expect(cols).toContain('printer_id')
    const id = upsertCategory('قديم', 1).category_id
    expect(listCategories().find(c => c.category_id === id)!.printer_id).toBeNull()
  })
})
