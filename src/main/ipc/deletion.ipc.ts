import { ipcMain } from 'electron'
import { handle } from '../net/router'
import { getDeleteImpact, deleteEntity } from '../services/deletionService'
import { requireRole, verifyOwnerPassword } from '../services/authService'
import { broadcastStockChanged } from './broadcast'
import log from 'electron-log/main'
import type { IpcResponse } from '../../shared/types'

export function registerDeletionIpc(): void {
  // Read-only: what would happen if this were deleted. Always called first so the
  // owner sees the consequences before deciding.
  handle('deletion:impact', async (_e, { kind, id }): Promise<IpcResponse> => {
    try {
      requireRole('owner')
      return { success: true, data: getDeleteImpact(kind, id) }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  handle('deletion:delete', async (_e, { kind, id, force, ownerPassword }): Promise<IpcResponse> => {
    try {
      requireRole('owner')

      // Forcing erases records that past invoices point at, so it needs the password
      // re-entered — being signed in on an unattended till is not the same as
      // deciding to rewrite last month's figures.
      if (force) {
        if (!ownerPassword || !verifyOwnerPassword(ownerPassword)) {
          return { success: false, error: 'كلمة مرور المدير غير صحيحة' }
        }
      }

      const result = deleteEntity(kind, id, { force: !!force })
      // Menu items and materials both affect what the stock screens show.
      broadcastStockChanged('deletion')
      return { success: true, data: result }
    } catch (err: any) {
      log.error('[IPC] deletion:delete error:', err)
      return { success: false, error: err.message }
    }
  })
}
