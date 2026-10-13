import { getDb } from '../db/db'
import log from 'electron-log/main'
import type { WorkerAttendance } from '../../shared/types'

/**
 * Record a day worked, and WHICH shift it was.
 *
 * The shift falls back to the worker's usual one when not given, but is stored per
 * day — a chef who normally does mornings and covers an evening is recorded as
 * having worked the evening.
 *
 * Re-marking the same day updates the shift rather than being ignored, so a
 * mistaken shift can simply be corrected.
 */
export function markAttendance(
  workerId: number,
  workDate: string,
  createdBy: number,
  shiftNumber?: number | null
): WorkerAttendance {
  const db = getDb()

  const worker = db.prepare('SELECT worker_id, default_shift FROM workers WHERE worker_id = ?')
    .get(workerId) as { worker_id: number; default_shift: number | null } | undefined
  if (!worker) throw new Error('العامل غير موجود')

  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(workDate))) throw new Error('التاريخ غير صحيح')

  const requested = shiftNumber === 1 || shiftNumber === 2 ? shiftNumber : null
  const shift = requested ?? worker.default_shift ?? null

  db.prepare(`
    INSERT INTO worker_attendance (worker_id, work_date, shift_number, created_by)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(worker_id, work_date) DO UPDATE SET shift_number = excluded.shift_number
  `).run(workerId, workDate, shift, createdBy)

  log.info(`[WorkerAttendance] Worker #${workerId} present on ${workDate} (shift ${shift ?? '—'})`)
  return db.prepare(`
    SELECT * FROM worker_attendance WHERE worker_id = ? AND work_date = ?
  `).get(workerId, workDate) as WorkerAttendance
}

export function unmarkAttendance(workerId: number, workDate: string): void {
  const db = getDb()
  db.prepare(`DELETE FROM worker_attendance WHERE worker_id = ? AND work_date = ?`).run(workerId, workDate)
  log.info(`[WorkerAttendance] Unmarked worker #${workerId} on ${workDate}`)
}

export function listAttendance(workerId: number, dateFrom?: string, dateTo?: string): WorkerAttendance[] {
  const db = getDb()
  const conditions: string[] = ['worker_id = ?']
  const params: any[] = [workerId]

  if (dateFrom) {
    conditions.push('work_date >= ?')
    params.push(dateFrom)
  }
  if (dateTo) {
    conditions.push('work_date <= ?')
    params.push(dateTo)
  }

  return db.prepare(`
    SELECT * FROM worker_attendance
    WHERE ${conditions.join(' AND ')}
    ORDER BY work_date DESC
  `).all(...params) as WorkerAttendance[]
}

export function countAttendance(workerId: number, dateFrom: string, dateTo: string): number {
  const db = getDb()
  const row = db.prepare(`
    SELECT COUNT(*) as count FROM worker_attendance
    WHERE worker_id = ? AND work_date >= ? AND work_date <= ?
  `).get(workerId, dateFrom, dateTo) as { count: number }
  return row.count
}
