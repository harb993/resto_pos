import { ipcMain } from 'electron'
import { handle } from '../net/router'
import * as attendance from '../services/workerAttendanceService'
import { requireRole, requireOwnerOrAccountant } from '../services/authService'
import type { IpcResponse } from '../../shared/types'

export function registerWorkerAttendanceIpc(): void {
  handle('workerAttendance:mark', async (_e, data): Promise<IpcResponse> => {
    try {
      const session = requireRole('owner')
      const result = attendance.markAttendance(
        data.workerId, data.workDate, session.userId, data.shiftNumber
      )
      return { success: true, data: result }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  handle('workerAttendance:unmark', async (_e, data): Promise<IpcResponse> => {
    try {
      requireRole('owner')
      attendance.unmarkAttendance(data.workerId, data.workDate)
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // Marking attendance is the owner's call; the accountant only reads it, because
  // the days worked are what a salary payment is calculated from.
  handle('workerAttendance:list', async (_e, data): Promise<IpcResponse> => {
    try {
      requireOwnerOrAccountant()
      return { success: true, data: attendance.listAttendance(data.workerId, data.dateFrom, data.dateTo) }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  handle('workerAttendance:count', async (_e, data): Promise<IpcResponse> => {
    try {
      requireOwnerOrAccountant()
      return { success: true, data: attendance.countAttendance(data.workerId, data.dateFrom, data.dateTo) }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })
}
