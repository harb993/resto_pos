import { ipcMain } from 'electron'
import { handle } from '../net/router'
import * as auth from '../services/authService'
import * as shifts from '../services/shiftService'
import log from 'electron-log/main'
import type { IpcResponse } from '../../shared/types'

export function registerAuthIpc(): void {
  handle('auth:login', async (_e, { username, password }): Promise<IpcResponse> => {
    try {
      const result = auth.login(username, password)
      // Signing in IS the start of the shift — the hours come from this, not from
      // anyone entering them by hand.
      if (result.success && result.user) {
        try {
          shifts.startSession(result.user.userId)
        } catch (err) {
          // Never block someone from working because the clock-in failed.
          log.error('[IPC] Failed to open shift session on login:', err)
        }
      }
      return { success: result.success, data: result.user, error: result.error }
    } catch (err: any) {
      log.error('[IPC] auth:login error:', err)
      return { success: false, error: err.message }
    }
  })

  handle('auth:logout', async (): Promise<IpcResponse> => {
    const session = auth.getCurrentSession()
    if (session) {
      try {
        shifts.endSession(session.userId)
      } catch (err) {
        log.error('[IPC] Failed to close shift session on logout:', err)
      }
    }
    auth.logout()
    return { success: true }
  })

  handle('auth:getSession', async (): Promise<IpcResponse> => {
    return { success: true, data: auth.getCurrentSession() }
  })

  // The override a cashier needs to void an invoice. Password-based — there are no
  // PINs in the system any more.
  handle('auth:verifyOwnerPassword', async (_e, { password }): Promise<IpcResponse> => {
    try {
      // Only a signed-in user can be prompted for an override in the first place.
      auth.requireAnyAuth()
      return { success: auth.verifyOwnerPassword(password) }
    } catch (err: any) {
      // Surfaces the lockout message when the override has been hammered.
      return { success: false, error: err.message }
    }
  })

  handle('auth:defaultCredentialWarnings', async (): Promise<IpcResponse> => {
    try {
      auth.requireAnyAuth()
      return { success: true, data: auth.getDefaultCredentialWarnings() }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  handle('auth:changeOwnPassword', async (_e, { currentPassword, newPassword }): Promise<IpcResponse> => {
    try {
      auth.requireAnyAuth()
      auth.changeOwnPassword(currentPassword, newPassword)
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  handle('auth:listUsers', async (): Promise<IpcResponse> => {
    try {
      auth.requireRole('owner')
      return { success: true, data: auth.listUsers() }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  handle('auth:toggleUserActive', async (_e, { userId, isActive }): Promise<IpcResponse> => {
    try {
      auth.requireRole('owner')
      auth.toggleUserActive(userId, isActive)
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // Owner edits one of the four fixed accounts — the person holding it and their
  // login. Used to hand a slot to a different cashier without creating a new account.
  handle('auth:updateUserAccount', async (_e, data): Promise<IpcResponse> => {
    try {
      auth.requireRole('owner')
      auth.updateUserAccount(data.userId, {
        username: data.username,
        fullName: data.fullName,
        password: data.password,
      })
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })
}
