import { getDb } from '../db/db'
import log from 'electron-log/main'
import { getSettings } from './settingsService'
import type { Shift } from '../../shared/types'

/**
 * Shifts are RECORDED, not assigned.
 *
 * A row is opened automatically when a user signs in and closed when they sign out
 * (or when the app shuts down with a session still open). Hours come from the gap
 * between those two timestamps, so the log reflects what was actually worked rather
 * than what someone typed in afterwards.
 */

/** Minutes since midnight, for comparing a clock time against the shift windows. */
function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  return (h || 0) * 60 + (m || 0)
}

export interface ShiftWindow {
  number: 1 | 2
  name: string
  /** `HH:MM` */
  start: string
  /** `HH:MM`. Earlier than `start` means the shift runs past midnight. */
  end: string
}

/**
 * The shifts the owner has configured — one window or two.
 *
 * With one shift a day the whole trading day is a single window, and shift 2's times
 * stay in the settings untouched so switching back to two restores them.
 */
export function shiftWindows(): ShiftWindow[] {
  const s = getSettings()
  const first: ShiftWindow = { number: 1, name: s.shift1_name, start: s.shift1_start, end: s.shift1_end }
  if (s.shifts_per_day === 1) return [first]
  return [first, { number: 2, name: s.shift2_name, start: s.shift2_start, end: s.shift2_end }]
}

/** Whether a clock time (minutes past midnight) is inside a window that may wrap. */
function within(minutes: number, startMin: number, endMin: number): boolean {
  if (endMin === startMin) return true            // a full 24-hour window
  return endMin > startMin
    ? minutes >= startMin && minutes < endMin
    : minutes >= startMin || minutes < endMin     // wraps past midnight
}

/**
 * Which configured shift a moment belongs to.
 *
 * With one shift a day the answer is always 1. With two, shift 1 owns its own window
 * and shift 2 gets everything else — including the small hours, which is where a
 * night shift's sales actually land.
 */
export function shiftNumberForTime(date = new Date()): 1 | 2 {
  const windows = shiftWindows()
  if (windows.length === 1) return 1

  const now = date.getHours() * 60 + date.getMinutes()
  const first = windows[0]
  return within(now, toMinutes(first.start), toMinutes(first.end)) ? 1 : 2
}

/**
 * The moment the shift covering `started` is due to end.
 *
 * This is what closes a session at the time the owner set rather than whenever the
 * till happens to be switched off. A shift that runs 17:00 → 03:00 and was opened at
 * 22:00 ends at 03:00 the NEXT day; the same shift joined at 01:00 ends at 03:00 the
 * same day. Getting that wrap wrong is the difference between a 5-hour shift and a
 * 29-hour one.
 */
export function shiftEndAfter(started: Date): Date {
  const windows = shiftWindows()

  const startedMin = started.getHours() * 60 + started.getMinutes()

  /** The window whose hours actually contain the moment the session began. */
  const owning = windows.find(w => within(startedMin, toMinutes(w.start), toMinutes(w.end)))

  if (owning) {
    // The ordinary case, unchanged: a session ends when ITS shift ends, at the time
    // the owner set — whether that is later today or after midnight.
    const startMin = toMinutes(owning.start)
    const endMin = toMinutes(owning.end)

    const end = new Date(started)
    end.setSeconds(0, 0)
    end.setHours(Math.floor(endMin / 60), endMin % 60)

    const wraps = endMin <= startMin
    if (wraps && startedMin >= startMin) end.setDate(end.getDate() + 1)
    else if (end.getTime() <= started.getTime()) end.setDate(end.getDate() + 1)

    return end
  }

  /*
    Nothing covers this moment — so end at the next shift BOUNDARY instead.

    Two shifts of 09:00–17:00 and 17:00–03:00 leave 03:00–09:00 uncovered, and a till
    signed into at 03:42 used to be handed to shift 2 regardless, whose 03:00 end had
    already gone. The end rolled to 03:00 TOMORROW: a 23-hour session that sat there
    all day looking like it was still trading, never closing and never exporting.
    Measured on this restaurant's own books.

    Every start and every end is a boundary — the moments the shop's day turns over.
    Taking the nearest one ends that 03:42 session at 09:00, when the shift that does
    cover the day begins. No session can outlive the next turn of the day.
  */
  const boundaries = windows.flatMap(w => [toMinutes(w.start), toMinutes(w.end)])
  const atMidnight = new Date(started)
  atMidnight.setHours(0, 0, 0, 0)

  let best: Date | null = null
  for (const minutes of boundaries) {
    for (const dayOffset of [0, 1]) {
      const candidate = new Date(atMidnight)
      candidate.setDate(candidate.getDate() + dayOffset)
      candidate.setMinutes(minutes)
      if (candidate.getTime() <= started.getTime()) continue
      if (!best || candidate.getTime() < best.getTime()) best = candidate
    }
  }

  // Only reachable if the windows describe no boundary at all. A day later is the
  // only truthful answer, and still bounded.
  if (!best) {
    best = new Date(started)
    best.setSeconds(0, 0)
    best.setDate(best.getDate() + 1)
  }

  return best
}

export interface ClosingWindow {
  number: 1 | 2
  name: string
  /** When this shift began. */
  start: Date
  /** When it is due to end, as the owner configured it. */
  scheduledEnd: Date
  /** When the NEXT shift begins — what the close-out's figures run up to. */
  coverEnd: Date
}

/** The window that began at `start`, with its two ends worked out. */
function closingWindowFrom(w: ShiftWindow, start: Date, windows: ShiftWindow[]): ClosingWindow {
  const startMin = toMinutes(w.start)
  const length = ((toMinutes(w.end) - startMin + 1440) % 1440) || 1440
  const scheduledEnd = new Date(start.getTime())
  scheduledEnd.setMinutes(scheduledEnd.getMinutes() + length)

  // The figures run to the next shift's START rather than this one's end. Shifts do
  // not tile the day — 10:00–04:00 leaves six hours uncovered — and an invoice rung up
  // at 04:20 by somebody closing late has to land in a close-out, not between two.
  let coverEnd: Date | null = null
  for (const other of windows) {
    for (const dayOffset of [0, 1, 2]) {
      const candidate = new Date(start.getFullYear(), start.getMonth(), start.getDate() + dayOffset)
      candidate.setMinutes(toMinutes(other.start))
      if (candidate.getTime() <= start.getTime()) continue
      if (!coverEnd || candidate.getTime() < coverEnd.getTime()) coverEnd = candidate
    }
  }

  return { number: w.number, name: w.name, start, scheduledEnd, coverEnd: coverEnd ?? scheduledEnd }
}

/**
 * The configured shift a moment belongs to, for the close-out.
 *
 * The shift running at `at`, or — when the shop is shut — the one that ended last, so
 * a cashier cashing up ten minutes after the shift ended still gets that shift.
 */
export function closingWindowAt(at = new Date()): ClosingWindow {
  const windows = shiftWindows()
  let best: { w: ShiftWindow; start: Date } | null = null

  for (const w of windows) {
    for (const dayOffset of [-1, 0]) {
      const start = new Date(at.getFullYear(), at.getMonth(), at.getDate() + dayOffset)
      start.setMinutes(toMinutes(w.start))
      if (start.getTime() > at.getTime()) continue
      if (!best || start.getTime() > best.start.getTime()) best = { w, start }
    }
  }

  // Unreachable — every window started at some point in the last two days.
  if (!best) best = { w: windows[0], start: new Date(at.getFullYear(), at.getMonth(), at.getDate()) }
  return closingWindowFrom(best.w, best.start, windows)
}

/** A named shift on a given day (`YYYY-MM-DD` is the day it STARTED). */
export function closingWindowOn(date: string, shiftNumber: number): ClosingWindow {
  const windows = shiftWindows()
  const w = windows.find(x => x.number === shiftNumber) ?? windows[0]
  const [y, m, d] = date.split('-').map(Number)
  const start = new Date(y, (m || 1) - 1, d || 1)
  if (Number.isNaN(start.getTime())) throw new Error('تاريخ غير صحيح')
  start.setMinutes(toMinutes(w.start))
  return closingWindowFrom(w, start, windows)
}

/** The session a user currently has open, if any. */
export function getOpenSession(userId: number): Shift | undefined {
  return getDb().prepare(`
    SELECT * FROM shifts WHERE cashier_id = ? AND ended_at IS NULL
    ORDER BY started_at DESC LIMIT 1
  `).get(userId) as Shift | undefined
}

/**
 * Open a shift on sign-in. If the user already has one open — the app crashed, or
 * they signed in twice — that one is reused so the day does not fill with stubs.
 */
export function startSession(userId: number): Shift {
  const db = getDb()

  const existing = getOpenSession(userId)
  if (existing) {
    log.info(`[Shift] Reusing open session #${existing.shift_id} for user ${userId}`)
    return existing
  }

  const now = new Date()
  const shiftNumber = shiftNumberForTime(now)
  const pad = (n: number) => String(n).padStart(2, '0')
  const clock = `${pad(now.getHours())}:${pad(now.getMinutes())}`

  const res = db.prepare(`
    INSERT INTO shifts (cashier_id, shift_date, shift_number, start_time, started_at, set_by)
    VALUES (?, date('now','localtime'), ?, ?, datetime('now','localtime'), ?)
  `).run(userId, shiftNumber, clock, userId)

  const id = res.lastInsertRowid as number
  log.info(`[Shift] Opened session #${id} for user ${userId} (shift ${shiftNumber} at ${clock})`)
  return db.prepare('SELECT * FROM shifts WHERE shift_id = ?').get(id) as Shift
}

/** Close a user's open session on sign-out. No-op when nothing is open. */
export function endSession(userId: number): void {
  const db = getDb()
  const open = getOpenSession(userId)
  if (!open) return

  db.prepare(`
    UPDATE shifts
    SET ended_at = datetime('now','localtime'),
        end_time = strftime('%H:%M','now','localtime')
    WHERE shift_id = ?
  `).run(open.shift_id)

  const row = db.prepare(`
    SELECT ROUND((julianday(ended_at) - julianday(started_at)) * 24, 2) AS hours
    FROM shifts WHERE shift_id = ?
  `).get(open.shift_id) as { hours: number }

  log.info(`[Shift] Closed session #${open.shift_id} for user ${userId} — ${row.hours}h`)
}

/** `YYYY-MM-DD HH:MM:SS` in local time, the format every timestamp column uses. */
export function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
         `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/**
 * Close every session whose shift has already ended, at the time it was due to end.
 *
 * This is the answer to a till left signed in overnight. Before it existed a session
 * ran until somebody signed out or the app was shut down, so a cashier who forgot on
 * Monday showed 52 hours by Wednesday — a real row in this restaurant's books.
 *
 * The recorded end is the SHIFT boundary, not the moment this happens to run. That is
 * the whole point: the owner says when a shift ends, and the books say the same thing
 * whether the till was switched off at 3am, at noon, or left running all week.
 *
 * Safe to call as often as you like — a session whose end has not yet passed is left
 * alone, so nothing is closed early.
 */
export function closeSessionsPastShiftEnd(now = new Date()): number {
  const db = getDb()
  const open = db.prepare(`
    SELECT shift_id, cashier_id, started_at FROM shifts
    WHERE ended_at IS NULL AND started_at IS NOT NULL
  `).all() as { shift_id: number; cashier_id: number; started_at: string }[]

  if (open.length === 0) return 0

  const close = db.prepare(`
    UPDATE shifts SET ended_at = ?, end_time = ? WHERE shift_id = ?
  `)
  let closed = 0

  const run = db.transaction(() => {
    for (const s of open) {
      // SQLite writes 'YYYY-MM-DD HH:MM:SS'; Date wants the T to parse it as local.
      const started = new Date(s.started_at.replace(' ', 'T'))
      if (Number.isNaN(started.getTime())) continue

      const due = shiftEndAfter(started)
      if (due.getTime() > now.getTime()) continue // still within its shift

      const p = (n: number) => String(n).padStart(2, '0')
      close.run(stamp(due), `${p(due.getHours())}:${p(due.getMinutes())}`, s.shift_id)
      closed++
      log.info(`[Shift] Auto-closed session #${s.shift_id} (user ${s.cashier_id}) at its ${p(due.getHours())}:${p(due.getMinutes())} shift end`)
    }
  })
  run()

  return closed
}

/**
 * Start the next shift for whoever is still standing at the till.
 *
 * A session only ever opened at sign-in, and nobody signs out of a restaurant till —
 * it stays on the POS from open to close, and often all night. So once a session was
 * auto-closed at its shift end, that till had NO session at all: the next day's sales
 * belonged to nothing, the الورديات screen showed an empty day, and no report was ever
 * exported again. The shift closed exactly once and then the books went quiet.
 *
 * Called on the same minute tick as the close, so the handover happens by itself:
 * shift 1 ends at 17:00, its report goes out, and shift 2 opens on the same tick with
 * the same person signed in.
 *
 * Only inside a shift. Between 04:00 and 10:00 the shop is shut, and a till left
 * switched on must not quietly clock somebody in for those six hours — that is how a
 * five-hour shift becomes an eleven-hour one in the wage sheet.
 */
export function resumeSessionForUser(userId: number, now = new Date()): Shift | null {
  if (getOpenSession(userId)) return null // already trading

  const minutes = now.getHours() * 60 + now.getMinutes()
  const trading = shiftWindows().some(w => within(minutes, toMinutes(w.start), toMinutes(w.end)))
  if (!trading) return null // the shop is shut

  const shift = startSession(userId)
  log.info(`[Shift] New shift began — opened session #${shift.shift_id} for the signed-in user ${userId}`)
  return shift
}

/**
 * Close anything still open. Called on shutdown so a session is not left running
 * forever when the till is switched off without signing out.
 */
export function endAllOpenSessions(): number {
  const res = getDb().prepare(`
    UPDATE shifts
    SET ended_at = datetime('now','localtime'),
        end_time = strftime('%H:%M','now','localtime')
    WHERE ended_at IS NULL AND started_at IS NOT NULL
  `).run()

  if (res.changes > 0) log.info(`[Shift] Closed ${res.changes} open session(s) on shutdown`)
  return res.changes
}

export function listShifts(filters: {
  cashierId?: number
  dateFrom?: string
  dateTo?: string
} = {}): Shift[] {
  const db = getDb()
  const conditions: string[] = []
  const params: any[] = []

  if (filters.cashierId) {
    conditions.push('s.cashier_id = ?')
    params.push(filters.cashierId)
  }
  if (filters.dateFrom) {
    conditions.push('s.shift_date >= ?')
    params.push(filters.dateFrom)
  }
  if (filters.dateTo) {
    conditions.push('s.shift_date <= ?')
    params.push(filters.dateTo)
  }

  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : ''

  // A session still running is measured up to now, so the screen shows time building
  // up live rather than a blank until sign-out.
  return db.prepare(`
    SELECT s.*, u.full_name as cashier_name, u.slot as cashier_slot,
      ROUND(
        (julianday(COALESCE(s.ended_at, datetime('now','localtime'))) - julianday(s.started_at)) * 24,
        2
      ) AS hours_worked,
      (s.ended_at IS NULL) AS is_open
    FROM shifts s JOIN users u ON u.user_id = s.cashier_id
    ${where}
    ORDER BY s.shift_date DESC, s.started_at DESC
    LIMIT 500
  `).all(...params) as Shift[]
}

/** Total hours a user worked over a period — the basis for any hours-based report. */
export function getHoursForPeriod(userId: number, dateFrom: string, dateTo: string): number {
  const row = getDb().prepare(`
    SELECT ROUND(SUM(
      (julianday(COALESCE(ended_at, datetime('now','localtime'))) - julianday(started_at)) * 24
    ), 2) AS hours
    FROM shifts
    WHERE cashier_id = ? AND shift_date >= ? AND shift_date <= ? AND started_at IS NOT NULL
  `).get(userId, dateFrom, dateTo) as { hours: number | null }
  return row.hours ?? 0
}
