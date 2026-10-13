import { dialog } from 'electron'
import { getDb } from '../db/db'
import log from 'electron-log/main'
import type { FinanceReport } from '../../shared/types'

interface Period { start: string; end: string }

export async function exportFinancialReport(period: Period): Promise<string | null> {
  // Dynamic import to avoid bundling issues
  const ExcelJS = require('exceljs')
  const db = getDb()
  const workbook = new ExcelJS.Workbook()

  // ===== Sheet 1: Sales =====
  const sales = workbook.addWorksheet('المبيعات')
  sales.columns = [
    { header: 'التاريخ', key: 'date', width: 14 },
    { header: 'عدد الفواتير', key: 'orders', width: 12 },
    { header: 'الإيرادات (ج.م)', key: 'revenue', width: 16 },
  ]
  const salesRows = db.prepare(`
    SELECT date(created_at) AS date, COUNT(*) AS orders, SUM(total_amount) AS revenue
    FROM orders WHERE status = 'completed' AND deleted_at IS NULL AND date(created_at) BETWEEN ? AND ?
    GROUP BY date ORDER BY date
  `).all(period.start, period.end)
  sales.addRows(salesRows)
  styleSalesSheet(sales)

  // ===== Sheet 2: Expenses =====
  const expenses = workbook.addWorksheet('المصروفات')
  expenses.columns = [
    { header: 'التاريخ', key: 'expense_date', width: 14 },
    { header: 'التصنيف', key: 'category', width: 14 },
    { header: 'الوصف', key: 'description', width: 30 },
    { header: 'المبلغ (ج.م)', key: 'amount', width: 14 },
  ]
  const expRows = db.prepare(`
    SELECT expense_date, category, description, amount FROM expenses
    WHERE expense_date BETWEEN ? AND ? ORDER BY expense_date
  `).all(period.start, period.end)
  expenses.addRows(expRows)
  styleSalesSheet(expenses)

  // ===== Sheet 3: Salaries =====
  const salaries = workbook.addWorksheet('المرتبات')
  salaries.columns = [
    { header: 'الموظف', key: 'full_name', width: 20 },
    { header: 'الفترة', key: 'period', width: 22 },
    { header: 'المبلغ (ج.م)', key: 'amount', width: 14 },
    { header: 'تاريخ الصرف', key: 'paid_on', width: 14 },
  ]
  // Same rule as salaryService and financeService: a salary counts on the day it was
  // paid. Matching only periods that fit entirely inside the range used to drop
  // fortnightly and monthly payments out of shorter reports.
  const salRows = db.prepare(`
    SELECT w.full_name, s.pay_period_start || ' → ' || s.pay_period_end AS period, s.amount, s.paid_on
    FROM salaries s JOIN workers w ON w.worker_id = s.worker_id
    WHERE COALESCE(s.paid_on, s.pay_period_end) BETWEEN ? AND ?
    ORDER BY COALESCE(s.paid_on, s.pay_period_end)
  `).all(period.start, period.end)
  salaries.addRows(salRows)
  styleSalesSheet(salaries)

  // ===== Sheet 5: Current Stock =====
  const stock = workbook.addWorksheet('المخزون الحالي')
  stock.columns = [
    { header: 'الصنف', key: 'name', width: 25 },
    { header: 'القسم', key: 'category', width: 20 },
    { header: 'سعر البيع (ج.م)', key: 'price', width: 15 },
    { header: 'التكلفة (ج.م)', key: 'cost', width: 15 },
    { header: 'الكمية المتاحة', key: 'qty', width: 15 },
  ]
  const stockRows = db.prepare(`
    SELECT m.name, c.name as category, m.price, m.cost_price as cost, m.stock_quantity as qty
    FROM menu_items m JOIN categories c ON m.category_id = c.category_id
    WHERE m.is_active = 1
    ORDER BY c.display_order, m.name
  `).all()
  stock.addRows(stockRows)
  styleSalesSheet(stock)

  // ===== Sheet 6: Stock Transactions =====
  const stockTxns = workbook.addWorksheet('حركة المخزون')
  stockTxns.columns = [
    { header: 'التاريخ', key: 'date', width: 20 },
    { header: 'الصنف', key: 'name', width: 25 },
    { header: 'الكمية (التغيير)', key: 'change', width: 15 },
    { header: 'نوع الحركة', key: 'reason', width: 15 },
    { header: 'المستخدم', key: 'user', width: 20 },
  ]
  const txnRows = db.prepare(`
    SELECT t.created_at as date, m.name, t.change_amount as change, 
           CASE t.reason 
             WHEN 'sale' THEN 'مبيعات' 
             WHEN 'restock' THEN 'إضافة مخزون'
             WHEN 'waste' THEN 'هالك'
             WHEN 'adjustment' THEN 'تسوية'
             WHEN 'conversion' THEN 'تحويل/تجهيز'
             ELSE t.reason 
           END as reason, 
           u.username as user
    FROM stock_transactions t
    JOIN menu_items m ON t.menu_item_id = m.item_id
    JOIN users u ON t.created_by = u.user_id
    WHERE date(t.created_at) BETWEEN ? AND ?
    ORDER BY t.created_at DESC
  `).all(period.start, period.end)
  stockTxns.addRows(txnRows)
  styleSalesSheet(stockTxns)

  // ===== Sheet 7: Profit Summary =====
  const revenue = (db.prepare(`SELECT COALESCE(SUM(total_amount),0) AS v FROM orders WHERE status='completed' AND deleted_at IS NULL AND date(created_at) BETWEEN ? AND ?`).get(period.start, period.end) as any).v
  const cogs = (db.prepare(`SELECT COALESCE(SUM(oi.quantity * oi.unit_cost),0) AS v FROM order_items oi JOIN orders o ON o.order_id = oi.order_id WHERE o.status='completed' AND o.deleted_at IS NULL AND date(o.created_at) BETWEEN ? AND ?`).get(period.start, period.end) as any).v
  const expTotal = (db.prepare(`SELECT COALESCE(SUM(amount),0) AS v FROM expenses WHERE expense_date BETWEEN ? AND ?`).get(period.start, period.end) as any).v
  const salTotal = (db.prepare(`SELECT COALESCE(SUM(amount),0) AS v FROM salaries WHERE COALESCE(paid_on, pay_period_end) BETWEEN ? AND ?`).get(period.start, period.end) as any).v

  const summary = workbook.addWorksheet('ملخص الأرباح')
  summary.columns = [
    { header: 'البند', key: 'label', width: 24 },
    { header: 'المبلغ (ج.م)', key: 'value', width: 18 },
  ]
  summary.addRows([
    { label: 'إجمالي الإيرادات', value: revenue },
    { label: 'تكلفة البضاعة المباعة', value: -cogs },
    { label: 'إجمالي الربح', value: revenue - cogs },
    { label: 'المصروفات التشغيلية', value: -expTotal },
    { label: 'المرتبات', value: -salTotal },
    { label: 'صافي الربح', value: revenue - cogs - expTotal - salTotal },
  ])
  styleSalesSheet(summary)

  // Bold the net profit row
  const lastRow = summary.getRow(summary.rowCount)
  lastRow.font = { bold: true, size: 13 }

  const { filePath } = await dialog.showSaveDialog({
    defaultPath: `تقرير-مالي-${period.start}-الى-${period.end}.xlsx`,
    filters: [{ name: 'Excel', extensions: ['xlsx'] }],
  })

  if (filePath) {
    await workbook.xlsx.writeFile(filePath)
    log.info(`[Report] Excel report exported to: ${filePath}`)
    return filePath
  }

  return null
}

function styleSalesSheet(sheet: any): void {
  // Style header row
  const headerRow = sheet.getRow(1)
  headerRow.font = { bold: true, size: 12, color: { argb: 'FFFFFFFF' } }
  headerRow.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFC41E2E' } // brand crimson
  }
  headerRow.alignment = { horizontal: 'center' }
  sheet.views = [{ state: 'frozen', ySplit: 1, rightToLeft: true }]
}

/**
 * The accountant's workbook: the same figures the on-screen report and the PDF show,
 * built from the one FinanceReport object so the three can never disagree.
 *
 * Money columns are given a real number format rather than being written as text,
 * so the accountant can sort, sum and pivot them in Excel.
 */
export async function exportFinanceWorkbook(report: FinanceReport): Promise<string | null> {
  const ExcelJS = require('exceljs')
  const wb = new ExcelJS.Workbook()
  wb.creator = 'Crispo POS'
  wb.created = new Date()

  const MONEY = '#,##0.00'

  // ===== Summary =====
  const s = wb.addWorksheet('الملخص المالي')
  s.columns = [
    { header: 'البند', key: 'label', width: 38 },
    { header: 'القيمة', key: 'value', width: 20, style: { numFmt: MONEY } },
  ]
  const summaryRows = [
    {
      label: report.shift
        ? `وردية ${report.shift.name}: ${report.shift.startedAt} → ${report.shift.endsAt}`
        : `الفترة: ${report.period.start} → ${report.period.end}`,
      value: null,
    },
    { label: 'المبيعات (ما دفعه العملاء)', value: report.revenue },
    { label: 'عدد الفواتير', value: report.orderCount },
    { label: 'متوسط قيمة الفاتورة', value: report.averageOrder },
    { label: 'ضريبة القيمة المضافة (تُورَّد للضرائب)', value: report.tax },
    { label: 'صافي المبيعات', value: report.netSales },
    { label: 'منها: رسوم التوصيل', value: report.deliveryFees },
    { label: 'الخصومات الممنوحة', value: report.discount },
    { label: 'تكلفة البضاعة المباعة', value: report.cogs },
    { label: `مجمل الربح (${report.grossMarginPct}%)`, value: report.grossProfit },
    { label: 'المصروفات التشغيلية', value: report.operatingExpenses },
    { label: 'المرتبات المصروفة', value: report.salariesTotal },
    { label: 'الهالك', value: report.wasteValue },
    { label: `صافي الربح (${report.netMarginPct}%)`, value: report.netProfit },
    { label: '— للعلم فقط (خارج حساب الربح) —', value: null },
    { label: 'مشتريات خامات مسجلة كمصروف', value: report.ingredientPurchases },
    { label: 'قيمة التوريدات المسجلة', value: report.stockPurchaseValue },
    { label: 'إجمالي ما خرج نقداً (مصروفات + مرتبات)', value: report.totalSpent },
    { label: 'قيمة الفواتير الملغاة', value: report.voidedValue },
  ]
  s.addRows(summaryRows)
  styleSalesSheet(s)
  // Found by its label rather than a row number, so adding a line above cannot leave
  // the bold on the wrong figure.
  const netRow = s.getRow(2 + summaryRows.findIndex(r => r.label.startsWith('صافي الربح')))
  netRow.font = { bold: true, size: 13 }

  // ===== Every pound spent =====
  const ledger = wb.addWorksheet('كل جنيه صُرف')
  ledger.columns = [
    { header: 'التاريخ', key: 'date', width: 14 },
    { header: 'النوع', key: 'kind', width: 12 },
    { header: 'البيان', key: 'label', width: 36 },
    { header: 'التصنيف', key: 'category', width: 24 },
    { header: 'سجّلها', key: 'by', width: 20 },
    { header: 'المبلغ', key: 'amount', width: 16, style: { numFmt: MONEY } },
  ]
  ledger.addRows(report.ledger.map(e => ({
    date: e.date,
    kind: e.kind === 'salary' ? 'مرتب' : 'مصروف',
    label: e.label,
    category: e.category,
    by: e.by || '—',
    amount: e.amount,
  })))
  ledger.addRow({ label: 'الإجمالي', amount: report.totalSpent })
  ledger.getRow(ledger.rowCount).font = { bold: true }
  styleSalesSheet(ledger)

  // ===== Daily money in / money out =====
  const daily = wb.addWorksheet('الحركة اليومية')
  daily.columns = [
    { header: 'التاريخ', key: 'date', width: 14 },
    { header: 'الإيرادات', key: 'revenue', width: 15, style: { numFmt: MONEY } },
    { header: 'تكلفة المبيعات', key: 'cogs', width: 16, style: { numFmt: MONEY } },
    { header: 'المصروفات', key: 'expenses', width: 15, style: { numFmt: MONEY } },
    { header: 'المرتبات', key: 'salaries', width: 15, style: { numFmt: MONEY } },
    { header: 'صافي اليوم', key: 'profit', width: 16, style: { numFmt: MONEY } },
  ]
  daily.addRows(report.daily)
  styleSalesSheet(daily)

  // ===== Profit by item =====
  const items = wb.addWorksheet('ربحية الأصناف')
  items.columns = [
    { header: 'الصنف', key: 'name', width: 34 },
    { header: 'الكمية المباعة', key: 'units', width: 15 },
    { header: 'الإيراد', key: 'revenue', width: 15, style: { numFmt: MONEY } },
    { header: 'التكلفة', key: 'cost', width: 15, style: { numFmt: MONEY } },
    { header: 'الربح', key: 'profit', width: 15, style: { numFmt: MONEY } },
    { header: 'الهامش %', key: 'marginPct', width: 12 },
  ]
  items.addRows(report.topItemsByProfit)
  styleSalesSheet(items)

  // ===== Expenses detail =====
  const exp = wb.addWorksheet('المصروفات')
  exp.columns = [
    { header: 'التاريخ', key: 'date', width: 14 },
    { header: 'التصنيف', key: 'category', width: 22 },
    { header: 'الوصف', key: 'description', width: 40 },
    { header: 'سجّلها', key: 'recordedBy', width: 20 },
    { header: 'المبلغ', key: 'amount', width: 15, style: { numFmt: MONEY } },
  ]
  exp.addRows(report.expenses)
  styleSalesSheet(exp)

  // ===== Salaries detail =====
  const sal = wb.addWorksheet('المرتبات')
  sal.columns = [
    { header: 'العامل', key: 'workerName', width: 26 },
    { header: 'من', key: 'periodStart', width: 14 },
    { header: 'إلى', key: 'periodEnd', width: 14 },
    { header: 'تاريخ الصرف', key: 'paidOn', width: 14 },
    { header: 'المبلغ', key: 'amount', width: 15, style: { numFmt: MONEY } },
  ]
  sal.addRows(report.salaries)
  styleSalesSheet(sal)

  const { filePath } = await dialog.showSaveDialog({
    title: 'حفظ التقرير المالي',
    defaultPath: `تقرير-مالي-${report.period.start}-الى-${report.period.end}.xlsx`,
    filters: [{ name: 'Excel', extensions: ['xlsx'] }],
  })
  if (!filePath) return null

  await wb.xlsx.writeFile(filePath)
  log.info(`[Report] Finance workbook exported to: ${filePath}`)
  return filePath
}
