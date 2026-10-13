import { ipcMain } from 'electron'
import { handle } from '../net/router'
import * as expense from '../services/expenseService'
import { requireAnyAuth, requireRole } from '../services/authService'
import log from 'electron-log/main'
import type { IpcResponse } from '../../shared/types'

export function registerExpenseIpc(): void {
  handle('expenses:add', async (_e, data): Promise<IpcResponse> => {
    try {
      const session = requireAnyAuth()  // cashiers can add too
      const result = expense.addExpense(
        data.category, data.description, data.amount,
        session.userId, data.expenseDate
      )
      return { success: true, data: result }
    } catch (err: any) {
      log.error('[IPC] expenses:add error:', err)
      return { success: false, error: err.message }
    }
  })

  handle('expenses:list', async (_e, filters = {}): Promise<IpcResponse> => {
    try {
      requireAnyAuth()
      return { success: true, data: expense.listExpenses(filters) }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  handle('expenses:delete', async (_e, { expenseId }): Promise<IpcResponse> => {
    try {
      requireRole('owner')  // only owner can delete
      expense.deleteExpense(expenseId)
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })
}
