/**
 * The markup for everything that comes out of a thermal printer.
 *
 * Chromium renders this, which is the whole point: Arabic needs a shaping engine to
 * join its letters and lay them out right-to-left, and the printers' own character
 * sets have none. Rendering to pixels and printing the pixels is the only way the
 * receipt reads the way the counter expects.
 *
 * The layout is sized in `rem` against a root font-size derived from the paper
 * width, so ONE template serves both the 384-dot raster path and the much smaller
 * CSS-pixel page the Windows driver path prints. Hard-coded pixel sizes would come
 * out microscopic on one of the two.
 */

import type { OrderType, PaymentType, SalesProductsReport, ClosingReport } from '../../../shared/types'

/** What the counter printer needs of a sales report — the report itself, as it is. */
export type SalesProductsTicket = SalesProductsReport

export interface TicketItem {
  name: string
  variantLabel?: string | null
  quantity: number
  unitPrice: number
  categoryId?: number | null
  categoryName?: string | null
}

export interface TicketOrder {
  orderId: number
  invoiceNumber: string
  orderType: OrderType
  createdAt: string
  /** `DD/MM/YYYY` — the invoice heads the date and the time as separate fields. */
  orderDate?: string
  /** `HH:MM`, 24-hour. */
  orderTime?: string
  cashierName: string
  items: TicketItem[]
  subtotal: number
  tax: number
  discount: number
  discountPercent: number
  deliveryFee: number
  totalAmount: number
  paymentType: PaymentType
  tenderedAmount?: number
  changeDue?: number
  customerName?: string | null
  customerPhone?: string | null
  customerAddress?: string | null
  areaName?: string | null
  driverName?: string | null
  /** Free text from the cashier. Printed only when there is some. */
  notes?: string | null
}

export interface TicketBranding {
  businessName: string
  businessAddress: string
  businessPhone: string
  receiptFooter: string
  currency: string
  /** data: URI, or null when the owner has the logo switched off. */
  logoDataUri?: string | null
}

export interface TicketOptions {
  /** Render width in CSS pixels. The raster path passes printer dots. */
  widthPx: number
  /** Blank lines of padding at the very bottom, before the cut. */
  feedLines?: number
  /** Stamps the ticket so a reprint is never mistaken for a second sale. */
  reprint?: boolean
  /**
   * Text size as a percentage of the default. 100 is what the counter reads
   * comfortably at arm's length; raise it for a kitchen that reads the ticket from
   * further away, lower it to fit more lines on a roll.
   */
  fontScale?: number
  /**
   * Print the FULL delivery block — address, area, driver.
   *
   * Off for the customer's own copy: they know their own address, and telling them
   * costs three lines of paper on every delivery. On for the rider's copy, which is
   * the one that actually has to find the door.
   */
  fullDelivery?: boolean
}

const ORDER_TYPE_AR: Record<OrderType, string> = {
  dine_in: 'صالة',
  takeaway: 'تيك أواي',
  delivery: 'دليفري',
}

/** Anything from the database can contain the characters that would break out of the markup. */
function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * `DD/MM/YYYY HH:MM` for the test page. Deliberately not Intl: its Arabic output
 * carries embedded right-to-left marks that reorder inside the isolated number spans.
 */
function stamp(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} - ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** A money figure, isolated so its sign cannot be dragged to the far end of the line. */
function money(n: number): string {
  return `<span class="num">${(Number(n) || 0).toFixed(2)}</span>`
}

/**
 * Everything scales off this: the number of characters that fit across the roll.
 *
 * Nineteen rather than a tighter fit because a 203dpi head is not a screen — it
 * burns a coarse dot and thins every stroke, so type that looks correct in a browser
 * comes off the printer noticeably lighter and smaller than it should. Widening the
 * character cell buys back the legibility the head takes away.
 */
const CHARS_ACROSS = 19

function baseFontPx(widthPx: number, fontScale = 100): number {
  const scale = Math.max(70, Math.min(200, fontScale || 100)) / 100
  return (widthPx / CHARS_ACROSS) * scale
}

function shell(widthPx: number, body: string, fontScale?: number, extraCss = ''): string {
  const base = baseFontPx(widthPx, fontScale)
  return `<!doctype html>
<html dir="rtl" lang="ar">
<head>
<meta charset="utf-8">
<style>
  @page { margin: 0; }
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  html {
    font-size: ${base.toFixed(3)}px;
    /* Tahoma carries a complete, well-hinted Arabic set on every Windows since XP,
       and stays legible when a 203dpi head knocks the anti-aliasing out of it. */
    font-family: Tahoma, "Segoe UI", "Arial", sans-serif;
  }
  body {
    width: ${widthPx}px;
    margin: 0;
    padding: 0;
    background: #fff;
    color: #000;
    font-size: 1rem;
    line-height: 1.28;
    /* Bold throughout, not just on headings. A thermal head under-burns the edge of
       every stroke, so regular weight comes out spindly and grey on the paper —
       which is what "the font is too small" usually turns out to mean. Hierarchy is
       carried by size instead, since Tahoma has only the two weights. */
    font-weight: 700;
    /* The head burns a dot or leaves it white — there is no grey. Rendering pure
       black on pure white means the threshold has clean edges to work with. */
    -webkit-font-smoothing: none;
  }
  .c { text-align: center; }
  .l { text-align: left; }
  .r { text-align: right; }
  .b { font-weight: 700; }
  /* Every number on the ticket. Without isolating them, the bidi algorithm drags an
     adjacent sign to the wrong end inside a right-to-left line: "-56.00" printed as
     "56.00-" and "10%" as "%10", which on an invoice is not a cosmetic problem. */
  .num { direction: ltr; unicode-bidi: isolate; }
  .rule { border-top: 1px dashed #000; margin: 0.4rem 0; }
  .rule-solid { border-top: 2px solid #000; margin: 0.15rem 0; }
  table { width: 100%; border-collapse: collapse; }
  td, th { padding: 0.12rem 0; vertical-align: top; }
  .row { display: flex; justify-content: space-between; gap: 0.5rem; }
  .row > span:last-child { white-space: nowrap; }
  .feed { height: var(--feed, 0); }
${extraCss}
</style>
</head>
<body>${body}</body>
</html>`
}

function feedBlock(lines: number | undefined): string {
  const n = Math.max(0, Math.min(20, lines ?? 0))
  return n > 0 ? `<div style="height:${n * 1.35}rem"></div>` : ''
}

/**
 * The order's note, boxed so it cannot be skimmed past.
 *
 * Returns nothing at all when there is no note — not an empty box, not a "ملاحظات: —"
 * line. A heading with nothing under it is paper spent to say nothing, which on a
 * thermal roll is the whole problem being solved here.
 */
function notesBlock(notes: string | null | undefined): string {
  const text = (notes ?? '').trim()
  if (!text) return ''
  return `<div class="note"><span class="note-tag">ملاحظات:</span> ${esc(text)}</div>`
}

function reprintBanner(on: boolean | undefined): string {
  if (!on) return ''
  return `<div class="c b" style="font-size:1.15rem;border:2px solid #000;padding:0.2rem;margin-bottom:0.4rem">
    نسخة مُعادة الطباعة
  </div>`
}

/**
 * The customer's invoice.
 *
 * Laid out the way the local competition prints theirs, because a receipt is the one
 * piece of the restaurant a customer takes home and a familiar shape reads as a
 * professional one: a dotted outer frame, a two-column header of `Label : value`
 * pairs, the restaurant's mark under it, a fully ruled items grid, and the money
 * stacked in its own boxes underneath.
 *
 * The labels are bilingual for the same reason — every till in the trade prints
 * `Order No` and `Total` in English over Arabic item names, so that is what both the
 * staff and the customer are used to reading.
 */
export function receiptHtml(
  order: TicketOrder,
  brand: TicketBranding,
  opts: TicketOptions,
): string {
  const cur = esc(brand.currency)
  const amount = (n: number) => `<span class="num">${(Number(n) || 0).toFixed(2)} ${cur}</span>`

  // The mark is cropped to its own ink, so the width here is width the logo actually
  // uses rather than white canvas — a percentage that would have been far too big for
  // the padded original. No max-height: the aspect ratio governs, and capping the
  // height would letterbox it back to the size we just escaped.
  const logo = brand.logoDataUri
    ? `<div class="c" style="padding:0.15rem 0">
         <img src="${brand.logoDataUri}" alt=""
              style="width:46%;display:block;margin:0 auto">
       </div>`
    : ''

  /**
   * One `Label : value` cell of the header grid.
   *
   * The label is English and the value is usually Arabic, so the value goes in a
   * <bdi>: without it the bidi algorithm pulls the colon to the far end of an
   * Arabic value and the field prints as ": Date".
   */
  const field = (label: string, value: string) =>
    `<div class="fld"><span class="lbl">${label} :</span> <bdi>${value}</bdi></div>`

  /**
   * The rider's details run the full width rather than sharing the two-column grid.
   * A phone number and a street address are simply longer than half a 72mm roll, and
   * wrapping the one line the driver actually navigates by is worse than spending a
   * whole line on it.
   */
  const wideField = (label: string, value: string) =>
    `<div class="fld wide"><span class="lbl">${label} :</span> <bdi>${value}</bdi></div>`

  const customerFields = order.orderType !== 'delivery'
    ? ''
    : opts.fullDelivery
      ? `${wideField('Customer', esc(order.customerName))}
         ${wideField('Phone', `<span class="num">${esc(order.customerPhone)}</span>`)}
         ${wideField('Address', esc(order.customerAddress))}
         ${order.areaName ? wideField('Area', esc(order.areaName)) : ''}
         ${order.driverName ? wideField('Driver', esc(order.driverName)) : ''}`
      // Every delivery invoice says where it was going, customer copy included. It is
      // the line that settles an argument later — which address this order was sent
      // to — and neither the shop's copy nor the customer's can answer that without
      // it. The area rides along when there is one, because that is what the delivery
      // fee on the same ticket was charged for.
      : `${field('Customer', esc(order.customerName))}
         ${field('Phone', `<span class="num">${esc(order.customerPhone)}</span>`)}
         ${wideField('Address', esc(order.customerAddress))}
         ${order.areaName ? wideField('Area', esc(order.areaName)) : ''}`

  /**
   * The Type column only exists when something is actually in it.
   *
   * On an order where nothing has a variant it was a column of dashes — a quarter of
   * the paper's width spent saying nothing, and it squeezed the item names into more
   * wrapped lines, so it cost height as well. Dropped entirely, the name gets that
   * width back and most rows fit on one line.
   */
  const showType = order.items.some(it => !!it.variantLabel)

  const rows = order.items.map(it => `
    <tr>
      <td class="${showType ? 'nm' : 'nm nm-wide'}">${esc(it.name)}</td>
      ${showType ? `<td class="c ty">${it.variantLabel ? esc(it.variantLabel) : '—'}</td>` : ''}
      <td class="c qt num">${it.quantity}</td>
      <td class="c tt num">${(it.unitPrice * it.quantity).toFixed(2)}</td>
    </tr>`).join('')

  // VAT is charged on dine-in only, and delivery orders are the only ones carrying a
  // fee — printing either line at zero on the other order types just adds noise.
  const taxLine = order.orderType === 'dine_in'
    ? `<div class="sum"><span>VAT :</span><span>${amount(order.tax)}</span></div>`
    : ''
  const feeLine = order.orderType === 'delivery'
    ? `<div class="sum"><span>Delivery :</span><span>${amount(order.deliveryFee)}</span></div>`
    : ''
  const discountLine = `<div class="sum">
      <span>Discount${order.discount > 0 ? ` (${order.discountPercent}%)` : ''} :</span>
      <span class="num">${order.discount > 0 ? '-' : ''}${(Number(order.discount) || 0).toFixed(2)} ${cur}</span>
    </div>`

  // Only meaningful when cash actually changed hands; on a card sale there is no
  // tender and no change, and printing two zero lines invites the customer to ask.
  const cashLines = order.paymentType === 'cash' && (order.tenderedAmount ?? 0) > 0
    ? `<div class="sum"><span>Paid :</span><span>${amount(order.tenderedAmount!)}</span></div>
       <div class="sum b"><span>Change :</span><span>${amount(order.changeDue ?? 0)}</span></div>`
    : ''

  const body = `
    ${reprintBanner(opts.reprint)}
    <div class="frame">

      <div class="hdr">
        <div class="ordno">
          Order No: <span class="num">${esc(order.invoiceNumber)}</span>
          <span class="otype">${ORDER_TYPE_AR[order.orderType]}</span>
        </div>
        <div class="grid">
          <!-- Date and time share one field: two labels for one moment was a whole
               wasted line, and nobody reads them separately. -->
          ${field('Date', `<span class="num">${esc(order.orderDate || order.createdAt)} ${esc(order.orderTime || '')}</span>`)}
          ${field('Emp', esc(order.cashierName))}
          ${customerFields}
        </div>
      </div>

      ${logo}

      <table class="items">
        <thead>
          <tr>
            <th class="${showType ? 'nm' : 'nm nm-wide'}">Name</th>
            ${showType ? '<th class="c ty">Type</th>' : ''}
            <th class="c qt">Qty</th>
            <th class="c tt">Total</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>

      <div class="totals">
        <div class="sum"><span>Amount :</span><span>${amount(order.subtotal)}</span></div>
        ${taxLine}
        ${feeLine}
        ${discountLine}
      </div>

      <div class="grand">
        <span>Total</span><span>${amount(order.totalAmount)}</span>
      </div>

      <div class="totals">
        <div class="sum">
          <span>Payment :</span>
          <span>${order.paymentType === 'cash' ? 'Cash / نقدي' : 'Card / بطاقة'}</span>
        </div>
        ${cashLines}
      </div>

      ${notesBlock(order.notes)}

      <div class="foot">
        <div class="b">${esc(brand.receiptFooter)}</div>
        <!-- Address and phone on ONE line. They were a line each, and a customer
             standing in the shop does not need the address of the shop. -->
        ${[brand.businessAddress, brand.businessPhone].filter(Boolean).length > 0
          ? `<div>${[esc(brand.businessAddress), brand.businessPhone ? `<span class="num">${esc(brand.businessPhone)}</span>` : '']
              .filter(Boolean).join(' · ')}</div>`
          : ''}
      </div>

    </div>
    ${feedBlock(opts.feedLines)}
  `

  return shell(opts.widthPx, body, opts.fontScale, RECEIPT_CSS)
}

/**
 * The framed look. Kept out of the shared shell because only the customer's invoice
 * wears it — a kitchen ticket wants the opposite, nothing but the items at the
 * largest type that will fit.
 *
 * Borders are solid black at 1px: a dotted CSS border renders as alternating dots
 * that a 203dpi head prints as a broken grey smudge, so the dotted effect in the
 * frame comes from `dashed` at a full millimetre pitch, which survives the threshold.
 */
const RECEIPT_CSS = `
  /* Every measurement here was cut to spend less paper. A thermal roll is charged by
     the metre and this receipt prints on every sale, so a tenth of a rem repeated
     down the page is real money. Nothing legible was traded away — the type sizes are
     untouched; what went is padding, blank lines and information printed twice. */
  .frame { border: 2px dashed #000; padding: 0.25rem 0.3rem; }

  /* The header, the money and the table headings are laid out left-to-right around
     English labels; only the Arabic values inside them flip, via <bdi>. Letting the
     whole line inherit the page's right-to-left direction is what threw the colons
     to the wrong end and wrapped every label onto two lines. */
  .hdr, .sum, .grand, .items th { direction: ltr; text-align: left; }

  .ordno {
    font-size: 1.2rem; font-weight: 700; white-space: nowrap;
    border-bottom: 2px solid #000; padding-bottom: 0.1rem; margin-bottom: 0.18rem;
    display: flex; justify-content: space-between; align-items: baseline; gap: 0.5rem;
  }
  /* Not a grid: fixed columns cannot serve both header rows at once. Half the width
     is too little for "Date : 01/09/2026 02:15 م" and more than enough for "Emp",
     but widening that column then wraps "Customer" on the row below. Letting each
     field take exactly the width of its own text and packing as many as fit per line
     wraps neither, and folds a short header onto a single line. */
  .grid { display: flex; flex-wrap: wrap; column-gap: 0.6rem; }
  .fld { font-size: 0.78rem; line-height: 1.2; flex: 0 1 auto; }
  .fld.wide { flex: 1 0 100%; }
  .lbl { font-weight: 700; }

  .items { border: 1px solid #000; margin: 0.2rem 0 0.18rem; table-layout: fixed; }
  .items th, .items td {
    border: 1px solid #000; padding: 0.06rem 0.08rem; vertical-align: middle;
    font-size: 0.95rem;
  }
  .items th { font-size: 0.82rem; }
  /* Every column is given an explicit share. Leaving the last ones to divide what is
     left over made both too narrow, and a fixed table does not grow to fit — it just
     breaks "150.00" across two lines mid-number, which on a price is unreadable. */
  /* The item name is set noticeably smaller than the figures beside it.
     It is the longest text on the ticket and the only thing that wraps: at the same
     size as the numbers, "ساندوتش زنجر سوبريم كلاسيك" took THREE lines, and three
     lines per item is most of why the receipt was so long. Smaller type here buys
     back more paper than anything else on the page, and the money — which is what
     anyone actually checks — stays at full size. */
  .items .nm {
    width: 40%; direction: rtl; text-align: right; word-wrap: break-word;
    font-size: 0.62rem; line-height: 1.25;
  }
  /* The variant wraps at spaces ONLY. Breaking anywhere turned "حار (سبايسي)" into
     three lines, orphaning the closing bracket and making every row a third taller. */
  .items .ty { width: 22%; direction: rtl; font-size: 0.7rem; word-break: keep-all; }
  /* With no Type column, the name takes back the width it was using. */
  .items .nm-wide { width: 62%; }
  .items .qt { width: 13%; }
  .items .tt { width: 23%; white-space: nowrap; }

  .totals { margin: 0.12rem 0; }
  .sum {
    display: flex; justify-content: space-between; gap: 0.4rem;
    font-size: 0.95rem; padding: 0.02rem 0.1rem;
    border-bottom: 1px dashed #000;
  }
  .sum > span:last-child { white-space: nowrap; }
  .grand {
    display: flex; justify-content: space-between; gap: 0.4rem;
    font-size: 1.45rem; font-weight: 700;
    border: 2px solid #000; padding: 0.14rem 0.18rem; margin: 0.18rem 0;
  }
  .otype { font-size: 0.95rem; font-weight: 700; white-space: nowrap; }
  /* The note is boxed so a glance at the ticket cannot miss it. */
  .note {
    border: 2px solid #000; padding: 0.14rem 0.2rem; margin: 0.15rem 0;
    font-size: 0.53rem; font-weight: 700; line-height: 1.3;
  }
  .note-tag { text-decoration: underline; }
  .foot {
    text-align: center; font-size: 0.85rem; line-height: 1.25;
    border-top: 2px solid #000; padding-top: 0.18rem; margin-top: 0.18rem;
  }
`

/**
 * The item rows shared by the kitchen and counter tickets — quantity first.
 *
 * Sized to be read at arm's length across a pass, not from the far side of the room.
 * The earlier sizes were closer to a poster: at 2rem a quantity, three items filled
 * more paper than the customer's fully-priced invoice, which is the wrong way round.
 * The quantity still gets the largest type here — it is just no longer enormous.
 */
function prepRows(order: TicketOrder): string {
  return order.items.map(it => `
    <tr style="border-bottom:1px dashed #000">
      <td class="b c num" style="width:20%;font-size:1.15rem;line-height:1.05;padding:0.08rem 0">×${it.quantity}</td>
      <td style="padding:0.08rem 0">
        <div class="b" style="font-size:0.8rem;line-height:1.15">${esc(it.name)}</div>
        ${it.variantLabel ? `<div class="b" style="font-size:0.7rem">— ${esc(it.variantLabel)}</div>` : ''}
      </td>
    </tr>`).join('')
}

/** The heading both prep tickets share: what kind of order, its number, the station. */
function prepHeader(order: TicketOrder, stationName: string, opts: TicketOptions): string {
  return `
    ${reprintBanner(opts.reprint)}
    <div class="c b" style="font-size:1.15rem;line-height:1.1;border:2px solid #000;padding:0.06rem">
      ${ORDER_TYPE_AR[order.orderType]}
    </div>
    <div class="c b" style="font-size:1rem;margin-top:0.08rem">
      <span class="num">${esc(order.invoiceNumber)}</span>
      <span style="font-size:0.75rem"> · ${esc(stationName)} · <span class="num">${esc(order.orderTime || '')}</span></span>
    </div>`
}

/**
 * The KITCHEN's copy.
 *
 * No prices anywhere — the line cook needs the quantity and the item, read from
 * across a hot pass, and money on a prep ticket is only something to mis-read. The
 * quantity gets the largest type on the page.
 *
 * No customer details either: the kitchen cooks the food, it does not deliver it. An
 * address on this ticket is a line of paper and a line of reading for nobody. That is
 * the difference between this and the counter's copy.
 */
export function kitchenTicketHtml(
  order: TicketOrder,
  stationName: string,
  opts: TicketOptions,
): string {
  const body = `
    ${prepHeader(order, stationName, opts)}
    <div class="rule-solid"></div>
    <table>${prepRows(order)}</table>
    <div class="rule-solid"></div>
    <div class="c b" style="font-size:0.85rem">
      إجمالي القطع: <span class="num">${order.items.reduce((s, i) => s + i.quantity, 0)}</span>
    </div>
    ${notesBlock(order.notes)}
    ${feedBlock(opts.feedLines)}
  `
  return shell(opts.widthPx, body, opts.fontScale, PREP_CSS)
}

/**
 * The COUNTER's copy — for whoever bags the order and hands it over.
 *
 * Same priceless item list as the kitchen, plus the two things the kitchen has no use
 * for and the counter cannot work without: who the order is for, and where it is
 * going. On a delivery that is the name, the phone and the area; on a takeaway it is
 * just the number to call out.
 */
export function counterTicketHtml(
  order: TicketOrder,
  stationName: string,
  opts: TicketOptions,
): string {
  const customerBlock = order.orderType === 'delivery' && order.customerName
    ? `<div class="handover">
         <div class="b" style="font-size:1.2rem">${esc(order.customerName)}</div>
         <div class="num" style="font-size:1.15rem">${esc(order.customerPhone)}</div>
         ${order.areaName ? `<div style="font-size:1.05rem">${esc(order.areaName)}</div>` : ''}
         ${order.customerAddress ? `<div style="font-size:1.05rem">${esc(order.customerAddress)}</div>` : ''}
         ${order.driverName ? `<div style="font-size:1.05rem">السائق: ${esc(order.driverName)}</div>` : ''}
       </div>`
    : order.customerName
      ? `<div class="handover"><div class="b" style="font-size:1.2rem">${esc(order.customerName)}</div></div>`
      : ''

  const body = `
    ${prepHeader(order, stationName, opts)}
    ${customerBlock}
    <div class="rule-solid"></div>
    <table>${prepRows(order)}</table>
    <div class="rule-solid"></div>
    <div class="c b" style="font-size:0.85rem">
      إجمالي القطع: <span class="num">${order.items.reduce((s, i) => s + i.quantity, 0)}</span>
    </div>
    ${notesBlock(order.notes)}
    ${feedBlock(opts.feedLines)}
  `
  return shell(opts.widthPx, body, opts.fontScale, PREP_CSS)
}

/** Shared by the two prep tickets. The receipt's framed styling does not apply here. */
const PREP_CSS = `
  .note {
    border: 2px solid #000; padding: 0.1rem 0.18rem; margin: 0.1rem 0;
    font-size: 0.43rem; font-weight: 700; line-height: 1.2;
  }
  .note-tag { text-decoration: underline; }
  .handover {
    border: 1px solid #000; padding: 0.1rem 0.2rem; margin-top: 0.12rem;
    text-align: center; line-height: 1.2;
  }
`

/** Why a cancellation ticket is being printed, and who is behind it. */
export interface VoidTicketInfo {
  /** 'void' — the invoice was cancelled. 'delete' — it was removed from the books. */
  kind: 'void' | 'delete'
  /** What the cashier or owner gave as the reason. May be empty. */
  reason?: string | null
  /** Who authorised it. */
  byName?: string | null
  /** `DD/MM/YYYY - HH:MM` of the cancellation itself, not of the original sale. */
  at: string
}

/**
 * The CANCELLATION ticket — the slip that tells a kitchen to stop cooking.
 *
 * A void is only half-done while the food is still on the pass. The kitchen printed a
 * prep ticket the moment the order was rung up and has no other way of learning the
 * order has gone; before this, the only signal was somebody walking through and
 * saying so, which on a busy Friday is how a cancelled order still gets cooked, bagged
 * and thrown away.
 *
 * Laid out to be unmistakable at a glance across a hot pass: a solid black banner, and
 * every item struck through. It carries the same order number and the same items as
 * the ticket already clipped to the rail, so the cook can find that ticket and pull it.
 */
export function voidTicketHtml(
  order: TicketOrder,
  stationName: string,
  info: VoidTicketInfo,
  opts: TicketOptions,
): string {
  const heading = info.kind === 'delete' ? 'فاتورة محذوفة' : 'فاتورة ملغاة'

  const rows = order.items.map(it => `
    <tr style="border-bottom:1px dashed #000">
      <td class="b c num" style="width:20%;font-size:1.15rem;line-height:1.05;padding:0.08rem 0">×${it.quantity}</td>
      <td style="padding:0.08rem 0">
        <div class="b struck" style="font-size:0.8rem;line-height:1.15">${esc(it.name)}</div>
        ${it.variantLabel ? `<div class="b struck" style="font-size:0.7rem">— ${esc(it.variantLabel)}</div>` : ''}
      </td>
    </tr>`).join('')

  const reason = (info.reason ?? '').trim()

  const body = `
    <div class="banner">${heading}<br>CANCELLED</div>

    <div class="c b" style="font-size:1.25rem;margin-top:0.12rem">
      ${ORDER_TYPE_AR[order.orderType]} <span class="num">${esc(order.invoiceNumber)}</span>
    </div>
    <div class="c" style="font-size:0.7rem;margin-top:0.04rem">
      ${esc(stationName)} · طُلب <span class="num">${esc(order.orderTime || '')}</span>
      · أُلغي <span class="num">${esc(info.at)}</span>
    </div>
    <div class="c" style="font-size:0.7rem">
      الكاشير: ${esc(order.cashierName)}${info.byName ? ` · بمعرفة: ${esc(info.byName)}` : ''}
    </div>

    <div class="rule-solid"></div>
    <table>
      <tr><th style="text-align:center;width:20%;font-size:0.7rem">الكمية</th>
          <th style="text-align:right;font-size:0.7rem">الصنف</th></tr>
      ${rows}
    </table>
    <div class="rule-solid"></div>

    <div class="c b" style="font-size:0.85rem">
      إجمالي القطع الملغاة: <span class="num">${order.items.reduce((s, i) => s + i.quantity, 0)}</span>
    </div>

    ${reason ? `<div class="note"><span class="note-tag">السبب:</span> ${esc(reason)}</div>` : ''}

    <div class="banner" style="font-size:0.95rem;margin-top:0.18rem">
      أوقف التحضير — لا تُسلَّم
    </div>
    ${feedBlock(opts.feedLines)}
  `
  return shell(opts.widthPx, body, opts.fontScale, PREP_CSS + VOID_CSS)
}

const VOID_CSS = `
  /* Solid black, white type. A thermal head burns the whole cell, so this is the one
     thing on the roll that cannot be mistaken for an ordinary prep ticket. */
  .banner {
    background: #000; color: #fff; text-align: center; font-weight: 700;
    font-size: 1.3rem; line-height: 1.12; padding: 0.16rem 0.1rem;
  }
  .struck { text-decoration: line-through; text-decoration-thickness: 0.06rem; }
  /* Overrides the prep ticket's note size. On a kitchen ticket a note is a detail;
     on a cancellation it is the answer to "why has this come back", which somebody
     is going to be asked — so it is set to be read, not squinted at. */
  .note { font-size: 0.72rem; padding: 0.16rem 0.22rem; margin: 0.16rem 0; }
`

/** What a supplier voucher needs to say, gathered by the service before printing. */
export interface SupplierTicket {
  invoiceNumber: number
  supplierName: string
  supplierPhone?: string | null
  date: string
  reference?: string | null
  recordedBy?: string | null
  items: { name: string; unit: string; quantity: number; unitCost: number; lineTotal: number }[]
  /** This delivery. */
  invoiceTotal: number
  /** The supplier's whole account, as it stands after this delivery. */
  totalSupplied: number
  totalPaid: number
  balanceOwed: number
  notes?: string | null
}

/**
 * The voucher for goods arriving from a supplier — printed twice, once for each side.
 *
 * This is not a customer receipt and does not pretend to be. What both parties are
 * signing off is three numbers: what came in today, what has been paid across the
 * whole account, and what is therefore still owed. The running balance matters more
 * than the delivery total, because it is the figure they will argue about later.
 *
 * Signature lines at the bottom are the point of printing it at all — a delivery
 * nobody signed for is exactly the one that gets disputed.
 */
export function supplierInvoiceHtml(
  t: SupplierTicket,
  brand: TicketBranding,
  opts: TicketOptions & { copy: 'supplier' | 'restaurant' },
): string {
  const cur = esc(brand.currency)
  const amount = (n: number) => `<span class="num">${(Number(n) || 0).toFixed(2)} ${cur}</span>`

  const logo = brand.logoDataUri
    ? `<div class="c" style="padding:0.15rem 0">
         <img src="${brand.logoDataUri}" alt="" style="width:46%;display:block;margin:0 auto">
       </div>`
    : ''

  // The unit price sits under the name rather than in a column of its own: a purchase
  // document has to show the rate the two sides agreed, but a fifth column on an 80mm
  // roll leaves every heading touching its neighbour.
  const rows = t.items.map(it => `
    <tr>
      <td class="nm">
        ${esc(it.name)}
        <div style="font-size:0.78rem">
          <span class="num">${it.unitCost.toFixed(2)}</span> ${cur} / ${esc(it.unit)}
        </div>
      </td>
      <td class="c ty">${esc(it.unit)}</td>
      <td class="c qt num">${it.quantity}</td>
      <td class="c tt num">${it.lineTotal.toFixed(2)}</td>
    </tr>`).join('')

  const isSupplierCopy = opts.copy === 'supplier'

  const body = `
    ${reprintBanner(opts.reprint)}
    <div class="frame">

      <div class="hdr">
        <div class="ordno">
          إيصال توريد <span class="num">#${t.invoiceNumber}</span>
          <span class="otype">${isSupplierCopy ? 'نسخة المورد' : 'نسخة المطعم'}</span>
        </div>
        <div class="grid">
          <div class="fld wide"><span class="lbl">المورد :</span> <bdi>${esc(t.supplierName)}</bdi></div>
          ${t.supplierPhone ? `<div class="fld wide"><span class="lbl">الهاتف :</span> <span class="num">${esc(t.supplierPhone)}</span></div>` : ''}
          <div class="fld"><span class="lbl">التاريخ :</span> <span class="num">${esc(t.date)}</span></div>
          ${t.reference ? `<div class="fld"><span class="lbl">مرجع :</span> <bdi>${esc(t.reference)}</bdi></div>` : ''}
          ${t.recordedBy ? `<div class="fld wide"><span class="lbl">استلمها :</span> <bdi>${esc(t.recordedBy)}</bdi></div>` : ''}
          <div class="fld wide"><span class="lbl">الجهة :</span> <bdi>${esc(brand.businessName)}</bdi></div>
        </div>
      </div>

      ${logo}

      <table class="items">
        <thead>
          <tr>
            <th class="nm">الصنف</th>
            <th class="c ty">وحدة</th>
            <th class="c qt">كمية</th>
            <th class="c tt">إجمالي</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>

      <div class="grand">
        <span>قيمة التوريد</span><span>${amount(t.invoiceTotal)}</span>
      </div>

      <!-- The account, not just today. This is the part either side will come back to. -->
      <div class="totals">
        <div class="sum"><span>إجمالي التوريدات :</span><span>${amount(t.totalSupplied)}</span></div>
        <div class="sum"><span>إجمالي المدفوع :</span><span>${amount(t.totalPaid)}</span></div>
      </div>

      <div class="grand">
        <!-- Smaller than the other heavy box: "المستحق للمورد" is long enough to wrap
             at the grand-total size, and a two-line label in a bordered box looks
             like a fault. -->
        <span style="font-size:1.05rem">${t.balanceOwed >= 0 ? 'المستحق للمورد' : 'دفعنا زيادة'}</span>
        <span>${amount(Math.abs(t.balanceOwed))}</span>
      </div>

      ${notesBlock(t.notes)}

      <div class="sign">
        <div class="sign-box">توقيع المورد<div class="sign-line"></div></div>
        <div class="sign-box">توقيع المستلم<div class="sign-line"></div></div>
      </div>

      <div class="foot">
        ${[brand.businessAddress, brand.businessPhone].filter(Boolean).length > 0
          ? `<div>${[esc(brand.businessAddress), brand.businessPhone ? `<span class="num">${esc(brand.businessPhone)}</span>` : '']
              .filter(Boolean).join(' · ')}</div>`
          : ''}
      </div>

    </div>
    ${feedBlock(opts.feedLines)}
  `

  return shell(opts.widthPx, body, opts.fontScale, RECEIPT_CSS + SUPPLIER_CSS)
}

/** Only the voucher has signature lines; the customer's receipt has no use for them. */
const SUPPLIER_CSS = `
  .sign { display: flex; gap: 0.6rem; margin-top: 0.4rem; }
  .sign-box { flex: 1; text-align: center; font-size: 0.85rem; }
  .sign-line { border-bottom: 1px solid #000; height: 1.6rem; }
`

/** The page the "اختبار الطابعة" button prints — proves paper, Arabic, cut and drawer. */
/**
 * «Sales Products» on the counter printer.
 *
 * Deliberately the same shape as the sheet the owner already reads: the period and the
 * store at the top, then section by section — a heading, its lines as Product / Qty /
 * Total, and the section's own total — and the grand total at the end.
 *
 * Receipt paper is 48–72mm, so the screen's four columns will not fit. The unit column
 * is dropped (it is «each» on every line) and quantity sits tight against the name,
 * which keeps the number and the thing it counts on the same line at 58mm.
 */
export function salesProductsHtml(
  report: SalesProductsTicket,
  brand: TicketBranding,
  opts: TicketOptions,
): string {
  const money = (n: number) => n.toFixed(2)

  const section = (g: SalesProductsTicket['groups'][number]) => `
    <div style="margin-top:9px">
      <div class="b" style="font-size:1.15rem;border-bottom:1px solid #000;padding-bottom:2px">
        ${esc(g.category)}
      </div>
      ${g.items.map(i => `
        <div class="row" style="font-size:1.05rem;margin-top:3px">
          <span style="flex:1;padding-left:6px">${esc(i.name)}</span>
          <span class="b num" style="min-width:2.4em;text-align:center">${i.quantity}</span>
          <span class="num" style="min-width:4.2em;text-align:left">${money(i.total)}</span>
        </div>`).join('')}
      <div class="row b" style="font-size:1.05rem;margin-top:3px;border-top:1px dotted #000;padding-top:2px">
        <span>إجمالي ${esc(g.category)}</span>
        <span class="num">${money(g.total)}</span>
      </div>
    </div>`

  const materials = report.materials.length === 0 ? '' : `
    <div class="rule"></div>
    <div class="b c" style="font-size:1.15rem">الخامات المستهلكة</div>
    ${report.materials.map(m => `
      <div class="row" style="font-size:1.05rem;margin-top:3px">
        <span style="flex:1;padding-left:6px">${esc(m.name)}</span>
        <span class="b num" style="min-width:4.5em;text-align:left">${m.quantity} ${esc(m.unit)}</span>
      </div>`).join('')}`

  const body = `
    <div class="c b" style="font-size:1.45rem">${esc(brand.businessName)}</div>
    <div class="c b" style="font-size:1.2rem;margin-top:2px">تقرير المبيعات بالأصناف</div>
    <div class="rule"></div>
    <div style="font-size:1.05rem">
      <div class="row"><span>من:</span><span class="num">${esc(report.period.start)}</span></div>
      <div class="row"><span>إلى:</span><span class="num">${esc(report.period.end)}</span></div>
      <div class="row"><span>عدد الفواتير:</span><span class="b num">${report.orderCount}</span></div>
      <div class="row"><span>طُبع:</span><span class="num">${esc(stamp())}</span></div>
    </div>
    <div class="rule"></div>
    ${report.groups.map(section).join('')
      || '<div class="c" style="font-size:1.1rem;padding:10px 0">لا توجد مبيعات في هذه الفترة</div>'}
    <div class="rule"></div>
    <div class="row b" style="font-size:1.3rem">
      <span>الإجمالي</span>
      <span class="num">${money(report.grandTotal)} ${esc(brand.currency)}</span>
    </div>
    <div class="row b" style="font-size:1.05rem;margin-top:2px">
      <span>إجمالي الكمية</span>
      <span class="num">${report.totalQuantity}</span>
    </div>
    ${materials}
    ${feedBlock(opts.feedLines)}
  `
  return shell(opts.widthPx, body, opts.fontScale)
}

/**
 * «تقفيل الوردية» on the counter printer — short enough to keep.
 *
 * It used to carry a line for every invoice of the shift, which on a normal night is
 * sixty lines and on a busy one two hundred: a strip a metre long, with the figures
 * anybody actually reads lost at the top of it. The invoices are on the shift report
 * (PDF and Excel); the slip is the page the drawer is counted against, so it holds
 * what that takes and nothing else:
 *
 *   the sales         how many, cash and card, by order type
 *   what went out     every expense and every wage, one line each, then their totals
 *   the drawer        how the expected cash is arrived at, boxed
 *
 * No profit on it: this slip is handled at the counter, and profit is on the owner's
 * own report. Spacing is tight and the text is held to at most 110% even where the
 * shop prints its receipts larger — the slip is read at the counter, not across it.
 */
export function closingHtml(
  r: ClosingReport,
  brand: TicketBranding,
  opts: TicketOptions & { printedBy?: string | null },
): string {
  const amt = (n: number) => `<span class="num">${(Number(n) || 0).toFixed(2)}</span>`
  const n = (v: number) => `<span class="num">${v}</span>`
  const line = (label: string, value: string, cls = '') =>
    `<div class="row ${cls}"><span>${label}</span><span>${value}</span></div>`
  const heading = (text: string) => `<div class="rule"></div><div class="h">${text}</div>`
  /** dd/mm hh:mm — the date matters on a night shift that ends after midnight. */
  const when = (stampText: string) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(stampText)
    return m ? `${m[3]}/${m[2]} ${m[4]}:${m[5]}` : stampText
  }

  /** A whole pound needs no ".00" in a list of small payments — it is what lets two fit a line. */
  const short = (v: number) => {
    const x = Number(v) || 0
    return `<span class="num">${Number.isInteger(x) ? x : x.toFixed(2)}</span>`
  }

  // Every payment out — expenses by what they were for, then wages, then suppliers.
  // These are what the drawer is short by, so each one is shown; two to a line, which
  // is what keeps a night with fifteen of them to half a hand's length of paper.
  const outCells = [
    ...r.expenses.map(e => [esc(e.description !== '—' ? e.description : e.category), e.amount] as const),
    ...r.salaries.map(s => [`مرتب ${esc(s.workerName)}`, s.amount] as const),
    ...r.supplierPayments.map(s => [`مورد ${esc(s.supplierName)}${s.method === 'cash' ? '' : '*'}`, s.amount] as const),
  ].map(([name, value]) => `<div class="cell"><span class="nm">${name}</span>${short(value)}</div>`)
  const outLines = outCells.length ? `<div class="grid">${outCells.join('')}</div>` : ''

  const byType = r.byOrderType
    .map(t => line(`${esc(t.label)} (${n(t.orders)})`, amt(t.total), 'li'))
    .join('')

  const body = `
    <div class="c b" style="font-size:1.3rem">${esc(brand.businessName)}</div>
    <div class="c b" style="font-size:1.1rem">تقفيل الوردية · ${esc(r.shiftName)}</div>
    <div class="c" style="font-size:0.85rem">
      <span class="num">${esc(when(r.from))}</span> ←
      ${r.isOpen ? 'جارية' : `<span class="num">${esc(when(r.endsAt))}</span>`}
    </div>
    <div class="c" style="font-size:0.75rem">طُبع <span class="num">${esc(stamp())}</span>${opts.printedBy ? ` · ${esc(opts.printedBy)}` : ''}</div>

    ${heading('المبيعات')}
    ${line(`عدد الفواتير`, n(r.orderCount))}
    ${line(`نقدي (${n(r.cashOrders)})`, amt(r.cashSales))}
    ${r.cardSales > 0 || r.cardOrders > 0 ? line(`بطاقة (${n(r.cardOrders)})`, amt(r.cardSales)) : ''}
    ${byType}
    ${r.discount > 0 ? line('خصومات', amt(r.discount), 'li') : ''}
    ${r.voidedCount > 0 ? line(`ملغاة (${n(r.voidedCount)})`, amt(r.voidedValue), 'li') : ''}
    ${line('إجمالي المبيعات', amt(r.revenue), 'b big')}

    ${heading('المصروفات والمرتبات')}
    ${outLines || '<div class="c li">لا توجد مصروفات ولا مرتبات</div>'}
    <div class="thin"></div>
    ${line('إجمالي المصروفات', amt(r.expensesTotal))}
    ${line('إجمالي المرتبات', amt(r.salariesTotal))}
    ${r.supplierPaymentsTotal > 0 ? line('مدفوعات موردين', amt(r.supplierPaymentsTotal)) : ''}
    ${line('إجمالي المدفوع', amt(r.outgoingsTotal), 'b')}

    <div class="box">
      <div class="row b big" style="margin:0"><span>النقدية في الدرج</span><span>${amt(r.expectedCash)}</span></div>
      <div class="how">
        نقدي ${short(r.cashSales)}
        − مدفوع ${short(r.expensesTotal + r.salariesTotal + r.supplierCashTotal)}
        ${r.driverCashOut > 0 ? `− مع السائقين ${short(r.driverCashOut)}` : ''}
        ${r.settlementsReceived > 0 ? `+ توريد ${short(r.settlementsReceived)}` : ''}
      </div>
    </div>
    ${r.driverCashPending > 0 ? line('لم يُورَّد من السائقين بعد', amt(r.driverCashPending), 'li') : ''}
    ${r.supplierPayments.some(s => s.method !== 'cash') ? '<div class="li">* مدفوع لمورد بغير النقدية — لم يخرج من الدرج</div>' : ''}

    <div class="sign"><span>توقيع الكاشير</span><span>توقيع المدير</span></div>
    ${feedBlock(opts.feedLines)}
  `
  // Held to 110% at most: the shop's receipt size is chosen for a customer reading at
  // arm's length; this is a page of figures, and every step up adds to its length.
  const scale = Math.min(Number(opts.fontScale) || 100, 110)
  return shell(opts.widthPx, body, scale, CLOSING_CSS)
}

const CLOSING_CSS = `
  body { line-height: 1.2; }
  .row { font-size: 1rem; margin: 0; break-inside: avoid; }
  .row.big { font-size: 1.15rem; }
  .row.li, .li { font-size: 0.85rem; }
  .h { font-size: 1rem; font-weight: 700; text-align: center; margin-bottom: 0.1rem; }
  .rule { margin: 0.25rem 0; }
  .thin { border-top: 1px dotted #000; margin: 0.15rem 0; }
  .box { border: 2px solid #000; padding: 0.15rem 0.3rem; margin-top: 0.2rem; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; column-gap: 0.7rem; font-size: 0.8rem; }
  .cell { display: flex; justify-content: space-between; gap: 0.3rem; min-width: 0; }
  .nm { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .how { font-size: 0.72rem; text-align: center; }
  .sign { display: flex; justify-content: space-between; font-size: 0.8rem;
          margin-top: 1.2rem; padding: 0 0.2rem; }
  .sign span { border-top: 1px dotted #000; padding-top: 0.1rem; min-width: 40%; text-align: center; }
`

export function testPageHtml(
  printerName: string,
  brand: TicketBranding,
  opts: TicketOptions,
): string {
  const body = `
    <div class="c b" style="font-size:1.5rem">اختبار الطباعة</div>
    <div class="rule"></div>
    <div style="font-size:1.15rem">
      <div class="row"><span>الطابعة:</span><span class="b">${esc(printerName)}</span></div>
      <div class="row"><span>المطعم:</span><span>${esc(brand.businessName)}</span></div>
      <div class="row"><span>الوقت:</span><span class="num">${esc(stamp())}</span></div>
    </div>
    <div class="rule"></div>
    <div class="c" style="font-size:1rem">
      <div>أبجد هوز حطي كلمن سعفص قرشت</div>
      <div>ABCDEFGHIJKLM 0123456789</div>
      <div class="b" style="font-size:1.3rem">${esc(brand.currency)} 1,234.56</div>
    </div>
    <div class="rule"></div>
    <div class="c" style="font-size:1.15rem">إذا ظهر النص العربي متصلاً وواضحاً فالطابعة جاهزة للعمل</div>
    ${feedBlock(opts.feedLines)}
  `
  return shell(opts.widthPx, body, opts.fontScale)
}
