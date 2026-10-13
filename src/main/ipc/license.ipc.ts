import { handleLocal } from '../net/router'
import { applyNetworkMode } from './network.ipc'
import * as license from '../services/licenseService'
import log from 'electron-log/main'
import type { IpcResponse } from '../../shared/types'

/**
 * Registered LOCAL on purpose. A node asking whether it is licensed is asking about
 * the machine in front of the cashier, not the master — forwarded, every node in the
 * shop would inherit the master's activation and the licence would protect one PC
 * instead of each of them.
 *
 * These are also the only channels that answer before activation; everything else is
 * refused by the guard in net/router.ts.
 */
export function registerLicenseIpc(): void {
  handleLocal('license:status', async (): Promise<IpcResponse> => {
    return { success: true, data: license.getLicenseStatus() }
  })

  handleLocal('license:activate', async (_e, { key }): Promise<IpcResponse> => {
    try {
      const result = license.activate(key)

      // Startup skipped networking on an unactivated machine, so bring it up now
      // rather than making the owner restart the till to finish commissioning it.
      if (result.success) {
        try {
          await applyNetworkMode()
        } catch (err) {
          log.warn('[License] Network mode failed to start after activation:', err)
        }
      }

      return { success: result.success, data: result.status, error: result.error }
    } catch (err: any) {
      log.error('[IPC] license:activate error:', err)
      return { success: false, error: err.message }
    }
  })
}
