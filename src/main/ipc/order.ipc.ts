import { ipcMain, BrowserWindow, Notification } from 'electron'
import { handle } from '../net/router'
import * as order from '../services/orderService'
import * as rawMaterials from '../services/rawMaterialService'
import { requireAnyAuth, requireRole, verifyOwnerPassword } from '../services/authService'
import { broadcastStockChanged, broadcastOrdersChanged, broadcast } from './broadcast'
import { printOrderInBackground, printVoidNoticeInBackground } from './printer.ipc'
import { getSettings } from '../services/settingsService'
import { requireOpenWorkShift } from '../services/workShiftService'
import log from 'electron-log/main'
import type { IpcResponse } from '../../shared/types'

export function registerOrderIpc(): void {
  handle('order:create', async (_e, data): Promise<IpcResponse> => {
    try {
      const session = requireAnyAuth()
      // No shift, no sale: every invoice belongs to a shift, so between one ending and
      // the next starting the till waits for the owner — or for the start time.
      requireOpenWorkShift()
      data.cashierId = session.userId
      // The role decides whether the discount cap applies — never let it come from the payload.
      const result = order.createOrder(data, session.role)
      broadcastStockChanged('sale')
      broadcastOrdersChanged('sale')

      // Send the tickets to the printers without waiting for them. The sale is
      // already recorded; a printer that is out of paper must not hold up the next
      // customer, and the cashier hears about it through 'app:printResult' instead.
      //
      // `tenderedAmount` is display-only — it is what the customer handed over, which
      // nothing but this screen knows, and it decides nothing about the totals.
      if (getSettings().print_auto) {
        printOrderInBackground(result.orderId, Number(data?.tenderedAmount) || undefined)
      }

      // Low-stock alerts watch raw materials only. Finished meals are not stocked —
      // what runs out is chicken, buns, sauce and packaging.
      const lowStock = rawMaterials.getLowStockMaterials().map(m => ({
        item_id: `rm-${m.raw_material_id}`,
        name: `${m.name} (${m.stock_quantity} ${m.unit})`,
        stock_quantity: m.stock_quantity,
        category_name: 'مواد خام',
      }))
      // Sent even when the list is empty: a till that only ever heard "something is
      // low" could never be told that nothing is any more.
      broadcast('app:lowStockAlert', lowStock)
      if (lowStock.length > 0) {
        // Also fire native Windows toast notification
        if (Notification.isSupported()) {
          const itemNames = lowStock.slice(0, 3).map((i: any) => i.name).join('، ')
          new Notification({
            title: '⚠️ تنبيه نقص المخزون',
            body: `${itemNames}${lowStock.length > 3 ? ` و${lowStock.length - 3} أصناف أخرى` : ''}`
          }).show()
        }
      }

      return { success: true, data: result }
    } catch (err: any) {
      log.error('[IPC] order:create error:', err)
      return { success: false, error: err.message }
    }
  })

  // Invoice numbering — owner setting, guarded against reissuing a used number.
  handle('order:invoiceCounters', async (): Promise<IpcResponse> => {
    try {
      requireRole('owner')
      return { success: true, data: order.getInvoiceCounters() }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  handle('order:setInvoiceStart', async (_e, { orderType, nextNumber }): Promise<IpcResponse> => {
    try {
      requireRole('owner')
      order.setInvoiceStart(orderType, nextNumber)
      return { success: true, data: order.getInvoiceCounters() }
    } catch (err: any) {
      log.error('[IPC] order:setInvoiceStart error:', err)
      return { success: false, error: err.message }
    }
  })

  handle('order:void', async (_e, { orderId, reason, ownerPassword }): Promise<IpcResponse> => {
    try {
      const session = requireAnyAuth()
      // A cashier cannot void on their own — the owner authorises it with their password.
      if (session.role === 'cashier') {
        if (!ownerPassword || !verifyOwnerPassword(ownerPassword)) {
          return { success: false, error: 'كلمة مرور المدير غير صحيحة' }
        }
      }
      const returnedStock = order.voidOrder(orderId, session.userId, reason)
      broadcastStockChanged('void')
      broadcastOrdersChanged('void')

      // Tell the kitchen to stop cooking. The prep ticket printed at the moment of
      // sale is still on the rail; without this, a cancelled order is still cooked,
      // bagged and binned. Read from the database BEFORE the reply, printed after —
      // a jammed printer must not fail a void that is already recorded.
      printVoidNoticeInBackground(orderId, {
        kind: 'void', reason, byName: session.fullName,
      })

      return { success: true, data: { returnedStock } }
    } catch (err: any) {
      log.error('[IPC] order:void error:', err)
      return { success: false, error: err.message }
    }
  })

  handle('order:delete', async (_e, { orderId }): Promise<IpcResponse> => {
    try {
      const session = requireRole('owner')
      // Read the status BEFORE deleting: an invoice that was already voided has had
      // its cancellation slip, and a second one would send a cook looking for a
      // ticket they pulled ten minutes ago.
      const before = order.getOrderWithItems(orderId) as any
      const alreadyVoided = before?.status === 'voided'

      // Hand back what returned to stock, so the screen can say so rather than
      // leaving the owner to go and check a number that may still be cached.
      const returnedStock = order.softDeleteOrder(orderId, session.userId)
      broadcastStockChanged('delete')
      broadcastOrdersChanged('delete')

      if (!alreadyVoided) {
        printVoidNoticeInBackground(orderId, { kind: 'delete', byName: session.fullName })
      }

      return { success: true, data: { returnedStock } }
    } catch (err: any) {
      log.error('[IPC] order:delete error:', err)
      return { success: false, error: err.message }
    }
  })

  handle('order:list', async (_e, filters = {}): Promise<IpcResponse> => {
    try {
      const session = requireAnyAuth()
      // Cashiers can only see their own orders
      if (session.role === 'cashier') {
        filters.cashierId = session.userId
        // ...and never the deleted ones. Only the owner can delete an invoice, so
        // reviewing what was deleted is a management question, not a till one.
        filters.deleted = 'exclude'
      }
      return { success: true, data: order.listOrders(filters) }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  handle('order:get', async (_e, { orderId }): Promise<IpcResponse> => {
    try {
      requireAnyAuth()
      return { success: true, data: order.getOrderWithItems(orderId) }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })
}
