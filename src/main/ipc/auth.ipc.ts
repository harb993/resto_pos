import { ipcMain } from 'electron'
import * as auth from '../services/authService'
import log from 'electron-log/main'
import type { IpcResponse } from '../../shared/types'

export function registerAuthIpc(): void {
  ipcMain.handle('auth:login', async (_e, { username, password }): Promise<IpcResponse> => {
    try {
      const result = auth.login(username, password)
      return { success: result.success, data: result.user, error: result.error }
    } catch (err: any) {
      log.error('[IPC] auth:login error:', err)
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('auth:loginByPin', async (_e, { pin }): Promise<IpcResponse> => {
    try {
      const result = auth.loginByPin(pin)
      return { success: result.success, data: result.user, error: result.error }
    } catch (err: any) {
      log.error('[IPC] auth:loginByPin error:', err)
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('auth:logout', async (): Promise<IpcResponse> => {
    auth.logout()
    return { success: true }
  })

  ipcMain.handle('auth:getSession', async (): Promise<IpcResponse> => {
    return { success: true, data: auth.getCurrentSession() }
  })

  ipcMain.handle('auth:verifyOwnerPin', async (_e, { pin }): Promise<IpcResponse> => {
    return { success: auth.verifyOwnerPin(pin) }
  })

  ipcMain.handle('auth:createUser', async (_e, data): Promise<IpcResponse> => {
    try {
      auth.requireRole('owner')
      const result = auth.createUser(data.username, data.password, data.pin, data.role, data.fullName)
      return { success: result.success, data: { userId: result.userId }, error: result.error }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('auth:listUsers', async (): Promise<IpcResponse> => {
    try {
      auth.requireRole('owner')
      return { success: true, data: auth.listUsers() }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('auth:toggleUserActive', async (_e, { userId, isActive }): Promise<IpcResponse> => {
    try {
      auth.requireRole('owner')
      auth.toggleUserActive(userId, isActive)
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('auth:resetPin', async (_e, { userId, newPin }): Promise<IpcResponse> => {
    try {
      auth.requireRole('owner')
      auth.resetUserPin(userId, newPin)
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })
}
