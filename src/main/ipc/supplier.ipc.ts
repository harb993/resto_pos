import log from 'electron-log/main'
import { handle } from '../net/router'
import * as suppliers from '../services/supplierService'
import { requireOwnerOrAccountant, requireRole } from '../services/authService'
import { broadcastStockChanged } from './broadcast'
import { printSupplierInvoice } from '../services/printerService'
import type { IpcResponse } from '../../shared/types'

/**
 * Buying goods is the owner's and the accountant's business, never the cashier's —
 * these screens show what the restaurant owes and let money be recorded as paid.
 * Editing the supplier list itself is owner-only.
 */
export function registerSupplierIpc(): void {
  handle('suppliers:list', async (_e, { includeInactive } = {}): Promise<IpcResponse> => {
    try {
      requireOwnerOrAccountant()
      return { success: true, data: suppliers.listSuppliers(includeInactive === true) }
    } catch (err: any) { return { success: false, error: err.message } }
  })

  handle('suppliers:summary', async (): Promise<IpcResponse> => {
    try {
      requireOwnerOrAccountant()
      return { success: true, data: suppliers.getSuppliersSummary() }
    } catch (err: any) { return { success: false, error: err.message } }
  })

  handle('suppliers:account', async (_e, { supplierId }): Promise<IpcResponse> => {
    try {
      requireOwnerOrAccountant()
      return { success: true, data: suppliers.getSupplierAccount(supplierId) }
    } catch (err: any) { return { success: false, error: err.message } }
  })

  handle('suppliers:upsert', async (_e, data): Promise<IpcResponse> => {
    try {
      requireRole('owner')
      return { success: true, data: suppliers.upsertSupplier(data) }
    } catch (err: any) {
      log.error('[IPC] suppliers:upsert error:', err)
      return { success: false, error: err.message }
    }
  })

  handle('suppliers:delete', async (_e, { supplierId }): Promise<IpcResponse> => {
    try {
      requireRole('owner')
      suppliers.deleteSupplier(supplierId)
      return { success: true }
    } catch (err: any) { return { success: false, error: err.message } }
  })

  /**
   * Recording a delivery moves stock, so every screen showing a material balance is
   * told — the same announcement a sale or a prep run makes.
   */
  handle('suppliers:recordDelivery', async (_e, data): Promise<IpcResponse> => {
    try {
      const session = requireOwnerOrAccountant()
      const invoice = suppliers.recordDelivery(data, session.userId)
      broadcastStockChanged('supplier-delivery')
      return { success: true, data: invoice }
    } catch (err: any) {
      log.error('[IPC] suppliers:recordDelivery error:', err)
      return { success: false, error: err.message }
    }
  })

  handle('suppliers:recordPayment', async (_e, data): Promise<IpcResponse> => {
    try {
      const session = requireOwnerOrAccountant()
      return { success: true, data: suppliers.recordPayment(data, session.userId) }
    } catch (err: any) {
      log.error('[IPC] suppliers:recordPayment error:', err)
      return { success: false, error: err.message }
    }
  })

  handle('suppliers:deletePayment', async (_e, { paymentId }): Promise<IpcResponse> => {
    try {
      requireRole('owner')
      suppliers.deletePayment(paymentId)
      return { success: true }
    } catch (err: any) { return { success: false, error: err.message } }
  })

  /** Two copies on the cashier's printer — one for the supplier, one for us. */
  handle('suppliers:printInvoice', async (_e, { invoiceId, reprint }): Promise<IpcResponse> => {
    try {
      requireOwnerOrAccountant()
      const results = await printSupplierInvoice(invoiceId, { reprint: reprint === true })
      return { success: true, data: results }
    } catch (err: any) {
      log.error('[IPC] suppliers:printInvoice error:', err)
      return { success: false, error: err.message }
    }
  })

  handle('suppliers:invoice', async (_e, { invoiceId }): Promise<IpcResponse> => {
    try {
      requireOwnerOrAccountant()
      return { success: true, data: suppliers.getInvoice(invoiceId) }
    } catch (err: any) { return { success: false, error: err.message } }
  })
}
