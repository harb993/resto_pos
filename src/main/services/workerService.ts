import { getDb } from '../db/db'
import log from 'electron-log/main'
import type { Worker } from '../../shared/types'

/**
 * Daily workers — kitchen and cleaning help that changes day to day. They never log
 * into the system (that is the four fixed accounts in `users`); they are recorded
 * here, marked present per day in `worker_attendance`, and paid days × daily_wage.
 */
export function upsertWorker(
  fullName: string,
  roleTitle: string | null,
  isActive: number,
  linkedUserId: number | null,
  workerId?: number,
  dailyWage = 0,
  defaultShift: number | null = null
): Worker {
  const db = getDb()

  const name = String(fullName ?? '').trim()
  if (!name) throw new Error('اسم العامل مطلوب')

  const wage = Number(dailyWage)
  if (!Number.isFinite(wage) || wage < 0) {
    throw new Error('الأجر اليومي يجب أن يكون صفراً أو أكثر')
  }

  // The shift this person normally works. Null is allowed — plenty of staff float.
  const shift = defaultShift === 1 || defaultShift === 2 ? defaultShift : null

  if (workerId) {
    db.prepare(`
      UPDATE workers SET full_name = ?, role_title = ?, daily_wage = ?, default_shift = ?,
        is_active = ?, linked_user_id = ?
      WHERE worker_id = ?
    `).run(name, roleTitle, wage, shift, isActive, linkedUserId, workerId)
    log.info(`[Worker] Updated worker #${workerId}: ${name} @ ${wage}/day, shift ${shift ?? '—'}`)
    return getWorker(workerId)
  }

  const result = db.prepare(`
    INSERT INTO workers (full_name, role_title, daily_wage, default_shift, is_active, linked_user_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(name, roleTitle, wage, shift, isActive, linkedUserId)
  const id = result.lastInsertRowid as number
  log.info(`[Worker] Created worker #${id}: ${name} @ ${wage}/day, shift ${shift ?? '—'}`)
  return getWorker(id)
}

export function getWorker(workerId: number): Worker {
  const row = getDb().prepare('SELECT * FROM workers WHERE worker_id = ?')
    .get(workerId) as Worker | undefined
  if (!row) throw new Error('العامل غير موجود')
  return row
}

/**
 * The roster, each worker with his running account.
 *
 * The account is the whole point of the screen: a daily worker turns up, the days
 * pile up, money is handed over in round numbers whenever there is money, and
 * nobody remembers where that left things. So:
 *
 *   earned  = every day marked present × his daily wage
 *   paid    = every salary payment recorded against him
 *   balance = earned − paid
 *
 * A positive balance is what the restaurant owes him. A negative one is what he owes
 * the restaurant — he has been paid past the days he has worked, which is exactly
 * what a سلفة is once the month moves on.
 *
 * One honest limitation: there is one wage per worker, not a history of wages, so
 * raising someone's daily wage re-prices every day he has ever worked. The screen
 * says so rather than quietly restating last month.
 */
export function listWorkers(): Worker[] {
  const db = getDb()
  const rows = db.prepare(`
    SELECT w.*, u.username as linked_username,
      (SELECT COUNT(*) FROM worker_attendance a WHERE a.worker_id = w.worker_id) AS daysWorked,
      (SELECT COALESCE(SUM(s.amount), 0) FROM salaries s WHERE s.worker_id = w.worker_id) AS paid,
      -- The same "when did the money move" rule salaryService uses, so the date here
      -- agrees with the one on the salaries screen.
      (SELECT MAX(COALESCE(s.paid_on, s.pay_period_end)) FROM salaries s
        WHERE s.worker_id = w.worker_id) AS lastPaidOn
    FROM workers w
    LEFT JOIN users u ON u.user_id = w.linked_user_id
    ORDER BY w.is_active DESC, w.full_name
  `).all() as Worker[]

  return rows.map(w => {
    const earned = round2((w.daysWorked ?? 0) * (w.daily_wage ?? 0))
    const paid = round2(w.paid ?? 0)
    return { ...w, earned, paid, balance: round2(earned - paid) }
  })
}

/** Money is stored as REAL; round every computed figure before it reaches a screen. */
function round2(n: number): number {
  return Math.round(((n || 0) + Number.EPSILON) * 100) / 100
}

/**
 * What a daily worker has earned over a period: the days they were marked present
 * multiplied by their wage. This is what the salary screen proposes, so the owner
 * confirms a figure derived from the attendance log rather than typing one.
 */
export function getWorkerPayForPeriod(
  workerId: number,
  dateFrom: string,
  dateTo: string
): { days: number; dailyWage: number; total: number; workerName: string } {
  const db = getDb()
  const worker = getWorker(workerId)

  const row = db.prepare(`
    SELECT COUNT(*) as days FROM worker_attendance
    WHERE worker_id = ? AND work_date >= ? AND work_date <= ?
  `).get(workerId, dateFrom, dateTo) as { days: number }

  return {
    days: row.days,
    dailyWage: worker.daily_wage,
    total: Math.round(row.days * worker.daily_wage * 100) / 100,
    workerName: worker.full_name,
  }
}
