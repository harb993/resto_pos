import { ipcMain } from 'electron'
import * as settings from '../services/settingsService'
import { runBackup } from '../db/db'
import { requireRole } from '../services/authService'
import type { IpcResponse } from '../../shared/types'

export function registerSettingsIpc(): void {
  ipcMain.handle('settings:get', async (): Promise<IpcResponse> => {
    try { return { success: true, data: settings.getSettings() } }
    catch (err: any) { return { success: false, error: err.message } }
  })

  ipcMain.handle('settings:update', async (_e, data): Promise<IpcResponse> => {
    try {
      requireRole('owner')
      settings.updateSettings(data)
      return { success: true }
    } catch (err: any) { return { success: false, error: err.message } }
  })

  ipcMain.handle('app:backup', async (): Promise<IpcResponse> => {
    try {
      requireRole('owner')
      const path = await runBackup()
      return { success: true, data: { path } }
    } catch (err: any) { return { success: false, error: err.message } }
  })
}
