import { getDb } from '../db/db'
import type { AppSettings } from '../../shared/types'

export function getSettings(): AppSettings {
  const db = getDb()
  const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[]
  const map: Record<string, string> = {}
  for (const r of rows) map[r.key] = r.value
  return {
    // A rate of 0 is a real answer — a shop that charges no VAT — so it must survive
    // rather than be read as "unset" and replaced by the default. Anything that is not
    // a number at all does fall back, because a NaN here would spread through every
    // total on the screen and the receipt.
    tax_rate: clampFloat(map.tax_rate, 0.14, 0, 1),
    currency_symbol: map.currency_symbol || 'EGP',
    business_name: map.business_name || 'Restaurant',
    business_address: map.business_address || '',
    business_phone: map.business_phone || '',
    receipt_footer: map.receipt_footer || '',
    max_cashier_discount: parseFloat(map.max_cashier_discount || '10'),
    backup_folder: map.backup_folder || '',
    // How the day is divided. One shift means the whole trading day is a single
    // window — the second shift's times are kept but ignored, so switching back to
    // two does not lose them.
    shifts_per_day: clampInt(map.shifts_per_day, 2, 1, 2) as 1 | 2,
    shift1_name: map.shift1_name || 'صباحية',
    shift1_start: hhmm(map.shift1_start, '09:00'),
    shift1_end: hhmm(map.shift1_end, '17:00'),
    shift2_name: map.shift2_name || 'مسائية',
    shift2_start: hhmm(map.shift2_start, '17:00'),
    shift2_end: hhmm(map.shift2_end, '01:00'),
    // Printing. A till that has to be told to print every sale is a till that
    // eventually forgets, so automatic is the default.
    print_auto: map.print_auto === undefined ? 1 : Number(map.print_auto) ? 1 : 0,
    print_logo: map.print_logo === undefined ? 1 : Number(map.print_logo) ? 1 : 0,
    print_feed_lines: clampInt(map.print_feed_lines, 2, 0, 12),
    print_font_scale: clampInt(map.print_font_scale, 100, 70, 200),
    // Networking. Defaults to standalone, so an existing till keeps behaving exactly
    // as it did until somebody deliberately makes it a master or a node.
    net_mode: ['standalone', 'master', 'node'].includes(map.net_mode) ? map.net_mode : 'standalone',
    net_port: clampInt(map.net_port, 47615, 1024, 65535),
    net_token: map.net_token || '',
    // Which shop this till belongs to, and the master that adopted it. A node needs
    // no address any more — the master dials it — so all it keeps is a name to show.
    net_fleet_id: map.net_fleet_id || '',
    net_master_name: map.net_master_name || '',
    // A lock is the master's decision, so it has to outlive a reboot of the till it
    // was applied to — otherwise switching the machine off and on again would be the
    // way around it. The master re-asserts it on every link anyway; this covers the
    // case where the till comes back up before the master does.
    net_locked: map.net_locked === '1' ? 1 : 0,
    net_lock_reason: map.net_lock_reason || '',
    // The master's list of tills, as JSON. Kept here rather than in a table of its
    // own because it is a handful of rows that change only when somebody adds or
    // removes a machine, and a schema migration would buy nothing.
    net_tills: map.net_tills || '[]',
    // The nightly backup. 0–23; 3am by default, when nobody is trading.
    backup_hour: clampInt(map.backup_hour, 3, 0, 23),
    /** `YYYY-MM-DD` of the last successful daily backup, so a missed night is caught. */
    backup_last_daily: map.backup_last_daily || '',
    // The end-of-shift report. On by default: the whole point is that it happens
    // without anybody at 1am remembering to press anything.
    shift_export_auto: map.shift_export_auto === undefined ? 1 : Number(map.shift_export_auto) ? 1 : 0,
    shift_export_folder: map.shift_export_folder || '',
    /** The restaurant's group: an invite link, a phone number, or empty. */
    whatsapp_group: map.whatsapp_group || '',
  }
}

/**
 * A `HH:MM` clock time, or the fallback.
 *
 * These drive when a shift is closed automatically, so a value that does not parse
 * must not reach that arithmetic — a bad string would otherwise become NaN minutes
 * and either close every session immediately or never close one at all.
 */
function hhmm(raw: string | undefined, fallback: string): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(raw ?? '').trim())
  if (!m) return fallback
  const h = Number(m[1]), min = Number(m[2])
  if (h > 23 || min > 59) return fallback
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`
}

/**
 * The same, for a fractional value. Kept separate from clampInt because the tax rate
 * is the one setting where 0 and "missing" must not be confused: an empty string or a
 * corrupt value falls back, but a genuine 0 is returned as 0.
 */
function clampFloat(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = parseFloat(String(raw ?? '').trim())
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}

/** Settings arrive as text and are typed in by hand — never trust the stored value. */
function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = parseInt(raw ?? '', 10)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}

export function updateSettings(settings: Partial<AppSettings>): void {
  const db = getDb()
  const upsert = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
  const txn = db.transaction(() => {
    for (const [k, v] of Object.entries(settings)) {
      if (v !== undefined) upsert.run(k, String(v))
    }
  })
  txn()
}
