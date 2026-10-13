import { describe, it, expect, beforeAll } from 'vitest'
import { initDatabase, getDb } from '../src/main/db/db'
import { updateSettings } from '../src/main/services/settingsService'
import { getShiftReport } from '../src/main/services/shiftReportService'
import { shiftSummaryText } from '../src/main/services/shiftExportService'
import { resolveShift, shiftLabel } from '../src/shared/shifts'

/**
 * A shop that runs ONE shift a day has no night shift to name.
 *
 * The number on a `shifts` row records which window the session fell in on the day it
 * was worked, and that is history — it is never rewritten. But the name shown for it
 * has to follow the shop as it is configured NOW. The two came apart the moment an
 * owner switched to a single shift: sessions recorded earlier still carried
 * `shift_number = 2`, so the reports, the exported file names and the message sent to
 * the restaurant's group all kept saying «مسائية» for a shift that no longer existed.
 */

describe('naming a shift', () => {
  const TWO = { shifts_per_day: 2 as const, shift1_name: 'صباحية', shift2_name: 'مسائية' }
  const ONE = { ...TWO, shifts_per_day: 1 as const }

  it('names both windows when the day is split', () => {
    expect(resolveShift(1, TWO)).toEqual({ number: 1, name: 'صباحية', icon: '☀️' })
    expect(resolveShift(2, TWO)).toEqual({ number: 2, name: 'مسائية', icon: '🌙' })
  })

  it('names everything as the single window when there is only one', () => {
    // Including a session RECORDED as shift 2, before the owner switched over. This
    // is the reported bug.
    expect(resolveShift(2, ONE)).toEqual({ number: 1, name: 'صباحية', icon: '☀️' })
    expect(resolveShift(1, ONE)).toEqual({ number: 1, name: 'صباحية', icon: '☀️' })
  })

  it('follows a renamed shift', () => {
    expect(shiftLabel(2, { ...ONE, shift1_name: 'اليوم كامل' })).toBe('اليوم كامل')
    expect(shiftLabel(2, { ...TWO, shift2_name: 'الليلية' })).toBe('الليلية')
  })

  it('falls back to the defaults rather than printing nothing', () => {
    expect(shiftLabel(1, { shifts_per_day: 2, shift1_name: '  ', shift2_name: '' })).toBe('صباحية')
    expect(shiftLabel(2, { shifts_per_day: 2, shift1_name: '', shift2_name: '   ' })).toBe('مسائية')
    expect(shiftLabel(2, undefined)).toBe('مسائية')
    expect(shiftLabel(null, undefined)).toBe('صباحية')
  })
})

describe('the exported report, on a shop that has switched to one shift', () => {
  let shiftId: number

  beforeAll(() => {
    initDatabase()
    const db = getDb()
    const userId = (db.prepare(`SELECT user_id FROM users WHERE role = 'owner'`).get() as any).user_id

    // A session recorded while the shop still ran two shifts — the night one.
    shiftId = Number(db.prepare(`
      INSERT INTO shifts (cashier_id, shift_date, shift_number, start_time, end_time,
                          started_at, ended_at, set_by)
      VALUES (?, '2026-09-10', 2, '01:58', '03:00',
              '2026-09-10 01:58:00', '2026-09-10 03:00:00', ?)
    `).run(userId, userId).lastInsertRowid)
  })

  it('still says «مسائية» while the shop really has two shifts', () => {
    updateSettings({ shifts_per_day: 2 } as never)
    expect(shiftSummaryText(getShiftReport(shiftId))).toContain('مسائية')
  })

  it('stops saying «مسائية» once the owner sets one shift a day', () => {
    updateSettings({ shifts_per_day: 1 } as never)

    const text = shiftSummaryText(getShiftReport(shiftId))
    expect(text).not.toContain('مسائية')
    expect(text).not.toContain('🌙')
    expect(text).toContain('صباحية')
    expect(text).toContain('☀️')
  })

  it('leaves the recorded number alone — the row is history, only the name follows', () => {
    const row = getDb().prepare('SELECT shift_number FROM shifts WHERE shift_id = ?')
      .get(shiftId) as any
    expect(row.shift_number).toBe(2)

    // …so switching back restores the night name rather than having lost it.
    updateSettings({ shifts_per_day: 2 } as never)
    expect(shiftSummaryText(getShiftReport(shiftId))).toContain('مسائية')
  })
})
