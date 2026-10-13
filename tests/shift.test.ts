import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../src/main/db/db'
import { updateSettings } from '../src/main/services/settingsService'
import {
  shiftWindows, shiftNumberForTime, shiftEndAfter,
  startSession, endSession, closeSessionsPastShiftEnd, getOpenSession, getHoursForPeriod,
} from '../src/main/services/shiftService'

/**
 * Shifts close when the owner says they close.
 *
 * Before this, a session ran until somebody signed out or the app was shut down. A
 * cashier who forgot on Monday night showed 52 hours by Wednesday — a real row in
 * this restaurant's books, found while auditing. The recorded end must be the shift
 * boundary the owner configured, whatever time the till is actually switched off.
 */

let userId: number

/** `YYYY-MM-DD HH:MM:SS` in local time, matching what SQLite writes. */
const stamp = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
         `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** Put an open session into the past, as if someone signed in then and never out. */
function openSessionAt(when: Date, shiftNumber: 1 | 2 = 1): number {
  const p = (n: number) => String(n).padStart(2, '0')
  return Number(getDb().prepare(`
    INSERT INTO shifts (cashier_id, shift_date, shift_number, start_time, started_at, set_by)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    userId,
    `${when.getFullYear()}-${p(when.getMonth() + 1)}-${p(when.getDate())}`,
    shiftNumber,
    `${p(when.getHours())}:${p(when.getMinutes())}`,
    stamp(when),
    userId,
  ).lastInsertRowid)
}

const shiftRow = (id: number) => getDb().prepare('SELECT * FROM shifts WHERE shift_id=?').get(id) as any

beforeAll(() => {
  initDatabase()
  userId = (getDb().prepare(`SELECT user_id FROM users WHERE username='cashier1'`).get() as any).user_id
})

beforeEach(() => {
  getDb().prepare('DELETE FROM shifts').run()
  updateSettings({
    shifts_per_day: 2,
    shift1_name: 'صباحية', shift1_start: '09:00', shift1_end: '17:00',
    shift2_name: 'مسائية', shift2_start: '17:00', shift2_end: '03:00',
  })
})

describe('the shifts the owner configured', () => {
  it('is two windows by default', () => {
    expect(shiftWindows().map(w => `${w.start}-${w.end}`)).toEqual(['09:00-17:00', '17:00-03:00'])
  })

  it('is one window when the owner asks for one, keeping the second`s times', () => {
    updateSettings({ shifts_per_day: 1 })
    expect(shiftWindows()).toHaveLength(1)
    expect(shiftNumberForTime(new Date(2026, 8, 7, 22, 0))).toBe(1) // everything is shift 1
    updateSettings({ shifts_per_day: 2 })
    expect(shiftWindows()[1].start).toBe('17:00') // not lost
  })

  it('puts a moment in the right shift, including after midnight', () => {
    expect(shiftNumberForTime(new Date(2026, 8, 7, 10, 0))).toBe(1) // 10:00 morning
    expect(shiftNumberForTime(new Date(2026, 8, 7, 16, 59))).toBe(1)
    expect(shiftNumberForTime(new Date(2026, 8, 7, 17, 0))).toBe(2) // evening begins
    expect(shiftNumberForTime(new Date(2026, 8, 7, 23, 30))).toBe(2)
    expect(shiftNumberForTime(new Date(2026, 8, 8, 1, 30))).toBe(2)  // 01:30 still evening
  })

  it('rejects a nonsense time rather than doing nonsense arithmetic with it', () => {
    updateSettings({ shift1_start: 'not a time' as any })
    expect(shiftWindows()[0].start).toBe('09:00') // falls back
  })
})

describe('when a shift is due to end', () => {
  it('ends the morning shift the same day', () => {
    const end = shiftEndAfter(new Date(2026, 8, 7, 9, 30))
    expect(stamp(end)).toBe('2026-09-07 17:00:00')
  })

  it('carries an evening shift past midnight into the next day', () => {
    // Signed in at 22:00 on the 7th; the 17:00-03:00 shift ends at 03:00 on the 8th.
    const end = shiftEndAfter(new Date(2026, 8, 7, 22, 0))
    expect(stamp(end)).toBe('2026-09-08 03:00:00')
  })

  it('ends the same day for someone who joined after midnight', () => {
    // Signed in at 01:00 on the 8th — already the far side of midnight, so the same
    // 03:00 boundary, two hours later. Getting this wrong makes it 26 hours.
    const end = shiftEndAfter(new Date(2026, 8, 8, 1, 0))
    expect(stamp(end)).toBe('2026-09-08 03:00:00')
  })

  it('handles a single shift that runs to 3am', () => {
    updateSettings({ shifts_per_day: 1, shift1_start: '11:00', shift1_end: '03:00' })
    expect(stamp(shiftEndAfter(new Date(2026, 8, 7, 12, 0)))).toBe('2026-09-08 03:00:00')
    expect(stamp(shiftEndAfter(new Date(2026, 8, 8, 2, 0)))).toBe('2026-09-08 03:00:00')
  })
})

describe('closing a session that was left open', () => {
  it('closes it at the shift end, not when the check happens to run', () => {
    const id = openSessionAt(new Date(2026, 8, 7, 22, 0), 2)
    // Two days later the till is finally switched on again.
    const closed = closeSessionsPastShiftEnd(new Date(2026, 8, 9, 11, 0))
    expect(closed).toBe(1)

    const row = shiftRow(id)
    expect(row.ended_at).toBe('2026-09-08 03:00:00')
    expect(row.end_time).toBe('03:00')

    const hours = (getDb().prepare(
      'SELECT ROUND((julianday(ended_at)-julianday(started_at))*24,2) v FROM shifts WHERE shift_id=?'
    ).get(id) as any).v
    expect(hours).toBe(5) // 22:00 -> 03:00, not the 37 it would have been
  })

  it('leaves a session that is still inside its shift alone', () => {
    const id = openSessionAt(new Date(2026, 8, 7, 22, 0), 2)
    expect(closeSessionsPastShiftEnd(new Date(2026, 8, 8, 1, 0))).toBe(0)
    expect(shiftRow(id).ended_at).toBeNull()
  })

  it('closes exactly at the boundary, not a minute early', () => {
    const id = openSessionAt(new Date(2026, 8, 7, 22, 0), 2)
    expect(closeSessionsPastShiftEnd(new Date(2026, 8, 8, 2, 59))).toBe(0)
    expect(closeSessionsPastShiftEnd(new Date(2026, 8, 8, 3, 0))).toBe(1)
    expect(shiftRow(id).ended_at).toBe('2026-09-08 03:00:00')
  })

  it('is safe to run over and over', () => {
    const id = openSessionAt(new Date(2026, 8, 7, 22, 0), 2)
    const now = new Date(2026, 8, 9, 11, 0)
    expect(closeSessionsPastShiftEnd(now)).toBe(1)
    expect(closeSessionsPastShiftEnd(now)).toBe(0)
    expect(closeSessionsPastShiftEnd(now)).toBe(0)
    expect(shiftRow(id).ended_at).toBe('2026-09-08 03:00:00') // not moved
  })

  it('closes several cashiers` sessions independently', () => {
    const other = (getDb().prepare(`SELECT user_id FROM users WHERE username='cashier2'`).get() as any).user_id
    const a = openSessionAt(new Date(2026, 8, 7, 10, 0), 1)   // morning, ends 17:00
    const b = Number(getDb().prepare(`
      INSERT INTO shifts (cashier_id, shift_date, shift_number, start_time, started_at, set_by)
      VALUES (?, '2026-09-07', 2, '22:00', '2026-09-07 22:00:00', ?)
    `).run(other, other).lastInsertRowid)

    closeSessionsPastShiftEnd(new Date(2026, 8, 9, 11, 0))
    expect(shiftRow(a).ended_at).toBe('2026-09-07 17:00:00')
    expect(shiftRow(b).ended_at).toBe('2026-09-08 03:00:00')
  })

  it('does not disturb a session that was already signed out normally', () => {
    const id = startSession(userId).shift_id
    endSession(userId)
    const closedAt = shiftRow(id).ended_at
    expect(closedAt).toBeTruthy()
    closeSessionsPastShiftEnd(new Date(2026, 8, 9, 11, 0))
    expect(shiftRow(id).ended_at).toBe(closedAt)
  })

  it('keeps the hours report honest', () => {
    openSessionAt(new Date(2026, 8, 7, 22, 0), 2)
    closeSessionsPastShiftEnd(new Date(2026, 8, 12, 11, 0))
    // Five hours worked, not the five days the till was left switched on.
    expect(getHoursForPeriod(userId, '2026-09-01', '2026-09-30')).toBe(5)
  })

  it('lets the cashier sign in again afterwards without reusing the closed row', () => {
    const old = openSessionAt(new Date(2026, 8, 7, 22, 0), 2)
    closeSessionsPastShiftEnd(new Date(2026, 8, 9, 11, 0))
    expect(getOpenSession(userId)).toBeUndefined()

    const fresh = startSession(userId)
    expect(fresh.shift_id).not.toBe(old)
    expect(fresh.ended_at).toBeNull()
  })
})
