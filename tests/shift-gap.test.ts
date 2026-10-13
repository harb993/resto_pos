import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../src/main/db/db'
import { updateSettings } from '../src/main/services/settingsService'
import {
  shiftEndAfter, shiftNumberForTime, closeSessionsPastShiftEnd, resumeSessionForUser,
} from '../src/main/services/shiftService'
import { sweepShiftExports } from '../src/main/services/shiftExportService'

/**
 * A session opened when NO shift covers the clock.
 *
 * Shifts do not tile the day. A shop trading 10:00–04:00 is shut from 04:00 to 10:00,
 * and two shifts of 09:00–17:00 and 17:00–03:00 leave the same sort of gap. Somebody
 * signing in during one — a cashier cashing up late, an owner checking a figure at
 * dawn — opened a session the old code had nowhere to put.
 *
 * It handed the session to a window anyway, whose end had already passed that day, so
 * the end rolled to the SAME TIME TOMORROW. The result was a session of very nearly 24
 * hours that never closed and never exported, sitting on the screen all day looking
 * like the shop was still trading. Reported from this restaurant: a shift set 10:00 to
 * 04:00, still running at 04:10.
 */

let ownerId: number

const openSessionAt = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, '0')
  const ts = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:00`
  return Number(getDb().prepare(`
    INSERT INTO shifts (cashier_id, shift_date, shift_number, start_time, started_at, set_by)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(ownerId, ts.slice(0, 10), shiftNumberForTime(d), ts.slice(11, 16), ts, ownerId).lastInsertRowid)
}

const isOpen = (id: number) =>
  (getDb().prepare('SELECT ended_at FROM shifts WHERE shift_id = ?').get(id) as any).ended_at === null

const hoursBetween = (from: Date, to: Date) => (to.getTime() - from.getTime()) / 3_600_000

beforeAll(() => {
  initDatabase()
  ownerId = (getDb().prepare(`SELECT user_id FROM users WHERE role='owner'`).get() as any).user_id
})

beforeEach(() => { getDb().prepare('DELETE FROM shifts').run() })

describe('one shift a day, 10:00 to 04:00', () => {
  beforeEach(() => {
    updateSettings({ shifts_per_day: 1, shift1_start: '10:00', shift1_end: '04:00' } as never)
  })

  it('closes an evening session at 04:00 the next morning', () => {
    const id = openSessionAt(new Date(2026, 8, 13, 20, 0))

    expect(isOpen(id)).toBe(true)
    closeSessionsPastShiftEnd(new Date(2026, 8, 14, 3, 50))
    expect(isOpen(id), 'must not close early').toBe(true)

    closeSessionsPastShiftEnd(new Date(2026, 8, 14, 4, 10))
    expect(isOpen(id)).toBe(false)
  })

  it('closes a session opened after midnight at 04:00 the same morning', () => {
    const id = openSessionAt(new Date(2026, 8, 14, 1, 30))
    closeSessionsPastShiftEnd(new Date(2026, 8, 14, 4, 10))
    expect(isOpen(id)).toBe(false)
  })

  it('THE REPORTED CASE: signed in at 04:13, in the gap after the shift ended', () => {
    const started = new Date(2026, 8, 14, 4, 13)
    const due = shiftEndAfter(started)

    // Was 04:00 TOMORROW — 23.8 hours — so it never closed and never exported.
    expect(hoursBetween(started, due)).toBeLessThan(8)
    expect(due.getHours()).toBe(10)   // the next turn of the day
    expect(due.getDate()).toBe(14)    // today, not tomorrow
  })

  it('and that session does close, once the shop opens', () => {
    const id = openSessionAt(new Date(2026, 8, 14, 4, 13))
    closeSessionsPastShiftEnd(new Date(2026, 8, 14, 9, 0))
    expect(isOpen(id), 'still inside the gap').toBe(true)

    closeSessionsPastShiftEnd(new Date(2026, 8, 14, 10, 5))
    expect(isOpen(id)).toBe(false)
  })

  it('no session can ever be scheduled to outlive a day', () => {
    // Every minute of the clock, including the gap.
    for (let hour = 0; hour < 24; hour++) {
      const started = new Date(2026, 8, 14, hour, 30)
      const hours = hoursBetween(started, shiftEndAfter(started))
      expect(hours, `a session started at ${hour}:30 lasts ${hours.toFixed(1)}h`).toBeLessThanOrEqual(24)
      expect(hours).toBeGreaterThan(0)
    }
  })
})

describe('the report those sessions were owed', () => {
  /**
   * The export waits for the SHIFT to end, not for the sign-out — otherwise swapping
   * cashiers produces seven reports in ten minutes. But the shift end it waited for was
   * the broken one, so a session opened in the gap was owed a report at a time almost a
   * day away and simply never got one.
   *
   * On this restaurant's books: sessions started 03:42, 03:52 and 04:02, all signed out
   * of within ten minutes, all still showing report_exported_at = NULL hours later.
   */
  beforeEach(() => {
    updateSettings({ shifts_per_day: 1, shift1_start: '10:00', shift1_end: '04:00' } as never)
  })

  it('is written once the shift really is over', async () => {
    const id = openSessionAt(new Date(2026, 8, 14, 4, 13))
    getDb().prepare(
      `UPDATE shifts SET ended_at = '2026-09-14 04:22:00', end_time = '04:22' WHERE shift_id = ?`
    ).run(id)

    const exportedAt = () => (getDb()
      .prepare('SELECT report_exported_at FROM shifts WHERE shift_id = ?')
      .get(id) as any).report_exported_at

    // 04:30 — the shop is shut and the shift it belongs to has not turned over yet.
    await sweepShiftExports(new Date(2026, 8, 14, 4, 30))
    expect(exportedAt(), 'nothing owed yet').toBeNull()

    // 10:05 — the day has turned over. Before the fix this moment was 04:00 TOMORROW,
    // so the sweep skipped the row on every tick and the report never came.
    await sweepShiftExports(new Date(2026, 8, 14, 10, 5))
    expect(exportedAt()).not.toBeNull()
  })
})

describe('a till that is never signed out of', () => {
  /**
   * Nobody signs out of a restaurant till. It sits on the POS from open to close, and
   * usually overnight too. A session only ever opened at sign-in, so once the first one
   * was auto-closed at its shift end that till had NO session at all — every following
   * day recorded nothing and exported nothing.
   */
  const openWindowCovering = (d: Date) => {
    const p = (n: number) => String(n).padStart(2, '0')
    const from = new Date(d.getTime() - 60 * 60_000)
    const to = new Date(d.getTime() + 60 * 60_000)
    return { start: `${p(from.getHours())}:${p(from.getMinutes())}`, end: `${p(to.getHours())}:${p(to.getMinutes())}` }
  }

  it('opens the next shift for whoever is still standing there', () => {
    const w = openWindowCovering(new Date())
    updateSettings({ shifts_per_day: 1, shift1_start: w.start, shift1_end: w.end } as never)

    expect(resumeSessionForUser(ownerId), 'the shop is open and nothing is running').not.toBeNull()
    expect(resumeSessionForUser(ownerId), 'but never a second one on top').toBeNull()
  })

  it('does NOT clock anyone in while the shop is shut', () => {
    // A one-minute window an hour ago: the shop is closed right now.
    const p = (n: number) => String(n).padStart(2, '0')
    const ago = new Date(Date.now() - 60 * 60_000)
    const start = `${p(ago.getHours())}:${p(ago.getMinutes())}`
    // The end is a real minute later, not "the same hour, minute + 1": at xx:59 that
    // wrapped to xx:00, which is a window lasting 23 hours and 1 minute — one that
    // contains right now. The test then failed for one minute in every hour.
    const after = new Date(ago.getTime() + 60_000)
    const end = `${p(after.getHours())}:${p(after.getMinutes())}`
    updateSettings({ shifts_per_day: 1, shift1_start: start, shift1_end: end } as never)

    // Otherwise a till left switched on overnight quietly bills six hours of wages.
    expect(resumeSessionForUser(ownerId)).toBeNull()
  })
})

describe('two shifts, 09:00–17:00 and 17:00–03:00', () => {
  beforeEach(() => {
    updateSettings({
      shifts_per_day: 2,
      shift1_start: '09:00', shift1_end: '17:00',
      shift2_start: '17:00', shift2_end: '03:00',
    } as never)
  })

  it('still closes each shift at its own end', () => {
    const morning = openSessionAt(new Date(2026, 8, 13, 10, 0))
    closeSessionsPastShiftEnd(new Date(2026, 8, 13, 17, 5))
    expect(isOpen(morning)).toBe(false)

    const evening = openSessionAt(new Date(2026, 8, 13, 20, 0))
    closeSessionsPastShiftEnd(new Date(2026, 8, 14, 3, 5))
    expect(isOpen(evening)).toBe(false)
  })

  it('no longer strands a session opened in the 03:00–09:00 gap', () => {
    const started = new Date(2026, 8, 14, 3, 42)
    const due = shiftEndAfter(started)

    expect(hoursBetween(started, due)).toBeLessThan(8)   // was 23.3
    expect(due.getHours()).toBe(9)

    const id = openSessionAt(started)
    closeSessionsPastShiftEnd(new Date(2026, 8, 14, 9, 5))
    expect(isOpen(id)).toBe(false)
  })
})
