import { app, BrowserWindow, dialog, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import log from 'electron-log/main'
import { handle } from '../net/router'
import { requireRole } from '../services/authService'
import { requireSettingsUnlocked } from './settings.ipc'
import { runBackup, getDb } from '../db/db'
import { getSettings } from '../services/settingsService'
import {
  currentShopDataCounts, exportShopDataTo, importShopData, parseShopData, countShopData,
  type ShopDataPackage,
} from '../services/shopDataService'
import { broadcast } from './broadcast'
import type { IpcResponse } from '../../shared/types'

/**
 * Exporting and importing the shop's own data — the «تصدير البيانات» tab.
 *
 * All of it is the owner's, and the two that change anything also need the settings
 * PIN: an import rewrites the settings, so it sits behind the same lock they do.
 *
 * The file to import is chosen in one call and applied in the next, with the parsed
 * contents held HERE in between. The screen is only ever told what the file holds; it
 * never hands a path or a payload back, so nothing it sends can make the main process
 * read a different file or import different rows than the ones the owner was shown.
 */

/** A data file should be a few hundred KB. Anything this big is not one of ours. */
const MAX_IMPORT_BYTES = 50 * 1024 * 1024

let pendingImport: { userId: number; fileName: string; pkg: ShopDataPackage } | null = null
/** The folders this session exported to — the only ones the screen may ask to open. */
const exportedFolders = new Set<string>()

function parentWindow(): BrowserWindow | undefined {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
}

/** Why an import cannot happen right now, or null when it can. */
function importBlocker(): string | null {
  const db = getDb()
  const has = (table: string) => (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c > 0
  if (has('orders') || has('supplier_invoice_items') || has('driver_settlements')) {
    return 'توجد فواتير أو توريدات مسجلة — صفّر النظام أولاً من تبويب «الأمان والنسخ الاحتياطي» ثم أعد الاستيراد'
  }
  return null
}

export function registerShopDataIpc(): void {
  handle('shopData:counts', async (): Promise<IpcResponse> => {
    try {
      requireRole('owner')
      return { success: true, data: currentShopDataCounts() }
    } catch (err: any) { return { success: false, error: err.message } }
  })

  handle('shopData:export', async (): Promise<IpcResponse> => {
    try {
      requireRole('owner')

      const options = {
        title: 'اختر المكان الذي تُحفظ فيه بيانات المحل',
        defaultPath: app.getPath('desktop'),
        properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[],
      }
      const win = parentWindow()
      const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
      // Closing the picker is not a failure — say nothing rather than claim success.
      if (picked.canceled || !picked.filePaths[0]) return { success: true, data: null }

      const result = await exportShopDataTo(picked.filePaths[0])
      exportedFolders.add(result.folder)
      return { success: true, data: result }
    } catch (err: any) {
      log.error('[IPC] shopData:export error:', err)
      return { success: false, error: err.message }
    }
  })

  handle('shopData:openFolder', async (_e, { folder } = {}): Promise<IpcResponse> => {
    try {
      requireRole('owner')
      if (typeof folder !== 'string' || !exportedFolders.has(folder)) throw new Error('المجلد غير معروف')
      const failed = await shell.openPath(folder)
      if (failed) throw new Error(failed)
      return { success: true }
    } catch (err: any) { return { success: false, error: err.message } }
  })

  // Step one: choose the file and be told what is in it. Nothing is changed.
  handle('shopData:pickImport', async (): Promise<IpcResponse> => {
    try {
      const session = requireRole('owner')
      requireSettingsUnlocked(session.userId)
      pendingImport = null

      const options = {
        title: 'اختر ملف بيانات المحل (shop-data.json)',
        defaultPath: app.getPath('desktop'),
        filters: [{ name: 'بيانات المحل', extensions: ['json'] }],
        properties: ['openFile'] as 'openFile'[],
      }
      const win = parentWindow()
      const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
      if (picked.canceled || !picked.filePaths[0]) return { success: true, data: null }

      const filePath = picked.filePaths[0]
      if (fs.statSync(filePath).size > MAX_IMPORT_BYTES) throw new Error('الملف أكبر من أن يكون ملف بيانات محل')

      let raw: unknown
      try {
        // Excel and Notepad both put a byte-order mark on a file they have saved.
        raw = JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^﻿/, ''))
      } catch {
        throw new Error('تعذرت قراءة الملف — ليس ملف بيانات صالحاً')
      }
      const pkg = parseShopData(raw)

      pendingImport = { userId: session.userId, fileName: path.basename(filePath), pkg }
      return {
        success: true,
        data: {
          fileName: pendingImport.fileName,
          businessName: pkg.businessName,
          exportedAt: pkg.exportedAt,
          counts: countShopData(pkg),
          blocked: importBlocker(),
        },
      }
    } catch (err: any) {
      log.error('[IPC] shopData:pickImport error:', err)
      return { success: false, error: err.message }
    }
  })

  // Step two: apply the file that was just shown — and only that one.
  handle('shopData:import', async (): Promise<IpcResponse> => {
    try {
      const session = requireRole('owner')
      requireSettingsUnlocked(session.userId)
      if (!pendingImport || pendingImport.userId !== session.userId) {
        throw new Error('اختر ملف البيانات أولاً')
      }
      const blocked = importBlocker()
      if (blocked) throw new Error(blocked)

      // A copy of what is about to be replaced, so an import made in error can be undone
      // from the backups list.
      let safetyCopy: string | null = null
      try {
        safetyCopy = await runBackup()
      } catch (err) {
        log.warn('[ShopData] Pre-import backup failed; continuing:', err)
      }

      const counts = importShopData(pendingImport.pkg, session.userId)
      pendingImport = null

      broadcast('app:settingsChanged', getSettings())
      // The menu, the stock and the settings on screen all describe rows that have
      // just been replaced.
      for (const w of BrowserWindow.getAllWindows()) w.webContents.reload()

      return { success: true, data: { counts, safetyCopy } }
    } catch (err: any) {
      log.error('[IPC] shopData:import error:', err)
      return { success: false, error: err.message }
    }
  })
}
