import { ipcMain } from 'electron'
import { handle } from '../net/router'
import * as worker from '../services/workerService'
import { requireRole, requireOwnerOrAccountant } from '../services/authService'
import type { IpcResponse } from '../../shared/types'

export function registerWorkerIpc(): void {
  handle('workers:upsert', async (_e, data): Promise<IpcResponse> => {
    try {
      requireRole('owner')
      const result = worker.upsertWorker(
        data.fullName, data.roleTitle, data.isActive ?? 1,
        data.linkedUserId || null, data.workerId, data.dailyWage ?? 0,
        // The screen has always offered "الوردية المعتادة" and this call has always
        // dropped it on the floor, so the choice silently reset to none on every save.
        data.defaultShift ?? null,
      )
      return { success: true, data: result }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // Days present × daily wage — what the salary screen proposes for a pay period.
  handle('workers:payForPeriod', async (_e, { workerId, dateFrom, dateTo }): Promise<IpcResponse> => {
    try {
      requireOwnerOrAccountant()
      return { success: true, data: worker.getWorkerPayForPeriod(workerId, dateFrom, dateTo) }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // The accountant needs to read the roster and the wages to pay people; only the
  // owner hires, edits or sets a wage.
  handle('workers:list', async (): Promise<IpcResponse> => {
    try {
      requireOwnerOrAccountant()
      return { success: true, data: worker.listWorkers() }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })
}
