import { ipcMain, shell } from 'electron'
import { handle } from '../net/router'
import * as shift from '../services/shiftService'
import { getShiftReport, getWorkShiftReport } from '../services/shiftReportService'
import {
  getWorkShiftStatus, startWorkShiftManually, listWorkShifts,
} from '../services/workShiftService'
import { getClosingReport } from '../services/closingService'
import { printClosingReport } from '../services/printerService'
import { exportShiftPdf } from '../services/pdfReportService'
import {
  exportShiftFiles, shareShiftExport, shiftExportRoot, whatsappTarget,
} from '../services/shiftExportService'
import { requireRole, requireAnyAuth, requireOwnerOrAccountant, getCurrentSession } from '../services/authService'
import log from 'electron-log/main'
import type { IpcResponse, ShiftExport } from '../../shared/types'

/**
 * A close-out report is visible to the owner and accountant for any shift, and to a
 * cashier for their OWN shift only — they need to count their drawer, but not to read
 * a colleague's takings.
 */
function assertCanReadShift(cashierId: number): void {
  const session = getCurrentSession()
  if (!session) throw new Error('Not authenticated')
  if (session.role === 'owner' || session.role === 'accountant') return
  if (session.userId !== cashierId) {
    throw new Error('لا يمكنك عرض تقرير وردية موظف آخر')
  }
}

/** The sheet for a cashier's session, or — with `work` — for the shop's whole shift. */
function reportFor(shiftId: number, work: unknown) {
  if (work) {
    const session = getCurrentSession()
    if (!session) throw new Error('Not authenticated')
    if (session.role !== 'owner' && session.role !== 'accountant') {
      throw new Error('تقرير الوردية الكامل متاح للمدير والمحاسب فقط')
    }
    return getWorkShiftReport(shiftId)
  }
  const report = getShiftReport(shiftId)
  assertCanReadShift(report.cashierId)
  return report
}

export function registerShiftIpc(): void {
  // ---- The shop's shift: is one running, and starting the next one ----

  handle('workShift:status', async (): Promise<IpcResponse> => {
    try {
      requireAnyAuth()
      return { success: true, data: getWorkShiftStatus() }
    } catch (err: any) { return { success: false, error: err.message } }
  })

  handle('workShift:list', async (): Promise<IpcResponse> => {
    try {
      requireAnyAuth()
      return { success: true, data: listWorkShifts() }
    } catch (err: any) { return { success: false, error: err.message } }
  })

  // The owner's decision alone: starting a shift is what lets the till take money.
  handle('workShift:start', async (): Promise<IpcResponse> => {
    try {
      const session = requireRole('owner')
      // Every screen hears about it through the service's own announcement.
      return { success: true, data: startWorkShiftManually(session.userId) }
    } catch (err: any) {
      log.error('[IPC] workShift:start error:', err)
      return { success: false, error: err.message }
    }
  })

  // Sessions are opened and closed by signing in and out (see auth.ipc.ts), so there
  // is deliberately no handler for creating or editing a shift by hand — the hours
  // have to be what was actually worked.

  handle('shifts:list', async (_e, filters = {}): Promise<IpcResponse> => {
    try {
      requireAnyAuth()
      return { success: true, data: shift.listShifts(filters) }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  handle('shifts:hoursForPeriod', async (_e, { userId, dateFrom, dateTo }): Promise<IpcResponse> => {
    try {
      requireOwnerOrAccountant()
      return { success: true, data: shift.getHoursForPeriod(userId, dateFrom, dateTo) }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // The close-out report: everything that happened during one session.
  handle('shifts:report', async (_e, { shiftId, work }): Promise<IpcResponse> => {
    try {
      requireAnyAuth()
      const report = reportFor(shiftId, work)
      return { success: true, data: report }
    } catch (err: any) {
      log.error('[IPC] shifts:report error:', err)
      return { success: false, error: err.message }
    }
  })

  handle('shifts:exportReportPdf', async (_e, { shiftId, work }): Promise<IpcResponse> => {
    try {
      requireAnyAuth()
      // Rebuilt from the database rather than taking figures from the renderer.
      const report = reportFor(shiftId, work)
      const filePath = await exportShiftPdf(report)
      return { success: true, data: { filePath } }
    } catch (err: any) {
      log.error('[IPC] shifts:exportReportPdf error:', err)
      return { success: false, error: err.message }
    }
  })

  /**
   * Both files at once, into the dated export folder — the same pair the automatic
   * end-of-shift export writes. No save dialog: the point is that the two files end
   * up together where the sender expects to find them.
   */
  handle('shifts:exportFiles', async (_e, { shiftId, work }): Promise<IpcResponse> => {
    try {
      requireAnyAuth()
      reportFor(shiftId, work)
      return { success: true, data: { ...(await exportShiftFiles(shiftId, !!work)), work: !!work } }
    } catch (err: any) {
      log.error('[IPC] shifts:exportFiles error:', err)
      return { success: false, error: err.message }
    }
  })

  /**
   * Export if needed, then open the group chat with the summary typed and the folder
   * open beside it. One press, because at 1am it has to be one press.
   */
  handle('shifts:shareToGroup', async (_e, { shiftId, exported, work }): Promise<IpcResponse> => {
    try {
      requireAnyAuth()
      const isWork = !!(work ?? exported?.work)
      reportFor(shiftId, isWork)

      const files: ShiftExport = exported?.pdfPath
        ? exported
        : { ...(await exportShiftFiles(shiftId, isWork)), work: isWork }
      const { prefilled } = await shareShiftExport(files)
      return { success: true, data: { ...files, prefilled } }
    } catch (err: any) {
      log.error('[IPC] shifts:shareToGroup error:', err)
      return { success: false, error: err.message }
    }
  })

  handle('shifts:openExportFolder', async (_e, { folder } = {}): Promise<IpcResponse> => {
    try {
      requireAnyAuth()
      const err = await shell.openPath(folder || shiftExportRoot())
      if (err) throw new Error(err)
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  /**
   * «تقفيل الوردية»: the close-out for a CONFIGURED shift — every invoice and every
   * payment out between the hours set in the settings, whoever was at the till. With
   * no date it is the shift running now (or the one that just ended).
   *
   * Open to whoever is signed in: the person closing the till at the end of the night
   * is the cashier, and they cannot count a drawer against a figure they may not see.
   */
  handle('closing:report', async (_e, { workShiftId } = {}): Promise<IpcResponse> => {
    try {
      requireAnyAuth()
      return { success: true, data: getClosingReport({ workShiftId }) }
    } catch (err: any) {
      log.error('[IPC] closing:report error:', err)
      return { success: false, error: err.message }
    }
  })

  handle('closing:print', async (_e, { workShiftId } = {}): Promise<IpcResponse> => {
    try {
      const session = requireAnyAuth()
      // Rebuilt from the database rather than taking figures from the renderer.
      const report = getClosingReport({ workShiftId })
      const result = await printClosingReport(report, { printedBy: session.fullName })
      if (!result.ok) return { success: false, error: result.error || 'تعذرت الطباعة' }
      return { success: true, data: result }
    } catch (err: any) {
      log.error('[IPC] closing:print error:', err)
      return { success: false, error: err.message }
    }
  })

  /** Lets the settings screen show exactly what pressing "send" will open. */
  handle('shifts:whatsappTarget', async (): Promise<IpcResponse> => {
    try {
      requireRole('owner')
      return { success: true, data: whatsappTarget('') }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })
}
