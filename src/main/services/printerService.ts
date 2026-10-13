/**
 * The printers on the counter, and everything that comes out of them.
 *
 * The restaurant runs four identical XPrinter thermal units. Rather than hard-code
 * what each one is for, every printer is a row in the `printers` table with a role,
 * and this service decides which of them a given order concerns:
 *
 *   receipt   the customer's invoice, prices and all — every order
 *   kitchen   a priceless prep ticket, optionally filtered to certain categories
 *   bar       the same, for drinks; a separate role so it can be switched off alone
 *   delivery  a second copy of the invoice for the rider — delivery orders only
 *
 * Tickets are rasterised (see printing/render.ts) because Arabic cannot be printed
 * any other way on this hardware.
 */

import { app, BrowserWindow } from 'electron'
import log from 'electron-log/main'
import fs from 'node:fs'
import path from 'node:path'
import { getDb } from '../db/db'
import { getSettings } from './settingsService'
import type {
  Printer, PrinterInput, PrinterRole, PrintJobResult, SystemPrinter, OrderType, PaymentType,
  SalesProductsReport, ClosingReport,
} from '../../shared/types'
import {
  buildTicket, dotsForPaper, printableMmForPaper, init, MAX_REPORT_DOTS,
  openDrawer as drawerKick, beep as beepCommand,
} from './printing/escpos'
import { renderToMono, printViaDriver, mmToCssPx } from './printing/render'
import { sendToNetwork, sendToWindowsPrinter, probeNetwork } from './printing/transport'
import { printOnNodes } from '../net/masterLink'
import {
  receiptHtml, kitchenTicketHtml, counterTicketHtml, testPageHtml, supplierInvoiceHtml,
  voidTicketHtml, salesProductsHtml, closingHtml,
  type TicketOrder, type TicketBranding, type TicketItem, type SupplierTicket,
  type VoidTicketInfo,
} from './printing/templates'
import { getInvoice as getSupplierInvoice, getSupplierAccount } from './supplierService'

// ===== Registry =====

export function listPrinters(): Printer[] {
  return getDb()
    .prepare('SELECT * FROM printers ORDER BY display_order, printer_id')
    .all() as Printer[]
}

export function getPrinter(printerId: number): Printer | null {
  return (getDb()
    .prepare('SELECT * FROM printers WHERE printer_id = ?')
    .get(printerId) as Printer | undefined) ?? null
}

const ROLES: PrinterRole[] = ['receipt', 'counter', 'kitchen', 'bar', 'delivery']
const CONNECTIONS = ['windows_raw', 'windows_driver', 'network'] as const

/**
 * Validate here rather than leaning on the table's CHECK constraints: a rejected
 * INSERT surfaces as "SQLITE_CONSTRAINT", which tells the owner nothing about which
 * box on the form is wrong.
 */
function validate(input: PrinterInput): void {
  if (!input.name?.trim()) throw new Error('اسم الطابعة مطلوب')
  if (!ROLES.includes(input.role)) throw new Error('نوع الطابعة غير صحيح')
  if (!CONNECTIONS.includes(input.connection)) throw new Error('طريقة التوصيل غير صحيحة')

  if (input.connection === 'network') {
    if (!input.host?.trim()) throw new Error('عنوان IP الخاص بالطابعة مطلوب')
    const port = input.port ?? 9100
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('رقم المنفذ غير صحيح')
  } else if (!input.deviceName?.trim()) {
    throw new Error('اختر الطابعة المثبتة في ويندوز')
  }

  const paper = input.paperWidth ?? 80
  if (paper !== 58 && paper !== 80) throw new Error('عرض الورق يجب أن يكون 58 أو 80 مم')

  const copies = input.copies ?? 1
  if (!Number.isInteger(copies) || copies < 1 || copies > 5) {
    throw new Error('عدد النسخ يجب أن يكون بين 1 و 5')
  }
}

export function upsertPrinter(input: PrinterInput): Printer {
  validate(input)
  const db = getDb()

  const categoryIds = input.categoryIds?.length
    ? JSON.stringify([...new Set(input.categoryIds.map(Number).filter(Number.isFinite))])
    : null

  const values = {
    name: input.name.trim(),
    role: input.role,
    connection: input.connection,
    device_name: input.connection === 'network' ? null : (input.deviceName?.trim() || null),
    host: input.connection === 'network' ? (input.host?.trim() || null) : null,
    port: input.connection === 'network' ? (input.port ?? 9100) : 9100,
    paper_width: input.paperWidth ?? 80,
    copies: input.copies ?? 1,
    cut_paper: input.cutPaper === false ? 0 : 1,
    open_drawer: input.openDrawer ? 1 : 0,
    beep: input.beep ? 1 : 0,
    category_ids: categoryIds,
    station: input.station ?? 'any',
    auto_print: input.autoPrint === false ? 0 : 1,
    is_active: input.isActive === false ? 0 : 1,
    display_order: input.displayOrder ?? 0,
  }

  if (input.printerId) {
    db.prepare(`
      UPDATE printers SET
        name = @name, role = @role, connection = @connection, device_name = @device_name,
        host = @host, port = @port, paper_width = @paper_width, copies = @copies,
        cut_paper = @cut_paper, open_drawer = @open_drawer, beep = @beep,
        category_ids = @category_ids,
        station = @station, auto_print = @auto_print, is_active = @is_active, display_order = @display_order
      WHERE printer_id = @printer_id
    `).run({ ...values, printer_id: input.printerId })
    const updated = getPrinter(input.printerId)
    if (!updated) throw new Error('الطابعة غير موجودة')
    log.info(`[Print] Updated printer #${input.printerId} "${values.name}"`)
    return updated
  }

  const res = db.prepare(`
    INSERT INTO printers
      (name, role, connection, device_name, host, port, paper_width, copies,
       cut_paper, open_drawer, beep, category_ids, station, auto_print, is_active, display_order)
    VALUES
      (@name, @role, @connection, @device_name, @host, @port, @paper_width, @copies,
       @cut_paper, @open_drawer, @beep, @category_ids, @station, @auto_print, @is_active, @display_order)
  `).run(values)

  log.info(`[Print] Added printer "${values.name}" (${values.role}/${values.connection})`)
  return getPrinter(Number(res.lastInsertRowid))!
}

export function deletePrinter(printerId: number): void {
  const printer = getPrinter(printerId)
  if (!printer) throw new Error('الطابعة غير موجودة')
  getDb().prepare('DELETE FROM printers WHERE printer_id = ?').run(printerId)
  log.info(`[Print] Removed printer "${printer.name}"`)
}

/** Whatever Windows already has installed — the pick-list when adding a printer. */
export async function listSystemPrinters(): Promise<SystemPrinter[]> {
  const win = BrowserWindow.getAllWindows()[0]
  if (!win) return []
  const printers = await win.webContents.getPrintersAsync()
  return printers.map(p => ({
    name: p.name,
    displayName: p.displayName || p.name,
    description: p.description || '',
    status: p.status,
    isDefault: p.isDefault,
  }))
}

// ===== Branding =====

/**
 * The receipt logo, inlined as a data URI — the render window loads from a temp
 * directory and would not resolve a relative path.
 *
 * `receipt-logo.png` is the restaurant's own mark, already scaled to the print head's
 * resolution so it does not have to be resampled on every sale. The app icon is the
 * fallback for an installation that predates it. Each is looked for beside the source
 * in development and in the packaged resources otherwise.
 */
function logoDataUri(): string | null {
  const roots = [
    process.resourcesPath || '',
    app.getAppPath(),
    path.join(__dirname, '../..'),
  ]
  for (const name of ['receipt-logo.png', 'icon.png']) {
    for (const root of roots) {
      const file = root && path.join(root, 'build', name)
      try {
        if (file && fs.existsSync(file)) {
          return `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`
        }
      } catch { /* try the next location */ }
    }
  }
  return null
}

let cachedLogo: string | null | undefined

function branding(): TicketBranding {
  const s = getSettings()
  if (cachedLogo === undefined) cachedLogo = logoDataUri()
  return {
    businessName: s.business_name,
    businessAddress: s.business_address,
    businessPhone: s.business_phone,
    receiptFooter: s.receipt_footer || 'شكراً لزيارتكم',
    currency: s.currency_symbol,
    logoDataUri: s.print_logo ? cachedLogo : null,
  }
}

// ===== Reading an order back for printing =====

interface OrderRow {
  order_id: number
  invoice_number: string | null
  order_type: OrderType
  created_at: string
  cashier_name: string
  subtotal: number
  tax: number
  discount: number
  delivery_fee: number
  total_amount: number
  payment_type: PaymentType
  status: string
  customer_name: string | null
  customer_phone: string | null
  customer_address: string | null
  notes: string | null
  area_name: string | null
  driver_name: string | null
}

/**
 * `DD/MM/YYYY HH:MM`, built by hand rather than through Intl.
 *
 * toLocaleString('ar-EG') prints Arabic-Indic numerals (٢٠٢٦/٨/٢٩) beside prices in
 * Western ones, which on one ticket reads as a printing fault; forcing Latin digits
 * fixes that but leaves the right-to-left marks Intl embeds around each field, and
 * those reorder the date into nonsense inside the receipt's bidi isolation. A plain
 * 24-hour stamp has neither problem and is what a receipt wants anyway.
 */
function formatWhen(sqlDateTime: string): { full: string; date: string; time: string } {
  // SQLite stores 'YYYY-MM-DD HH:MM:SS' in local time.
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(sqlDateTime)
  if (!m) return { full: sqlDateTime, date: sqlDateTime, time: '' }
  const [, year, month, day, hour, minute] = m
  const date = `${day}/${month}/${year}`
  const time = `${hour}:${minute}`
  return { full: `${date} - ${time}`, date, time }
}

export function buildTicketOrder(orderId: number, tenderedAmount?: number): TicketOrder {
  const db = getDb()

  const row = db.prepare(`
    SELECT o.order_id, o.invoice_number, o.order_type, o.created_at,
           o.subtotal, o.tax, o.discount, o.delivery_fee, o.total_amount,
           o.payment_type, o.status,
           o.customer_name, o.customer_phone, o.customer_address, o.notes,
           u.full_name AS cashier_name,
           da.area_name, dd.full_name AS driver_name
    FROM orders o
    JOIN users u ON u.user_id = o.cashier_id
    LEFT JOIN delivery_areas da ON da.delivery_area_id = o.delivery_area_id
    LEFT JOIN delivery_drivers dd ON dd.driver_id = o.driver_id
    WHERE o.order_id = ?
  `).get(orderId) as OrderRow | undefined

  if (!row) throw new Error('الفاتورة غير موجودة')

  const items = db.prepare(`
    SELECT oi.quantity, oi.unit_price, oi.variant_label,
           mi.name AS item_name, mi.category_id, c.name AS category_name
    FROM order_items oi
    JOIN menu_items mi ON mi.item_id = oi.menu_item_id
    LEFT JOIN categories c ON c.category_id = mi.category_id
    WHERE oi.order_id = ?
    ORDER BY oi.order_item_id
  `).all(orderId) as {
    quantity: number; unit_price: number; variant_label: string | null
    item_name: string; category_id: number | null; category_name: string | null
  }[]

  // The discount is stored as an amount; the receipt shows the percentage it came
  // from, so recover it rather than printing a bare figure with no basis.
  const discountPercent = row.subtotal > 0
    ? Math.round((row.discount / row.subtotal) * 100)
    : 0

  const tendered = typeof tenderedAmount === 'number' && tenderedAmount > 0
    ? tenderedAmount
    : undefined

  const when = formatWhen(row.created_at)

  return {
    orderId: row.order_id,
    invoiceNumber: row.invoice_number || String(row.order_id),
    orderType: row.order_type,
    createdAt: when.full,
    orderDate: when.date,
    orderTime: when.time,
    cashierName: row.cashier_name,
    items: items.map<TicketItem>(i => ({
      name: i.item_name,
      variantLabel: i.variant_label,
      quantity: i.quantity,
      unitPrice: i.unit_price,
      categoryId: i.category_id,
      categoryName: i.category_name,
    })),
    subtotal: row.subtotal,
    tax: row.tax,
    discount: row.discount,
    discountPercent,
    deliveryFee: row.delivery_fee,
    totalAmount: row.total_amount,
    paymentType: row.payment_type,
    tenderedAmount: tendered,
    changeDue: tendered !== undefined ? Math.max(0, tendered - row.total_amount) : undefined,
    customerName: row.customer_name,
    customerPhone: row.customer_phone,
    customerAddress: row.customer_address,
    areaName: row.area_name,
    notes: row.notes,
    driverName: row.driver_name,
  }
}

// ===== Sending =====

/**
 * One job at a time, app-wide.
 *
 * Four printers on one order means four renders, and each render is an off-screen
 * Chromium window. Firing them together spikes memory on a till that is usually the
 * cheapest PC in the building, and two jobs reaching the same printer at once
 * interleave their bytes into garbage. Serialising costs a few hundred milliseconds
 * of an operation nobody is watching.
 */
let queue: Promise<unknown> = Promise.resolve()

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task)
  // Keep the chain alive after a failed job — an unhandled rejection here would
  // otherwise stop every later receipt.
  queue = run.catch(() => undefined)
  return run
}

function parseCategoryIds(raw: string | null): number[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.map(Number).filter(Number.isFinite) : []
  } catch {
    return []
  }
}

/**
 * Is this printer one THIS machine can actually drive?
 *
 * A network printer has its own address on the LAN, so any till can reach it. A USB
 * printer can only be driven by the machine it is plugged into: the master cannot
 * write to a queue that exists on the node, and vice versa.
 */
function isLocalPrinter(printer: Printer): boolean {
  if (printer.connection === 'network') return true       // its own IP — reachable from anywhere
  if (printer.station === 'any') return true              // not pinned to a machine
  return printer.station === (getSettings().net_mode === 'node' ? 'node' : 'master')
}

/** Push one already-built page at one printer, honouring its connection type. */
async function deliver(
  printer: Printer,
  html: string,
  // A report is as long as the day was busy; a ticket that long is a fault.
  opts: { report?: boolean } = {},
): Promise<void> {
  if (printer.connection === 'windows_driver') {
    if (!isLocalPrinter(printer)) {
      // The driver path renders a page through Windows' own printing stack, which
      // cannot be done on behalf of another machine. Raw mode can — its output is
      // just bytes — so that is the mode to use for a printer on the other till.
      throw new Error(
        `الطابعة "${printer.name}" موصولة بجهاز آخر — استخدم الوضع المباشر أو طابعة شبكة`,
      )
    }
    await printViaDriver(html, {
      deviceName: printer.device_name!,
      printableMm: printableMmForPaper(printer.paper_width),
      copies: printer.copies,
    })
    return
  }

  const bitmap = await renderToMono(html, dotsForPaper(printer.paper_width))
  const payload = buildTicket(bitmap, {
    cutPaper: !!printer.cut_paper,
    openDrawer: !!printer.open_drawer,
    beep: !!printer.beep,
    maxDots: opts.report ? MAX_REPORT_DOTS : undefined,
  })

  for (let copy = 0; copy < printer.copies; copy++) {
    if (printer.connection === 'network') {
      await sendToNetwork(printer.host!, printer.port, payload)
    } else if (isLocalPrinter(printer)) {
      await sendToWindowsPrinter(printer.device_name!, payload)
    } else {
      // Plugged into the other till. The ticket is already rendered here — where the
      // database, templates and fonts live — so the node only has to write the bytes
      // to its own port. That is why the whole ESC/POS payload goes across rather
      // than an instruction to print order N.
      await dispatchToStation(printer, payload)
    }
  }
}

/**
 * Hand a finished ticket to the till that owns the printer.
 *
 * Fails loudly, and now says WHY. The link is duplex, so the till actually answers:
 * "that machine is not connected" and "that machine is connected and its paper has
 * run out" used to be the same message, and they call for opposite actions from the
 * person reading it.
 */
async function dispatchToStation(printer: Printer, payload: Buffer): Promise<void> {
  const sent = await printOnNodes({
    printerId: printer.printer_id,
    printerName: printer.name,
    deviceName: printer.device_name!,
    payloadBase64: payload.toString('base64'),
  })
  if (!sent.ok) {
    throw new Error(`تعذرت الطباعة على "${printer.name}" — ${sent.error || 'الجهاز غير متصل'}`)
  }
}

/** Which printers get a ticket for this order, and what that ticket says. */
function pageFor(
  printer: Printer,
  order: TicketOrder,
  opts: { reprint?: boolean; feedLines: number; fontScale: number },
): { html: string } | null {
  const ticketOpts = {
    // The template scales off whatever width it is given, so the raster path can ask
    // for printer dots and the driver path for CSS pixels of the same paper.
    widthPx: printer.connection === 'windows_driver'
      ? mmToCssPx(printableMmForPaper(printer.paper_width))
      : dotsForPaper(printer.paper_width),
    feedLines: opts.feedLines,
    reprint: opts.reprint,
    fontScale: opts.fontScale,
  }

  switch (printer.role) {
    case 'receipt':
      return { html: receiptHtml(order, branding(), ticketOpts) }

    case 'delivery':
      // A rider's copy of an order nobody is delivering is just wasted paper.
      if (order.orderType !== 'delivery') return null
      // This is the copy that has to find the door, so it gets the full address
      // block the customer's own copy leaves off.
      return { html: receiptHtml(order, branding(), { ...ticketOpts, fullDelivery: true }) }

    // The three prep stations print the same priceless ticket — prices on a prep
    // ticket are only something to mis-read. They differ in which categories they
    // are responsible for and which printer they come out of, and the ticket is
    // headed with the printer's own name so each station knows the slip is theirs.
    case 'counter':
    case 'kitchen':
    case 'bar': {
      const only = parseCategoryIds(printer.category_ids)
      const items = only.length
        ? order.items.filter(i => i.categoryId != null && only.includes(i.categoryId))
        : order.items
      if (items.length === 0) return null

      // The counter bags the order and hands it over, so its ticket carries who it is
      // for and where it is going. The kitchen only cooks, and an address on a prep
      // ticket is a line of paper and a line of reading for nobody.
      const render = printer.role === 'counter' ? counterTicketHtml : kitchenTicketHtml
      return { html: render({ ...order, items }, printer.name, ticketOpts) }
    }

    default:
      return null
  }
}

/**
 * Print an order on every printer that wants it.
 *
 * Never throws for a printer that fails. A sale is already recorded and paid for by
 * the time this runs — a jammed kitchen printer must not look like a failed order,
 * and it must not stop the customer's receipt either. Every outcome comes back in
 * the result list so the screen can say exactly which printer needs attention.
 */
export async function printOrder(
  orderId: number,
  opts: { tenderedAmount?: number; reprint?: boolean; onlyPrinterId?: number } = {},
): Promise<PrintJobResult[]> {
  const order = buildTicketOrder(orderId, opts.tenderedAmount)
  const { print_feed_lines: feedLines, print_font_scale: fontScale } = getSettings()

  let printers = listPrinters().filter(p => p.is_active)
  if (opts.onlyPrinterId) {
    printers = printers.filter(p => p.printer_id === opts.onlyPrinterId)
  } else if (!opts.reprint) {
    // A printer with auto-print off is one the owner wants driven by hand.
    printers = printers.filter(p => p.auto_print)
  }

  if (printers.length === 0) return []

  const results: PrintJobResult[] = []

  for (const printer of printers) {
    const page = pageFor(printer, order, { reprint: opts.reprint, feedLines, fontScale })
    if (!page) {
      results.push({
        printerId: printer.printer_id, printerName: printer.name,
        role: printer.role, ok: true, skipped: true,
      })
      continue
    }

    try {
      await enqueue(() => deliver(printer, page.html))
      results.push({
        printerId: printer.printer_id, printerName: printer.name,
        role: printer.role, ok: true,
      })
      log.info(`[Print] Invoice ${order.invoiceNumber} → "${printer.name}" (${printer.role})`)
    } catch (err: any) {
      results.push({
        printerId: printer.printer_id, printerName: printer.name,
        role: printer.role, ok: false, error: err?.message || 'فشل غير معروف',
      })
      log.error(`[Print] Invoice ${order.invoiceNumber} → "${printer.name}" FAILED:`, err)
    }
  }

  return results
}

/** The stations that were told to cook — and so are the ones that must be told to stop. */
const PREP_ROLES: PrinterRole[] = ['kitchen', 'bar', 'counter']

/**
 * Tell the kitchen an invoice has been cancelled.
 *
 * A void used to be a database change and nothing else. The prep ticket printed at the
 * moment of sale was still clipped to the rail, so the food carried on being cooked,
 * bagged and thrown away — the stock came back in the books while the ingredients went
 * in the bin. This puts a struck-through copy of that same ticket on the same printer,
 * so the cook can find the original and pull it.
 *
 * It goes to the prep stations only. A cancellation slip on the customer's receipt
 * printer is paper for nobody: the customer has already left, and the counter's copy
 * is covered by the counter role being one of the prep roles.
 *
 * Category routing is honoured exactly as it is for the original ticket, so a station
 * that never saw the order is not handed its cancellation either. Never throws — a
 * void is already recorded by the time this runs.
 */
export async function printVoidedOrder(
  orderId: number,
  info: Omit<VoidTicketInfo, 'at'> & { at?: string },
): Promise<PrintJobResult[]> {
  const order = buildTicketOrder(orderId)
  const { print_feed_lines: feedLines, print_font_scale: fontScale } = getSettings()

  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const meta: VoidTicketInfo = {
    ...info,
    at: info.at ?? `${pad(now.getDate())}/${pad(now.getMonth() + 1)}/${now.getFullYear()} - ` +
                   `${pad(now.getHours())}:${pad(now.getMinutes())}`,
  }

  const stations = listPrinters().filter(p => p.is_active && PREP_ROLES.includes(p.role))
  if (stations.length === 0) return []

  const results: PrintJobResult[] = []

  for (const printer of stations) {
    const only = parseCategoryIds(printer.category_ids)
    const items = only.length
      ? order.items.filter(i => i.categoryId != null && only.includes(i.categoryId))
      : order.items
    if (items.length === 0) {
      results.push({
        printerId: printer.printer_id, printerName: printer.name,
        role: printer.role, ok: true, skipped: true,
      })
      continue
    }

    const html = voidTicketHtml({ ...order, items }, printer.name, meta, {
      widthPx: printer.connection === 'windows_driver'
        ? mmToCssPx(printableMmForPaper(printer.paper_width))
        : dotsForPaper(printer.paper_width),
      feedLines,
      fontScale,
    })

    try {
      await enqueue(() => deliver(printer, html))
      results.push({
        printerId: printer.printer_id, printerName: printer.name, role: printer.role, ok: true,
      })
      log.info(`[Print] Cancellation of ${order.invoiceNumber} → "${printer.name}" (${printer.role})`)
    } catch (err: any) {
      results.push({
        printerId: printer.printer_id, printerName: printer.name, role: printer.role,
        ok: false, error: err?.message || 'فشل غير معروف',
      })
      log.error(`[Print] Cancellation of ${order.invoiceNumber} → "${printer.name}" FAILED:`, err)
    }
  }

  return results
}

/**
 * Print a supplier delivery voucher — twice, one copy for each side.
 *
 * It goes to the CASHIER's printer: that is where the paper and the person are when a
 * delivery arrives, and it is the only printer guaranteed to be loaded. A kitchen
 * station has no business printing a purchase document.
 *
 * The two copies are separate jobs rather than `copies: 2` on one, because they are
 * not identical — each is headed with whose copy it is — and because two jobs means
 * two cuts, so they come off the roll as two documents rather than one long strip
 * somebody has to tear in half.
 */
export async function printSupplierInvoice(
  invoiceId: number,
  opts: { reprint?: boolean } = {},
): Promise<PrintJobResult[]> {
  const invoice = getSupplierInvoice(invoiceId)
  const account = getSupplierAccount(invoice.supplier_id)

  // The cashier's printer, or failing that whatever is active — a shop with one
  // printer that has not labelled it "receipt" should still get its voucher.
  const active = listPrinters().filter(p => p.is_active)
  const printer = active.find(p => p.role === 'receipt') ?? active[0]
  if (!printer) throw new Error('لا توجد طابعة مفعّلة لطباعة الإيصال')

  const settings = getSettings()
  const ticket: SupplierTicket = {
    invoiceNumber: invoice.supplier_invoice_id,
    supplierName: account.supplier.name,
    supplierPhone: account.supplier.phone,
    date: invoice.invoice_date,
    reference: invoice.reference,
    recordedBy: invoice.created_by_name ?? null,
    items: (invoice.items ?? []).map(i => ({
      name: i.material_name ?? '—',
      unit: i.material_unit ?? '',
      quantity: i.quantity,
      unitCost: i.unit_cost,
      lineTotal: i.line_total,
    })),
    invoiceTotal: invoice.total_amount,
    totalSupplied: account.supplied,
    totalPaid: account.paid,
    balanceOwed: account.owed,
    notes: invoice.notes,
  }

  const results: PrintJobResult[] = []
  for (const copy of ['supplier', 'restaurant'] as const) {
    const html = supplierInvoiceHtml(ticket, branding(), {
      widthPx: printer.connection === 'windows_driver'
        ? mmToCssPx(printableMmForPaper(printer.paper_width))
        : dotsForPaper(printer.paper_width),
      feedLines: settings.print_feed_lines,
      fontScale: settings.print_font_scale,
      reprint: opts.reprint,
      copy,
    })

    try {
      await enqueue(() => deliver(printer, html))
      results.push({
        printerId: printer.printer_id, printerName: printer.name, role: printer.role, ok: true,
      })
      log.info(`[Print] Supplier voucher #${invoiceId} (${copy}) → "${printer.name}"`)
    } catch (err: any) {
      results.push({
        printerId: printer.printer_id, printerName: printer.name, role: printer.role,
        ok: false, error: err?.message || 'فشل غير معروف',
      })
      log.error(`[Print] Supplier voucher #${invoiceId} (${copy}) FAILED:`, err)
    }
  }

  return results
}

/**
 * The sales-by-product report, on the counter printer and nowhere else.
 *
 * Explicitly NOT sent to the kitchen or bar stations, even when they are set to print
 * automatically. A prep station prints what it has to cook; a week's sales figures
 * landing in the middle of service is noise on the one printer nobody can afford to
 * have ignored. So this goes to the `receipt` printer, and if the shop has not
 * labelled one, to whatever single printer is active — a one-printer shop should still
 * get its report rather than an error about a role it never set.
 */
export async function printSalesProductsReport(
  report: SalesProductsReport,
  opts: { printerId?: number } = {},
): Promise<PrintJobResult> {
  const active = listPrinters().filter(p => p.is_active)
  const printer = opts.printerId
    ? active.find(p => p.printer_id === opts.printerId)
    : (active.find(p => p.role === 'receipt') ?? active.find(p => p.role === 'counter') ?? active[0])

  if (!printer) throw new Error('لا توجد طابعة مفعّلة لطباعة التقرير')
  if (printer.role === 'kitchen' || printer.role === 'bar') {
    throw new Error(
      `"${printer.name}" طابعة مطبخ — تقرير المبيعات يُطبع على طابعة الكاشير فقط`
    )
  }

  const settings = getSettings()
  const html = salesProductsHtml(report, branding(), {
    widthPx: printer.connection === 'windows_driver'
      ? mmToCssPx(printableMmForPaper(printer.paper_width))
      : dotsForPaper(printer.paper_width),
    feedLines: settings.print_feed_lines,
    fontScale: settings.print_font_scale,
  })

  try {
    await enqueue(() => deliver(printer, html, { report: true }))
    log.info(`[Print] Sales report ${report.period.start}→${report.period.end} → "${printer.name}"`)
    return { printerId: printer.printer_id, printerName: printer.name, role: printer.role, ok: true }
  } catch (err: any) {
    log.error('[Print] Sales report FAILED:', err)
    return {
      printerId: printer.printer_id, printerName: printer.name, role: printer.role,
      ok: false, error: err?.message || 'فشل غير معروف',
    }
  }
}

/**
 * «تقفيل الوردية» on the cashier's printer — the same printer, and the same path to
 * it, as the customer's receipt.
 *
 * One copy whatever the printer's own copy count says: that setting exists so the
 * customer and the counter each get a receipt, and two metres of close-out is one
 * metre nobody asked for.
 */
export async function printClosingReport(
  report: ClosingReport,
  opts: { printedBy?: string | null } = {},
): Promise<PrintJobResult> {
  const active = listPrinters().filter(p => p.is_active)
  const found = active.find(p => p.role === 'receipt')
    ?? active.find(p => p.role === 'counter')
    ?? active.find(p => p.role !== 'kitchen' && p.role !== 'bar')
  if (!found) throw new Error('لا توجد طابعة كاشير مفعّلة لطباعة التقفيل')
  const printer: Printer = { ...found, copies: 1 }

  const settings = getSettings()
  const html = closingHtml(report, branding(), {
    widthPx: printer.connection === 'windows_driver'
      ? mmToCssPx(printableMmForPaper(printer.paper_width))
      : dotsForPaper(printer.paper_width),
    feedLines: settings.print_feed_lines,
    fontScale: settings.print_font_scale,
    printedBy: opts.printedBy,
  })

  try {
    await enqueue(() => deliver(printer, html, { report: true }))
    log.info(`[Print] Closing ${report.shiftDate} shift ${report.shiftNumber} → "${printer.name}"`)
    return { printerId: printer.printer_id, printerName: printer.name, role: printer.role, ok: true }
  } catch (err: any) {
    log.error('[Print] Closing report FAILED:', err)
    return {
      printerId: printer.printer_id, printerName: printer.name, role: printer.role,
      ok: false, error: err?.message || 'فشل غير معروف',
    }
  }
}

/** The settings screen's "اختبار" button. Proves paper, Arabic, cut and drawer at once. */
export async function testPrint(printerId: number): Promise<void> {
  const printer = getPrinter(printerId)
  if (!printer) throw new Error('الطابعة غير موجودة')

  const settings = getSettings()
  const html = testPageHtml(printer.name, branding(), {
    widthPx: dotsForPaper(printer.paper_width),
    feedLines: settings.print_feed_lines,
    fontScale: settings.print_font_scale,
  })

  await enqueue(() => deliver(printer, html))
  log.info(`[Print] Test page sent to "${printer.name}"`)
}

/** Check a printer answers without using any paper. */
export async function testConnection(printerId: number): Promise<void> {
  const printer = getPrinter(printerId)
  if (!printer) throw new Error('الطابعة غير موجودة')

  if (printer.connection === 'network') {
    await probeNetwork(printer.host!, printer.port)
    return
  }

  const installed = await listSystemPrinters()
  const match = installed.find(p => p.name === printer.device_name)
  if (!match) {
    throw new Error(`الطابعة "${printer.device_name}" غير مثبتة في ويندوز`)
  }
}

/**
 * Kick the cash drawer without printing.
 *
 * Wired to a printer, not to the PC, so it goes out on whichever receipt printer has
 * the drawer attached. The `windows_driver` connection cannot do this at all — a
 * driver renders pages, it does not pass commands through — so a printer set up that
 * way is skipped with an explanation rather than failing silently.
 */
export async function openCashDrawer(printerId?: number): Promise<void> {
  const candidates = listPrinters().filter(p => p.is_active && p.open_drawer)
  const printer = printerId
    ? candidates.find(p => p.printer_id === printerId)
    : candidates[0]

  if (!printer) throw new Error('لا توجد طابعة مربوطة بدرج النقدية')
  if (printer.connection === 'windows_driver') {
    throw new Error('فتح الدرج غير متاح في وضع "عبر تعريف ويندوز" — استخدم الوضع المباشر')
  }

  const payload = Buffer.concat([init(), drawerKick()])
  await enqueue(async () => {
    if (printer.connection === 'network') {
      await sendToNetwork(printer.host!, printer.port, payload)
    } else {
      await sendToWindowsPrinter(printer.device_name!, payload)
    }
  })
  log.info(`[Print] Cash drawer kicked via "${printer.name}"`)
}

/**
 * Sound the buzzer without printing — the proof that this printer HAS one.
 *
 * The buzzer is a Xinye extension rather than core ESC/POS, so whether it works is a
 * property of the specific model on the counter and cannot be known from here. This
 * sends the command and nothing else: no paper moves, so if the model turns out to
 * print the bytes instead of obeying them, the evidence is a few characters on the
 * leader rather than a defaced receipt in a customer's hand.
 */
export async function testPrinterBeep(printerId: number): Promise<void> {
  const printer = getPrinter(printerId)
  if (!printer) throw new Error('الطابعة غير موجودة')
  if (printer.connection === 'windows_driver') {
    throw new Error('صوت التنبيه غير متاح في وضع "عبر تعريف ويندوز" — استخدم الوضع المباشر')
  }

  const payload = Buffer.concat([init(), beepCommand()])
  await enqueue(async () => {
    if (printer.connection === 'network') {
      await sendToNetwork(printer.host!, printer.port, payload)
    } else if (isLocalPrinter(printer)) {
      await sendToWindowsPrinter(printer.device_name!, payload)
    } else {
      // Plugged into the other till — same route the tickets themselves take.
      await dispatchToStation(printer, payload)
    }
  })
  log.info(`[Print] Test beep sent to "${printer.name}"`)
}
