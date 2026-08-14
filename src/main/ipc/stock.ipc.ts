import { ipcMain } from 'electron'
import * as stock from '../services/stockService'
import { requireRole } from '../services/authService'
import log from 'electron-log/main'
import type { IpcResponse } from '../../shared/types'

export function registerStockIpc(): void {
  ipcMain.handle('stock:restock', async (_e, data): Promise<IpcResponse> => {
    try {
      const session = requireRole('owner')
      stock.restockItem(data.menuItemId, data.quantity, data.reason || 'restock', session.userId)
      return { success: true }
    } catch (err: any) {
      log.error('[IPC] stock:restock error:', err)
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('stock:lowStock', async (_e, { threshold } = {}): Promise<IpcResponse> => {
    try {
      return { success: true, data: stock.getLowStockItems(threshold) }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('stock:history', async (_e, { menuItemId, limit } = {}): Promise<IpcResponse> => {
    try {
      return { success: true, data: stock.getStockHistory(menuItemId, limit) }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })
}
