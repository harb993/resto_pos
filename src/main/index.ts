import { app, BrowserWindow, Menu, shell } from 'electron'
import path from 'node:path'
import log from 'electron-log/main'
import {
  initDatabase, closeDatabase, runBackup, isDemoMode, refreshDemoDatabaseIfStale,
  clearAllBusinessData,
} from './db/db'
import { registerAuthIpc } from './ipc/auth.ipc'
import { registerMenuIpc } from './ipc/menu.ipc'
import { registerOrderIpc } from './ipc/order.ipc'
import { registerRawMaterialIpc } from './ipc/rawMaterial.ipc'
import { registerAnalyticsIpc } from './ipc/analytics.ipc'
import { registerSettingsIpc } from './ipc/settings.ipc'
import { registerExpenseIpc } from './ipc/expense.ipc'
import { registerWorkerIpc } from './ipc/worker.ipc'
import { registerWorkerAttendanceIpc } from './ipc/workerAttendance.ipc'
import { registerSalaryIpc } from './ipc/salary.ipc'
import { registerShiftIpc } from './ipc/shift.ipc'
import { registerDeliveryIpc } from './ipc/delivery.ipc'
import { registerReportIpc } from './ipc/report.ipc'
import { registerFinanceIpc } from './ipc/finance.ipc'
import { registerCustomerIpc } from './ipc/customer.ipc'
import { registerDeletionIpc } from './ipc/deletion.ipc'
import { registerWhatsappIpc } from './ipc/whatsapp.ipc'
import { registerPrinterIpc } from './ipc/printer.ipc'
import { registerNetworkIpc } from './ipc/network.ipc'
import { registerSupplierIpc } from './ipc/supplier.ipc'
import { registerShopDataIpc } from './ipc/shopData.ipc'
import { registerLicenseIpc } from './ipc/license.ipc'
import { getLicenseStatus } from './services/licenseService'
import { applyNetworkMode } from './net/mode'
import { stopServer } from './net/tillServer'
import { stopNodeMode } from './net/nodeLink'
import { stopMasterMode } from './net/masterLink'
import { startBackupSchedule, stopBackupSchedule } from './services/backupScheduler'
import {
  startShiftExportSchedule, stopShiftExportSchedule, tickShiftExports,
} from './services/shiftExportService'
import { broadcast } from './ipc/broadcast'
import { cleanPrintTemp } from './services/printing/transport'
import { closeRenderWindows } from './services/printing/render'
import { endAllOpenSessions, closeSessionsPastShiftEnd, resumeSessionForUser } from './services/shiftService'
import { tickWorkShift, getWorkShiftStatus, onWorkShiftChanged } from './services/workShiftService'
import { getSettings } from './services/settingsService'
import { getCurrentSession } from './services/authService'
import { restoreCatalogCostsOnce } from './services/menuImportService'
import { ensureDesktopShortcut, SHORTCUT_MARKER_FILE } from './services/desktopShortcut'

import fs from 'node:fs'

// Initialize logging
log.initialize()
log.info('App starting...', { version: app.getVersion() })

// Global error handlers â€” don't let one exception take down the till
process.on('uncaughtException', (err) => {
  log.error('Uncaught exception in main process:', err)
})
process.on('unhandledRejection', (reason) => {
  log.error('Unhandled promise rejection:', reason)
})

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  const iconPath = path.join(app.getAppPath(), 'build', 'icon.ico')
  const devIconPath = path.join(__dirname, '../../build/icon.ico')
  const resolvedIcon = fs.existsSync(iconPath) ? iconPath : (fs.existsSync(devIconPath) ? devIconPath : undefined)

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 700,
    title: 'أبو الدهب',
    icon: resolvedIcon,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // The preload only touches contextBridge + ipcRenderer, both of which are
      // available to a sandboxed preload â€” so there is no reason to leave the
      // renderer unsandboxed. Every privileged operation already goes over IPC.
      sandbox: true,
    },
    show: false, // show when ready to avoid flash
  })

  // Show when ready
  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
    mainWindow?.maximize()
  })

  // The ticket renderer holds an invisible window between sales, and Electron will
  // not emit 'window-all-closed' while any window exists â€” so release them the moment
  // the till's own window goes, or closing the app would leave it running unseen.
  mainWindow.on('closed', () => {
    mainWindow = null
    closeRenderWindows()
  })

  // Recover from renderer crash
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    log.error('Renderer process gone:', details.reason)
    mainWindow?.reload()
  })

  // Renderer-side errors used to vanish into a devtools console nobody opens on a
  // till. Forward warnings and errors into the same log file as everything else so
  // a failure on site can actually be diagnosed after the fact.
  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    if (level >= 2) { // 2 = warning, 3 = error
      const where = sourceId ? ` (${sourceId}:${line})` : ''
      const write = level === 3 ? log.error : log.warn
      write(`[Renderer] ${message}${where}`)
    }
  })

  // Open external links in browser, not in the app
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  // In dev, load from vite dev server; in production, load built files
  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

function placeDesktopShortcut(): void {
  try {
    // Kept per PC and per Windows user — beside the licence key — not in the shop's
    // database: that lives in the program folder, and a folder copied to a new till
    // would otherwise arrive saying the new desktop had already had its shortcut.
    const markerFile = path.join(app.getPath('userData'), SHORTCUT_MARKER_FILE)
    const outcome = ensureDesktopShortcut({
      platform: process.platform,
      isPackaged: app.isPackaged,
      // The portable build runs from a temporary copy; the shortcut must start the
      // .exe the owner actually has, not that copy.
      target: process.env.PORTABLE_EXECUTABLE_FILE || process.execPath,
      desktopDir: app.getPath('desktop'),
      exists: file => fs.existsSync(file),
      readTarget: file => {
        try { return shell.readShortcutLink(file).target || null } catch { return null }
      },
      write: (file, operation, options) => shell.writeShortcutLink(file, operation, options),
      alreadyOffered: () => fs.existsSync(markerFile),
      markOffered: () => {
        fs.mkdirSync(path.dirname(markerFile), { recursive: true })
        fs.writeFileSync(markerFile, new Date().toISOString())
      },
    })
    if (outcome !== 'skipped') log.info(`[Shortcut] Desktop shortcut: ${outcome}`)
  } catch (err) {
    log.warn('[Shortcut] Could not place the desktop shortcut:', err)
  }
}

app.whenReady().then(async () => {
  // No menu bar. Electron's default one is English, and it carries Reload (Ctrl+R) —
  // one stray key mid-order reloads the till and the cart with it — and the developer
  // tools. Copy and paste in text boxes work without it on Windows.
  Menu.setApplicationMenu(null)

  // 1. Initialize database. Normally the restaurant's own; the showcase account
  //    switches to its separate one when it signs in.
  if (isDemoMode()) refreshDemoDatabaseIfStale()
  initDatabase()

  // Handing the system over: `--reset-data` empties the restaurant's books and quits
  // without opening a window. Kept out of the interface on purpose â€” this is a
  // commissioning step, not something to leave a button for in a working till.
  //
  // A FULL wipe, menu and stock included, unlike the reset button in the settings
  // screen. This one runs when the software is being handed to a different
  // restaurant, and one shop's dishes and ingredients are of no use to the next.
  if (process.argv.includes('--reset-data')) {
    try {
      const { cleared } = clearAllBusinessData({ keepMenuAndStock: false })
      const total = Object.values(cleared).reduce((a, b) => a + b, 0)
      log.info(`[Reset] Cleared ${total} row(s) across ${Object.keys(cleared).length} table(s)`)
      closeDatabase()
      app.exit(0)
    } catch (err) {
      log.error('[Reset] Failed:', err)
      app.exit(1)
    }
    return
  }

  // 2. Register all IPC handlers. The licence channels go first because every other
  //    one is refused until they have been satisfied â€” see the guard in net/router.
  registerLicenseIpc()
  registerAuthIpc()
  registerMenuIpc()
  registerOrderIpc()
  registerRawMaterialIpc()
  registerAnalyticsIpc()
  registerSettingsIpc()
  registerExpenseIpc()
  registerWorkerIpc()
  registerWorkerAttendanceIpc()
  registerSalaryIpc()
  registerShiftIpc()
  registerDeliveryIpc()
  registerReportIpc()
  registerFinanceIpc()
  registerCustomerIpc()
  registerDeletionIpc()
  registerWhatsappIpc()
  registerPrinterIpc()
  registerNetworkIpc()
  registerSupplierIpc()
  registerShopDataIpc()

  // A ticket that failed mid-print leaves its temp file behind. Clear them at
  // startup rather than letting a year of them accumulate in the temp folder.
  cleanPrintTemp()

  // One-off repair: dishes whose cost was overwritten with 0 by an unpriced recipe get
  // the sheet's figure back. Fills blanks only — see restoreCatalogCosts.
  try {
    restoreCatalogCostsOnce()
  } catch (err) {
    log.warn('[Menu] Cost restore skipped:', err)
  }

  // Shifts end when the owner says they end. Checked at startup â€” so a till that was
  // switched off overnight still has yesterday's session closed at its proper time
  // rather than running on into today â€” and then once a minute while the app is up.
  //
  // A minute tick rather than a timer aimed at the exact boundary: a timer set hours
  // ahead does not survive the machine sleeping, and a till that wakes at 09:00 would
  // keep last night's shift open until something else nudged it.
  try {
    const closed = closeSessionsPastShiftEnd()
    if (closed > 0) log.info(`[Shift] Closed ${closed} session(s) left open past their shift end`)
  } catch (err) {
    log.warn('[Shift] Could not close finished sessions at startup:', err)
  }
  // The shop's own shift: ended at its time, started at its time. Done once now so a
  // till switched on mid-shift is trading at once, then on the same minute tick.
  onWorkShiftChanged(() => {
    broadcast('app:workShiftChanged', getWorkShiftStatus())
    tickShiftExports() // a shift that has just ended has a report owed on it
  })
  const tickShop = () => {
    if ((getSettings() as any).net_mode === 'node') return // the master keeps the shifts
    try {
      tickWorkShift()
    } catch (err) {
      log.warn('[WorkShift] Tick failed:', err)
    }
  }
  tickShop()

  setInterval(() => {
    tickShop()
    try {
      const closed = closeSessionsPastShiftEnd()
      // A shift that has just closed has a report owed on it. Sweeping here as well
      // as on the export schedule's own tick means the files appear within seconds of
      // the boundary rather than up to a minute later.
      if (closed > 0) tickShiftExports()

      // ...and the next shift starts for whoever is still at the till. Without this a
      // till that is never signed out of closes its first shift and then never opens
      // another, so every following day records nothing and exports nothing.
      //
      // Not on a node: there the shifts belong to the master, which keeps the books
      // and runs this same tick against them.
      if ((getSettings() as any).net_mode !== 'node') {
        const who = getCurrentSession()
        if (who) resumeSessionForUser(who.userId)
      }
    } catch (err) {
      log.warn('[Shift] Scheduled shift close failed:', err)
    }
  }, 60 * 1000)

  // An unactivated till must not announce itself on the LAN or start serving nodes â€”
  // the activation screen is the only thing it is allowed to do. The status is
  // logged either way, because "which device id is this PC" is the first question
  // asked whenever an activation goes wrong.
  const licence = getLicenseStatus()
  log.info(`[License] Device ${licence.deviceId} â€” ${licence.activated ? 'activated' : 'NOT activated'}`)

  if (licence.activated) {
    // Take up this machine's place on the network â€” master, node, or neither. Done
    // after every handler is registered, because a master starts answering for them
    // the moment it begins listening.
    await applyNetworkMode()
  }

  // 3. Create window
  createWindow()

  // The «أبو الدهب» shortcut on the desktop, with the logo — first run only. The
  // showcase account runs the same .exe with a flag, so it never makes one.
  if (!isDemoMode()) placeDesktopShortcut()

  // 4. Try a backup on launch, but only if the newest one is over 20h old â€”
  //    otherwise a few restarts in a row would roll every older backup off the
  //    30-file retention window.
  try {
    const written = await runBackup({ minIntervalHours: 20 })
    log.info(written ? `Startup backup completed: ${written}` : 'Startup backup skipped (recent one exists)')
  } catch (err) {
    log.warn('Startup backup skipped or failed:', err)
  }

  // 5. Keep snapshotting through the day. Backing up only at startup and shutdown
  //    means a power cut mid-service loses everything rung up since opening â€” which
  //    is exactly the session worth keeping. Hourly caps the loss at an hour.
  //
  //    A failure here used to be a line in a log file nobody opens. A real shop ran a
  //    whole day with `Hourly backup failed: disk I/O error` repeating while the
  //    screen said nothing at all — so it now reaches the interface as well, because
  //    a till that has stopped backing up is worth interrupting somebody about.
  setInterval(() => {
    void runBackup({ minIntervalHours: 1 })
      .then(written => { if (written) log.info(`Hourly backup: ${written}`) })
      .catch(err => {
        const error = err?.message || String(err)
        log.error('Hourly backup FAILED:', error)
        broadcast('app:backupResult', { ok: false, at: Date.now(), error, hourly: true })
      })
  }, 60 * 60 * 1000)

  // 6. The nightly one, which is the copy that also goes to the other till so that
  //    losing this machine does not lose the shop's history with it.
  startBackupSchedule()

  // 7. The close-out report for every shift that ends — PDF and workbook, written
  //    without anybody having to remember. It sweeps rather than being triggered by
  //    the sign-out, so a shift closed while the till was switched off still gets its
  //    report at the next launch. See shiftExportService.
  startShiftExportSchedule()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// Electron does not await async 'before-quit' listeners â€” it tears the process down
// regardless. So hold the quit open explicitly, finish the backup and close the
// database, then quit for real. Without the preventDefault the app exits first and
// the shutdown backup never actually runs.
let shutdownStarted = false
let shutdownFinished = false

app.on('before-quit', (event) => {
  if (shutdownFinished) return // drain complete: let the quit through

  // Always hold the quit while the drain is in flight...
  event.preventDefault()

  // ...but only ever run the drain ONCE. before-quit can fire repeatedly (closing
  // several windows, a second quit request arriving mid-backup), and without this
  // guard each one started another backup â€” two writers racing on the same
  // timestamped filename, and closeDatabase() called on an already-closed handle.
  if (shutdownStarted) return
  shutdownStarted = true

  void (async () => {
    // Close any shift left running so the hours stop at shutdown rather than
    // counting through the night until the till is next switched on.
    try {
      endAllOpenSessions()
    } catch (err) {
      log.warn('Failed to close open shift sessions on shutdown:', err)
    }
    // The ticket renderer keeps a window alive between sales; it is not a window
    // anyone can see, but it is still a window, and 'window-all-closed' never fires
    // while it is up.
    try {
      closeRenderWindows()
    } catch (err) {
      log.warn('Failed to close print render windows:', err)
    }
    // Let go of the LAN before the database closes: a node mid-request against a
    // master that has already shut its database would get an error rather than the
    // clean "master unreachable" it knows how to show.
    try {
      stopBackupSchedule()
      stopShiftExportSchedule()
      stopNodeMode()
      stopMasterMode()
      await stopServer()
    } catch (err) {
      log.warn('Failed to shut down networking:', err)
    }
    try {
      const written = await runBackup()
      log.info(written ? `Shutdown backup completed: ${written}` : 'Shutdown backup skipped')
    } catch (err) {
      log.warn('Shutdown backup failed:', err)
    }
    try {
      closeDatabase() // checkpoints the WAL and releases the file cleanly
    } catch (err) {
      log.warn('Database close failed:', err)
    }
    shutdownFinished = true
    app.quit()
  })()
})
