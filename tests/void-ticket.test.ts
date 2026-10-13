import { describe, it, expect } from 'vitest'
import { voidTicketHtml, kitchenTicketHtml, type TicketOrder } from '../src/main/services/printing/templates'

/**
 * The slip that tells a kitchen to stop cooking.
 *
 * A void used to be a database change and nothing else. The prep ticket printed at the
 * moment of sale stayed clipped to the rail, so a cancelled order was still cooked,
 * bagged and binned — the stock came back in the books while the ingredients went in
 * the bin. What the cook needs is the SAME order number and the SAME items, struck
 * through, so they can find the original ticket and pull it.
 */

const ORDER: TicketOrder = {
  orderId: 41,
  invoiceNumber: '74263',
  orderType: 'delivery',
  createdAt: '07/09/2026 - 03:15',
  orderDate: '07/09/2026',
  orderTime: '03:15',
  cashierName: 'Cashier',
  items: [
    { name: 'وجبة ربع فراخ ورك', variantLabel: 'حار', quantity: 1, unitPrice: 105, categoryId: 1 },
    { name: 'وجبة ربع فراخ صدر', quantity: 2, unitPrice: 105, categoryId: 1 },
  ],
  subtotal: 315, tax: 0, discount: 0, discountPercent: 0, deliveryFee: 0,
  totalAmount: 315, paymentType: 'cash',
}

const html = voidTicketHtml(ORDER, 'المطبخ', {
  kind: 'void', reason: 'العميل ألغى الطلب', byName: 'المدير', at: '07/09/2026 - 03:22',
}, { widthPx: 384, feedLines: 2, fontScale: 100 })

describe('the cancellation ticket', () => {
  it('cannot be mistaken for an ordinary prep ticket', () => {
    expect(html).toContain('فاتورة ملغاة')
    expect(html).toContain('CANCELLED')
    // Solid black banner: a thermal head burns the whole cell, so nothing else on the
    // roll looks remotely like it.
    expect(html).toContain('background: #000')
  })

  it('strikes every item through', () => {
    expect(html).toContain('text-decoration: line-through')
    for (const item of ORDER.items) {
      const line = html.slice(html.indexOf(item.name) - 120, html.indexOf(item.name))
      expect(line, `${item.name} should be struck through`).toContain('struck')
    }
    // The variant matters too — "حار" cancelled is not the same order as "عادي".
    expect(html).toContain('حار')
  })

  it('carries the number and quantities of the ticket already on the rail', () => {
    expect(html).toContain('74263')
    expect(html).toContain('×1')
    expect(html).toContain('×2')
    expect(html).toContain('إجمالي القطع الملغاة')
    expect(html).toContain('3') // 1 + 2
  })

  it('says who cancelled it, when, and why', () => {
    expect(html).toContain('المدير')
    expect(html).toContain('03:22')
    expect(html).toContain('العميل ألغى الطلب')
    // And the time it was ORDERED, so the cook can find the right ticket.
    expect(html).toContain('03:15')
  })

  it('never prints a price — same rule as every other prep ticket', () => {
    expect(html).not.toContain('105')
    expect(html).not.toContain('315')
  })

  it('leaves out the reason box entirely when there is no reason', () => {
    const bare = voidTicketHtml(ORDER, 'المطبخ', { kind: 'delete', at: '07/09/2026 - 03:22' },
      { widthPx: 384 })
    expect(bare).not.toContain('السبب')
    expect(bare).toContain('فاتورة محذوفة')
  })

  it('is the same width and font machinery as the kitchen ticket it replaces', () => {
    const prep = kitchenTicketHtml(ORDER, 'المطبخ', { widthPx: 384, fontScale: 100 })
    const widthOf = (s: string) => /width:\s*(\d+)px/.exec(s)?.[1]
    expect(widthOf(html)).toBe(widthOf(prep))
  })
})
