/**
 * The network channels.
 *
 * Every one of these is `handleLocal`, so none of them is ever forwarded. That is
 * deliberate: a till asking "what is my mode" or "stop being a node" is talking about
 * the machine in front of the owner, not about the master. Forwarded, those would
 * report the master's state and reconfigure the master — and a node could never be
 * turned back into a standalone till, because the instruction to stop being a node
 * would be sent to the very machine it was trying to stop talking to.
 *
 * The shape of this file follows the shape of the system: almost everything here is
 * something the MASTER does, because the master is now the only machine anybody has
 * to configure.
 */

import { app } from 'electron'
import log from 'electron-log/main'
import { handleLocal } from '../net/router'
import { requireRole } from '../services/authService'
import { getSettings, updateSettings } from '../services/settingsService'
import { getDb } from '../db/db'
import { isServerRunning, tillPort } from '../net/tillServer'
import { lanAddresses, discoverDevices } from '../net/discovery'
import { localIdentity } from '../net/identity'
import {
  adoptTill, dropTill, commandTill, tillSummaries, connectedTillCount,
  ensureFleetIdentity,
} from '../net/masterLink'
import { nodeLinkStatus } from '../net/nodeLink'
import { applyNetworkMode } from '../net/mode'
import { runDailyBackup, backupHealth } from '../services/backupScheduler'
import type { NodeCommand } from '../net/protocol'
import type { IpcResponse, NetworkStatus } from '../../shared/types'

export { applyNetworkMode }

function status(): NetworkStatus {
  const s = getSettings()
  const me = localIdentity()
  const base: NetworkStatus = {
    mode: s.net_mode,
    running: isServerRunning(),
    port: isServerRunning() ? tillPort() : s.net_port,
    addresses: lanAddresses(),
    machineName: me.machineName,
    appVersion: me.appVersion,
  }

  if (s.net_mode === 'master') {
    return { ...base, tills: tillSummaries(), connectedNodes: connectedTillCount() }
  }
  if (s.net_mode === 'node') {
    const link = nodeLinkStatus()
    return {
      ...base,
      linked: link.linked,
      masterName: link.masterName,
      masterAddress: link.masterAddress,
      reason: link.reason,
      locked: link.locked,
      lockReason: link.lockReason,
      mirror: link.mirror,
      masterTimeOffsetMs: link.masterTimeOffsetMs,
    }
  }
  return base
}

export function registerNetworkIpc(): void {
  handleLocal('net:status', async (): Promise<IpcResponse> => {
    try {
      requireRole('owner')
      return { success: true, data: status() }
    } catch (err: any) { return { success: false, error: err.message } }
  })

  /**
   * Choose this machine's role.
   *
   * There is no address and no token to fill in any more. A master makes its own
   * secret; a node is given one when it is adopted. The only decision left is which
   * of the three things this machine is.
   */
  handleLocal('net:setMode', async (_e, data): Promise<IpcResponse> => {
    try {
      requireRole('owner')
      const { mode, port } = data ?? {}
      if (!['standalone', 'master', 'node'].includes(mode)) {
        return { success: false, error: 'وضع الشبكة غير صحيح' }
      }

      // Becoming a node by hand means forgetting whoever owned this till before,
      // otherwise it would sit waiting for a master that is never going to dial.
      const patch: Record<string, unknown> = {
        net_mode: mode,
        net_port: Number(port) || 47615,
      }
      // Choosing either of these by hand means "this machine does not own the books",
      // so it stops being anybody's master and lets go of everything a master holds.
      //
      // Letting go of the TOKEN is the part that matters. A machine switched to
      // master mints one for itself; if that survived a switch back to node, the till
      // would hold a secret no master knew, refuse every enrolment as "already linked
      // to another master", and be impossible to add to anything ever again. A till
      // that has just been told it is a follower has no master yet — so it waits to
      // be adopted by whoever asks, which is the whole point of the mode.
      if (mode === 'standalone' || mode === 'node') {
        patch.net_tills = '[]'
        patch.net_token = ''
        patch.net_fleet_id = ''
        patch.net_master_name = ''
        // And it is nobody's to lock any more.
        patch.net_locked = 0
        patch.net_lock_reason = ''
      }
      updateSettings(patch as never)

      if (mode === 'master') ensureFleetIdentity()
      await applyNetworkMode()
      log.info(`[Net] Mode set to ${mode}`)
      return { success: true, data: status() }
    } catch (err: any) {
      log.error('[IPC] net:setMode error:', err)
      return { success: false, error: err.message }
    }
  })

  /**
   * Sweep the LAN for tills and network printers.
   *
   * Local-only, like the rest of this file: the owner is asking what THIS machine can
   * see. Forwarded to the master it would report the master's view of the network,
   * which is not the question — and would not help someone standing at a node trying
   * to work out why it cannot see anything.
   */
  handleLocal('net:discover', async (): Promise<IpcResponse> => {
    try {
      requireRole('owner')
      const s = getSettings()
      const found = await discoverDevices(s.net_port)
      return { success: true, data: { ...found, mode: s.net_mode } }
    } catch (err: any) {
      log.error('[IPC] net:discover error:', err)
      return { success: false, error: err.message }
    }
  })

  /**
   * Take a till on. One press, at the master, and the other machine needs nobody
   * standing at it — which is the entire point of the master doing the dialling.
   */
  handleLocal('net:adopt', async (_e, { host, port }): Promise<IpcResponse> => {
    try {
      requireRole('owner')
      const target = String(host || '').trim()
      if (!target) return { success: false, error: 'اختر الجهاز أولاً' }

      // Adopting is what makes a machine a master; making the owner pick the mode
      // first is the step they should not have to think about.
      if (getSettings().net_mode === 'node') {
        return { success: false, error: 'هذا الجهاز تابع — أضف الأجهزة من الجهاز الرئيسي' }
      }
      if (getSettings().net_mode !== 'master') {
        updateSettings({ net_mode: 'master' } as never)
        ensureFleetIdentity()
        await applyNetworkMode()
        log.info('[Net] Became master because the owner adopted a till')
      }

      const result = await adoptTill(target, Number(port) || 47615)
      return result.success ? { success: true, data: status() } : result
    } catch (err: any) {
      log.error('[IPC] net:adopt error:', err)
      return { success: false, error: err.message }
    }
  })

  handleLocal('net:drop', async (_e, { tillId }): Promise<IpcResponse> => {
    try {
      requireRole('owner')
      const result = await dropTill(String(tillId || ''))
      return result.success ? { success: true, data: status() } : result
    } catch (err: any) { return { success: false, error: err.message } }
  })

  /**
   * Do something to a till from here: sign its cashier out, lock it, wake it up,
   * restart it. The commands themselves are defined in net/protocol.ts.
   */
  handleLocal('net:command', async (_e, { tillId, command }): Promise<IpcResponse> => {
    try {
      requireRole('owner')
      const cmd = command as NodeCommand
      if (!cmd?.kind) return { success: false, error: 'أمر غير معروف' }
      // Printing and session mirroring are the system talking to itself, not
      // something to expose as a button.
      if (cmd.kind === 'print' || cmd.kind === 'session') {
        return { success: false, error: 'هذا الأمر غير متاح يدوياً' }
      }
      const result = await commandTill(String(tillId || ''), cmd)
      log.info(`[Net] Command "${cmd.kind}" → till ${tillId}: ${result.success ? 'ok' : result.error}`)
      return result
    } catch (err: any) {
      log.error('[IPC] net:command error:', err)
      return { success: false, error: err.message }
    }
  })

  /**
   * What is actually in THIS machine's database.
   *
   * Shown next to the mode buttons, because "which machine should be the master" is
   * the one decision here that cannot be undone by pressing a different button — the
   * master is whichever machine owns the books, and every other till then trades on
   * its data. A shop once set the wrong machine as master and would have run the
   * night on a scratch database holding two menu items and no stock. Nothing was
   * destroyed, but nothing was right either, and there was nothing on the screen to
   * suggest anything was wrong.
   *
   * Deliberately local, and deliberately NOT part of /health: what a shop has sold is
   * nobody else's business, and /health is unauthenticated.
   */
  handleLocal('net:booksSummary', async (): Promise<IpcResponse> => {
    try {
      requireRole('owner')
      const db = getDb()
      const one = (sql: string): any => { try { return db.prepare(sql).get() } catch { return {} } }
      const orders = one(
        'SELECT COUNT(*) n, MIN(date(created_at)) first, MAX(date(created_at)) last FROM orders WHERE deleted_at IS NULL')
      return {
        success: true,
        data: {
          orders: orders?.n ?? 0,
          firstOrder: orders?.first ?? null,
          lastOrder: orders?.last ?? null,
          menuItems: one('SELECT COUNT(*) n FROM menu_items')?.n ?? 0,
          rawMaterials: one('SELECT COUNT(*) n FROM raw_materials')?.n ?? 0,
        },
      }
    } catch (err: any) { return { success: false, error: err.message } }
  })

  handleLocal('net:localAddresses', async (): Promise<IpcResponse> => {
    try {
      requireRole('owner')
      return { success: true, data: { addresses: lanAddresses(), version: app.getVersion() } }
    } catch (err: any) { return { success: false, error: err.message } }
  })

  // ===== Backups =====

  /** How the nightly backup is doing, and which machines hold last night's copy. */
  handleLocal('net:backupHealth', async (): Promise<IpcResponse> => {
    try {
      requireRole('owner')
      return { success: true, data: backupHealth() }
    } catch (err: any) { return { success: false, error: err.message } }
  })

  /** Run tonight's backup now — and push it to the tills — without waiting for 3am. */
  handleLocal('net:backupNow', async (): Promise<IpcResponse> => {
    try {
      requireRole('owner')
      if (getSettings().net_mode === 'node') {
        return { success: false, error: 'النسخ الاحتياطي يعمل على الجهاز الرئيسي' }
      }
      const result = await runDailyBackup('manual')
      return result.ok ? { success: true, data: backupHealth() } : { success: false, error: result.error }
    } catch (err: any) { return { success: false, error: err.message } }
  })

  handleLocal('net:setBackupHour', async (_e, { hour }): Promise<IpcResponse> => {
    try {
      requireRole('owner')
      const h = Number(hour)
      if (!Number.isInteger(h) || h < 0 || h > 23) {
        return { success: false, error: 'الساعة يجب أن تكون بين 0 و 23' }
      }
      updateSettings({ backup_hour: h } as never)
      log.info(`[Backup] Nightly backup moved to ${h}:00`)
      return { success: true, data: backupHealth() }
    } catch (err: any) { return { success: false, error: err.message } }
  })
}
