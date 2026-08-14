import { ipcMain, BrowserWindow } from 'electron'
import * as order from '../services/orderService'
import * as stock from '../services/stockService'
import { requireAnyAuth, requireRole, verifyOwnerPin } from '../services/authService'
import log from 'electron-log/main'
import type { IpcResponse } from '../../shared/types'

export function registerOrderIpc(): void {
  ipcMain.handle('order:create', async (_e, data): Promise<IpcResponse> => {
    try {
      const session = requireAnyAuth()
      data.cashierId = session.userId
      const result = order.createOrder(data)

      // Check for low stock after order and push alerts
      const lowStock = stock.getLowStockItems(5)
      if (lowStock.length > 0) {
        const wins = BrowserWindow.getAllWindows()
        for (const w of wins) {
          w.webContents.send('app:lowStockAlert', lowStock)
        }
      }

      return { success: true, data: result }
    } catch (err: any) {
      log.error('[IPC] order:create error:', err)
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('order:void', async (_e, { orderId, reason, ownerPin }): Promise<IpcResponse> => {
    try {
      const session = requireAnyAuth()
      // If cashier, require owner PIN
      if (session.role === 'cashier') {
        if (!ownerPin || !verifyOwnerPin(ownerPin)) {
          return { success: false, error: 'Invalid owner PIN' }
        }
      }
      order.voidOrder(orderId, session.userId, reason)
      return { success: true }
    } catch (err: any) {
      log.error('[IPC] order:void error:', err)
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('order:list', async (_e, filters = {}): Promise<IpcResponse> => {
    try {
      const session = requireAnyAuth()
      // Cashiers can only see their own orders
      if (session.role === 'cashier') {
        filters.cashierId = session.userId
      }
      return { success: true, data: order.listOrders(filters) }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('order:get', async (_e, { orderId }): Promise<IpcResponse> => {
    try {
      requireAnyAuth()
      return { success: true, data: order.getOrderWithItems(orderId) }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })
}
