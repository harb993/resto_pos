import { ipcMain } from 'electron'
import { handle } from '../net/router'
import * as customers from '../services/customerService'
import { requireAnyAuth, requireOwnerOrAccountant } from '../services/authService'
import type { IpcResponse } from '../../shared/types'

export function registerCustomerIpc(): void {
  // The cashier needs the lookup to fill a repeat customer's details at the till;
  // the full book and its takings are for the owner and accountant.
  handle('customers:byPhone', async (_e, { phone }): Promise<IpcResponse> => {
    try {
      requireAnyAuth()
      return { success: true, data: customers.getCustomerByPhone(phone) ?? null }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  handle('customers:list', async (_e, filters = {}): Promise<IpcResponse> => {
    try {
      requireOwnerOrAccountant()
      return { success: true, data: customers.listCustomers(filters) }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  handle('customers:orders', async (_e, { phone, limit }): Promise<IpcResponse> => {
    try {
      requireOwnerOrAccountant()
      return { success: true, data: customers.getCustomerOrders(phone, limit) }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  handle('customers:stats', async (): Promise<IpcResponse> => {
    try {
      requireOwnerOrAccountant()
      return { success: true, data: customers.getCustomerStats() }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })
}
