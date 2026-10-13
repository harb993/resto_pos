/**
 * What time this till thinks it is.
 *
 * On a standalone or master machine that is simply the machine's own clock. On a NODE
 * it is the master's clock, because the two tills have to agree.
 *
 * Why it matters: every row in the books is written on the master and stamped with
 * the master's time, so the DATA was never at risk. But the screens were reading the
 * local clock to work out what "today" means, which shift a sale belongs to, and how
 * long an order has been out with a driver. Two shop PCs drift apart by minutes over
 * a few months, and nobody ever sets them — so the same day's takings could be
 * filtered differently on the two machines, and near midnight they disagreed about
 * which day it was at all. A cashier reading one screen and an owner reading the
 * other saw different numbers and neither was obviously wrong.
 *
 * The offset arrives on the `app:masterLink` event, derived from the heartbeat the
 * master already sends every ten seconds. It is zero whenever there is no master to
 * follow, which is exactly when the local clock is the right answer anyway.
 */

let offsetMs = 0

/** Fed from App.tsx whenever the master link reports in. */
export function setMasterOffset(ms: number | undefined | null): void {
  offsetMs = Number.isFinite(ms as number) ? (ms as number) : 0
}

export function masterOffsetMs(): number {
  return offsetMs
}

/** Milliseconds since the epoch, on the master's clock. */
export function nowMs(): number {
  return Date.now() + offsetMs
}

export function now(): Date {
  return new Date(nowMs())
}

/** `YYYY-MM-DD` for today, as the master reckons it. */
export function todayStr(): string {
  return dateStr(now())
}

export function dateStr(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** `YYYY-MM-DD` for n days before today. */
export function daysAgoStr(n: number): string {
  const d = now()
  d.setDate(d.getDate() - n)
  return dateStr(d)
}

/**
 * SQLite writes `YYYY-MM-DD HH:MM:SS` with a space; Safari and some Chromium builds
 * refuse that in `new Date()`. Every screen that reads a timestamp out of the
 * database needs this, so it lives here rather than being re-typed in each one.
 */
export function parseDbTime(value: string | null | undefined): Date | null {
  if (!value) return null
  const d = new Date(value.replace(' ', 'T'))
  return Number.isNaN(d.getTime()) ? null : d
}

/** How long ago that timestamp was, in minutes, on the master's clock. */
export function minutesSince(value: string | null | undefined): number | null {
  const d = parseDbTime(value)
  if (!d) return null
  return Math.floor((nowMs() - d.getTime()) / 60000)
}

/** "45 د" / "2 س 10 د" — how long something has been sitting. */
export function elapsedSince(value: string | null | undefined): string {
  const mins = minutesSince(value)
  if (mins === null || mins < 0) return ''
  if (mins < 60) return `${mins} د`
  return `${Math.floor(mins / 60)} س ${mins % 60} د`
}

/** `HH:MM` of a database timestamp. */
export function timeOf(value: string | null | undefined): string {
  const d = parseDbTime(value)
  if (!d) return ''
  return d.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' })
}
