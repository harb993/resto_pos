import { ipcMain, shell } from 'electron'
import { handle } from '../net/router'
import { exportFinancialReport } from '../services/reportService'
import { getSalesProductsReport } from '../services/salesProductsService'
import { getCostingReport } from '../services/costingService'
import { exportSalesProducts, salesReportFolder } from '../services/salesProductsExport'
import { printSalesProductsReport } from '../services/printerService'
import { requireOwnerOrAccountant } from '../services/authService'
import log from 'electron-log/main'
import type { IpcResponse } from '../../shared/types'

export function registerReportIpc(): void {
  handle('reports:exportExcel', async (_e, { start, end }): Promise<IpcResponse> => {
    try {
      requireOwnerOrAccountant()
      const filePath = await exportFinancialReport({ start, end })
      return { success: true, data: { filePath } }
    } catch (err: any) {
      log.error('[IPC] reports:exportExcel error:', err)
      return { success: false, error: err.message }
    }
  })

  // ---- «Sales Products»: how many of everything, and what it consumed ----

  handle('reports:salesProducts', async (_e, { start, end }): Promise<IpcResponse> => {
    try {
      requireOwnerOrAccountant()
      return { success: true, data: getSalesProductsReport(start, end) }
    } catch (err: any) {
      log.error('[IPC] reports:salesProducts error:', err)
      return { success: false, error: err.message }
    }
  })

  handle('reports:salesProductsExport', async (_e, { start, end }): Promise<IpcResponse> => {
    try {
      requireOwnerOrAccountant()
      const report = getSalesProductsReport(start, end)
      const files = await exportSalesProducts(report)
      log.info(`[Report] Sales products exported: ${files.folder}`)
      return { success: true, data: files }
    } catch (err: any) {
      log.error('[IPC] reports:salesProductsExport error:', err)
      return { success: false, error: err.message }
    }
  })

  handle('reports:salesProductsPrint', async (_e, { start, end, printerId } = {}): Promise<IpcResponse> => {
    try {
      requireOwnerOrAccountant()
      const report = getSalesProductsReport(start, end)
      const result = await printSalesProductsReport(report, { printerId })
      if (!result.ok) return { success: false, error: result.error || 'تعذرت الطباعة' }
      return { success: true, data: result }
    } catch (err: any) {
      log.error('[IPC] reports:salesProductsPrint error:', err)
      return { success: false, error: err.message }
    }
  })

  /** The sheet's costing against today's ingredient prices. */
  handle('reports:costing', async (): Promise<IpcResponse> => {
    try {
      requireOwnerOrAccountant()
      return { success: true, data: getCostingReport() }
    } catch (err: any) {
      log.error('[IPC] reports:costing error:', err)
      return { success: false, error: err.message }
    }
  })

  handle('reports:openSalesFolder', async (): Promise<IpcResponse> => {
    try {
      requireOwnerOrAccountant()
      await shell.openPath(salesReportFolder())
      return { success: true }
    } catch (err: any) { return { success: false, error: err.message } }
  })
}
