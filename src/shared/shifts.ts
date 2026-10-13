/**
 * What to CALL a shift — one rule, used by every screen, every report and every
 * exported file.
 *
 * The number stored on a `shifts` row records which window the session fell in on the
 * day it was worked. That number is history and is never rewritten. But the NAME shown
 * for it has to follow the shop as it is configured now, and those two came apart the
 * moment an owner switched to a single shift a day: sessions recorded earlier still
 * carried `shift_number = 2`, so a restaurant running one shift kept seeing — and
 * exporting, and sending to its group — reports headed «مسائية» for a night shift it
 * no longer has.
 *
 * So: with one shift a day there is exactly one window, and everything belongs to it,
 * whatever is stamped on the row. With two, 2 means the second and anything else means
 * the first. Every caller goes through here rather than repeating
 * `n === 1 ? shift1_name : shift2_name`, which is the shape that let six copies of
 * this decision drift apart in the first place.
 */

export interface ShiftNaming {
  /** 1 or 2. One means a single window covers the whole trading day. */
  shifts_per_day: 1 | 2
  shift1_name: string
  shift2_name: string
}

export interface ResolvedShift {
  /** The window it is shown as belonging to — 1 whenever the shop runs one shift. */
  number: 1 | 2
  name: string
  /** ☀️ for the day window, 🌙 for the night one. */
  icon: string
}

export function resolveShift(
  shiftNumber: number | null | undefined,
  settings: Partial<ShiftNaming> | null | undefined,
): ResolvedShift {
  const first = settings?.shift1_name?.trim() || 'صباحية'
  const second = settings?.shift2_name?.trim() || 'مسائية'

  // A shop with one shift a day has no second window to name. Checked before the
  // stored number, which is exactly the case that used to leak «مسائية» through.
  const single = Number(settings?.shifts_per_day ?? 2) === 1

  if (!single && Number(shiftNumber) === 2) {
    return { number: 2, name: second, icon: '🌙' }
  }
  return { number: 1, name: first, icon: '☀️' }
}

/** Just the name — the common case, for a heading or a file name. */
export function shiftLabel(
  shiftNumber: number | null | undefined,
  settings: Partial<ShiftNaming> | null | undefined,
): string {
  return resolveShift(shiftNumber, settings).name
}
