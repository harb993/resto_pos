import { vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

// A fresh temp userData dir per test process, so initDatabase() gets a clean DB file.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'restopos-test-'))

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getVersion: () => '1.0.0-test',
    getPath: () => tmpRoot,
    getAppPath: () => process.cwd(),
    whenReady: () => Promise.resolve(),
    on: () => {},
    quit: () => {},
  },
  ipcMain: { handle: () => {} },
  BrowserWindow: Object.assign(function () {}, { getAllWindows: () => [] }),
  Notification: Object.assign(function () {}, { isSupported: () => false }),
  dialog: { showSaveDialog: () => Promise.resolve({ filePath: undefined }) },
  shell: { openExternal: () => {} },
  contextBridge: { exposeInMainWorld: () => {} },
  ipcRenderer: { invoke: () => Promise.resolve(), on: () => {}, removeListener: () => {} },
}))

vi.mock('electron-log/main', () => ({
  default: {
    initialize: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  },
}))

export { tmpRoot }
