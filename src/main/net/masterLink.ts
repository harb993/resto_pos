/**
 * The master's fleet: the tills it owns, the links it holds open to them, and the
 * commands it can give them.
 *
 * The master is the only machine anyone configures. It keeps the list of tills, it
 * dials each one, it finds them again when their address changes underneath it, and
 * it is where the owner stands to sign a cashier out, lock a till, or drop one.
 *
 * WHY THE MASTER DIALS
 *
 * Because the master is the machine that knows things. It has the books, it has the
 * list of tills, and it is where the owner already is. Making the node dial meant the
 * node had to be told an address — so somebody had to walk to it and type one, and
 * had to walk back and retype it every time the address changed. Every failure in
 * that arrangement looked identical from the node's side ("cannot reach the master"),
 * which is how a shop spends a night checking a cable that was never the problem.
 *
 * SUPERVISION IS THE POINT
 *
 * A link is not something you open once. Tills get switched off, switches drop silent
 * connections, and DHCP hands out a different address after a power cut. So every
 * till has a supervisor that dials, backs off when it fails, and — after a few
 * failures — stops trusting the stored address and goes looking for the till by name.
 * A till that has moved is found and reconnected without anybody being told to do
 * anything.
 */

import http from 'node:http'
import crypto from 'node:crypto'
import type { Socket } from 'node:net'
import log from 'electron-log/main'
import { Link } from './link'
import { invokeLocal } from './router'
import { runWithSession } from '../services/authService'
import { getSettings, updateSettings } from '../services/settingsService'
import { snapshotDatabase } from '../db/db'
import { findTillByName, identifyTill } from './discovery'
import { localIdentity } from './identity'
import {
  LINK_PATH, LINK_PROTOCOL, TOKEN_HEADER, MASTER_HEADER, NODE_HEADER, ENROLL_PATH,
  REDIAL_BACKOFF_MS, RELOCATE_AFTER_FAILURES, NODE_FORBIDDEN_CHANNELS,
  describeDialFailure, encodeIdentityHeader, decodeIdentityHeader,
  type Identity, type NodeCommand, type PushEvent, type RemotePrintJob,
  type EnrollRequest, type EnrollResponse, type FileTransfer,
} from './protocol'
import type { IpcResponse, SessionUser } from '../../shared/types'

/** What we remember about a till between restarts. Stored as JSON in settings. */
export interface EnrolledTill {
  id: string
  machineName: string
  host: string
  port: number
  addedAt: number
  /** The master's decision, re-asserted every time the link comes up. */
  locked: boolean
  lockReason: string
}

type TillState = 'connected' | 'connecting' | 'unreachable' | 'relocating'

interface Runtime {
  record: EnrolledTill
  link: Link | null
  state: TillState
  failures: number
  lastError: string
  lastErrorAt: number
  lastSeen: number
  /** That till's own sign-in. Two tills mean two people signed in at once. */
  session: SessionUser | null
  timer: NodeJS.Timeout | null
  dialling: boolean
  peer: Identity | null
  mirrorTimer: NodeJS.Timeout | null
}

const tills = new Map<string, Runtime>()
let running = false

/** How often a connected till's read-only mirror is refreshed. */
const MIRROR_REFRESH_MS = 5 * 60 * 1000
/** A dial that has not completed in this long is not going to. */
const DIAL_TIMEOUT_MS = 8_000

// ===== Identity of this fleet =====

/**
 * The secret every till in this shop shares, and the id that says which shop it is.
 *
 * Made once, automatically, and then left alone. It used to be the owner's job: press
 * a button on one till, read 32 hex characters off the screen, type them into the
 * other. That step bought nothing — a random secret the machine invents is no weaker
 * than a random secret the machine invents and then makes a person copy by hand.
 */
export function ensureFleetIdentity(): { token: string; fleetId: string } {
  const s = getSettings()
  let { net_token: token, net_fleet_id: fleetId } = s
  const patch: Record<string, string> = {}
  if (!token) { token = crypto.randomBytes(16).toString('hex'); patch.net_token = token }
  if (!fleetId) { fleetId = crypto.randomUUID(); patch.net_fleet_id = fleetId }
  if (Object.keys(patch).length) {
    updateSettings(patch as never)
    log.info('[Master] Generated this shop\'s connection identity')
  }
  return { token, fleetId }
}

// ===== The stored list =====

function loadRecords(): EnrolledTill[] {
  try {
    const raw = getSettings().net_tills
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter(t => t?.id && t?.machineName) : []
  } catch (err) {
    log.warn('[Master] Stored till list is unreadable, starting empty:', err)
    return []
  }
}

function saveRecords(): void {
  const records = [...tills.values()].map(t => t.record)
  updateSettings({ net_tills: JSON.stringify(records) } as never)
}

// ===== What the settings screen sees =====

export interface TillSummary extends EnrolledTill {
  state: TillState
  lastError: string
  lastErrorAt: number
  lastSeen: number
  signedInAs: string | null
  appVersion: string
  connectedSince: number | null
}

export function tillSummaries(): TillSummary[] {
  return [...tills.values()].map(t => ({
    ...t.record,
    state: t.state,
    lastError: t.lastError,
    lastErrorAt: t.lastErrorAt,
    lastSeen: t.lastSeen,
    signedInAs: t.session?.fullName ?? null,
    appVersion: t.peer?.appVersion ?? '',
    connectedSince: t.link?.alive ? t.link.since : null,
  })).sort((a, b) => a.machineName.localeCompare(b.machineName))
}

export function connectedTillCount(): number {
  return [...tills.values()].filter(t => t.link?.alive).length
}

// ===== Adopting and dropping =====

/**
 * Take a till on: tell it it is ours, then start dialling it.
 *
 * This is the entire setup, and it happens at the master with one press. The till
 * being adopted needs no address typed into it and nobody standing at it.
 */
export async function adoptTill(host: string, port: number): Promise<IpcResponse> {
  const { token, fleetId } = ensureFleetIdentity()

  const found = await identifyTill(host, port)
  if (!found) {
    return { success: false, error: `لا يوجد جهاز يعمل عليه البرنامج على ${host}:${port}` }
  }
  /**
   * A machine set as a master cannot be taken on as a till — but saying only that is
   * useless, because the usual way to end up here is not two real masters. It is one
   * person who could not find the "add device" button on the other machine until they
   * switched it to master, and now neither will accept the other. So say which
   * machine to change and what to change it to.
   */
  if (found.role === 'master') {
    const owns = found.connectedNodes ?? 0
    return {
      success: false,
      error: owns > 0
        ? `«${found.machineName}» جهاز رئيسي وله ${owns} جهاز تابع — لا يمكن ضمّه. أضف الأجهزة من هناك بدلاً من هنا.`
        : `«${found.machineName}» مضبوط كـ«جهاز رئيسي». على ذلك الجهاز افتح: الإعدادات ← الربط بين الأجهزة ← اختر «جهاز واحد»، ثم اضغط «أضف» هنا مرة أخرى. (لا تحتاج ضبطه كتابع — الضمّ من هنا يفعل ذلك.)`,
    }
  }
  if ([...tills.values()].some(t => t.record.machineName === found.machineName)) {
    return { success: false, error: `«${found.machineName}» مضاف بالفعل` }
  }

  const body: EnrollRequest = { token, fleetId, master: localIdentity() }
  let reply: EnrollResponse
  try {
    const res = await fetch(`http://${host}:${port}${ENROLL_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8_000),
    })
    reply = await res.json() as EnrollResponse
  } catch (err: any) {
    return { success: false, error: describeDialFailure(err, `${host}:${port}`) }
  }
  if (!reply?.ok) {
    return { success: false, error: reply?.error || 'رفض الجهاز الانضمام' }
  }

  const record: EnrolledTill = {
    id: crypto.randomUUID(),
    machineName: found.machineName || host,
    host, port,
    addedAt: Date.now(),
    locked: false,
    lockReason: '',
  }
  tills.set(record.id, blank(record))
  saveRecords()
  log.info(`[Master] Adopted "${record.machineName}" at ${host}:${port}`)

  /*
    Taking a till on IS becoming a master. Saying so was left to the owner, and the
    consequences were quiet and total:

      - `supervise()` returns immediately unless master mode is running, so on a
        machine still set to «جهاز واحد» the adoption enrolled the other PC and then
        never dialled it. Nothing connected, and nothing said why.
      - `applyNetworkMode()` reads `net_mode` at every startup. Left standalone, the
        saved till list was loaded by nobody, so a pair that HAD been connected came up
        disconnected the next morning and stayed that way.

    The error message shown when the other machine is a master already promises this —
    "الضمّ من هنا يفعل ذلك" — so this end should hold up its half of it. Adopt once, and
    the two machines find each other from then on, including after a power cut.
  */
  if (getSettings().net_mode !== 'master') {
    updateSettings({ net_mode: 'master' } as never)
    log.info('[Master] This machine is now the master — it has a till on its books')
  }

  if (!running) {
    // Reloads the list from settings (the record above is already saved) and starts
    // supervising every till, so the adoption connects now rather than at next boot.
    startMasterMode()
  } else {
    supervise(record.id)
  }

  return { success: true, data: { machineName: record.machineName } }
}

/** Let a till go: tell it to forget us, then stop dialling it. */
export async function dropTill(id: string): Promise<IpcResponse> {
  const t = tills.get(id)
  if (!t) return { success: false, error: 'هذا الجهاز غير موجود في القائمة' }

  // Best effort — a till that is switched off cannot be told, and must not be able
  // to stop the master removing it.
  if (t.link?.alive) {
    await t.link.command({ kind: 'drop' }).catch(() => undefined)
  }
  if (t.timer) clearTimeout(t.timer)
  if (t.mirrorTimer) clearInterval(t.mirrorTimer)
  t.link?.close('dropped by the master')
  tills.delete(id)
  saveRecords()
  log.info(`[Master] Dropped "${t.record.machineName}"`)
  return { success: true }
}

// ===== Giving orders =====

export async function commandTill(id: string, command: NodeCommand): Promise<IpcResponse> {
  const t = tills.get(id)
  if (!t) return { success: false, error: 'هذا الجهاز غير موجود في القائمة' }

  // Lock is the master's decision, so it is remembered here and re-asserted every
  // time the link comes back. Otherwise restarting a locked till would unlock it.
  if (command.kind === 'lock' || command.kind === 'unlock') {
    t.record.locked = command.kind === 'lock'
    t.record.lockReason = command.kind === 'lock' ? (command.reason || '') : ''
    saveRecords()
  }
  if (command.kind === 'signOut') t.session = null

  if (!t.link?.alive) {
    return {
      success: false,
      error: `«${t.record.machineName}» غير متصل الآن — ${t.lastError || 'لم يتم الاتصال بعد'}`,
    }
  }
  return t.link.command(command)
}

/** Push an event to every linked till. Never throws — a dead till is not an error. */
export function broadcastToNodes(event: PushEvent): void {
  for (const t of tills.values()) {
    if (t.link?.alive) t.link.sendEvent(event.type, event.data)
  }
}

/**
 * Send a rendered ticket to the till that has the printer plugged into it, and find
 * out whether it actually printed.
 *
 * The old version could only report "did anyone hear me", because the stream it used
 * had no way back. Now the till answers, so an empty paper roll in the kitchen shows
 * up on the cashier's screen at the moment it matters instead of being discovered
 * when the food does not arrive.
 */
export async function printOnNodes(job: RemotePrintJob): Promise<{ ok: boolean; error?: string }> {
  const linked = [...tills.values()].filter(t => t.link?.alive)
  if (linked.length === 0) {
    return { ok: false, error: 'لا يوجد جهاز تابع متصل لتنفيذ الطباعة' }
  }

  const results = await Promise.all(
    linked.map(async t => ({
      name: t.record.machineName,
      res: await t.link!.command({ kind: 'print', job }),
    })),
  )

  if (results.some(r => r.res.success)) return { ok: true }
  const why = results.map(r => `${r.name}: ${r.res.error || 'فشل'}`).join('؛ ')
  return { ok: false, error: why }
}

/** Push a file — the mirror, or a nightly backup — to every linked till. */
export async function sendFileToNodes(
  meta: Omit<FileTransfer, 'digest' | 'bytes'>,
  data: Buffer,
): Promise<{ delivered: string[]; failed: { name: string; error: string }[] }> {
  const full: FileTransfer = {
    ...meta,
    bytes: data.length,
    digest: crypto.createHash('sha256').update(data).digest('hex'),
  }
  const delivered: string[] = []
  const failed: { name: string; error: string }[] = []

  await Promise.all([...tills.values()]
    .filter(t => t.link?.alive)
    .map(async t => {
      const res = await t.link!.sendFile(full, data)
      if (res.success) delivered.push(t.record.machineName)
      else failed.push({ name: t.record.machineName, error: res.error || 'سبب غير معروف' })
    }))

  return { delivered, failed }
}

// ===== Supervision =====

function blank(record: EnrolledTill): Runtime {
  return {
    record, link: null, state: 'connecting', failures: 0,
    lastError: '', lastErrorAt: 0, lastSeen: 0,
    session: null, timer: null, dialling: false, peer: null, mirrorTimer: null,
  }
}

function fail(t: Runtime, message: string): void {
  t.failures++
  t.lastError = message
  t.lastErrorAt = Date.now()
  t.state = 'unreachable'
  // Log the first failure and then only every tenth, or a till switched off overnight
  // fills the log with the same line 1,200 times and buries everything else.
  if (t.failures === 1 || t.failures % 10 === 0) {
    log.warn(`[Master] "${t.record.machineName}" unreachable (attempt ${t.failures}): ${message}`)
  }
}

function schedule(id: string): void {
  const t = tills.get(id)
  if (!t || !running) return
  if (t.timer) clearTimeout(t.timer)

  const step = REDIAL_BACKOFF_MS[Math.min(t.failures, REDIAL_BACKOFF_MS.length - 1)]
  // A little jitter, so several tills coming back after a power cut do not all dial
  // on the same tick and time each other out.
  const wait = step + Math.floor(Math.random() * 500)
  t.timer = setTimeout(() => { void supervise(id) }, wait)
}

async function supervise(id: string): Promise<void> {
  const t = tills.get(id)
  if (!t || !running || t.dialling || t.link?.alive) return

  t.dialling = true
  try {
    // After a few failures the stored address is no longer worth believing. Go and
    // find the till by name instead — this is the whole of the automatic recovery,
    // and the reason a changed IP is no longer an outage.
    if (t.failures >= RELOCATE_AFTER_FAILURES && t.failures % RELOCATE_AFTER_FAILURES === 0) {
      t.state = 'relocating'
      const found = await findTillByName(t.record.machineName, t.record.port)
      if (found && found.ip !== t.record.host) {
        log.info(`[Master] "${t.record.machineName}" moved ${t.record.host} → ${found.ip}`)
        t.record.host = found.ip
        saveRecords()
      } else if (!found) {
        fail(t, `لم يُعثر على «${t.record.machineName}» على الشبكة — الجهاز مغلق أو الكابل مفصول`)
        schedule(id)
        return
      }
    }

    t.state = 'connecting'
    const link = await dial(t)
    t.link = link
    t.peer = link.peer
    t.failures = 0
    t.lastError = ''
    t.state = 'connected'
    t.lastSeen = Date.now()
    log.info(`[Master] Linked to "${t.record.machineName}" at ${t.record.host}:${t.record.port}`)

    // Re-assert what the master has decided about this till, then give it a fresh
    // copy of the books to read while we are away next time.
    if (t.record.locked) {
      void link.command({ kind: 'lock', reason: t.record.lockReason })
    }
    void pushMirror(t)
    t.mirrorTimer = setInterval(() => { void pushMirror(t) }, MIRROR_REFRESH_MS)
  } catch (err: any) {
    fail(t, err?.message || 'تعذر الاتصال')
    schedule(id)
  } finally {
    t.dialling = false
  }
}

/**
 * Open one link: an HTTP upgrade on the till's ordinary port.
 *
 * Rejects rather than hanging. Every failure carries the reason the till gave, so
 * "the app is closed on that PC" and "that PC is not on the network" stop looking
 * like the same problem.
 */
function dial(t: Runtime): Promise<Link> {
  const { host, port } = t.record
  const where = `${t.record.machineName} (${host}:${port})`
  const { token } = ensureFleetIdentity()

  return new Promise<Link>((resolve, reject) => {
    const req = http.request({
      host, port, path: LINK_PATH, method: 'GET',
      headers: {
        connection: 'Upgrade',
        upgrade: LINK_PROTOCOL,
        [TOKEN_HEADER]: token,
        // ASCII-escaped: an Arabic business or machine name in a raw header makes
        // http.request() throw ERR_INVALID_CHAR before the dial leaves the machine.
        [MASTER_HEADER]: encodeIdentityHeader(localIdentity()),
      },
      timeout: DIAL_TIMEOUT_MS,
    })

    let settled = false
    const done = (err: Error | null, link?: Link) => {
      if (settled) return
      settled = true
      if (err) reject(err); else resolve(link!)
    }

    req.on('upgrade', (res, socket: Socket) => {
      let peer: Identity
      try {
        peer = decodeIdentityHeader(res.headers[NODE_HEADER])
      } catch {
        socket.destroy()
        return done(new Error(`${where} لم يعرّف بنفسه`))
      }

      const link = new Link(socket, peer, {
        onRequest: (channel, payload) => serveForTill(t, channel, payload),
        onClose: reason => {
          if (t.mirrorTimer) { clearInterval(t.mirrorTimer); t.mirrorTimer = null }
          t.link = null
          t.state = 'unreachable'
          t.lastError = `انقطع الاتصال — ${reason}`
          t.lastErrorAt = Date.now()
          schedule(t.record.id)
        },
      }, `master→${peer.machineName}`)

      done(null, link)
    })

    // A plain HTTP response means the till refused the upgrade, and its status line
    // is the most specific thing anyone will get about why.
    req.on('response', res => {
      const why = res.statusCode === 401 ? 'رمز الاتصال غير مطابق — أعد ضمّ الجهاز'
        : res.statusCode === 409 ? 'هذا الجهاز ليس مضبوطاً كتابع'
          : res.statusCode === 403 ? 'الجهاز رفض الاتصال — ليس على نفس الشبكة'
            : `رد الجهاز بالحالة ${res.statusCode}`
      res.resume()
      done(new Error(`${where}: ${why}`))
    })
    req.on('timeout', () => {
      req.destroy()
      done(new Error(`${where} لم يرد خلال ${DIAL_TIMEOUT_MS / 1000} ثوانٍ — قد يحجب جدار الحماية المنفذ`))
    })
    req.on('error', err => done(new Error(describeDialFailure(err, where))))
    req.end()
  })
}

/**
 * Run one of the till's requests here, as that till's own signed-in user.
 *
 * Each till's session is held separately: a master serving two tills has two people
 * signed in at once, and a module-level global could not hold both — whoever signed
 * in last would own every request, so a cashier's order could be attributed to the
 * owner, or a node's request could pass an owner-only check because the owner
 * happened to be signed in at the master.
 */
async function serveForTill(t: Runtime, channel: string, payload: unknown): Promise<IpcResponse> {
  t.lastSeen = Date.now()

  if (NODE_FORBIDDEN_CHANNELS.has(channel)) {
    return { success: false, error: 'هذا الإجراء متاح على الجهاز الرئيسي فقط' }
  }
  if (t.record.locked) {
    return {
      success: false,
      error: t.record.lockReason
        ? `هذا الجهاز مقفول من الجهاز الرئيسي — ${t.record.lockReason}`
        : 'هذا الجهاز مقفول من الجهاز الرئيسي',
    }
  }

  const { result, session } = await runWithSession(t.session, () => invokeLocal(channel, payload))
  t.session = session
  return result
}

/** Give one till a fresh read-only copy of the books. */
async function pushMirror(t: Runtime): Promise<void> {
  if (!t.link?.alive) return
  try {
    const data = await snapshotDatabase()
    const meta: FileTransfer = {
      kind: 'mirror',
      name: 'mirror.db',
      bytes: data.length,
      digest: crypto.createHash('sha256').update(data).digest('hex'),
    }
    const res = await t.link.sendFile(meta, data)
    if (!res.success) {
      log.warn(`[Master] Mirror push to "${t.record.machineName}" failed: ${res.error}`)
    }
  } catch (err: any) {
    log.warn(`[Master] Could not build a mirror for "${t.record.machineName}":`, err?.message || err)
  }
}

// ===== Mode =====

export function startMasterMode(): void {
  stopMasterMode()
  running = true
  ensureFleetIdentity()

  for (const record of loadRecords()) {
    // `locked` and `lockReason` were added after the first release; a record written
    // by an older build has neither.
    tills.set(record.id, blank({
      ...record,
      locked: record.locked ?? false,
      lockReason: record.lockReason ?? '',
    }))
  }
  log.info(`[Master] Master mode — ${tills.size} till(s) on the books`)
  for (const id of tills.keys()) void supervise(id)
}

export function stopMasterMode(): void {
  running = false
  for (const t of tills.values()) {
    if (t.timer) clearTimeout(t.timer)
    if (t.mirrorTimer) clearInterval(t.mirrorTimer)
    t.link?.close('master mode stopped')
  }
  tills.clear()
}
