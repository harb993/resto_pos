import { getDb } from '../db/db'
import log from 'electron-log/main'
import type { Salary } from '../../shared/types'

/**
 * Salary payments to daily workers.
 *
 * ONE date rule, used everywhere: a salary counts on the day it was PAID
 * (`paid_on`), falling back to the end of the period when it has not been paid yet.
 * That is when the money actually leaves, so it is what a report for a date range
 * should include.
 *
 * The old rule — `pay_period_start >= from AND pay_period_end <= to` — only matched
 * periods sitting entirely inside the range, so a fortnightly payment vanished from
 * every weekly report and a monthly one from every fortnightly report. Different
 * screens used different variants of it, so the same month could show three
 * different salary totals.
 */

/** The day a salary hits the books. Kept identical to financeService. */
const EFFECTIVE_DATE = `COALESCE(s.paid_on, s.pay_period_end)`

const SELECT_SALARY = `
  SELECT s.*, w.full_name AS worker_name, w.daily_wage,
         ${EFFECTIVE_DATE} AS effective_date,
         (SELECT COUNT(*) FROM worker_attendance a
           WHERE a.worker_id = s.worker_id
             AND a.work_date BETWEEN s.pay_period_start AND s.pay_period_end) AS days_in_period
  FROM salaries s JOIN workers w ON w.worker_id = s.worker_id`

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export function upsertSalary(
  workerId: number,
  amount: number,
  periodStart: string,
  periodEnd: string,
  paidOn: string | null,
  createdBy: number,
  salaryId?: number
): Salary {
  const db = getDb()

  // ---- Validate before writing. None of this was checked before, so a typo could
  //      put a negative salary or a backwards period into the accounts. ----
  const worker = db.prepare('SELECT worker_id, full_name FROM workers WHERE worker_id = ?')
    .get(workerId) as { worker_id: number; full_name: string } | undefined
  if (!worker) throw new Error('العامل غير موجود')

  const value = Number(amount)
  if (!Number.isFinite(value) || value < 0) throw new Error('المبلغ يجب أن يكون صفراً أو أكثر')

  if (!DATE_RE.test(periodStart) || !DATE_RE.test(periodEnd)) {
    throw new Error('تاريخ الفترة غير صحيح')
  }
  if (periodStart > periodEnd) {
    throw new Error('تاريخ بداية الفترة بعد تاريخ النهاية')
  }
  if (paidOn && !DATE_RE.test(paidOn)) throw new Error('تاريخ الصرف غير صحيح')

  // Paying the same worker twice for the same period is almost always a slip —
  // and it silently doubles the wage bill.
  const clash = db.prepare(`
    SELECT salary_id FROM salaries
    WHERE worker_id = ? AND pay_period_start = ? AND pay_period_end = ?
      AND salary_id IS NOT ?
  `).get(workerId, periodStart, periodEnd, salaryId ?? null) as { salary_id: number } | undefined
  if (clash) {
    throw new Error(`يوجد مرتب مسجل بالفعل لـ ${worker.full_name} عن نفس الفترة`)
  }

  if (salaryId) {
    db.prepare(`
      UPDATE salaries SET worker_id = ?, amount = ?, pay_period_start = ?,
        pay_period_end = ?, paid_on = ?
      WHERE salary_id = ?
    `).run(workerId, value, periodStart, periodEnd, paidOn, salaryId)
    log.info(`[Salary] Updated #${salaryId}: ${worker.full_name} ${value}`)
    return db.prepare(`${SELECT_SALARY} WHERE s.salary_id = ?`).get(salaryId) as Salary
  }

  const result = db.prepare(`
    INSERT INTO salaries (worker_id, amount, pay_period_start, pay_period_end, paid_on, created_by)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(workerId, value, periodStart, periodEnd, paidOn, createdBy)

  const id = result.lastInsertRowid as number
  log.info(`[Salary] Created #${id}: ${worker.full_name} ${value} for ${periodStart}→${periodEnd}`)
  return db.prepare(`${SELECT_SALARY} WHERE s.salary_id = ?`).get(id) as Salary
}

export function listSalaries(filters: {
  workerId?: number
  dateFrom?: string
  dateTo?: string
} = {}): Salary[] {
  const db = getDb()
  const conditions: string[] = []
  const params: any[] = []

  if (filters.workerId) {
    conditions.push('s.worker_id = ?')
    params.push(filters.workerId)
  }
  // Filter on when the money moved, not on the period fitting inside the range.
  if (filters.dateFrom) {
    conditions.push(`${EFFECTIVE_DATE} >= ?`)
    params.push(filters.dateFrom)
  }
  if (filters.dateTo) {
    conditions.push(`${EFFECTIVE_DATE} <= ?`)
    params.push(filters.dateTo)
  }

  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : ''
  return db.prepare(`
    ${SELECT_SALARY}
    ${where}
    ORDER BY ${EFFECTIVE_DATE} DESC, s.salary_id DESC
    LIMIT 500
  `).all(...params) as Salary[]
}

export function getSalariesTotal(dateFrom: string, dateTo: string): number {
  const db = getDb()
  const row = db.prepare(`
    SELECT COALESCE(SUM(s.amount), 0) AS total FROM salaries s
    WHERE ${EFFECTIVE_DATE} BETWEEN ? AND ?
  `).get(dateFrom, dateTo) as { total: number }
  return row.total
}

export function deleteSalary(salaryId: number): void {
  const db = getDb()
  const row = db.prepare('SELECT salary_id FROM salaries WHERE salary_id = ?').get(salaryId)
  if (!row) throw new Error('سجل المرتب غير موجود')
  db.prepare('DELETE FROM salaries WHERE salary_id = ?').run(salaryId)
  log.info(`[Salary] Deleted #${salaryId}`)
}
