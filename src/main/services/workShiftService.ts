import { getDb } from '../db/db'
import log from 'electron-log/main'
import {
  shiftWindows, closingWindowAt, stamp, type ShiftWindow, type ClosingWindow,
} from './shiftService'
import type { WorkShift, WorkShiftStatus } from '../../shared/types'

/**
 * The shop's shift — «الوردية» — as a thing that is actually opened and closed.
 *
 * The `shifts` table records PEOPLE: one row per sign-in, for hours and wages. This is
 * the other thing, the one everything else hangs off: the trading period itself. An
 * invoice number, a close-out, a profit figure, a salary paid out of the drawer — each
 * belongs to exactly one of these rows, by when it happened.
 *
 * How a shift begins and ends
 * ---------------------------
 *   it ENDS    at the end time the owner set, by itself. Nobody has to remember.
 *   it BEGINS  at the start time the owner set, by itself — always. A configured start
 *              time opens a fresh shift whatever was running before it.
 *
 * Between one shift ending and the next one's start time the shop has no shift: the
 * till will not ring anything up, and the screen asks the owner whether to start one
 * now. A shift started that way is an EXTRA one — «وردية إضافية» — and it lasts until
 * the next configured start, when the regular shift takes over by itself.
 *
 * What a shift covers
 * -------------------
 * Sales can only happen while a shift is open. Everything else — an expense typed in
 * ten minutes after closing, a supplier paid in the morning before opening — is given
 * to the shift that was last running, so nothing is ever between two shifts and on
 * neither report.
 */

interface Row {
  work_shift_id: number
  shift_number: number
  opened_at: string
  closed_at: string | null
  opened_by: number | null
}

const FAR_FUTURE = new Date(9999, 11, 31)

/**
 * The table, made on first use.
 *
 * It is in schema.sql too, but a till being updated already has a database, and this
 * must exist there before the first sale after the update — whichever path the
 * start-up takes to get to it.
 */
const ready = new WeakSet<object>()
function db() {
  const database = getDb()
  if (!ready.has(database)) {
    database.exec(`CREATE TABLE IF NOT EXISTS work_shifts (
    work_shift_id INTEGER PRIMARY KEY AUTOINCREMENT,
    shift_number  INTEGER NOT NULL DEFAULT 1,
    opened_at     TEXT NOT NULL,
    closed_at     TEXT,
    -- Who started it by hand. NULL means it began by itself at its configured time.
    opened_by     INTEGER REFERENCES users(user_id),
    report_exported_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_work_shifts_opened ON work_shifts(opened_at);`)
    ready.add(database)
  }
  return database
}

const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number)
  return (h || 0) * 60 + (m || 0)
}
const parse = (s: string) => new Date(s.replace(' ', 'T'))

function windowFor(number: number): ShiftWindow {
  const windows = shiftWindows()
  return windows.find(w => w.number === number) ?? windows[0]
}

/** A clock time on the day of `base`, moved by whole days. */
function atMinutes(base: Date, dayOffset: number, minutes: number): Date {
  const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + dayOffset)
  d.setMinutes(minutes)
  return d
}

/**
 * When a shift opened at `opened` is due to end: its own end time, or the next
 * configured start — whichever comes first.
 *
 * The second half is what keeps an extra shift from swallowing tomorrow. A shop set
 * for 09:00–17:50 whose owner starts another shift at 18:00 gets one that runs until
 * 09:00, when the regular shift begins by itself; without that bound its "own end"
 * would be 17:50 the NEXT day, and the regular shift would never start at all.
 */
function scheduledEnd(number: number, opened: Date): Date {
  const endMin = toMinutes(windowFor(number).end)
  let ownEnd = atMinutes(opened, 1, endMin)
  for (const dayOffset of [0, 1, 2]) {
    const candidate = atMinutes(opened, dayOffset, endMin)
    if (candidate.getTime() > opened.getTime()) { ownEnd = candidate; break }
  }
  const nextStart = nextWindowStart(opened).start
  return nextStart.getTime() < ownEnd.getTime() ? nextStart : ownEnd
}

/**
 * The configured window `at` falls inside, with the moment that occurrence began.
 * Where two windows overlap, the one that started most recently — the newer shift is
 * the one that has taken over.
 */
function windowContaining(at: Date): { w: ShiftWindow; start: Date } | null {
  let best: { w: ShiftWindow; start: Date } | null = null
  for (const w of shiftWindows()) {
    const startMin = toMinutes(w.start)
    const length = ((toMinutes(w.end) - startMin + 1440) % 1440) || 1440
    for (const dayOffset of [-1, 0]) {
      const start = atMinutes(at, dayOffset, startMin)
      const end = new Date(start.getTime() + length * 60_000)
      if (start.getTime() <= at.getTime() && at.getTime() < end.getTime()) {
        if (!best || start.getTime() > best.start.getTime()) best = { w, start }
      }
    }
  }
  return best
}

/** The next configured start after `at` — when a shift would begin by itself. */
function nextWindowStart(at: Date): { w: ShiftWindow; start: Date } {
  let best: { w: ShiftWindow; start: Date } | null = null
  for (const w of shiftWindows()) {
    for (const dayOffset of [0, 1]) {
      const start = atMinutes(at, dayOffset, toMinutes(w.start))
      if (start.getTime() <= at.getTime()) continue
      if (!best || start.getTime() < best.start.getTime()) best = { w, start }
    }
  }
  return best!
}

const latestRow = () => db().prepare(
  `SELECT * FROM work_shifts ORDER BY opened_at DESC, work_shift_id DESC LIMIT 1`,
).get() as Row | undefined

const openRow = () => db().prepare(
  `SELECT * FROM work_shifts WHERE closed_at IS NULL ORDER BY opened_at DESC LIMIT 1`,
).get() as Row | undefined

function insert(number: number, openedAt: Date, by: number | null): Row {
  const id = db().prepare(
    `INSERT INTO work_shifts (shift_number, opened_at, opened_by) VALUES (?, ?, ?)`,
  ).run(number, stamp(openedAt), by).lastInsertRowid as number
  log.info(`[WorkShift] #${id} (shift ${number}) opened at ${stamp(openedAt)}${by ? ` by user ${by}` : ' automatically'}`)
  return db().prepare('SELECT * FROM work_shifts WHERE work_shift_id = ?').get(id) as Row
}

/**
 * Bring the shift up to date with the clock: close one whose end time has passed, and
 * open the next when its start time has come.
 *
 * Called on the minute tick and before anything that depends on the answer, so it does
 * not matter whether the till was running when the hour struck. Returns true when
 * something changed.
 */
export function tickWorkShift(now = new Date()): boolean {
  const changed = advance(now)
  // Said once, from here, whoever happened to notice first. The clock is checked from
  // several places — the minute tick, a screen asking for the status, a sale being
  // rung up — and whichever gets there first does the closing; if only the minute
  // tick announced it, a shift closed by a screen's own question would end silently
  // and every other screen would go on showing it as open.
  if (changed && listener) {
    const notify = listener
    setImmediate(() => { try { notify() } catch (err) { log.warn('[WorkShift] Listener failed:', err) } })
  }
  return changed
}

let listener: (() => void) | null = null

/** Be told whenever a shift ends or begins. One listener: the main process's broadcast. */
export function onWorkShiftChanged(fn: (() => void) | null): void {
  listener = fn
}

function advance(now: Date): boolean {
  let changed = false

  const open = openRow()
  if (open) {
    const due = scheduledEnd(open.shift_number, parse(open.opened_at))
    if (due.getTime() <= now.getTime()) {
      db().prepare(`UPDATE work_shifts SET closed_at = ? WHERE work_shift_id = ?`)
        .run(stamp(due), open.work_shift_id)
      log.info(`[WorkShift] #${open.work_shift_id} closed at its ${stamp(due)} end`)
      changed = true
    } else {
      return false
    }
  }

  const last = latestRow()
  const inside = windowContaining(now)

  if (!last) {
    // The very first shift on these books. Opened whatever the hour, so a till
    // installed at midday — or at midnight — can trade straight away instead of
    // sitting dead until the next start time comes round.
    if (inside) insert(inside.w.number, inside.start, null)
    else insert(nextWindowStart(now).w.number, now, null)
    return true
  }

  // The start time the owner set has come, and this occurrence has not had its shift:
  // nothing on the books was opened at or after that start. (Whatever was running
  // before it has just been closed above — a configured start is one of its bounds.)
  if (inside && parse(last.opened_at).getTime() < inside.start.getTime()) {
    insert(inside.w.number, inside.start, null)
    return true
  }

  return changed
}

/**
 * The owner starting a shift between the configured ones — «وردية إضافية».
 *
 * It runs until the next configured start (see scheduledEnd), at which point the
 * regular shift opens by itself exactly as it would have.
 */
export function startWorkShiftManually(userId: number, now = new Date()): WorkShift {
  tickWorkShift(now)
  if (openRow()) throw new Error('توجد وردية مفتوحة بالفعل')
  const row = insert(nextWindowStart(now).w.number, now, userId)
  if (listener) setImmediate(listener)
  return describe(row)
}

/**
 * «تقفيل» — end the running shift now, rather than at its configured time.
 *
 * The till closes when the last customer has gone, which is not always the minute the
 * settings say. Ending it here closes the books for that shift on the spot: the slip
 * printed next is final, and the till takes no more sales until the next shift starts
 * — by itself at its configured time, or by the owner before that.
 *
 * With nothing running (the shift already ended at its time) this changes nothing and
 * names the shift that ended last, so the slip for it can still be printed.
 */
export function closeWorkShiftNow(now = new Date()): { closed: boolean; shift: WorkShift | null } {
  tickWorkShift(now)
  const open = openRow()
  if (!open) {
    const last = latestRow()
    return { closed: false, shift: last ? describe(last) : null }
  }

  // Never before it began: a clock that has been put back must not produce a shift
  // that ends before its own start.
  const at = Math.max(now.getTime(), parse(open.opened_at).getTime())
  db().prepare(`UPDATE work_shifts SET closed_at = ? WHERE work_shift_id = ?`)
    .run(stamp(new Date(at)), open.work_shift_id)
  log.info(`[WorkShift] #${open.work_shift_id} closed by hand at ${stamp(new Date(at))}`)
  if (listener) setImmediate(listener)

  const row = db().prepare('SELECT * FROM work_shifts WHERE work_shift_id = ?').get(open.work_shift_id) as Row
  return { closed: true, shift: describe(row) }
}

function describe(row: Row): WorkShift {
  const opened = parse(row.opened_at)
  const end = row.closed_at ? parse(row.closed_at) : scheduledEnd(row.shift_number, opened)
  const next = db().prepare(
    `SELECT opened_at FROM work_shifts WHERE opened_at > ? ORDER BY opened_at LIMIT 1`,
  ).get(row.opened_at) as { opened_at: string } | undefined

  return {
    workShiftId: row.work_shift_id,
    shiftNumber: row.shift_number === 2 ? 2 : 1,
    // One started by hand between the configured shifts is its own thing, not a
    // second «صباحية» on the same day.
    name: row.opened_by != null ? 'إضافية' : windowFor(row.shift_number).name,
    date: row.opened_at.slice(0, 10),
    openedAt: row.opened_at.slice(0, 16),
    endsAt: stamp(end).slice(0, 16),
    isOpen: !row.closed_at,
    manual: row.opened_by != null,
    from: row.opened_at,
    to: next ? next.opened_at : stamp(FAR_FUTURE),
  }
}

/** What the screens need to know: is a shift running, and if not, when does one start. */
export function getWorkShiftStatus(now = new Date()): WorkShiftStatus {
  tickWorkShift(now)
  const open = openRow()
  const last = latestRow()
  const next = open ? null : nextWindowStart(now)
  return {
    open: open ? describe(open) : null,
    last: !open && last ? describe(last) : null,
    next: next ? { shiftNumber: next.w.number, name: next.w.name, startsAt: stamp(next.start).slice(0, 16) } : null,
  }
}

/** Refuse to trade outside a shift — with the reason, and what will end the wait. */
export function requireOpenWorkShift(now = new Date()): WorkShift {
  const status = getWorkShiftStatus(now)
  if (status.open) return status.open
  const when = status.next ? ` — الوردية التالية تبدأ ${status.next.startsAt.slice(11)}` : ''
  throw new Error(`لا توجد وردية مفتوحة. اطلب من المدير بدء وردية جديدة${when}`)
}

export function listWorkShifts(limit = 90): WorkShift[] {
  const rows = db().prepare(
    `SELECT * FROM work_shifts ORDER BY opened_at DESC, work_shift_id DESC LIMIT ?`,
  ).all(Math.max(1, Math.min(500, limit))) as Row[]
  return rows.map(describe)
}

function toWindow(row: Row): ClosingWindow {
  const d = describe(row)
  return {
    number: d.shiftNumber,
    name: d.name,
    start: parse(d.from),
    scheduledEnd: parse(d.endsAt.length === 16 ? `${d.endsAt}:00` : d.endsAt),
    coverEnd: parse(d.to),
  }
}

export function workShiftWindow(workShiftId: number): ClosingWindow {
  const row = db().prepare('SELECT * FROM work_shifts WHERE work_shift_id = ?')
    .get(workShiftId) as Row | undefined
  if (!row) throw new Error(`الوردية ${workShiftId} غير موجودة`)
  return toWindow(row)
}

/**
 * The shift to report on when nobody named one: the one running, else the last one.
 *
 * Books from before shifts were opened and closed have no rows at all; those fall back
 * to the hours in the settings, which is what every report used until now.
 */
export function currentWorkWindow(now = new Date()): ClosingWindow {
  const row = openRow() ?? latestRow()
  return row ? toWindow(row) : closingWindowAt(now)
}

/** Closed shifts whose close-out files have not been written yet. */
export function workShiftsAwaitingExport(): number[] {
  return (db().prepare(`
    SELECT work_shift_id FROM work_shifts
    WHERE closed_at IS NOT NULL AND report_exported_at IS NULL
    ORDER BY closed_at LIMIT 20
  `).all() as { work_shift_id: number }[]).map(r => r.work_shift_id)
}

export function markWorkShiftExported(workShiftId: number): void {
  db().prepare(
    `UPDATE work_shifts SET report_exported_at = datetime('now','localtime') WHERE work_shift_id = ?`,
  ).run(workShiftId)
}
