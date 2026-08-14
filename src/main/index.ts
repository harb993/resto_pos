import { app, BrowserWindow, shell } from 'electron'
import path from 'node:path'
import log from 'electron-log/main'
import { initDatabase, closeDatabase, runBackup } from './db/db'
import { registerAuthIpc } from './ipc/auth.ipc'
import { registerMenuIpc } from './ipc/menu.ipc'
import { registerOrderIpc } from './ipc/order.ipc'
import { registerStockIpc } from './ipc/stock.ipc'
import { registerAnalyticsIpc } from './ipc/analytics.ipc'
import { registerSettingsIpc } from './ipc/settings.ipc'

// Initialize logging
log.initialize()
log.info('App starting...', { version: app.getVersion() })

// Global error handlers — don't let one exception take down the till
process.on('uncaughtException', (err) => {
  log.error('Uncaught exception in main process:', err)
})
process.on('unhandledRejection', (reason) => {
  log.error('Unhandled promise rejection:', reason)
})

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 700,
    title: 'Resto POS',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // needed for better-sqlite3 in preload context
    },
    show: false, // show when ready to avoid flash
  })

  // Show when ready
  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
    mainWindow?.maximize()
  })

  // Recover from renderer crash
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    log.error('Renderer process gone:', details.reason)
    mainWindow?.reload()
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

app.whenReady().then(async () => {
  // 1. Initialize database
  initDatabase()

  // 2. Register all IPC handlers
  registerAuthIpc()
  registerMenuIpc()
  registerOrderIpc()
  registerStockIpc()
  registerAnalyticsIpc()
  registerSettingsIpc()

  // 3. Create window
  createWindow()

  // 4. Try a backup on launch (if > 20h since last)
  try {
    await runBackup()
    log.info('Startup backup completed')
  } catch (err) {
    log.warn('Startup backup skipped or failed:', err)
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', async () => {
  try {
    await runBackup()
    log.info('Shutdown backup completed')
  } catch (err) {
    log.warn('Shutdown backup failed:', err)
  }
  closeDatabase()
})
