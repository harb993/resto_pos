import { describe, it, expect, beforeEach } from 'vitest'
import { useCartStore } from '../src/renderer/state/stores'
import type { MenuItem, VariantOption } from '../src/shared/types'

const item = (id: number, name: string, price: number): MenuItem => ({
  item_id: id, category_id: 1, name, price, cost_price: price / 2,
  description: null, image_path: null, is_active: 1, stock_quantity: 100,
  created_at: '', updated_at: '',
})

const MEAL = item(1, 'وجبة 4 قطع دجاج مقرمش', 135)
const PEPSI = item(2, 'بيبسي كانز', 20)
const BURGER = item(3, 'برجر', 100)

/**
 * Variant options as they come from the database. A cart line is keyed on the option
 * IDS, so ids matter here and the names are only what ends up on the ticket.
 */
const opt = (id: number, groupId: number, name: string, delta = 0): VariantOption => ({
  variant_option_id: id, variant_group_id: groupId,
  option_name: name, price_delta: delta, display_order: 0,
})

// Spice: costs the same either way.
const NORMAL = opt(1, 1, 'عادي')
const SPICY = opt(2, 1, 'حار (سبايسي)')
// Layers: each one costs more than the last.
const SINGLE = opt(10, 2, 'سنجل', 0)
const DOUBLE = opt(11, 2, 'دبل', 25)
const TRIPLE = opt(12, 2, 'تريبل', 45)
// Size, including one priced BELOW the item's base.
const SMALL = opt(20, 3, 'صغير', -10)
const LARGE = opt(21, 3, 'كبير', 15)

const cart = () => useCartStore.getState()
const lineFor = (variant?: string) =>
  cart().items.find(i => i.variantLabel === variant)!.lineId

describe('cart store — variant lines are independent', () => {
  beforeEach(() => cart().clear())

  it('keeps normal and spicy of the same item as two separate lines', () => {
    cart().addItem(MEAL, [NORMAL])
    cart().addItem(MEAL, [SPICY])
    expect(cart().items).toHaveLength(2)
    expect(cart().getSubtotal()).toBe(270)
  })

  it('re-adding the same variant stacks onto that line only', () => {
    cart().addItem(MEAL, [NORMAL])
    cart().addItem(MEAL, [NORMAL])
    cart().addItem(MEAL, [SPICY])
    expect(cart().items.map(i => i.quantity)).toEqual([2, 1])
  })

  it('changing qty on one variant line leaves the other alone', () => {
    cart().addItem(MEAL, [NORMAL])
    cart().addItem(MEAL, [SPICY])

    cart().updateQuantity(lineFor('عادي'), 2) // "+" on the first row only

    expect(cart().items.map(i => i.quantity)).toEqual([2, 1])
    expect(cart().getSubtotal()).toBe(405) // 3 meals, not 4
  })

  it('deleting one variant line keeps the others', () => {
    cart().addItem(MEAL, [NORMAL])
    cart().addItem(MEAL, [SPICY])
    cart().addItem(PEPSI)

    cart().removeItem(lineFor('عادي'))

    expect(cart().items.map(i => i.variantLabel ?? i.name))
      .toEqual(['حار (سبايسي)', 'بيبسي كانز'])
  })

  it('decrementing one variant line to 0 removes only that line', () => {
    cart().addItem(MEAL, [NORMAL])
    cart().addItem(MEAL, [SPICY])

    cart().updateQuantity(lineFor('عادي'), 0) // "−" on a qty-1 row

    expect(cart().items).toHaveLength(1)
    expect(cart().items[0].variantLabel).toBe('حار (سبايسي)')
  })

  it('reports the combined quantity of an item across its variants', () => {
    cart().addItem(MEAL, [NORMAL])
    cart().addItem(MEAL, [NORMAL])
    cart().addItem(MEAL, [SPICY])
    cart().addItem(PEPSI)

    expect(cart().getItemQuantity(MEAL.item_id)).toBe(3)
    expect(cart().getItemQuantity(PEPSI.item_id)).toBe(1)
  })

  it('keys a line on the option ids, not on how they were labelled', () => {
    // Two options can legitimately share a name across different groups. Keying on
    // text would merge them into one row priced as whichever was added first.
    const sizeLarge = opt(30, 3, 'كبير', 15)
    const portionLarge = opt(31, 4, 'كبير', 30)

    cart().addItem(MEAL, [sizeLarge])
    cart().addItem(MEAL, [portionLarge])

    expect(cart().items).toHaveLength(2)
    expect(cart().getSubtotal()).toBe((135 + 15) + (135 + 30))
  })

  it('treats the same options chosen in a different order as one line', () => {
    cart().addItem(BURGER, [DOUBLE, SPICY])
    cart().addItem(BURGER, [SPICY, DOUBLE])

    expect(cart().items).toHaveLength(1)
    expect(cart().items[0].quantity).toBe(2)
  })
})

describe('cart store — variants change the price', () => {
  beforeEach(() => cart().clear())

  it('adds the delta of a single chosen option', () => {
    cart().addItem(BURGER, [DOUBLE])
    expect(cart().items[0].unitPrice).toBe(125)
    expect(cart().getSubtotal()).toBe(125)
  })

  it('adds up the deltas across several groups', () => {
    // A triple burger that is also large: both differences apply.
    cart().addItem(BURGER, [TRIPLE, LARGE])
    expect(cart().items[0].unitPrice).toBe(100 + 45 + 15)
  })

  it('applies a negative delta for a size priced below the base', () => {
    cart().addItem(MEAL, [SMALL])
    expect(cart().items[0].unitPrice).toBe(125)
  })

  it('never prices a line below zero', () => {
    const absurd = opt(99, 9, 'خصم مبالغ', -9999)
    cart().addItem(PEPSI, [absurd])
    expect(cart().items[0].unitPrice).toBe(0)
  })

  it('leaves an item with no options at its base price', () => {
    cart().addItem(PEPSI)
    expect(cart().items[0].unitPrice).toBe(20)
    expect(cart().items[0].variantLabel).toBeUndefined()
    expect(cart().items[0].variantOptionIds).toBeUndefined()
  })

  it('carries the option ids so the main process can reprice the line', () => {
    cart().addItem(BURGER, [TRIPLE, SPICY])
    expect(cart().items[0].variantOptionIds).toEqual([12, 2])
    expect(cart().items[0].variantLabel).toBe('تريبل · حار (سبايسي)')
  })

  it('prices each variant line independently in the subtotal', () => {
    cart().addItem(BURGER, [SINGLE])   // 100
    cart().addItem(BURGER, [DOUBLE])   // 125
    cart().addItem(BURGER, [TRIPLE])   // 145
    expect(cart().items).toHaveLength(3)
    expect(cart().getSubtotal()).toBe(370)
  })
})

describe('cart store — totals', () => {
  beforeEach(() => cart().clear())

  it('charges VAT on dine-in only', () => {
    cart().addItem(MEAL)
    expect(cart().getTax(0.14)).toBeCloseTo(18.9)
    // Takeaway and delivery are tax-free — the food leaves the premises.
    cart().setOrderType('takeaway')
    expect(cart().getTax(0.14)).toBe(0)
    cart().setOrderType('delivery')
    expect(cart().getTax(0.14)).toBe(0)
    cart().setOrderType('dine_in')
    expect(cart().getTax(0.14)).toBeCloseTo(18.9)
  })

  it('taxes what the customer actually pays, so a discount lowers the VAT with it', () => {
    // Must match orderService.createOrder, which computes tax on (subtotal −
    // discount). Taxing the undiscounted subtotal here quoted the customer a higher
    // total on screen than the receipt then printed.
    cart().addItem(MEAL)              // 135
    cart().setDiscountPercent(10)     // −13.50 → taxable 121.50
    expect(cart().getTax(0.14)).toBeCloseTo(17.01)
    expect(cart().getTotal(0.14)).toBeCloseTo(138.51) // 135 + 17.01 − 13.50
  })

  it('charges no VAT on a discounted takeaway either', () => {
    cart().addItem(MEAL)
    cart().setOrderType('takeaway')
    cart().setDiscountPercent(10)
    expect(cart().getTax(0.14)).toBe(0)
    expect(cart().getTotal(0.14)).toBeCloseTo(121.5)
  })

  it('adds the delivery fee to the total', () => {
    cart().addItem(MEAL)
    cart().setOrderType('delivery')
    cart().setDeliveryFee(25)
    expect(cart().getTotal(0.14)).toBe(160) // 135 + 0 tax + 25 fee
  })

  it('a percentage discount follows the subtotal instead of freezing', () => {
    cart().addItem(MEAL)          // subtotal 135
    cart().setDiscountPercent(10)
    expect(cart().getDiscount()).toBeCloseTo(13.5)

    cart().addItem(MEAL)          // subtotal 270 — 10% must now be 27
    expect(cart().getSubtotal()).toBe(270)
    expect(cart().getDiscount()).toBeCloseTo(27)
    expect(cart().discountPercent).toBe(10) // the percentage is what's stored
  })

  it('clamps the discount percentage to a sane range', () => {
    cart().addItem(MEAL)
    cart().setDiscountPercent(500)
    expect(cart().discountPercent).toBe(100)
    cart().setDiscountPercent(-20)
    expect(cart().discountPercent).toBe(0)
  })

  it('clear() resets the discount along with everything else', () => {
    cart().addItem(MEAL)
    cart().setDiscountPercent(15)
    cart().setDeliveryFee(30)
    cart().clear()
    expect(cart().discountPercent).toBe(0)
    expect(cart().deliveryFee).toBe(0)
    expect(cart().items).toHaveLength(0)
  })
})
