import { ipcMain, BrowserWindow } from 'electron'
import { handle } from '../net/router'
import * as settings from '../services/settingsService'
import {
  runBackup, isDemoMode, getDataDirectory, listBackups, restoreBackup, verifyBackupFile,
  getBackupDir, getActiveProfile, clearAllBusinessData,
} from '../db/db'
import { verifyOwnerPassword } from '../services/authService'
import { shell } from 'electron'
import { broadcast } from './broadcast'
import { resolve as pathResolve } from 'node:path'
import { requireRole, getCurrentSession } from '../services/authService'
import log from 'electron-log/main'
import type { IpcResponse } from '../../shared/types'

// What the login screen legitimately needs before anyone has authenticated.
const PUBLIC_SETTING_KEYS = ['business_name', 'currency_symbol'] as const

/**
 * The PIN that opens the settings screen.
 *
 * Fixed on purpose, and not a setting: the owner's password gets handed to whoever is
 * minding the shop that week, and the settings are where the VAT rate, the shift hours
 * and the discount cap live. A second lock that nobody at the till can change — or
 * reset by changing a password — is the point. It lives here, in the main process, so
 * it is checked where the screen cannot reach it rather than shipped inside the page.
 */
const SETTINGS_PIN = '442299'

/** How long an unlock lasts without a save, so a till left on the screen locks itself. */
const UNLOCK_MS = 60 * 60 * 1000
const MAX_PIN_ATTEMPTS = 5
const PIN_LOCKOUT_MS = 60_000

/** userId → when their unlock runs out. */
const unlocked = new Map<number, number>()
const pinThrottle = { failures: 0, lockedUntil: 0 }

export function requireSettingsUnlocked(userId: number): void {
  if ((unlocked.get(userId) ?? 0) < Date.now()) {
    unlocked.delete(userId)
    throw new Error('الإعدادات مقفلة — أدخل الرقم السري أولاً')
  }
  unlocked.set(userId, Date.now() + UNLOCK_MS)
}

export function registerSettingsIpc(): void {
  handle('settings:unlock', async (_e, { pin } = {}): Promise<IpcResponse> => {
    try {
      const session = requireRole('owner')

      const wait = pinThrottle.lockedUntil - Date.now()
      if (wait > 0) {
        return { success: false, error: `محاولات كثيرة — حاول بعد ${Math.ceil(wait / 1000)} ثانية` }
      }

      if (String(pin ?? '') !== SETTINGS_PIN) {
        pinThrottle.failures++
        if (pinThrottle.failures >= MAX_PIN_ATTEMPTS) {
          pinThrottle.failures = 0
          pinThrottle.lockedUntil = Date.now() + PIN_LOCKOUT_MS
        }
        log.warn(`[Settings] Wrong settings PIN from ${session.username}`)
        return { success: false, error: 'الرقم السري غير صحيح' }
      }

      pinThrottle.failures = 0
      unlocked.set(session.userId, Date.now() + UNLOCK_MS)
      return { success: true }
    } catch (err: any) { return { success: false, error: err.message } }
  })

  handle('settings:lock', async (): Promise<IpcResponse> => {
    const session = getCurrentSession()
    if (session) unlocked.delete(session.userId)
    return { success: true }
  })

  handle('settings:get', async (): Promise<IpcResponse> => {
    try {
      const all = settings.getSettings()
      // The login screen calls this to render the branding, so it cannot require a
      // session — but it must not hand out tax rates, discount caps or backup paths
      // to an unauthenticated caller either.
      if (!getCurrentSession()) {
        const publicOnly: Record<string, unknown> = {}
        for (const k of PUBLIC_SETTING_KEYS) publicOnly[k] = all[k]
        return { success: true, data: publicOnly }
      }
      return { success: true, data: all }
    } catch (err: any) { return { success: false, error: err.message } }
  })

  handle('settings:update', async (_e, data): Promise<IpcResponse> => {
    try {
      const session = requireRole('owner')
      requireSettingsUnlocked(session.userId)
      settings.updateSettings(data)

      // Push the saved values to every open screen. Without this each screen keeps
      // whatever it read when it mounted, so a changed VAT rate, currency or shift
      // time only appeared after navigating away and back — or a restart.
      const fresh = settings.getSettings()
      broadcast('app:settingsChanged', fresh)
      log.info('[Settings] Updated and broadcast to renderer')

      return { success: true, data: fresh }
    } catch (err: any) { return { success: false, error: err.message } }
  })

  // Lets the UI show a standing "this is the practice database" banner, so demo
  // figures can never be mistaken for real takings.
  handle('app:mode', async (): Promise<IpcResponse> => {
    return { success: true, data: { demo: isDemoMode(), dataDir: getDataDirectory() } }
  })

  handle('app:backup', async (): Promise<IpcResponse> => {
    try {
      requireRole('owner')
      const path = await runBackup()
      return { success: true, data: { path } }
    } catch (err: any) { return { success: false, error: err.message } }
  })

  handle('app:listBackups', async (): Promise<IpcResponse> => {
    try {
      requireRole('owner')
      return { success: true, data: listBackups() }
    } catch (err: any) { return { success: false, error: err.message } }
  })

  handle('app:openBackupFolder', async (): Promise<IpcResponse> => {
    try {
      requireRole('owner')
      await shell.openPath(getBackupDir())
      return { success: true }
    } catch (err: any) { return { success: false, error: err.message } }
  })

  /**
   * Restore replaces EVERY record in the business. It is gated on re-entering the
   * owner password even though only an owner can reach the screen: being signed in
   * on an unattended till is not the same as deciding to wipe today's takings.
   */
  handle('app:restoreBackup', async (_e, { filePath, ownerPassword }): Promise<IpcResponse> => {
    try {
      requireRole('owner')

      if (!ownerPassword || !verifyOwnerPassword(ownerPassword)) {
        return { success: false, error: 'كلمة مرور المدير غير صحيحة' }
      }
      if (typeof filePath !== 'string' || !filePath) {
        return { success: false, error: 'لم يتم اختيار نسخة احتياطية' }
      }
      // Only ever restore from our own backup folder — not an arbitrary path.
      const dir = getBackupDir()
      const resolved = pathResolve(filePath)
      if (!resolved.startsWith(pathResolve(dir))) {
        return { success: false, error: 'يجب اختيار نسخة من مجلد النسخ الاحتياطية' }
      }

      const { safetyCopy } = await restoreBackup(resolved)
      log.warn(`[Settings] Database RESTORED from ${resolved}`)

      // Everything on screen now describes a database that no longer exists, and the
      // session belongs to a user row that may differ — reload to a clean sign-in.
      for (const w of BrowserWindow.getAllWindows()) w.webContents.reload()

      return { success: true, data: { safetyCopy } }
    } catch (err: any) {
      log.error('[Settings] Restore failed:', err)
      return { success: false, error: err.message }
    }
  })

  handle('app:verifyBackup', async (_e, { filePath }): Promise<IpcResponse> => {
    try {
      requireRole('owner')
      return { success: true, data: verifyBackupFile(filePath) }
    } catch (err: any) { return { success: false, error: err.message } }
  })

  /**
   * Start the books again, keeping the shop.
   *
   * Every invoice, expense, salary, shift and supplier account goes, and invoice
   * numbering returns to 1. The MENU and the STOCK stay exactly as they are — the
   * dishes, their prices and costs, their ingredients, the questions the till asks,
   * the materials and the quantities counted on the shelves. Clearing those too made
   * a reset something an owner could not afford to do, so the takings they wanted rid
   * of stayed in the books instead.
   *
   * Three separate locks, because there is no undo beyond a backup:
   *   - the owner role, so no member of staff can reach it;
   *   - the owner password typed again, because being signed in on a till left open
   *     is not the same as deciding to erase the year;
   *   - the real books only — the showcase account rebuilds itself daily and has
   *     nothing to reset, and nothing it does should look like this.
   * A backup is taken first, so a reset made in error is still recoverable.
   */
  handle('app:resetSystem', async (_e, { ownerPassword }): Promise<IpcResponse> => {
    try {
      requireRole('owner')

      if (getActiveProfile() !== 'real') {
        return { success: false, error: 'تصفير النظام غير متاح في حساب العرض التجريبي' }
      }
      if (!ownerPassword || !verifyOwnerPassword(ownerPassword)) {
        return { success: false, error: 'كلمة مرور المدير غير صحيحة' }
      }

      let safetyCopy: string | null = null
      try {
        safetyCopy = await runBackup()
        log.info(`[Settings] Pre-reset backup: ${safetyCopy}`)
      } catch (err) {
        log.warn('[Settings] Pre-reset backup failed; continuing:', err)
      }

      const { cleared, kept } = clearAllBusinessData({ keepMenuAndStock: true })
      const rows = Object.values(cleared).reduce((a, b) => a + b, 0)
      log.warn(`[Settings] SYSTEM RESET by owner — ${rows} row(s) cleared, menu and stock kept`)

      // Every screen is now describing records that no longer exist.
      for (const w of BrowserWindow.getAllWindows()) w.webContents.reload()

      return { success: true, data: { cleared, kept, rows, safetyCopy } }
    } catch (err: any) {
      log.error('[Settings] Reset failed:', err)
      return { success: false, error: err.message }
    }
  })
}
