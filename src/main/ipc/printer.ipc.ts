import { ipcMain, BrowserWindow } from 'electron'
import { handle } from '../net/router'
import { broadcast } from './broadcast'
import log from 'electron-log/main'
import * as printers from '../services/printerService'
import { requireAnyAuth, requireRole } from '../services/authService'
import type { IpcResponse, PrintJobResult } from '../../shared/types'

/**
 * Setting printers up is the owner's job; using them is everyone's. So the registry
 * calls require the owner role, while printing, reprinting and kicking the drawer
 * only require somebody to be signed in — a cashier reprinting a receipt for a
 * customer who dropped theirs must not need the manager fetched.
 */
export function registerPrinterIpc(): void {
  handle('printers:list', async (): Promise<IpcResponse> => {
    try {
      requireAnyAuth()
      return { success: true, data: printers.listPrinters() }
    } catch (err: any) { return { success: false, error: err.message } }
  })

  handle('printers:listSystem', async (): Promise<IpcResponse> => {
    try {
      requireRole('owner')
      return { success: true, data: await printers.listSystemPrinters() }
    } catch (err: any) { return { success: false, error: err.message } }
  })

  handle('printers:upsert', async (_e, data): Promise<IpcResponse> => {
    try {
      requireRole('owner')
      return { success: true, data: printers.upsertPrinter(data) }
    } catch (err: any) {
      log.error('[IPC] printers:upsert error:', err)
      return { success: false, error: err.message }
    }
  })

  handle('printers:delete', async (_e, { printerId }): Promise<IpcResponse> => {
    try {
      requireRole('owner')
      printers.deletePrinter(printerId)
      return { success: true }
    } catch (err: any) { return { success: false, error: err.message } }
  })

  handle('printers:test', async (_e, { printerId }): Promise<IpcResponse> => {
    try {
      requireRole('owner')
      await printers.testPrint(printerId)
      return { success: true }
    } catch (err: any) {
      log.error('[IPC] printers:test error:', err)
      return { success: false, error: err.message }
    }
  })

  handle('printers:testConnection', async (_e, { printerId }): Promise<IpcResponse> => {
    try {
      requireRole('owner')
      await printers.testConnection(printerId)
      return { success: true }
    } catch (err: any) { return { success: false, error: err.message } }
  })

  /** Manual print or reprint of an invoice, from the POS or the order history. */
  handle('printers:printOrder', async (_e, { orderId, tenderedAmount, reprint, printerId }): Promise<IpcResponse> => {
    try {
      requireAnyAuth()
      const results = await printers.printOrder(orderId, {
        tenderedAmount, reprint: reprint !== false, onlyPrinterId: printerId,
      })
      return { success: true, data: results }
    } catch (err: any) {
      log.error('[IPC] printers:printOrder error:', err)
      return { success: false, error: err.message }
    }
  })

  handle('printers:openDrawer', async (_e, { printerId } = {}): Promise<IpcResponse> => {
    try {
      requireAnyAuth()
      await printers.openCashDrawer(printerId)
      return { success: true }
    } catch (err: any) { return { success: false, error: err.message } }
  })

  // Owner-only: it is a setup step, not something to fire from behind the counter.
  handle('printers:testBeep', async (_e, { printerId } = {}): Promise<IpcResponse> => {
    try {
      requireRole('owner')
      await printers.testPrinterBeep(printerId)
      return { success: true }
    } catch (err: any) { return { success: false, error: err.message } }
  })
}

/**
 * Print an order in the background and tell the screens how it went.
 *
 * Called from the order IPC the moment a sale is recorded. It deliberately returns
 * nothing and never throws: the order is already in the books, so nothing here can
 * be allowed to turn a completed sale into an error on the cashier's screen. What a
 * failed printer produces is a warning, pushed to whoever is looking.
 */
export function printOrderInBackground(
  orderId: number,
  tenderedAmount?: number,
): void {
  void printers.printOrder(orderId, { tenderedAmount })
    .then((results) => {
      const failed = results.filter(r => !r.ok)
      const printed = results.filter(r => r.ok && !r.skipped)
      if (failed.length === 0) {
        if (printed.length > 0) log.info(`[Print] Order ${orderId}: ${printed.length} ticket(s) printed`)
        return
      }
      broadcastPrintResult(orderId, results)
    })
    .catch((err) => {
      log.error(`[Print] Order ${orderId}: printing failed outright:`, err)
      broadcastPrintResult(orderId, [])
    })
}

/**
 * Put a cancellation slip on the prep printers, in the background.
 *
 * Same contract as `printOrderInBackground`: the void is already recorded, so a
 * printer that is out of paper must never turn a completed cancellation into an error
 * on the cashier's screen. Failures reach the screen through 'app:printResult'.
 */
export function printVoidNoticeInBackground(
  orderId: number,
  info: { kind: 'void' | 'delete'; reason?: string | null; byName?: string | null },
): void {
  void printers.printVoidedOrder(orderId, info)
    .then((results) => {
      const failed = results.filter(r => !r.ok)
      if (failed.length === 0) {
        const printed = results.filter(r => r.ok && !r.skipped)
        if (printed.length > 0) {
          log.info(`[Print] Order ${orderId} cancellation: ${printed.length} ticket(s) printed`)
        }
        return
      }
      broadcastPrintResult(orderId, results)
    })
    .catch((err) => {
      log.error(`[Print] Order ${orderId}: cancellation ticket failed outright:`, err)
    })
}

function broadcastPrintResult(orderId: number, results: PrintJobResult[]): void {
  // Goes to the node tills too: with network printers the master does the printing
  // for everyone, so a jammed printer must reach the cashier who rang the sale up,
  // wherever they are standing.
  broadcast('app:printResult', { orderId, results })
}
