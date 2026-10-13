import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../src/main/db/db'
import { getSettings, updateSettings } from '../src/main/services/settingsService'
import { createOrder } from '../src/main/services/orderService'
import { useCartStore } from '../src/renderer/state/stores'

/**
 * The VAT rate, and the fact that ZERO is a real answer.
 *
 * A shop that charges no VAT sets the rate to 0. Every `rate || default` in the code
 * read that as "unset" and quietly substituted 14%, so the owner could type 0, save
 * it, watch it persist — and the till would still add 14% on screen. The receipt,
 * computed in the main process, charged nothing. The customer was quoted one total
 * and handed another, and nothing anyone typed in settings changed it.
 *
 * The same trap exists for any shop on a rate the default happens to differ from, but
 * 0 is where it is invisible and permanent.
 */

let ownerId: number
let itemId: number

beforeAll(() => {
  initDatabase()
  const db = getDb()
  ownerId = (db.prepare(`SELECT user_id FROM users WHERE role = 'owner'`).get() as any).user_id
  const catId = Number(db.prepare(`INSERT INTO categories (name, display_order) VALUES ('برجر', 1)`)
    .run().lastInsertRowid)
  itemId = Number(db.prepare(
    `INSERT INTO menu_items (category_id, name, price, cost_price) VALUES (?, 'برجر', 100, 40)`
  ).run(catId).lastInsertRowid)
})

const sell = (orderType: any = 'dine_in') =>
  createOrder({
    cashierId: ownerId,
    items: [{ menuItemId: itemId, quantity: 1 }],
    paymentType: 'cash',
    orderType,
  } as any, 'owner')

describe('storing the rate', () => {
  it('keeps a rate of zero as zero', () => {
    updateSettings({ tax_rate: 0 } as never)
    expect(getSettings().tax_rate).toBe(0)
  })

  it('keeps a fractional percentage', () => {
    updateSettings({ tax_rate: 0.145 } as never)
    expect(getSettings().tax_rate).toBeCloseTo(0.145)
  })

  it('falls back only when the value is not a number at all', () => {
    const db = getDb()
    const set = (v: string) =>
      db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('tax_rate', ?)`).run(v)

    set('')             // blank — genuinely unset
    expect(getSettings().tax_rate).toBe(0.14)
    set('abc')          // corrupt
    expect(getSettings().tax_rate).toBe(0.14)
    set('0')            // a real zero — must NOT fall back
    expect(getSettings().tax_rate).toBe(0)
  })

  it('never lets a corrupt value become NaN and poison every total', () => {
    getDb().prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('tax_rate', 'x')`).run()
    const rate = getSettings().tax_rate
    expect(Number.isNaN(rate)).toBe(false)
    expect(Number.isFinite(rate)).toBe(true)
  })

  it('clamps a nonsense rate rather than charging 900%', () => {
    getDb().prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('tax_rate', '9')`).run()
    expect(getSettings().tax_rate).toBe(1)
    getDb().prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('tax_rate', '-2')`).run()
    expect(getSettings().tax_rate).toBe(0)
  })
})

describe('what the customer is actually charged', () => {
  it('charges nothing on a dine-in bill when the rate is zero', () => {
    updateSettings({ tax_rate: 0 } as never)
    const r = sell('dine_in')
    expect(r.tax).toBe(0)
    expect(r.totalAmount).toBe(100)
  })

  it('charges the rate the owner set', () => {
    updateSettings({ tax_rate: 0.14 } as never)
    expect(sell('dine_in').tax).toBeCloseTo(14)
    updateSettings({ tax_rate: 0.10 } as never)
    expect(sell('dine_in').tax).toBeCloseTo(10)
  })

  it('never charges VAT on takeaway or delivery, whatever the rate', () => {
    updateSettings({ tax_rate: 0.14 } as never)
    expect(sell('takeaway').tax).toBe(0)
  })
})

describe('the till screen agrees with the receipt', () => {
  const cart = () => useCartStore.getState()

  beforeEach(() => {
    cart().clear()
    cart().addItem({ item_id: 1, name: 'برجر', price: 100, category_id: 1 } as never)
  })

  /** Exactly what POSScreen computes, including the fallback that used to be wrong. */
  const screenRate = (taxRate: unknown) => (Number.isFinite(taxRate) ? taxRate as number : 0.14)

  it('shows no VAT when the owner has set the rate to zero', () => {
    // The bug: `0 || 0.14` is 0.14, so the screen charged 14% on a zero-VAT shop.
    const rate = screenRate(0)
    expect(rate).toBe(0)
    cart().setOrderType('dine_in')
    expect(cart().getTax(rate)).toBe(0)
    expect(cart().getTotal(rate)).toBe(100)
  })

  it('still defaults when the rate really is missing', () => {
    expect(screenRate(undefined)).toBe(0.14)
    expect(screenRate(NaN)).toBe(0.14)
  })

  it('matches the recorded order at the same rate', () => {
    updateSettings({ tax_rate: 0 } as never)
    const recorded = sell('dine_in')

    cart().setOrderType('dine_in')
    const rate = screenRate(getSettings().tax_rate)

    expect(cart().getTax(rate)).toBe(recorded.tax)
    expect(cart().getTotal(rate)).toBe(recorded.totalAmount)
  })
})
