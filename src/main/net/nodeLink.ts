/**
 * The node till: what it does when the master dials in, and what it does when it
 * does not.
 *
 * A node owns no books. Every IPC call its renderer makes is sent up the link the
 * master opened, and every change made anywhere — at the master or at a third till —
 * arrives as an event and is re-broadcast to this machine's own screens, so the tills
 * never disagree about stock, settings or orders.
 *
 * WHEN THE MASTER IS AWAY
 *
 * The old rule was simply "refuse everything", which is right about selling and wrong
 * about everything else: a till whose master had been switched off showed nothing at
 * all — no menu, no prices, no history — so the person standing at it could not even
 * see what the shop sells, let alone work out what had gone wrong.
 *
 * So now there are two answers rather than one. Anything that READS is served from
 * the mirror, a copy of the master's database kept fresh while the link is up.
 * Anything that WRITES is still refused, in plain words, because that has not stopped
 * being true: two tills issuing invoice numbers from separate offline queues produce
 * duplicate invoices and stock nobody can reconcile, and a till that quietly
 * disagrees with the books is worse than one that says it is offline.
 *
 * The list of what may be read offline is default-deny and lives in protocol.ts.
 */

import { BrowserWindow, app } from 'electron'
import type { Socket } from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import log from 'electron-log/main'
import { Link } from './link'
import { setForwarder, invokeLocal } from './router'
import { mirrorRemoteSession } from '../services/authService'
import { sendToWindowsPrinter } from '../services/printing/transport'
import { getSettings, updateSettings } from '../services/settingsService'
import {
  runOnMirror, hasMirror, mirrorAge, applyMirrorSnapshot, closeMirror, getBackupDir,
} from '../db/db'
import {
  OFFLINE_READABLE_CHANNELS, NODE_FORBIDDEN_CHANNELS,
  type NodeCommand, type FileTransfer, type Identity, type LinkErrorCode,
} from './protocol'
import type { IpcResponse, SessionUser } from '../../shared/types'

let link: Link | null = null
let master: Identity | null = null
let masterAddress = ''
/** Set by the master. A locked till reads but does not trade. */
let locked = false
let lockReason = ''
/** Why the link is not up, in words fit to put on a screen. */
let lastReason = 'لم يتصل الجهاز الرئيسي بهذا الجهاز بعد'

/**
 * How far this machine's clock is from the master's, in milliseconds.
 *
 * Positive means the master is ahead. The books are written on the master and always
 * carry the master's time, so the DATA was never at risk — but this till's screens
 * were reading their own clock to decide what "today" means, which shift a sale falls
 * in, and how long an order has been out with a driver. Two tills a few minutes apart
 * then showed the same day's work differently, and near midnight they disagreed about
 * which day it was at all.
 */
let masterOffsetMs = 0
/** What the screens were last told, so a steady clock is not re-announced forever. */
let announcedOffsetMs = 0

/** mode.ts installs this, so a `drop` command can re-apply the mode without a cycle. */
let applyMode: (() => Promise<void>) | null = null
export function setModeApplier(fn: (() => Promise<void>) | null): void {
  applyMode = fn
}

/**
 * Bring this machine into whatever the settings now say, from anywhere that changed
 * them — without importing mode.ts, which imports this file.
 *
 * Enrolment is the case that needs it. Being adopted writes `net_mode: 'node'`, but
 * writing the setting is not the same as becoming a node: `startNodeMode()` is what
 * installs the forwarder, and until it runs every IPC call on this machine still goes
 * to its OWN database. The master would dial in, the link would come up, the screens
 * would say connected — and the till would go on ringing sales into its own books.
 * Two sets of accounts, no warning, until somebody restarted it.
 */
export async function applyModeNow(): Promise<void> {
  if (!applyMode) {
    log.warn('[Net] No mode applier installed — cannot apply the new mode until restart')
    return
  }
  await applyMode()
}

export function isNodeLinked(): boolean {
  return link !== null && link.alive
}

export function currentMasterName(): string {
  return master?.machineName || getSettings().net_master_name || ''
}

export function isTillLocked(): boolean {
  return locked
}

export interface NodeLinkStatus {
  linked: boolean
  masterName: string
  masterAddress: string
  since: number | null
  locked: boolean
  lockReason: string
  reason: string
  mirror: { at: number; bytes: number } | null
  /** Add this to this machine's clock to get the master's. */
  masterTimeOffsetMs: number
}

export function nodeLinkStatus(): NodeLinkStatus {
  return {
    linked: isNodeLinked(),
    masterName: currentMasterName(),
    masterAddress,
    since: link?.since ?? null,
    locked,
    lockReason,
    reason: isNodeLinked() ? '' : lastReason,
    mirror: mirrorAge(),
    masterTimeOffsetMs: isNodeLinked() ? masterOffsetMs : 0,
  }
}

/** What this machine should believe the time is: its own clock, corrected. */
export function masterNow(): number {
  return Date.now() + (isNodeLinked() ? masterOffsetMs : 0)
}

function toWindows(channel: string, data: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, data)
  }
}

function announce(): void {
  toWindows('app:masterLink', nodeLinkStatus())
}

// ===== Serving this machine's own renderer =====

function refuse(code: LinkErrorCode, error: string): IpcResponse {
  return { success: false, error, code } as IpcResponse
}

/**
 * Every IPC call this machine's renderer makes, once it is a node.
 *
 * Installed for as long as the mode is `node`, link or no link — because answering
 * from the mirror is exactly what has to happen when there is no link, and a
 * forwarder that only existed while connected could not do it.
 */
async function forward(channel: string, payload: unknown): Promise<IpcResponse> {
  if (NODE_FORBIDDEN_CHANNELS.has(channel)) {
    return refuse('forbidden', 'هذا الإجراء متاح على الجهاز الرئيسي فقط')
  }

  if (link?.alive) {
    if (locked && !OFFLINE_READABLE_CHANNELS.has(channel)) {
      return refuse('locked', lockReason
        ? `هذا الجهاز مقفول من الجهاز الرئيسي — ${lockReason}`
        : 'هذا الجهاز مقفول من الجهاز الرئيسي')
    }
    const result = await link.request(channel, payload)
    mirrorAuthChannels(channel, result)
    return result
  }

  return offline(channel, payload)
}

/**
 * Questions about THIS MACHINE, which must be answerable whatever the network is
 * doing — served from the till's own database, not the master's.
 *
 * Signing in is the one that matters. Every network setting on this machine is
 * guarded by `requireRole('owner')`, so a till that will not let anyone sign in
 * until its master appears cannot be reconfigured to point at a master, cannot be
 * turned back into a standalone machine, and cannot be repaired at all except by
 * editing its database by hand. That is a locked room with the key inside, and it is
 * exactly what happened the first time this shipped.
 *
 * These read this till's own `restaurant.db` — the one it has had all along — so the
 * answer is about the machine in front of you rather than about the books. The
 * session that results still reaches nothing but the read-only channels below.
 */
const MACHINE_LOCAL_CHANNELS = new Set<string>([
  'auth:login', 'auth:logout', 'auth:getSession',
  'app:mode', 'license:status', 'license:activate', 'settings:get',
])

/**
 * No link. Three different answers, because these are three different situations and
 * the person reading the screen needs to act differently in each.
 */
async function offline(channel: string, payload: unknown): Promise<IpcResponse> {
  const who = currentMasterName() || 'الجهاز الرئيسي'

  // A locked till stays locked when the link drops. Otherwise unplugging the cable
  // would be the way around the master's lock, which would make the lock worthless.
  // Signing in is still allowed, or the owner could not unlock anything either.
  if (locked && !MACHINE_LOCAL_CHANNELS.has(channel)) {
    return refuse('locked', lockReason
      ? `هذا الجهاز مقفول من الجهاز الرئيسي — ${lockReason}`
      : 'هذا الجهاز مقفول من الجهاز الرئيسي')
  }

  // 1. About this machine — always answerable, from this machine's own database.
  if (MACHINE_LOCAL_CHANNELS.has(channel)) {
    try {
      return await invokeLocal(channel, payload)
    } catch (err: any) {
      log.error(`[Node] Local ${channel} failed:`, err?.message || err)
      return refuse('handler-threw', err?.message || 'تعذر تنفيذ الطلب محلياً')
    }
  }

  // 2. Anything that writes. Refused, and told why — this is the rule that keeps two
  //    tills from issuing invoice numbers from separate queues.
  if (!OFFLINE_READABLE_CHANNELS.has(channel)) {
    return refuse('offline-write',
      `${who} غير متصل بهذا الجهاز الآن — يمكن الاطلاع على البيانات فقط، ولا يمكن تسجيل أي طلب أو تعديل حتى يعود. السبب: ${lastReason}`)
  }

  // 3. Reading the books. Only from a copy the master actually sent, never from this
  //    till's own stale database — showing last month's prices as though they were
  //    today's is worse than showing nothing.
  if (!hasMirror()) {
    return refuse('no-link',
      `${who} غير متصل، ولم تصل نسخة من البيانات إلى هذا الجهاز بعد. يمكنك فتح «الربط بين الأجهزة» من الإعدادات لضبط الجهاز. السبب: ${lastReason}`)
  }

  try {
    return await runOnMirror(() => invokeLocal(channel, payload))
  } catch (err: any) {
    log.error(`[Node] Mirror read failed for ${channel}:`, err?.message || err)
    return refuse('handler-threw', `تعذرت القراءة من النسخة المحلية: ${err?.message || 'خطأ غير معروف'}`)
  }
}

/**
 * Keep this machine's own copy of its sign-in in step with the master's.
 *
 * The master is the authority — every permission check happens there. But the few
 * channels that stay local (the network settings) still call `requireRole`, so
 * without a local copy the owner standing at a node could not open the settings at
 * all, which is precisely the moment they would want to.
 */
function mirrorAuthChannels(channel: string, result: IpcResponse): void {
  if (channel === 'auth:login') {
    const user = (result.data ?? null) as SessionUser | null
    mirrorRemoteSession(result.success && user ? user : null)
  } else if (channel === 'auth:logout') {
    mirrorRemoteSession(null)
  }
}

// ===== Being dialled =====

/** Called by tillServer once a master has passed the handshake. */
export function acceptMasterLink(socket: Socket, who: Identity, address: string): void {
  // One master at a time. A second dial replaces the first rather than running two,
  // so a master that was restarted does not leave a dead link holding the slot.
  if (link) link.close('replaced by a new link')

  master = who
  masterAddress = address

  link = new Link(socket, who, {
    onCommand: runCommand,
    onEvent: (event, data) => {
      // A settings change on the master is the shop's, not that machine's — store it
      // here too, or a restart would go back to this till's stale copy.
      if (event === 'app:settingsChanged') persistPushedSettings(data)
      toWindows(event, data)
    },
    onFile: receiveFile,
    onPeerTime: peerNow => {
      masterOffsetMs = peerNow - Date.now()
      // Only tell the screens when it has actually moved. A clock that wobbles by
      // the odd millisecond every ten seconds must not re-render the whole app.
      if (Math.abs(masterOffsetMs - announcedOffsetMs) > 1_000) {
        announcedOffsetMs = masterOffsetMs
        log.info(`[Node] Clock differs from ${who.machineName} by ${Math.round(masterOffsetMs / 1000)}s — following the master`)
        announce()
      }
    },
    onClose: reason => {
      link = null
      lastReason = `انقطع الاتصال بـ ${who.machineName} — ${reason}`
      log.warn(`[Node] ${lastReason}`)
      announce()
    },
  }, `node←${who.machineName}`)

  updateSettings({ net_master_name: who.machineName })
  lastReason = ''
  log.info(`[Node] ${who.machineName} (${address}) is now driving this till`)
  announce()

  // Adopt the master's shop settings — see adoptMasterSettings(). Not awaited: the
  // link is usable now, and a till that sat blank until a settings round-trip
  // completed would be worse than one that corrects its VAT rate a second later.
  void adoptMasterSettings()
}

/**
 * Settings that describe THIS MACHINE, never the shop.
 *
 * Everything else is the restaurant's — one VAT rate, one discount cap, one set of
 * shift times, one receipt footer — and a node showing its own copy of those is
 * simply wrong. These are the exceptions, and the first group is not a nicety:
 * copying `net_mode` from the master would tell this till it IS the master, at which
 * point it stops forwarding, opens its own empty books and starts issuing invoice
 * numbers against them. The rest are paths and counters that belong to the machine
 * they are on.
 */
export const MACHINE_OWN_SETTINGS = new Set<string>([
  'net_mode', 'net_port', 'net_token', 'net_fleet_id', 'net_master_name',
  'net_locked', 'net_lock_reason', 'net_tills',
  'backup_folder', 'backup_hour', 'backup_last_daily',
  'shift_export_folder',
])

/**
 * Which of the master's settings this till should take, and what it should leave
 * alone. Pure, and exported, because the cost of getting it wrong is not a cosmetic
 * one — a node that copied `net_mode` would believe it is the master.
 */
export function masterSettingsToAdopt(
  mine: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const changes: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(incoming)) {
    if (MACHINE_OWN_SETTINGS.has(key)) continue
    if (value === undefined || value === null) continue
    if (String(mine[key] ?? '') === String(value)) continue
    changes[key] = value
  }
  return changes
}

/**
 * Take the master's settings as this till's own.
 *
 * `settings:get` is answered locally on a node (see MACHINE_LOCAL_CHANNELS) — it has
 * to be, because the login screen asks for the branding before anyone has signed in
 * and before there is necessarily a link. The cost was that a node ran the whole
 * shift on whatever was in its own database: its own VAT rate, its own discount cap,
 * its own shift times. The master pushed changes while both were running, so the two
 * tills agreed right up until the node was restarted, and then quietly did not.
 *
 * So the values are copied into the node's own database when the link comes up. That
 * keeps the local answer correct, makes it survive a restart, and means a till whose
 * master is away still charges what the shop charges.
 */
async function adoptMasterSettings(): Promise<void> {
  if (!link?.alive) return

  try {
    const res = await link.request('settings:get', undefined)
    if (!res?.success || !res.data || typeof res.data !== 'object') {
      log.warn('[Node] Could not read the master settings:', res?.error ?? 'no data')
      return
    }

    const changes = masterSettingsToAdopt(
      getSettings() as unknown as Record<string, unknown>,
      res.data as Record<string, unknown>,
    )

    if (Object.keys(changes).length === 0) {
      log.info('[Node] Master settings already match')
      return
    }

    updateSettings(changes as never)
    log.info(`[Node] Adopted ${Object.keys(changes).length} setting(s) from the master: ${Object.keys(changes).join(', ')}`)

    // The screens are showing the old values — push the merged set at them.
    toWindows('app:settingsChanged', getSettings())
  } catch (err: any) {
    log.warn('[Node] Could not adopt the master settings:', err?.message || err)
  }
}

/**
 * The master changed a setting while we were connected. Keep the node's own copy in
 * step as well as its screens, so a restart does not fall back to stale values.
 */
function persistPushedSettings(data: unknown): void {
  if (!data || typeof data !== 'object') return
  const changes = masterSettingsToAdopt(
    getSettings() as unknown as Record<string, unknown>,
    data as Record<string, unknown>,
  )
  if (Object.keys(changes).length === 0) return
  try {
    updateSettings(changes as never)
  } catch (err: any) {
    log.warn('[Node] Could not store pushed settings:', err?.message || err)
  }
}

// ===== Doing as we are told =====

async function runCommand(command: NodeCommand): Promise<IpcResponse> {
  log.info(`[Node] Command from master: ${command.kind}`)

  switch (command.kind) {
    case 'session':
      mirrorRemoteSession(command.session)
      return { success: true }

    case 'signOut':
      mirrorRemoteSession(null)
      toWindows('app:forceSignOut', { reason: command.reason || '' })
      return { success: true }

    case 'lock':
      locked = true
      lockReason = command.reason || ''
      updateSettings({ net_locked: 1, net_lock_reason: lockReason } as never)
      announce()
      return { success: true }

    case 'unlock':
      locked = false
      lockReason = ''
      updateSettings({ net_locked: 0, net_lock_reason: '' } as never)
      announce()
      return { success: true }

    case 'refresh':
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) w.reload()
      }
      return { success: true }

    case 'restart':
      // Answer first — the master should be told this is happening, and after
      // relaunch there is nobody left to answer with.
      setTimeout(() => { app.relaunch(); app.exit(0) }, 250)
      return { success: true }

    case 'drop':
      updateSettings({
        net_mode: 'standalone', net_token: '', net_fleet_id: '', net_master_name: '',
        net_locked: 0, net_lock_reason: '',
      } as never)
      log.info('[Node] Dropped by the master — reverting to standalone')
      setTimeout(() => { void applyMode?.() }, 250)
      return { success: true }

    case 'print':
      return runRemotePrintJob(command)

    default:
      return refuse('unknown-channel', 'أمر غير معروف')
  }
}

/**
 * Put a ticket the master rendered onto a printer plugged into this machine.
 *
 * Unlike the old fire-and-forget version this reports back, because the link is
 * duplex now and there is somewhere to report to. A kitchen ticket that silently
 * goes nowhere means food does not get made, and the cashier who took the order —
 * standing at the other machine — is the person who needs to know.
 */
async function runRemotePrintJob(
  command: Extract<NodeCommand, { kind: 'print' }>,
): Promise<IpcResponse> {
  const { job } = command
  try {
    await sendToWindowsPrinter(job.deviceName, Buffer.from(job.payloadBase64, 'base64'))
    log.info(`[Node] Printed remote ticket on "${job.printerName}"`)
    return { success: true }
  } catch (err: any) {
    const error = err?.message || 'تعذرت الطباعة'
    log.error(`[Node] Remote print failed on "${job.printerName}":`, error)
    // Show it here too. The paper is on this machine, so somebody standing at it can
    // actually do something about an empty roll.
    toWindows('app:printResult', {
      orderId: 0,
      results: [{
        printerId: job.printerId, printerName: job.printerName,
        role: 'counter', ok: false, error,
      }],
    })
    return { success: false, error }
  }
}

// ===== Receiving files =====

async function receiveFile(meta: FileTransfer, data: Buffer): Promise<IpcResponse> {
  try {
    if (meta.kind === 'mirror') {
      applyMirrorSnapshot(data, meta.digest)
      announce()
      return { success: true }
    }

    // A nightly backup of the master's books, kept here so that losing the master
    // machine does not lose the shop's history with it.
    const dir = getBackupDir()
    const target = path.join(dir, meta.name)
    const temp = `${target}.incoming`
    fs.writeFileSync(temp, data)
    fs.renameSync(temp, target)
    log.info(`[Node] Stored master backup "${meta.name}" (${(data.length / 1024 / 1024).toFixed(1)} MB)`)
    return { success: true }
  } catch (err: any) {
    log.error(`[Node] Could not store ${meta.kind} "${meta.name}":`, err?.message || err)
    return { success: false, error: err?.message || 'تعذر حفظ الملف' }
  }
}

// ===== Mode =====

export function startNodeMode(): void {
  setForwarder(forward)
  // Come back up locked if that is how we were left. The master re-asserts this on
  // every link, but it cannot do so until it dials — and a till that unlocked itself
  // in the meantime would make switching the machine off the way around a lock.
  const s = getSettings()
  locked = s.net_locked === 1
  lockReason = s.net_lock_reason
  lastReason = `في انتظار أن يتصل ${currentMasterName() || 'الجهاز الرئيسي'} بهذا الجهاز`
  log.info(`[Node] Node mode — waiting to be dialled by ${currentMasterName() || 'a master'}`)
  announce()
}

/**
 * Test seam: the forwarder every IPC call on a node goes through.
 *
 * Exposed because the rule worth pinning down — "you can always sign in to the
 * machine in front of you" — is a property of this function, and a till that
 * cannot be signed into cannot be repaired.
 */
export const __forwardForTest = forward

export function stopNodeMode(): void {
  setForwarder(null)
  if (link) { link.close('this till is no longer a node'); link = null }
  master = null
  masterAddress = ''
  locked = false
  lockReason = ''
  masterOffsetMs = 0
  announcedOffsetMs = 0
  closeMirror()
}
