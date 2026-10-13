import { ipcMain, shell } from 'electron'
import { handle } from '../net/router'
import { getFinanceReport } from '../services/financeService'
import { exportFinanceWorkbook } from '../services/reportService'
import { exportFinancePdf } from '../services/pdfReportService'
import { requireOwnerOrAccountant } from '../services/authService'
import type { ClosingWindow } from '../services/shiftService'
import { currentWorkWindow, workShiftWindow } from '../services/workShiftService'
import log from 'electron-log/main'
import type { IpcResponse } from '../../shared/types'

/** A date must look like YYYY-MM-DD before it reaches a query. */
function validDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
}

function checkedPeriod(start: unknown, end: unknown): { start: string; end: string } {
  if (!validDate(start) || !validDate(end)) {
    throw new Error('التاريخ غير صحيح')
  }
  if (start > end) throw new Error('تاريخ البداية بعد تاريخ النهاية')
  return { start, end }
}

/**
 * The report for whole days, or for one configured shift.
 *
 * `shift` is 'current' for the shift running now (or the one that just ended), or the
 * id of a shift from the list.
 */
function buildReport(start: unknown, end: unknown, shift: unknown) {
  let window: ClosingWindow | undefined
  if (shift === 'current') {
    window = currentWorkWindow(new Date())
  } else if (Number.isInteger(shift) && (shift as number) > 0) {
    window = workShiftWindow(shift as number)
  }
  if (window) return getFinanceReport('', '', window)

  const period = checkedPeriod(start, end)
  return getFinanceReport(period.start, period.end)
}

export function registerFinanceIpc(): void {
  handle('finance:report', async (_e, { start, end, shift }): Promise<IpcResponse> => {
    try {
      requireOwnerOrAccountant()
      return { success: true, data: buildReport(start, end, shift) }
    } catch (err: any) {
      log.error('[IPC] finance:report error:', err)
      return { success: false, error: err.message }
    }
  })

  // Both exports rebuild the report server-side rather than trusting figures sent
  // from the renderer, so an exported file always matches the database.
  handle('finance:exportPdf', async (_e, { start, end, shift }): Promise<IpcResponse> => {
    try {
      requireOwnerOrAccountant()
      const report = buildReport(start, end, shift)
      const filePath = await exportFinancePdf(report)
      return { success: true, data: { filePath } }
    } catch (err: any) {
      log.error('[IPC] finance:exportPdf error:', err)
      return { success: false, error: err.message }
    }
  })

  handle('finance:exportExcel', async (_e, { start, end, shift }): Promise<IpcResponse> => {
    try {
      requireOwnerOrAccountant()
      const report = buildReport(start, end, shift)
      const filePath = await exportFinanceWorkbook(report)
      return { success: true, data: { filePath } }
    } catch (err: any) {
      log.error('[IPC] finance:exportExcel error:', err)
      return { success: false, error: err.message }
    }
  })

  // Opens the saved file in whatever the machine uses for PDFs/spreadsheets.
  handle('finance:openFile', async (_e, { filePath }): Promise<IpcResponse> => {
    try {
      requireOwnerOrAccountant()
      if (typeof filePath !== 'string' || !filePath) throw new Error('مسار الملف غير صحيح')
      const err = await shell.openPath(filePath)
      if (err) throw new Error(err)
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })
}
