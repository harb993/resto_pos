import fs from 'node:fs'
import path from 'node:path'
import { app, BrowserWindow } from 'electron'
import log from 'electron-log/main'
import { getSettings } from './settingsService'
import { getDataDirectory } from '../db/db'
import type { SalesProductsReport } from '../../shared/types'

/**
 * «Sales Products» as a file — a workbook to pivot, and a PDF to send on.
 *
 * The workbook writes quantities and money as REAL numbers rather than formatted text,
 * so the accountant can sum a column instead of retyping it. The PDF renders through
 * the same off-screen Chromium the receipts use, which is what shapes Arabic properly
 * — a PDF library would hand back disconnected letters.
 */

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

/** Windows will not have a colon or a slash in a file name, and dates are full of both. */
function safeName(s: string): string {
  return s.replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim()
}

export function salesReportFolder(): string {
  const configured = (getSettings() as any).shift_export_folder as string
  const base = configured && configured.trim() ? configured.trim() : getDataDirectory()
  const dir = path.join(base, 'تقارير المبيعات')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function fileStem(r: SalesProductsReport): string {
  return safeName(
    r.period.start === r.period.end
      ? `مبيعات-${r.period.start}`
      : `مبيعات-${r.period.start}-الى-${r.period.end}`
  )
}

export async function writeSalesWorkbook(r: SalesProductsReport, filePath: string): Promise<string> {
  const ExcelJS = require('exceljs')
  const wb = new ExcelJS.Workbook()
  wb.creator = r.storeName
  wb.created = new Date()

  const MONEY = '#,##0.00'
  const style = (sheet: any) => {
    const header = sheet.getRow(1)
    header.font = { bold: true, size: 12, color: { argb: 'FFFFFFFF' } }
    header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFC41E2E' } }
    header.alignment = { horizontal: 'center' }
    sheet.views = [{ state: 'frozen', ySplit: 1, rightToLeft: true }]
  }

  // ===== Everything sold, section by section =====
  const s = wb.addWorksheet('المبيعات بالأصناف')
  s.columns = [
    { header: 'القسم', key: 'category', width: 22 },
    { header: 'الصنف', key: 'name', width: 34 },
    { header: 'الكمية', key: 'qty', width: 10 },
    { header: 'الوحدة', key: 'unit', width: 10 },
    { header: 'المبيعات', key: 'total', width: 14 },
    { header: 'التكلفة', key: 'cost', width: 14 },
    { header: 'الربح', key: 'profit', width: 14 },
  ]
  for (const g of r.groups) {
    for (const i of g.items) {
      s.addRow({
        category: g.category, name: i.name, qty: i.quantity, unit: i.unit,
        total: i.total, cost: i.cost, profit: round2(i.total - i.cost),
      })
    }
    // A subtotal line per section, so the sheet reads like the printed report.
    const sub = s.addRow({
      category: g.category, name: `— إجمالي ${g.category} —`,
      qty: g.quantity, unit: '', total: g.total, cost: null, profit: null,
    })
    sub.font = { bold: true }
  }
  const grand = s.addRow({
    category: '', name: 'الإجمالي العام', qty: r.totalQuantity, unit: '',
    total: r.grandTotal, cost: null, profit: null,
  })
  grand.font = { bold: true, size: 12 }
  for (const col of ['total', 'cost', 'profit']) s.getColumn(col).numFmt = MONEY
  style(s)

  // ===== What it consumed =====
  const m = wb.addWorksheet('الخامات المستهلكة')
  m.columns = [
    { header: 'المادة', key: 'name', width: 30 },
    { header: 'الكمية', key: 'quantity', width: 14 },
    { header: 'الوحدة', key: 'unit', width: 12 },
    { header: 'التكلفة', key: 'cost', width: 14 },
  ]
  for (const x of r.materials) m.addRow(x)
  m.getColumn('cost').numFmt = MONEY
  style(m)

  // ===== The header block, so a printed sheet says what it is =====
  const info = wb.addWorksheet('بيانات التقرير')
  info.columns = [
    { header: 'البند', key: 'label', width: 26 },
    { header: 'القيمة', key: 'value', width: 30 },
  ]
  info.addRows([
    { label: 'المطعم', value: r.storeName },
    { label: 'من', value: r.period.start },
    { label: 'إلى', value: r.period.end },
    { label: 'عدد الفواتير', value: r.orderCount },
    { label: 'إجمالي الكمية', value: r.totalQuantity },
    { label: `الإجمالي (${r.currency})`, value: r.grandTotal },
    { label: 'عدد الأصناف', value: r.groups.reduce((t, g) => t + g.items.length, 0) },
  ])
  style(info)

  await wb.xlsx.writeFile(filePath)
  return filePath
}

const esc = (s: string): string =>
  String(s ?? '').replace(/[&<>"]/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string
  ))

function salesReportHtml(r: SalesProductsReport): string {
  const money = (n: number) => n.toFixed(2)
  return `<!doctype html><html dir="rtl" lang="ar"><head><meta charset="utf-8">
<style>
  @page { size: A4; margin: 12mm; }
  * { box-sizing: border-box; }
  body { font-family: "Segoe UI","Tahoma",sans-serif; color:#111; font-size:12px; margin:0; }
  h1 { font-size:19px; margin:0 0 2px; }
  h2 { font-size:14px; margin:16px 0 6px; padding-bottom:3px; border-bottom:2px solid #C41E2E; }
  .muted { color:#666; }
  .head { display:flex; justify-content:space-between; align-items:flex-start;
          border-bottom:3px solid #C41E2E; padding-bottom:8px; margin-bottom:10px; }
  table { width:100%; border-collapse:collapse; margin-bottom:4px; }
  th { background:#C41E2E; color:#fff; padding:5px 8px; text-align:right; font-size:11px; }
  td { padding:4px 8px; border-bottom:1px solid #eee; }
  tr.sub td { font-weight:800; background:#FAFAFA; border-top:1px solid #ccc; }
  .num { font-variant-numeric: tabular-nums; }
  .grand { display:flex; justify-content:space-between; font-size:16px; font-weight:800;
           background:#FDF2F2; border:2px solid #C41E2E; border-radius:6px;
           padding:9px 12px; margin-top:12px; }
  tbody { page-break-inside: avoid; }
</style></head><body>
<div class="head">
  <div>
    <h1>${esc(r.storeName)}</h1>
    <div class="muted">تقرير المبيعات بالأصناف</div>
  </div>
  <div class="muted" style="text-align:left">
    <div>من: <b class="num">${esc(r.period.start)}</b></div>
    <div>إلى: <b class="num">${esc(r.period.end)}</b></div>
    <div>عدد الفواتير: <b class="num">${r.orderCount}</b></div>
  </div>
</div>

${r.groups.map(g => `
  <h2>${esc(g.category)}</h2>
  <table>
    <thead><tr>
      <th style="width:48%">الصنف</th><th style="width:14%">الكمية</th>
      <th style="width:12%">الوحدة</th><th style="width:26%;text-align:left">الإجمالي</th>
    </tr></thead>
    <tbody>
      ${g.items.map(i => `<tr>
        <td>${esc(i.name)}</td>
        <td class="num"><b>${i.quantity}</b></td>
        <td class="muted">${esc(i.unit)}</td>
        <td class="num" style="text-align:left">${money(i.total)}</td>
      </tr>`).join('')}
      <tr class="sub">
        <td>إجمالي ${esc(g.category)}</td>
        <td class="num">${g.quantity}</td>
        <td></td>
        <td class="num" style="text-align:left">${money(g.total)}</td>
      </tr>
    </tbody>
  </table>`).join('') || '<p class="muted">لا توجد مبيعات في هذه الفترة.</p>'}

<div class="grand">
  <span>الإجمالي العام — ${r.totalQuantity} قطعة</span>
  <span class="num">${money(r.grandTotal)} ${esc(r.currency)}</span>
</div>

${r.materials.length === 0 ? '' : `
<h2>الخامات المستهلكة</h2>
<table>
  <thead><tr>
    <th style="width:48%">المادة</th><th style="width:18%">الكمية</th>
    <th style="width:14%">الوحدة</th><th style="width:20%;text-align:left">التكلفة</th>
  </tr></thead>
  <tbody>
    ${r.materials.map(m => `<tr>
      <td>${esc(m.name)}</td>
      <td class="num"><b>${m.quantity}</b></td>
      <td class="muted">${esc(m.unit)}</td>
      <td class="num" style="text-align:left">${money(m.cost)}</td>
    </tr>`).join('')}
  </tbody>
</table>`}
</body></html>`
}

/** Render through the same off-screen Chromium the receipts use — it shapes Arabic. */
export async function writeSalesPdf(r: SalesProductsReport, filePath: string): Promise<string> {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { offscreen: true, javascript: false, images: true },
  })
  try {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(salesReportHtml(r)))
    const pdf = await win.webContents.printToPDF({
      pageSize: 'A4', printBackground: true, margins: { marginType: 'default' },
    })
    fs.writeFileSync(filePath, pdf)
    log.info(`[Report] Sales PDF written: ${filePath} (${pdf.length} bytes)`)
    return filePath
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
}

/** Both files, into the dated reports folder. Returns where they went. */
export async function exportSalesProducts(
  r: SalesProductsReport,
): Promise<{ folder: string; pdfPath: string; xlsxPath: string }> {
  const folder = salesReportFolder()
  const stem = fileStem(r)
  const xlsxPath = path.join(folder, `${stem}.xlsx`)
  const pdfPath = path.join(folder, `${stem}.pdf`)

  await writeSalesWorkbook(r, xlsxPath)
  await writeSalesPdf(r, pdfPath)

  return { folder, pdfPath, xlsxPath }
}

/** Used by the IPC layer to open the folder after writing. */
export function appName(): string {
  return app.getName()
}
