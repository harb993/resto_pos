import { ipcMain } from 'electron'
import { handle } from '../net/router'
import * as salary from '../services/salaryService'
import { requireOwnerOrAccountant, requireRole } from '../services/authService'
import log from 'electron-log/main'
import type { IpcResponse } from '../../shared/types'

export function registerSalaryIpc(): void {
  // Paying the daily workers is the accountant's job, not just the owner's — both
  // can record a payment, and the row keeps whoever entered it in created_by.
  handle('salaries:upsert', async (_e, data): Promise<IpcResponse> => {
    try {
      const session = requireOwnerOrAccountant()
      const result = salary.upsertSalary(
        data.workerId, data.amount, data.periodStart,
        data.periodEnd, data.paidOn || null, session.userId, data.salaryId
      )
      return { success: true, data: result }
    } catch (err: any) {
      log.error('[IPC] salaries:upsert error:', err)
      return { success: false, error: err.message }
    }
  })

  handle('salaries:list', async (_e, filters = {}): Promise<IpcResponse> => {
    try {
      requireOwnerOrAccountant()
      return { success: true, data: salary.listSalaries(filters) }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // Removing a payment record changes the wage bill, so it stays with the owner.
  handle('salaries:delete', async (_e, { salaryId }): Promise<IpcResponse> => {
    try {
      requireRole('owner')
      salary.deleteSalary(salaryId)
      return { success: true }
    } catch (err: any) {
      log.error('[IPC] salaries:delete error:', err)
      return { success: false, error: err.message }
    }
  })
}
