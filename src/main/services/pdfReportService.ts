import { BrowserWindow, dialog } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import log from 'electron-log/main'
import { getSettings } from './settingsService'
import { shiftLabel } from '../../shared/shifts'
import type { FinanceReport, ShiftReport } from '../../shared/types'

/**
 * Renders the finance report to PDF.
 *
 * Electron can already print a page to PDF, so each report is built as a self-contained
 * HTML document and printed from a hidden window. That avoids pulling in a PDF library —
 * and, more usefully, the same markup is what a printer would produce, so "export" and
 * "print" can never drift apart.
 */
export async function exportFinancePdf(report: FinanceReport): Promise<string | null> {
  const settings = getSettings()

  const { filePath } = await dialog.showSaveDialog({
    title: 'حفظ التقرير المالي',
    defaultPath: `تقرير-مالي-${report.period.start}-الى-${report.period.end}.pdf`,
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  })
  if (!filePath) return null

  return renderPdf(buildReportHtml(report, settings), filePath)
}

/**
 * The close-out sheet for one shift, as a PDF. Same printing path as the finance
 * report — the document is written to a temp file and printed from a hidden window.
 */
export async function exportShiftPdf(report: ShiftReport): Promise<string | null> {
  const settings = getSettings()

  const { filePath } = await dialog.showSaveDialog({
    title: 'حفظ تقرير الوردية',
    defaultPath: `تقرير-وردية-${report.shiftDate}-${report.username}.pdf`,
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  })
  if (!filePath) return null

  return renderPdf(buildShiftHtml(report, settings), filePath)
}

/**
 * The same two documents, written straight to a path with nobody asked.
 *
 * The dialog versions above are for an owner who pressed "export" and wants to choose
 * where it lands. These are for the automatic end-of-shift export, which runs when
 * there may be nobody at the till at all — a save dialog there would sit open until
 * somebody happened to walk past, and the day's report would never be written.
 */
export function writeShiftPdf(report: ShiftReport, filePath: string): Promise<string> {
  return renderPdf(buildShiftHtml(report, getSettings()), filePath)
}

export function writeFinancePdf(report: FinanceReport, filePath: string): Promise<string> {
  return renderPdf(buildReportHtml(report, getSettings()), filePath)
}

/** Lays out an HTML document in a hidden window and writes the printed PDF. */
async function renderPdf(html: string, filePath: string): Promise<string> {
  const tempHtml = path.join(os.tmpdir(), `crispo-report-${Date.now()}.html`)
  fs.writeFileSync(tempHtml, html, 'utf-8')

  const win = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, javascript: false },
  })

  try {
    await win.loadFile(tempHtml)
    await new Promise(resolve => setTimeout(resolve, 300))
    const pdf = await win.webContents.printToPDF({
      pageSize: 'A4',
      printBackground: true,
      margins: { top: 0.4, bottom: 0.4, left: 0.4, right: 0.4 },
    })
    fs.writeFileSync(filePath, pdf)
    log.info(`[Report] PDF exported to: ${filePath} (${pdf.length} bytes)`)
    return filePath
  } finally {
    if (!win.isDestroyed()) win.destroy()
    try { fs.unlinkSync(tempHtml) } catch { /* already gone */ }
  }
}

const money = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** Escapes text coming from the database before it is put into the document. */
function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

function buildShiftHtml(r: ShiftReport, settings: any): string {
  const currency = settings.currency_symbol || 'ج.م'
  const business = esc(settings.business_name || 'أبو الدهب')
  const printedAt = new Date().toLocaleString('ar-EG')
  // Follows the shop's CURRENT setup, not the number stamped on the row: a shop that
  // has switched to one shift a day has no «مسائية» to head a report with.
  const shiftName = r.shiftName || shiftLabel(r.shiftNumber, settings)

  // A total row is set off by a tint and a size up, not by a heavier weight: past 700
  // the printer falls back to a different, narrower face and the "bold" line comes
  // out looking smaller than the lines it is the total of.
  const line = (label: string, value: string, opts: { bold?: boolean; color?: string } = {}) => `
    <tr${opts.bold ? ' style="background:#F6F1EA"' : ''}>
      <td style="padding:7px 10px;${opts.bold ? 'font-weight:700;font-size:13px;' : ''}">${label}</td>
      <td style="padding:7px 10px;text-align:left;font-weight:700;${opts.bold ? 'font-size:13.5px;' : ''}${opts.color ? `color:${opts.color};` : ''}">${value}</td>
    </tr>`

  return `<!doctype html>
<html lang="ar" dir="rtl"><head><meta charset="utf-8">
<style>
  * { box-sizing: border-box; }
  body { font-family:'Segoe UI','Cairo','Tajawal',Arial,sans-serif; color:#1C1614;
         margin:0; padding:22px; font-size:12px; background:#fff; }
  h1 { font-size:20px; margin:0 0 2px; color:#C41E2E; }
  h2 { font-size:14px; margin:20px 0 8px; padding-bottom:5px;
       border-bottom:2px solid #C41E2E; }
  .sub { color:#5C534E; font-size:11px; }
  .head { display:flex; justify-content:space-between; align-items:flex-start;
          border-bottom:3px solid #C41E2E; padding-bottom:12px; }
  table { width:100%; border-collapse:collapse; }
  th { background:#F4F1EB; text-align:right; padding:8px 10px; font-size:11px;
       border-bottom:1.5px solid #D3C9BC; }
  td { border-bottom:1px solid #EFE9E0; }
  .kpis { display:flex; gap:10px; margin:14px 0 4px; }
  .kpi { flex:1; border:1px solid #E4DDD3; border-top:3px solid #C41E2E;
         border-radius:8px; padding:11px 13px; }
  .kpi .l { font-size:10px; color:#5C534E; margin-bottom:5px; }
  .kpi .v { font-size:17px; font-weight:900; }
  .muted { color:#8A7F79; font-size:10px; }
  .drawer { border:2px solid #15803D; border-radius:8px; padding:12px 14px;
            background:#F2FAF4; margin-top:10px; }
  .open { background:#FDF6EB; border-right:3px solid #DE8709; padding:9px 12px;
          border-radius:5px; margin-top:10px; font-size:11px; }
  tfoot td { border-top:2px solid #1C1614; font-weight:900; }
  .section { page-break-inside:avoid; }
  .sign { margin-top:34px; display:flex; gap:40px; }
  .sign div { flex:1; border-top:1px solid #8A7F79; padding-top:6px; font-size:11px; text-align:center; }
</style></head><body>

<div class="head">
  <div>
    <h1>${business}</h1>
    <div class="sub">تقرير وردية — ${esc(shiftName)} · ${esc(r.shiftDate)}</div>
  </div>
  <div class="sub" style="text-align:left">طُبع في<br>${esc(printedAt)}</div>
</div>

<table style="margin-top:12px">
  ${line('الكاشير', esc(r.cashierName) + ' (' + esc(r.username) + ')')}
  ${line(r.workShiftId ? 'بداية الوردية' : 'وقت الدخول', esc(r.startTime || '—'))}
  ${line(r.workShiftId ? 'نهاية الوردية' : 'وقت الخروج', r.isOpen ? 'الوردية ما زالت مفتوحة' : esc(r.endTime || '—'))}
  ${line('ساعات العمل', r.hoursWorked.toFixed(2) + ' ساعة')}
</table>

${r.isOpen ? `<div class="open">⚠️ هذه الوردية لم تُغلق بعد — الأرقام محسوبة حتى وقت الطباعة وقد تتغير.</div>` : ''}

<div class="kpis">
  <div class="kpi"><div class="l">إجمالي المبيعات</div><div class="v" style="color:#C41E2E">${money(r.revenue)}</div></div>
  <div class="kpi" style="border-top-color:#15803D"><div class="l">عدد الفواتير</div><div class="v" style="color:#15803D">${r.orderCount}</div></div>
  <div class="kpi" style="border-top-color:#DE8709"><div class="l">متوسط الفاتورة</div><div class="v" style="color:#B06A07">${money(r.averageOrder)}</div></div>
  <div class="kpi" style="border-top-color:#1D4ED8"><div class="l">صافي ربح الوردية</div><div class="v" style="color:#1D4ED8">${money(r.netProfit)}</div></div>
</div>

<div class="section">
<h2>الدرج — النقدية</h2>
<table>
  ${line(`مبيعات نقدية (${r.cashOrders} فاتورة)`, money(r.cashSales) + ' ' + currency)}
  ${line(`مبيعات بالبطاقة (${r.cardOrders} فاتورة) — لا تدخل الدرج`, money(r.cardSales) + ' ' + currency)}
  ${r.driverCashOut > 0 ? line('نقدية خرجت مع سائقي الدليفري', '− ' + money(r.driverCashOut) + ' ' + currency, { color: '#D92D20' }) : ''}
  ${r.settlementsReceived > 0 ? line('توريد السائقين أثناء الوردية', '+ ' + money(r.settlementsReceived) + ' ' + currency, { color: '#15803D' }) : ''}
  ${line('المصروفات أثناء الوردية', '− ' + money(r.expensesTotal) + ' ' + currency, { color: '#D92D20' })}
  ${r.salariesTotal > 0 ? line('مرتبات صُرفت أثناء الوردية', '− ' + money(r.salariesTotal) + ' ' + currency, { color: '#D92D20' }) : ''}
  ${r.supplierCashTotal > 0 ? line('مدفوعات موردين نقداً', '− ' + money(r.supplierCashTotal) + ' ' + currency, { color: '#D92D20' }) : ''}
</table>

<div class="drawer">
  <div style="display:flex;justify-content:space-between;align-items:center">
    <b style="font-size:13px">النقدية المتوقعة في الدرج</b>
    <b style="font-size:18px;color:#15803D">${money(r.expectedCash)} ${currency}</b>
  </div>
  <div class="muted" style="margin-top:5px">
    تُقارن بالجرد الفعلي عند التسليم.
    ${r.driverCashPending > 0 ? `نقدية مع السائقين لم تُورَّد بعد: <b>${money(r.driverCashPending)} ${currency}</b>.` : ''}
  </div>
</div>
</div>

<div class="section">
<h2>ربح الوردية</h2>
<table>
  ${line('المبيعات (ما دفعه العملاء)', money(r.revenue) + ' ' + currency)}
  ${line('ضريبة القيمة المضافة — تُورَّد للضرائب', '− ' + money(r.tax) + ' ' + currency, { color: '#D92D20' })}
  ${line('صافي المبيعات', money(r.netSales) + ' ' + currency, { bold: true })}
  ${line('تكلفة البضاعة المباعة', '− ' + money(r.cogs) + ' ' + currency, { color: '#D92D20' })}
  ${line('مجمل الربح', money(r.grossProfit) + ' ' + currency, { bold: true })}
  ${line('المصروفات التشغيلية', '− ' + money(r.operatingExpenses) + ' ' + currency, { color: '#D92D20' })}
  ${r.salariesTotal > 0 ? line('المرتبات', '− ' + money(r.salariesTotal) + ' ' + currency, { color: '#D92D20' }) : ''}
  ${r.wasteValue > 0 ? line('الهالك', '− ' + money(r.wasteValue) + ' ' + currency, { color: '#D92D20' }) : ''}
  ${line('صافي ربح الوردية', money(r.netProfit) + ' ' + currency, { bold: true, color: r.netProfit >= 0 ? '#15803D' : '#D92D20' })}
</table>
${r.ingredientPurchases > 0 ? `<div class="muted" style="margin-top:6px">مشتريات خامات بقيمة ${money(r.ingredientPurchases)} ${currency} خرجت من الدرج ولم تُخصم من الربح مرة ثانية — تكلفتها محسوبة ضمن «تكلفة البضاعة المباعة».</div>` : ''}
${r.voidedCount > 0 ? `<div class="open">فواتير ملغاة خلال الوردية: <b>${r.voidedCount}</b> بقيمة <b>${money(r.voidedValue)} ${currency}</b> (خارج التحصيل).</div>` : ''}
</div>

<div class="section">
<h2>الإيراد حسب نوع الطلب</h2>
<table>
  <thead><tr><th>النوع</th><th>عدد الفواتير</th><th style="text-align:left">الإيراد</th></tr></thead>
  <tbody>${r.byOrderType.map(t => `<tr>
    <td style="padding:6px 10px">${esc(t.label)}</td>
    <td style="padding:6px 10px">${t.orders}</td>
    <td style="padding:6px 10px;text-align:left;font-weight:700">${money(t.total)}</td></tr>`).join('')
    || '<tr><td colspan="3" style="padding:12px;text-align:center" class="muted">لا توجد مبيعات</td></tr>'}</tbody>
</table>
</div>

<div class="section">
<h2>الأصناف المباعة</h2>
<table>
  <thead><tr><th>الصنف</th><th>الكمية</th><th style="text-align:left">الإيراد</th></tr></thead>
  <tbody>${r.items.map(i => `<tr>
    <td style="padding:6px 10px">${esc(i.name)}</td>
    <td style="padding:6px 10px">${i.units}</td>
    <td style="padding:6px 10px;text-align:left;font-weight:700">${money(i.revenue)}</td></tr>`).join('')
    || '<tr><td colspan="3" style="padding:12px;text-align:center" class="muted">لا توجد أصناف</td></tr>'}</tbody>
</table>
</div>

${r.expenses.length ? `<div class="section">
<h2>المصروفات المسجلة خلال الوردية</h2>
<table>
  <thead><tr><th>الوقت</th><th>النوع</th><th>البيان</th><th style="text-align:left">المبلغ</th></tr></thead>
  <tbody>${r.expenses.map(e => `<tr>
    <td style="padding:6px 10px">${esc(e.time)}</td>
    <td style="padding:6px 10px">${esc(e.category)}</td>
    <td style="padding:6px 10px">${esc(e.description)}</td>
    <td style="padding:6px 10px;text-align:left;font-weight:700">${money(e.amount)}</td></tr>`).join('')}</tbody>
  <tfoot><tr><td colspan="3" style="padding:8px 10px">الإجمالي</td>
    <td style="padding:8px 10px;text-align:left">${money(r.expensesTotal)} ${currency}</td></tr></tfoot>
</table>
</div>` : ''}

${r.salaries.length ? `<div class="section">
<h2>المرتبات المصروفة خلال الوردية</h2>
<table>
  <thead><tr><th>الوقت</th><th>العامل</th><th style="text-align:left">المبلغ</th></tr></thead>
  <tbody>${r.salaries.map(s => `<tr>
    <td style="padding:6px 10px">${esc(s.time)}</td>
    <td style="padding:6px 10px">${esc(s.workerName)}</td>
    <td style="padding:6px 10px;text-align:left;font-weight:700">${money(s.amount)}</td></tr>`).join('')}</tbody>
  <tfoot><tr><td colspan="2" style="padding:8px 10px">الإجمالي</td>
    <td style="padding:8px 10px;text-align:left">${money(r.salariesTotal)} ${currency}</td></tr></tfoot>
</table>
</div>` : ''}

${r.supplierPayments.length ? `<div class="section">
<h2>مدفوعات الموردين خلال الوردية</h2>
<table>
  <thead><tr><th>الوقت</th><th>المورد</th><th>الطريقة</th><th style="text-align:left">المبلغ</th></tr></thead>
  <tbody>${r.supplierPayments.map(s => `<tr>
    <td style="padding:6px 10px">${esc(s.time)}</td>
    <td style="padding:6px 10px">${esc(s.supplierName)}</td>
    <td style="padding:6px 10px">${s.method === 'cash' ? 'نقدي' : 'غير نقدي'}</td>
    <td style="padding:6px 10px;text-align:left;font-weight:700">${money(s.amount)}</td></tr>`).join('')}</tbody>
  <tfoot><tr><td colspan="3" style="padding:8px 10px">الإجمالي</td>
    <td style="padding:8px 10px;text-align:left">${money(r.supplierPaymentsTotal)} ${currency}</td></tr></tfoot>
</table>
</div>` : ''}

${r.stockMoves.length ? `<div class="section">
<h2>حركة المخزون خلال الوردية</h2>
<table>
  <thead><tr><th>المادة</th><th>نوع الحركة</th><th style="text-align:left">التغيير</th></tr></thead>
  <tbody>${r.stockMoves.map(m => `<tr>
    <td style="padding:6px 10px">${esc(m.name)}</td>
    <td style="padding:6px 10px">${esc(m.reason)}</td>
    <td style="padding:6px 10px;text-align:left;font-weight:700">${m.change > 0 ? '+' : ''}${m.change} ${esc(m.unit)}</td></tr>`).join('')}</tbody>
</table>
</div>` : ''}

<div class="section">
<h2>كل الفواتير (${r.invoices.length})</h2>
<table>
  <thead><tr><th>الوقت</th><th>رقم الفاتورة</th><th>النوع</th><th>الدفع</th><th>أصناف</th><th style="text-align:left">الإجمالي</th></tr></thead>
  <tbody>${r.invoices.map(i => `<tr${i.status === 'voided' ? ' style="opacity:.55;text-decoration:line-through"' : ''}>
    <td style="padding:5px 10px">${esc(i.time)}</td>
    <td style="padding:5px 10px;font-weight:700">${esc(i.invoiceNumber || '#' + i.orderId)}</td>
    <td style="padding:5px 10px">${esc(i.orderTypeLabel)}</td>
    <td style="padding:5px 10px">${i.paymentType === 'cash' ? 'نقدي' : 'بطاقة'}</td>
    <td style="padding:5px 10px">${i.itemCount}</td>
    <td style="padding:5px 10px;text-align:left;font-weight:700">${money(i.total)}</td></tr>`).join('')
    || '<tr><td colspan="6" style="padding:12px;text-align:center" class="muted">لا توجد فواتير في هذه الوردية</td></tr>'}</tbody>
  <tfoot><tr><td colspan="5" style="padding:9px 10px">إجمالي المبيعات</td>
    <td style="padding:9px 10px;text-align:left">${money(r.revenue)} ${currency}</td></tr></tfoot>
</table>
</div>

<div class="sign">
  <div>توقيع الكاشير</div>
  <div>النقدية المسلَّمة فعلياً</div>
  <div>توقيع المستلم</div>
</div>

</body></html>`
}

function buildReportHtml(r: FinanceReport, settings: any): string {
  const currency = settings.currency_symbol || 'ج.م'
  const business = esc(settings.business_name || 'أبو الدهب')
  const printedAt = new Date().toLocaleString('ar-EG')
  const profitColor = r.netProfit >= 0 ? '#15803D' : '#D92D20'

  const row = (label: string, value: string, opts: { bold?: boolean; color?: string; indent?: boolean } = {}) => `
    <tr>
      <td style="padding:7px 10px;${opts.indent ? 'padding-right:26px;' : ''}${opts.bold ? 'font-weight:800;' : ''}">${label}</td>
      <td style="padding:7px 10px;text-align:left;font-weight:${opts.bold ? 900 : 700};${opts.color ? `color:${opts.color};` : ''}">${value}</td>
    </tr>`

  return `<!doctype html>
<html lang="ar" dir="rtl"><head><meta charset="utf-8">
<style>
  * { box-sizing: border-box; }
  body {
    font-family: 'Segoe UI', 'Cairo', 'Tajawal', Arial, sans-serif;
    color: #1C1614; margin: 0; padding: 22px; font-size: 12px; background: #fff;
  }
  h1 { font-size: 21px; margin: 0 0 2px; color: #C41E2E; }
  h2 { font-size: 14px; margin: 22px 0 8px; padding-bottom: 5px;
       border-bottom: 2px solid #C41E2E; color: #1C1614; }
  .sub { color: #5C534E; font-size: 11px; }
  .head { display: flex; justify-content: space-between; align-items: flex-start;
          border-bottom: 3px solid #C41E2E; padding-bottom: 12px; margin-bottom: 6px; }
  table { width: 100%; border-collapse: collapse; }
  th { background: #F4F1EB; text-align: right; padding: 8px 10px; font-size: 11px;
       border-bottom: 1.5px solid #D3C9BC; }
  td { border-bottom: 1px solid #EFE9E0; }
  .kpis { display: flex; gap: 10px; margin: 14px 0 4px; }
  .kpi { flex: 1; border: 1px solid #E4DDD3; border-top: 3px solid #C41E2E;
         border-radius: 8px; padding: 11px 13px; }
  .kpi .l { font-size: 10px; color: #5C534E; margin-bottom: 5px; }
  .kpi .v { font-size: 17px; font-weight: 900; }
  .muted { color: #8A7F79; font-size: 10px; }
  .note { background: #FDF6EB; border-right: 3px solid #DE8709; padding: 9px 12px;
          font-size: 10.5px; color: #5C534E; border-radius: 5px; margin-top: 8px; }
  tfoot td { border-top: 2px solid #1C1614; font-weight: 900; }
  /* Keep a section and its heading together when the document breaks across pages. */
  .section { page-break-inside: avoid; }
</style></head><body>

<div class="head">
  <div>
    <h1>${business}</h1>
    <div class="sub">${r.shift
      ? `التقرير المالي — وردية ${esc(r.shift.name)} · من ${esc(r.shift.startedAt)} إلى ${esc(r.shift.endsAt)}`
      : `التقرير المالي — من ${esc(r.period.start)} إلى ${esc(r.period.end)}`}</div>
  </div>
  <div class="sub" style="text-align:left">
    طُبع في<br>${esc(printedAt)}
  </div>
</div>

<div class="kpis">
  <div class="kpi"><div class="l">الإيرادات</div><div class="v" style="color:#C41E2E">${money(r.revenue)}</div></div>
  <div class="kpi" style="border-top-color:#DE8709"><div class="l">إجمالي المصروف</div><div class="v" style="color:#B06A07">${money(r.totalSpent)}</div></div>
  <div class="kpi" style="border-top-color:${profitColor}"><div class="l">صافي الربح</div><div class="v" style="color:${profitColor}">${money(r.netProfit)}</div></div>
  <div class="kpi" style="border-top-color:#1D4ED8"><div class="l">عدد الفواتير</div><div class="v" style="color:#1D4ED8">${r.orderCount}</div></div>
</div>

<div class="section">
<h2>قائمة الأرباح والخسائر</h2>
<table>
  ${row('المبيعات (ما دفعه العملاء)', money(r.revenue) + ' ' + currency, { bold: true })}
  ${row('ضريبة القيمة المضافة — تُورَّد للضرائب', '− ' + money(r.tax) + ' ' + currency, { color: '#D92D20' })}
  ${row('صافي المبيعات', money(r.netSales) + ' ' + currency, { bold: true })}
  ${row('منها: رسوم التوصيل', money(r.deliveryFees) + ' ' + currency, { indent: true })}
  ${row('بعد خصومات للعملاء بقيمة', money(r.discount) + ' ' + currency, { indent: true })}
  ${row('تكلفة البضاعة المباعة', '− ' + money(r.cogs) + ' ' + currency, { color: '#D92D20' })}
  ${row(`مجمل الربح (هامش ${r.grossMarginPct}%)`, money(r.grossProfit) + ' ' + currency, { bold: true, color: '#15803D' })}
  ${row('المصروفات التشغيلية', '− ' + money(r.operatingExpenses) + ' ' + currency, { color: '#D92D20' })}
  ${row('المرتبات المصروفة', '− ' + money(r.salariesTotal) + ' ' + currency, { color: '#D92D20' })}
  ${r.wasteValue > 0 ? row('الهالك', '− ' + money(r.wasteValue) + ' ' + currency, { color: '#D92D20' }) : ''}
  <tfoot>
    <tr>
      <td style="padding:10px">صافي الربح (هامش ${r.netMarginPct}%)</td>
      <td style="padding:10px;text-align:left;color:${profitColor};font-size:15px">${money(r.netProfit)} ${currency}</td>
    </tr>
  </tfoot>
</table>
<div class="note">
  شراء الخامات لا يُخصم من الربح مرة ثانية، لأن تكلفة ما تم بيعه محسوبة بالفعل ضمن
  «تكلفة البضاعة المباعة». مشتريات خامات مسجلة كمصروف: <b>${money(r.ingredientPurchases)} ${currency}</b> ·
  توريدات مخزن: <b>${money(r.stockPurchaseValue)} ${currency}</b>.
</div>
</div>

<div class="section">
<h2>الإيرادات حسب نوع الطلب وطريقة الدفع</h2>
<table>
  <thead><tr><th>البند</th><th>عدد الفواتير</th><th style="text-align:left">الإيراد</th></tr></thead>
  <tbody>
    ${r.byOrderType.map(t => `<tr><td style="padding:7px 10px">${esc(t.label)}</td><td style="padding:7px 10px">${t.orders}</td><td style="padding:7px 10px;text-align:left;font-weight:700">${money(t.revenue)}</td></tr>`).join('')}
    ${r.byPayment.map(t => `<tr><td style="padding:7px 10px">دفع ${esc(t.label)}</td><td style="padding:7px 10px">${t.orders}</td><td style="padding:7px 10px;text-align:left;font-weight:700">${money(t.revenue)}</td></tr>`).join('')}
  </tbody>
</table>
</div>

<div class="section">
<h2>الأصناف الأعلى ربحاً</h2>
<table>
  <thead><tr><th>الصنف</th><th>الكمية</th><th>الإيراد</th><th>التكلفة</th><th style="text-align:left">الربح</th></tr></thead>
  <tbody>
    ${r.topItemsByProfit.map(i => `<tr>
      <td style="padding:6px 10px">${esc(i.name)}</td>
      <td style="padding:6px 10px">${i.units}</td>
      <td style="padding:6px 10px">${money(i.revenue)}</td>
      <td style="padding:6px 10px">${money(i.cost)}</td>
      <td style="padding:6px 10px;text-align:left;font-weight:800;color:#15803D">${money(i.profit)} <span class="muted">(${i.marginPct}%)</span></td>
    </tr>`).join('') || '<tr><td colspan="5" style="padding:14px;text-align:center" class="muted">لا توجد مبيعات في هذه الفترة</td></tr>'}
  </tbody>
</table>
</div>

<div class="section">
<h2>كل الأصناف المباعة — بالكمية</h2>
<p class="muted" style="margin:0 0 8px">
  إجمالي <b>${r.itemsSold.reduce((t, i) => t + i.units, 0)}</b> قطعة
  من <b>${r.itemsSold.length}</b> صنف.
</p>
<table>
  <thead><tr><th>الصنف</th><th>القسم</th><th>الكمية</th><th>المبيعات</th><th style="text-align:left">الربح</th></tr></thead>
  <tbody>
    ${r.itemsSold.map(i => `<tr>
      <td style="padding:6px 10px">${esc(i.name)}</td>
      <td style="padding:6px 10px" class="muted">${esc(i.category)}</td>
      <td style="padding:6px 10px;font-weight:800">${i.units}</td>
      <td style="padding:6px 10px">${money(i.revenue)}</td>
      <td style="padding:6px 10px;text-align:left;font-weight:700;color:#15803D">${money(i.profit)}</td>
    </tr>`).join('') || '<tr><td colspan="5" style="padding:14px;text-align:center" class="muted">لا توجد مبيعات في هذه الفترة</td></tr>'}
  </tbody>
</table>
</div>

<div class="section">
<h2>الخامات المستهلكة</h2>
<p class="muted" style="margin:0 0 8px">
  ما خرج من المخزن فعلياً مقابل هذه المبيعات — الخبز والمشروبات وقطع الفراخ والأرز والتغليف.
  الفواتير الملغاة مطروحة. تظهر هنا الأصناف التي لها مكونات مسجّلة فقط.
</p>
<table>
  <thead><tr><th>المادة</th><th>الكمية</th><th>الوحدة</th><th style="text-align:left">التكلفة</th></tr></thead>
  <tbody>
    ${r.materialsUsed.map(m => `<tr>
      <td style="padding:6px 10px">${esc(m.name)}</td>
      <td style="padding:6px 10px;font-weight:800">${m.quantity}</td>
      <td style="padding:6px 10px" class="muted">${esc(m.unit)}</td>
      <td style="padding:6px 10px;text-align:left;font-weight:700">${money(m.cost)}</td>
    </tr>`).join('') || '<tr><td colspan="4" style="padding:14px;text-align:center" class="muted">لا توجد خامات مستهلكة — لم تُسجَّل مكونات للأصناف المباعة</td></tr>'}
  </tbody>
</table>
</div>

<div class="section">
<h2>تفصيل المصروفات — كل جنيه صُرف</h2>
<table>
  <thead><tr><th>التاريخ</th><th>النوع</th><th>البيان</th><th>سجّلها</th><th style="text-align:left">المبلغ</th></tr></thead>
  <tbody>
    ${r.ledger.map(e => `<tr>
      <td style="padding:6px 10px;white-space:nowrap">${esc(e.date)}</td>
      <td style="padding:6px 10px">${e.kind === 'salary' ? 'مرتب' : 'مصروف'}</td>
      <td style="padding:6px 10px">${esc(e.label)}<div class="muted">${esc(e.category)}</div></td>
      <td style="padding:6px 10px">${esc(e.by) || '—'}</td>
      <td style="padding:6px 10px;text-align:left;font-weight:700">${money(e.amount)}</td>
    </tr>`).join('') || '<tr><td colspan="5" style="padding:14px;text-align:center" class="muted">لا توجد مصروفات في هذه الفترة</td></tr>'}
  </tbody>
  <tfoot>
    <tr>
      <td colspan="4" style="padding:9px 10px">الإجمالي المصروف</td>
      <td style="padding:9px 10px;text-align:left">${money(r.totalSpent)} ${currency}</td>
    </tr>
  </tfoot>
</table>
</div>

<div style="margin-top:26px;padding-top:10px;border-top:1px solid #E4DDD3" class="muted">
  ${business} — تقرير مُولَّد من نظام الكاشير.
  ${r.voidedCount > 0 ? `تنبيه: ${r.voidedCount} فاتورة ملغاة بقيمة ${money(r.voidedValue)} ${currency} خارج الحساب.` : ''}
</div>

</body></html>`
}
