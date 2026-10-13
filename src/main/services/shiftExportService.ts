/**
 * The end-of-shift export: the close-out sheet as a PDF and a workbook, written the
 * moment a shift closes, ready to go to the restaurant's group.
 *
 * Why it is automatic rather than a button
 * ----------------------------------------
 * The report only exists while somebody remembers to open the shift, press export and
 * pick a folder. A cashier finishing at 1am does not do that, so the day the owner
 * actually wants to look at is the day nobody exported. A shift closing is a fact the
 * app already knows — see shiftService — so the files are written from that fact.
 *
 * Why a marker column rather than a callback
 * ------------------------------------------
 * A shift closes down four different paths: the cashier signs out, the shift's
 * configured end time passes with the till running, the till is shut down with a
 * session open, or the machine was off overnight and the session is closed at the next
 * startup at its proper time. Hanging the export off one of those would silently miss
 * the other three, and the last two happen while the app is starting or stopping and
 * cannot run an async render at all.
 *
 * So closing a shift records nothing extra, and this sweeps: any shift that has ended
 * and has no `report_exported_at` gets its files written and the column stamped. That
 * is idempotent, survives a crash mid-render, and catches a shift the app was not even
 * running for.
 *
 * Sending it on
 * -------------
 * WhatsApp has no way for a desktop app to post a file into a group without a Business
 * API account and a registered number, so nothing here pretends to send by itself.
 * What it does is put both files in one dated folder, write the takings summary as
 * text, and hand the interface a one-press path: open WhatsApp on the group with the
 * summary already typed, with the folder open beside it to drag the two files in.
 */

import { shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import log from 'electron-log/main'
import { getDb, getDataDirectory } from '../db/db'
import { getSettings } from './settingsService'
import { getShiftReport, getWorkShiftReport } from './shiftReportService'
import { workShiftsAwaitingExport, markWorkShiftExported } from './workShiftService'
import { shiftEndAfter } from './shiftService'
import { writeShiftPdf } from './pdfReportService'
import { broadcast } from '../ipc/broadcast'
import { resolveShift, shiftLabel } from '../../shared/shifts'
import type { ShiftExport, ShiftReport } from '../../shared/types'

/** Windows will not have any of these in a file name, and neither will a folder name. */
function safeName(raw: string): string {
  return String(raw ?? '')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'وردية'
}

/**
 * Where the exports live. Beside the database by default, so they travel with the
 * data folder and a portable install keeps them on the same stick.
 */
export function shiftExportRoot(): string {
  const configured = (getSettings() as any).shift_export_folder as string | undefined
  const root = configured?.trim()
    ? configured.trim()
    : path.join(getDataDirectory(), 'تقارير الورديات')
  fs.mkdirSync(root, { recursive: true })
  return root
}

/** What this shift is called, under the shop's CURRENT setup — see shared/shifts.ts. */
function shiftName(report: ShiftReport): string {
  return report.shiftName || shiftLabel(report.shiftNumber, getSettings())
}

const money = (n: number) =>
  (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/**
 * The message that goes in the group.
 *
 * Deliberately the handful of numbers somebody reads on a phone at 1am — takings,
 * how many invoices, what should be in the drawer — not a transcription of the PDF.
 * The PDF is attached for anyone who wants the rest.
 */
export function shiftSummaryText(report: ShiftReport): string {
  const s = getSettings()
  const cur = s.currency_symbol || 'ج.م'
  const shift = resolveShift(report.shiftNumber, s)
  const lines = [
    `📋 *${s.business_name || 'المطعم'}* — تقرير وردية`,
    `${shift.icon} ${report.shiftName || shift.name} · ${report.shiftDate}`,
    `👤 الكاشير: ${report.cashierName}`,
    `🕐 ${report.startTime || '—'} → ${report.endTime || '—'} (${report.hoursWorked.toFixed(2)} ساعة)`,
    '',
    `💰 إجمالي المبيعات: *${money(report.revenue)} ${cur}*`,
    `🧾 عدد الفواتير: ${report.orderCount}  ·  متوسط الفاتورة: ${money(report.averageOrder)} ${cur}`,
    `💵 نقدي: ${money(report.cashSales)} ${cur}  ·  بطاقة: ${money(report.cardSales)} ${cur}`,
    `📤 المصروف من الوردية: ${money(report.expensesTotal)} ${cur}`,
    ...(report.salariesTotal > 0 ? [`👷 مرتبات: ${money(report.salariesTotal)} ${cur}`] : []),
    ...(report.supplierPaymentsTotal > 0 ? [`🚚 مدفوعات موردين: ${money(report.supplierPaymentsTotal)} ${cur}`] : []),
    `📈 صافي ربح الوردية: ${money(report.netProfit)} ${cur}`,
    `🏦 *المتوقع في الدرج: ${money(report.expectedCash)} ${cur}*`,
  ]
  if (report.voidedCount > 0) {
    lines.push(`⚠️ فواتير ملغاة: ${report.voidedCount} بقيمة ${money(report.voidedValue)} ${cur}`)
  }
  lines.push('', '📎 التقرير الكامل مرفق (PDF + Excel).')
  return lines.join('\n')
}

/**
 * The workbook. Same figures as the PDF, from the same ShiftReport object, so the two
 * can never disagree — and as real numbers rather than text, so the accountant can
 * sum and pivot them.
 */
export async function writeShiftWorkbook(report: ShiftReport, filePath: string): Promise<string> {
  const ExcelJS = require('exceljs')
  const wb = new ExcelJS.Workbook()
  wb.creator = getSettings().business_name || 'Resto POS'
  wb.created = new Date()

  const MONEY = '#,##0.00'
  const cur = getSettings().currency_symbol || 'ج.م'

  const style = (sheet: any) => {
    const header = sheet.getRow(1)
    header.font = { bold: true, size: 12, color: { argb: 'FFFFFFFF' } }
    header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFC41E2E' } }
    header.alignment = { horizontal: 'center' }
    sheet.views = [{ state: 'frozen', ySplit: 1, rightToLeft: true }]
  }

  // ===== Close-out =====
  const s = wb.addWorksheet('ملخص الوردية')
  s.columns = [
    { header: 'البند', key: 'label', width: 34 },
    { header: 'القيمة', key: 'value', width: 20 },
  ]
  const summaryRows: { label: string; value: unknown }[] = [
    { label: 'التاريخ', value: report.shiftDate },
    { label: 'الوردية', value: shiftName(report) },
    { label: 'الكاشير', value: `${report.cashierName} (${report.username})` },
    { label: 'من', value: report.startTime || '—' },
    { label: 'إلى', value: report.isOpen ? 'ما زالت مفتوحة' : (report.endTime || '—') },
    { label: 'ساعات العمل', value: report.hoursWorked },
    { label: `إجمالي المبيعات (${cur})`, value: report.revenue },
    { label: 'عدد الفواتير', value: report.orderCount },
    { label: `متوسط الفاتورة (${cur})`, value: report.averageOrder },
    { label: `مبيعات نقدية (${cur})`, value: report.cashSales },
    { label: `مبيعات بالبطاقة (${cur})`, value: report.cardSales },
    { label: `رسوم التوصيل (${cur})`, value: report.deliveryFees },
    { label: `الخصومات الممنوحة (${cur})`, value: report.discount },
    // ---- The profit, top to bottom ----
    { label: `ضريبة القيمة المضافة — تُورَّد للضرائب (${cur})`, value: report.tax },
    { label: `صافي المبيعات (${cur})`, value: report.netSales },
    { label: `تكلفة البضاعة المباعة (${cur})`, value: report.cogs },
    { label: `مجمل الربح (${cur})`, value: report.grossProfit },
    { label: `المصروفات التشغيلية (${cur})`, value: report.operatingExpenses },
    { label: `المرتبات (${cur})`, value: report.salariesTotal },
    { label: `الهالك (${cur})`, value: report.wasteValue },
    { label: `صافي ربح الوردية (${cur})`, value: report.netProfit },
    // ---- The drawer ----
    { label: `كل المصروفات أثناء الوردية (${cur})`, value: report.expensesTotal },
    { label: `منها مشتريات خامات — لا تُخصم من الربح (${cur})`, value: report.ingredientPurchases },
    { label: `مدفوعات موردين أثناء الوردية (${cur})`, value: report.supplierPaymentsTotal },
    { label: `نقدية خرجت مع السائقين (${cur})`, value: report.driverCashOut },
    { label: `توريد السائقين أثناء الوردية (${cur})`, value: report.settlementsReceived },
    { label: `المتوقع في الدرج (${cur})`, value: report.expectedCash },
    { label: 'فواتير ملغاة', value: report.voidedCount },
    { label: `قيمة الملغاة (${cur})`, value: report.voidedValue },
  ]
  s.addRows(summaryRows)
  s.getColumn('value').numFmt = MONEY
  // The two lines people look for — what was earned, and what should be in the
  // drawer. Found by label, so adding a row above cannot move the bold.
  for (const key of ['صافي ربح الوردية', 'المتوقع في الدرج']) {
    const at = summaryRows.findIndex(r => r.label.startsWith(key))
    if (at >= 0) s.getRow(at + 2).font = { bold: true, size: 13 }
  }
  style(s)

  // ===== Every invoice =====
  const inv = wb.addWorksheet('الفواتير')
  inv.columns = [
    { header: 'الوقت', key: 'time', width: 10 },
    { header: 'رقم الفاتورة', key: 'invoiceNumber', width: 16 },
    { header: 'النوع', key: 'orderTypeLabel', width: 12 },
    { header: 'الدفع', key: 'payment', width: 10 },
    { header: 'العميل', key: 'customerName', width: 22 },
    { header: 'عدد الأصناف', key: 'itemCount', width: 12 },
    { header: 'الخصم', key: 'discount', width: 12, style: { numFmt: MONEY } },
    { header: 'التوصيل', key: 'deliveryFee', width: 12, style: { numFmt: MONEY } },
    { header: 'الإجمالي', key: 'total', width: 14, style: { numFmt: MONEY } },
    { header: 'الحالة', key: 'status', width: 12 },
  ]
  inv.addRows(report.invoices.map(i => ({
    time: i.time,
    invoiceNumber: i.invoiceNumber || `#${i.orderId}`,
    orderTypeLabel: i.orderTypeLabel,
    payment: i.paymentType === 'cash' ? 'نقدي' : 'بطاقة',
    customerName: i.customerName || '—',
    itemCount: i.itemCount,
    discount: i.discount,
    deliveryFee: i.deliveryFee,
    total: i.total,
    status: i.status === 'voided' ? 'ملغاة' : 'مكتملة',
  })))
  inv.addRow({ customerName: 'الإجمالي', total: report.revenue })
  inv.getRow(inv.rowCount).font = { bold: true }
  style(inv)

  // ===== What was sold =====
  const items = wb.addWorksheet('الأصناف المباعة')
  items.columns = [
    { header: 'الصنف', key: 'name', width: 38 },
    { header: 'الكمية', key: 'units', width: 12 },
    { header: 'الإيراد', key: 'revenue', width: 16, style: { numFmt: MONEY } },
  ]
  items.addRows(report.items)
  style(items)

  // ===== Money out of the drawer =====
  const exp = wb.addWorksheet('المصروفات')
  exp.columns = [
    { header: 'الوقت', key: 'time', width: 10 },
    { header: 'النوع', key: 'category', width: 22 },
    { header: 'البيان', key: 'description', width: 40 },
    { header: 'المبلغ', key: 'amount', width: 14, style: { numFmt: MONEY } },
  ]
  exp.addRows(report.expenses)
  exp.addRow({ description: 'الإجمالي', amount: report.expensesTotal })
  exp.getRow(exp.rowCount).font = { bold: true }
  style(exp)

  // ===== Wages and suppliers paid from the till =====
  const pay = wb.addWorksheet('مرتبات وموردين')
  pay.columns = [
    { header: 'الوقت', key: 'time', width: 10 },
    { header: 'النوع', key: 'kind', width: 16 },
    { header: 'الاسم', key: 'name', width: 34 },
    { header: 'المبلغ', key: 'amount', width: 14, style: { numFmt: MONEY } },
  ]
  pay.addRows(report.salaries.map(x => ({ time: x.time, kind: 'مرتب', name: x.workerName, amount: x.amount })))
  pay.addRows(report.supplierPayments.map(x => ({
    time: x.time, kind: x.method === 'cash' ? 'مورد (نقدي)' : 'مورد (غير نقدي)', name: x.supplierName, amount: x.amount,
  })))
  pay.addRow({ name: 'الإجمالي', amount: report.salariesTotal + report.supplierPaymentsTotal })
  pay.getRow(pay.rowCount).font = { bold: true }
  style(pay)

  // ===== Stock that moved =====
  const stock = wb.addWorksheet('حركة المخزون')
  stock.columns = [
    { header: 'المادة', key: 'name', width: 30 },
    { header: 'الوحدة', key: 'unit', width: 12 },
    { header: 'نوع الحركة', key: 'reason', width: 20 },
    { header: 'التغيير', key: 'change', width: 14 },
  ]
  stock.addRows(report.stockMoves)
  style(stock)

  await wb.xlsx.writeFile(filePath)
  return filePath
}

/**
 * Write both files for one shift and return where they went.
 *
 * Does NOT stamp the shift as exported — the sweeper does that, so a manual re-export
 * from the report screen can be run as often as the owner likes without the automatic
 * one deciding the shift has been dealt with.
 */
export async function exportShiftFiles(shiftId: number, work = false): Promise<ShiftExport> {
  // work is the shop's shift — everybody's sales — rather than one cashier's session.
  const report = work ? getWorkShiftReport(shiftId) : getShiftReport(shiftId)

  const folder = path.join(shiftExportRoot(), report.shiftDate)
  fs.mkdirSync(folder, { recursive: true })

  const stem = safeName(
    work
      ? `وردية-${report.shiftDate}-${shiftName(report)}-${report.shiftId}`
      : `وردية-${report.shiftDate}-${shiftName(report)}-${report.cashierName}-${report.shiftId}`
  )
  const pdfPath = path.join(folder, `${stem}.pdf`)
  const excelPath = path.join(folder, `${stem}.xlsx`)

  // Workbook first. It is a file write and nothing else; the PDF opens an off-screen
  // Chromium window to render, which is the half that can fail on a tired till. This
  // way a failed PDF still leaves the figures on disk rather than nothing at all.
  await writeShiftWorkbook(report, excelPath)
  await writeShiftPdf(report, pdfPath)

  log.info(`[ShiftExport] Shift #${shiftId} exported to ${folder}`)

  return {
    shiftId: report.shiftId,
    shiftDate: report.shiftDate,
    shiftNumber: report.shiftNumber,
    shiftName: shiftName(report),
    cashierName: report.cashierName,
    folder,
    pdfPath,
    excelPath,
    summaryText: shiftSummaryText(report),
    revenue: report.revenue,
    orderCount: report.orderCount,
    expectedCash: report.expectedCash,
  }
}

/**
 * Export every session whose SHIFT has finished and that has not been exported yet.
 *
 * Two conditions, both learned the hard way:
 *
 *   the shift window is over   not merely "the session closed". Signing out happens
 *                              many times a day and is not the end of a shift.
 *   it sold something          a report of zeroes helps nobody and pushing one at the
 *                              group trains people to ignore the ones that matter.
 *
 * Runs at startup and on a minute tick, so the files appear within a minute of the
 * shift actually ending — however the session that made them up was closed. One at a
 * time: each export opens an off-screen Chromium window to render the PDF, and a till
 * is usually the cheapest PC in the building.
 */
export async function sweepShiftExports(now = new Date()): Promise<ShiftExport[]> {
  if (!exportsEnabled()) return []

  const db = getDb()
  const pending = db.prepare(`
    SELECT s.shift_id, s.started_at, s.ended_at,
           (SELECT COUNT(*) FROM orders o
             WHERE o.cashier_id = s.cashier_id
               AND o.created_at BETWEEN s.started_at AND s.ended_at
               AND o.deleted_at IS NULL) AS order_count
    FROM shifts s
    WHERE s.ended_at IS NOT NULL AND s.report_exported_at IS NULL
    ORDER BY s.ended_at
    LIMIT 20
  `).all() as { shift_id: number; started_at: string; ended_at: string; order_count: number }[]

  if (pending.length === 0) return []

  const stamp = db.prepare(
    `UPDATE shifts SET report_exported_at = datetime('now','localtime') WHERE shift_id = ?`
  )
  const done: ShiftExport[] = []

  for (const row of pending) {
    // ---- Is this session's SHIFT actually over? ----
    //
    // Signing out is not the end of a shift. A cashier signs out to swap with a
    // colleague, to let the owner check something, or because they lock the till on
    // the way to the kitchen — and every one of those closes a session. Exporting on
    // each of them produced seven reports in ten minutes and, worse, seven pushes at
    // the restaurant's group, which is how a useful report becomes noise nobody opens.
    //
    // So the report waits for the SHIFT WINDOW the owner configured to end. Sessions
    // that closed earlier stay unstamped and are picked up on a later tick, so nothing
    // is lost — it simply arrives when the shift really is over.
    const started = new Date(String(row.started_at).replace(' ', 'T'))
    if (!Number.isNaN(started.getTime())) {
      const due = shiftEndAfter(started)
      if (due.getTime() > now.getTime()) continue // still inside its shift
    }

    // A session that rang up nothing has no report worth writing: a sheet of zeroes,
    // and a message to the group saying the shop took nothing. The session is still
    // in الورديات, and the owner can export it by hand from there if they want it.
    if (row.order_count === 0) {
      stamp.run(row.shift_id)
      log.info(`[ShiftExport] Shift #${row.shift_id} had no sales — no report written`)
      continue
    }

    try {
      const result = await exportShiftFiles(row.shift_id)
      stamp.run(row.shift_id)
      done.push(result)
      // The screens turn this into "the report is ready" with the two buttons that
      // matter: open the folder, and send it to the group.
      broadcast('app:shiftExported', result)
    } catch (err: any) {
      // Marked as dealt with even on failure, and said loudly in the log. Left
      // unmarked, a shift whose report cannot be built — a corrupt row, a locked
      // folder — would be retried every minute forever, spawning a render window
      // each time until the till fell over.
      stamp.run(row.shift_id)
      log.error(`[ShiftExport] Shift #${row.shift_id} could not be exported: ${err?.message || err}`)
      broadcast('app:shiftExported', {
        shiftId: row.shift_id, error: err?.message || 'سبب غير معروف',
      })
    }
  }

  return done
}

/**
 * The same sweep for the SHOP's shifts — which is what the schedule now runs.
 *
 * One report per shift, covering everyone who sold in it and everything paid out of
 * it, written the moment the shift's end time passes. The per-cashier sweep above is
 * kept for exporting one person's session by hand; run on the schedule as well it
 * would send the group two overlapping reports for the same evening.
 */
export async function sweepWorkShiftExports(): Promise<ShiftExport[]> {
  if (!exportsEnabled()) return []
  const done: ShiftExport[] = []

  for (const id of workShiftsAwaitingExport()) {
    // Stamped first, for the reason the session sweep stamps on failure: a shift whose
    // report cannot be built must not be retried every minute for ever.
    markWorkShiftExported(id)
    try {
      if (getWorkShiftReport(id).invoices.length === 0) {
        log.info(`[ShiftExport] Work shift #${id} had no sales — no report written`)
        continue
      }
      const result = { ...(await exportShiftFiles(id, true)), work: true }
      done.push(result)
      broadcast('app:shiftExported', result)
    } catch (err: any) {
      log.error(`[ShiftExport] Work shift #${id} could not be exported: ${err?.message || err}`)
      broadcast('app:shiftExported', { shiftId: id, work: true, error: err?.message || 'سبب غير معروف' })
    }
  }
  return done
}

/** Master and standalone only, and only while the owner leaves it switched on. */
function exportsEnabled(): boolean {
  const s = getSettings() as any
  if (s.net_mode === 'node') return false // the master owns the shifts and the books
  return Number(s.shift_export_auto ?? 1) !== 0
}

let timer: NodeJS.Timeout | null = null
let running = false

/** One sweep at a time — an export takes seconds and the tick is every minute. */
export function tickShiftExports(): void {
  if (running) return
  running = true
  void sweepWorkShiftExports()
    .catch(err => log.error('[ShiftExport] Sweep failed:', err))
    .finally(() => { running = false })
}

export function startShiftExportSchedule(): void {
  stopShiftExportSchedule()
  // A minute after startup, so a shift closed while the till was off is exported
  // without competing with everything else the app does on launch.
  setTimeout(tickShiftExports, 60_000)
  timer = setInterval(tickShiftExports, 60_000)
  log.info('[ShiftExport] End-of-shift export scheduled')
}

export function stopShiftExportSchedule(): void {
  if (timer) { clearInterval(timer); timer = null }
}

// ===== Getting it to the group =====

/**
 * Open WhatsApp on the restaurant's group with the summary already typed.
 *
 * `whatsapp_group` holds whatever the owner pasted in: an invite link
 * (chat.whatsapp.com/…), a phone number, or nothing. A link opens the group itself —
 * WhatsApp cannot pre-fill a message on an invite link, so the summary goes to the
 * clipboard instead and the interface says so. A number gets the full wa.me link with
 * the text on it. With neither, WhatsApp opens on the share sheet and the owner picks
 * the group.
 */
export function whatsappTarget(text: string): { url: string; prefilled: boolean } {
  const raw = String((getSettings() as any).whatsapp_group ?? '').trim()

  if (/chat\.whatsapp\.com/i.test(raw)) {
    return { url: raw.startsWith('http') ? raw : `https://${raw}`, prefilled: false }
  }

  const digits = raw.replace(/[^\d]/g, '')
  if (digits.length >= 8) {
    return { url: `https://wa.me/${digits}?text=${encodeURIComponent(text)}`, prefilled: true }
  }

  return { url: `https://wa.me/?text=${encodeURIComponent(text)}`, prefilled: true }
}

/**
 * Put the two files in front of the person about to send them, and open the chat.
 *
 * Explorer is opened ON the PDF rather than on the folder, so both files are visible
 * and selected and can be dragged straight into the WhatsApp window that opens next.
 */
export async function shareShiftExport(exported: ShiftExport): Promise<{ prefilled: boolean }> {
  const target = whatsappTarget(exported.summaryText)
  try {
    shell.showItemInFolder(exported.pdfPath)
  } catch (err) {
    log.warn('[ShiftExport] Could not reveal the export folder:', err)
  }
  await shell.openExternal(target.url)
  return { prefilled: target.prefilled }
}
