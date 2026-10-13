/**
 * The nightly backup, and getting a copy of it onto the other till.
 *
 * Two things were wrong before this existed.
 *
 * The first is that every backup lived on the master and nowhere else. Losing that
 * one PC — a dead disk, a stolen machine, a power supply taking the drive with it —
 * lost the shop's entire trading history at the same moment, which is precisely the
 * event backups exist for. So the master now pushes each night's snapshot down the
 * link to every till it owns, and each till keeps it in its own backups folder. Two
 * machines, two full copies, no USB stick to remember.
 *
 * The second is that backups could fail SILENTLY. A real shop ran a whole day with
 * `Hourly backup failed: disk I/O error` repeating in a log file nobody opens, while
 * the screen said nothing at all. A backup that is not happening is worth
 * interrupting somebody about, so a failure now raises an alert on the master's
 * screens and keeps raising it until a backup succeeds.
 */

import fs from 'node:fs'
import log from 'electron-log/main'
import { runBackup } from '../db/db'
import { getSettings, updateSettings } from '../services/settingsService'
import { sendFileToNodes } from '../net/masterLink'
import { broadcast } from '../ipc/broadcast'

/** Checked every few minutes rather than aimed at the exact hour, because a timer set
 *  hours ahead does not survive the machine sleeping — and a till that wakes at 09:00
 *  would otherwise skip the night entirely. */
const TICK_MS = 5 * 60 * 1000

let timer: NodeJS.Timeout | null = null
let lastFailure: { at: number; error: string } | null = null
let running = false

export interface BackupHealth {
  lastDailyDate: string
  lastFailure: { at: number; error: string } | null
  copiedTo: string[]
  hour: number
}

let copiedTo: string[] = []

export function backupHealth(): BackupHealth {
  return {
    lastDailyDate: getSettings().backup_last_daily,
    lastFailure,
    copiedTo,
    hour: getSettings().backup_hour,
  }
}

function today(): string {
  // Local date, not UTC: "the nightly backup" means the shop's night, and a shop in
  // Cairo running at 03:00 is on the previous UTC day.
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * Is a daily backup owed right now?
 *
 * True once the configured hour has passed on a day that has not had one yet — which
 * also covers the machine having been switched off all night. The backup then runs at
 * the next startup rather than the day being skipped in silence, because "the till
 * was off at 3am" is the normal case in a shop, not an exception.
 */
function isDue(): boolean {
  const s = getSettings()
  if (s.backup_last_daily === today()) return false
  return new Date().getHours() >= s.backup_hour
}

/**
 * Take the snapshot, then put a copy on every till.
 *
 * The push is deliberately not allowed to fail the backup: a snapshot that exists
 * only on the master is still a good deal better than no snapshot, so a disconnected
 * till is reported and moved past rather than treated as a failed backup.
 */
export async function runDailyBackup(reason: string): Promise<{ ok: boolean; error?: string }> {
  if (running) return { ok: false, error: 'نسخة احتياطية قيد التنفيذ بالفعل' }
  running = true
  try {
    log.info(`[Backup] Daily backup starting (${reason})`)
    const written = await runBackup()
    if (!written) {
      // runBackup only returns null when it deliberately skipped; without an interval
      // set that cannot happen, so treat it as a real problem rather than a success.
      throw new Error('لم تُكتب أي نسخة')
    }

    updateSettings({ backup_last_daily: today() } as never)
    lastFailure = null

    const name = written.split(/[\\/]/).pop() || 'restaurant.db'
    const data = fs.readFileSync(written)
    const { delivered, failed } = await sendFileToNodes({ kind: 'backup', name }, data)
    copiedTo = delivered

    if (delivered.length) {
      log.info(`[Backup] Copied "${name}" to: ${delivered.join(', ')}`)
    }
    for (const f of failed) {
      log.warn(`[Backup] Could not copy "${name}" to ${f.name}: ${f.error}`)
    }

    // Tell the screens either way. A backup that reached only the master is a
    // different situation from one that reached both machines, and the owner is the
    // one who gets to decide whether that matters tonight.
    broadcast('app:backupResult', {
      ok: true, name, at: Date.now(),
      copiedTo: delivered,
      notCopied: failed,
    })
    return { ok: true }
  } catch (err: any) {
    const error = err?.message || 'سبب غير معروف'
    lastFailure = { at: Date.now(), error }
    log.error(`[Backup] Daily backup FAILED: ${error}`)
    // Loud on purpose. This is the failure that went unnoticed for a whole day.
    broadcast('app:backupResult', { ok: false, at: Date.now(), error })
    return { ok: false, error }
  } finally {
    running = false
  }
}

/**
 * Start the nightly schedule. Master and standalone only — a node has no books of its
 * own to snapshot, and the copy it holds arrives from the master already.
 */
export function startBackupSchedule(): void {
  stopBackupSchedule()

  const tick = (): void => {
    try {
      if (getSettings().net_mode === 'node') return
      if (isDue()) void runDailyBackup('scheduled')
    } catch (err: any) {
      log.warn('[Backup] Schedule tick failed:', err?.message || err)
    }
  }

  // Once now, so a machine that was off overnight catches up at startup.
  setTimeout(tick, 30_000)
  timer = setInterval(tick, TICK_MS)
  log.info(`[Backup] Nightly backup scheduled for ${getSettings().backup_hour}:00`)
}

export function stopBackupSchedule(): void {
  if (timer) { clearInterval(timer); timer = null }
}
