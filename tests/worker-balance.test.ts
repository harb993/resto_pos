import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../src/main/db/db'
import { upsertWorker, listWorkers } from '../src/main/services/workerService'
import { upsertSalary } from '../src/main/services/salaryService'

/**
 * The daily worker's running account: days worked × his wage, less what he has
 * actually been handed. It is the number the owner is trying to remember when he
 * asks "how much am I behind with Mahmoud?", so it has to be right in both
 * directions — owed to him, and owed by him after an advance.
 */

let ownerId: number

const balanceOf = (workerId: number) =>
  listWorkers().find(w => w.worker_id === workerId)!

/** Mark `n` consecutive days present, ending today. */
function attend(workerId: number, n: number): void {
  const ins = getDb().prepare(
    `INSERT OR IGNORE INTO worker_attendance (worker_id, work_date, created_by) VALUES (?, ?, ?)`
  )
  for (let i = 0; i < n; i++) {
    const d = new Date()
    d.setDate(d.getDate() - i)
    ins.run(workerId, d.toISOString().slice(0, 10), ownerId)
  }
}

beforeAll(() => {
  initDatabase()
  ownerId = (getDb().prepare(`SELECT user_id FROM users WHERE role='owner' LIMIT 1`).get() as any).user_id
})

beforeEach(() => {
  const db = getDb()
  db.prepare('DELETE FROM salaries').run()
  db.prepare('DELETE FROM worker_attendance').run()
  db.prepare('DELETE FROM workers').run()
})

describe('a daily worker’s account', () => {
  it('is zero on the day he is hired', () => {
    const w = upsertWorker('عامل جديد', 'مساعد', 1, null, undefined, 200)
    const b = balanceOf(w.worker_id)
    expect(b.daysWorked).toBe(0)
    expect(b.earned).toBe(0)
    expect(b.paid).toBe(0)
    expect(b.balance).toBe(0)
  })

  it('owes him days worked × his wage until he is paid', () => {
    const w = upsertWorker('محمود سيد', 'طباخ', 1, null, undefined, 350)
    attend(w.worker_id, 6)

    const b = balanceOf(w.worker_id)
    expect(b.daysWorked).toBe(6)
    expect(b.earned).toBe(2100)
    expect(b.balance).toBe(2100) // positive — the restaurant owes him
  })

  it('comes down by exactly what was paid, and lands on zero when settled', () => {
    const w = upsertWorker('علي حسن', 'مساعد مطبخ', 1, null, undefined, 220)
    attend(w.worker_id, 5) // 1100

    upsertSalary(w.worker_id, 600, '2026-09-01', '2026-09-03', '2026-09-03', ownerId)
    expect(balanceOf(w.worker_id).balance).toBe(500)

    upsertSalary(w.worker_id, 500, '2026-09-04', '2026-09-06', '2026-09-06', ownerId)
    const b = balanceOf(w.worker_id)
    expect(b.paid).toBe(1100)
    expect(b.balance).toBe(0)
    expect(b.lastPaidOn).toBe('2026-09-06')
  })

  it('goes negative when he is paid ahead of the days he has worked', () => {
    const w = upsertWorker('سعيد فتحي', 'نظافة', 1, null, undefined, 180)
    attend(w.worker_id, 2) // earned 360
    upsertSalary(w.worker_id, 500, '2026-09-01', '2026-09-02', '2026-09-02', ownerId)

    // He is 140 ahead: that is a سلفة to work off, not a debt the shop owes.
    expect(balanceOf(w.worker_id).balance).toBe(-140)
  })

  it('keeps each worker’s account to himself', () => {
    const a = upsertWorker('عامل أ', null, 1, null, undefined, 100)
    const b = upsertWorker('عامل ب', null, 1, null, undefined, 100)
    attend(a.worker_id, 3)
    upsertSalary(b.worker_id, 250, '2026-09-01', '2026-09-05', '2026-09-05', ownerId)

    expect(balanceOf(a.worker_id).balance).toBe(300)
    expect(balanceOf(b.worker_id).balance).toBe(-250)
  })

  it('remembers the usual shift instead of silently resetting it', () => {
    // The IPC layer used to drop this argument, so the choice on the form never stuck.
    const w = upsertWorker('عامل وردية', 'طباخ', 1, null, undefined, 200, 2)
    expect(balanceOf(w.worker_id).default_shift).toBe(2)

    const edited = upsertWorker('عامل وردية', 'طباخ', 1, null, w.worker_id, 200, 1)
    expect(edited.default_shift).toBe(1)
  })
})
