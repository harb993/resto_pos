/**
 * The little server every till runs, in every mode, always.
 *
 * It exists so a till can be FOUND and can be TOLD THINGS. It never serves the books
 * — that is the master's job, and the master reaches out over a link rather than
 * being called here.
 *
 *   GET  /health   always. Name, role, version. This is what makes a till findable,
 *                  and what lets a master recognise one of its own tills again after
 *                  the address has changed underneath it.
 *   POST /enroll   "you are my till now". The master pushes this; the till accepts
 *                  and stores the token. The inverse of the old /pair, and the whole
 *                  reason nobody has to walk to the second machine any more.
 *   GET  /link     an HTTP upgrade to the duplex link. Token required. This is the
 *                  master dialling in.
 *
 * Security is deliberately modest but not absent: a shared token on the link, and
 * enrolment fenced to this machine's own subnets. This is a cable between two PCs in
 * one shop, not the public internet — but a till that anyone on the wifi could drive
 * would still be wrong.
 */

import http from 'node:http'
import type { Socket } from 'node:net'
import log from 'electron-log/main'
import { getSettings, updateSettings } from '../services/settingsService'
import { lanAddresses, isSameLan } from './discovery'
import { localIdentity } from './identity'
import { acceptMasterLink, isNodeLinked, currentMasterName, applyModeNow } from './nodeLink'
import { connectedTillCount } from './masterLink'
import {
  LINK_PATH, ENROLL_PATH, HEALTH_PATH, LINK_PROTOCOL, TOKEN_HEADER, MASTER_HEADER,
  NODE_HEADER, encodeIdentityHeader, decodeIdentityHeader,
  type HealthBody, type EnrollRequest, type EnrollResponse, type Identity,
  type NetworkMode,
} from './protocol'

let server: http.Server | null = null
let boundPort = 0

/** Bodies here are tiny JSON objects; a cap stops a bad client exhausting memory. */
const MAX_BODY_BYTES = 64 * 1024

export function isServerRunning(): boolean {
  return server !== null
}

export function tillPort(): number {
  return boundPort
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('payload too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function header(req: http.IncomingMessage, name: string): string {
  const v = req.headers[name]
  return (Array.isArray(v) ? v[0] : v) ?? ''
}

/**
 * Is this till free to be adopted?
 *
 * "Belongs to somebody" is decided by `net_master_name`, not by holding a token.
 * That distinction matters more than it looks: a till that was briefly switched to
 * MASTER mints itself a token, and switching it back to node used to leave that
 * token behind. It then held a secret no master had ever heard of, refused every
 * enrolment as "already linked to another master", and named no master it was
 * supposedly linked to — a machine that could never be added to anything again
 * without editing its database by hand.
 *
 * Only a real enrolment, or a master actually dialling in, writes a master's name
 * here. So that is what is checked.
 */
function isAdoptable(): boolean {
  const s = getSettings()
  return s.net_mode !== 'master' && !s.net_master_name
}

export async function startServer(port: number): Promise<void> {
  await stopServer()

  server = http.createServer(async (req, res) => {
    const address = (req.socket.remoteAddress ?? 'unknown').replace(/^::ffff:/, '')
    try {
      if (req.method === 'GET' && req.url === HEALTH_PATH) {
        return json(res, 200, health())
      }
      if (req.method === 'POST' && req.url === ENROLL_PATH) {
        return await serveEnroll(req, res, address)
      }
      return json(res, 404, { ok: false, error: 'not found' })
    } catch (err: any) {
      log.error('[Till] Request failed:', err)
      if (!res.headersSent) json(res, 500, { ok: false, error: err?.message || 'server error' })
    }
  })

  // The link arrives as an HTTP upgrade rather than on a port of its own, so there is
  // one port to configure and one port to let through a firewall.
  server.on('upgrade', (req, socket) => {
    void serveUpgrade(req, socket as Socket)
  })

  await new Promise<void>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      server = null
      reject(err.code === 'EADDRINUSE'
        ? new Error(`المنفذ ${port} مستخدم بالفعل — تأكد أن البرنامج غير مفتوح مرتين على هذا الجهاز`)
        : err)
    }
    server!.once('error', onError)
    // 0.0.0.0 so the master can reach it over the cable; the token guards the link.
    server!.listen(port, '0.0.0.0', () => {
      server!.off('error', onError)
      boundPort = port
      log.info(`[Till] Listening on ${port} — ${lanAddresses().join(', ') || 'no LAN address'}`)
      resolve()
    })
  })
}

export async function stopServer(): Promise<void> {
  const s = server
  server = null
  boundPort = 0
  if (!s) return
  await new Promise<void>(resolve => s.close(() => resolve()))
  log.info('[Till] Server stopped')
}

function health(): HealthBody {
  const s = getSettings()
  const mode: NetworkMode =
    s.net_mode === 'master' || s.net_mode === 'node' ? s.net_mode : 'standalone'
  const me = localIdentity()
  return {
    ok: true,
    role: mode,
    machineName: me.machineName,
    appVersion: me.appVersion,
    businessName: me.businessName,
    connectedNodes: connectedTillCount(),
    linked: isNodeLinked(),
    adoptable: isAdoptable(),
  }
}

/**
 * Accept — or refuse — being taken on as somebody's till.
 *
 * Two ways in. A till nobody owns accepts the first master that asks. A till that is
 * already enrolled accepts only a caller that already holds its token, which is what
 * lets a master re-enrol its own till after changing its name without letting a
 * second master steal it mid-service.
 */
async function serveEnroll(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  address: string,
): Promise<void> {
  if (!isSameLan(address)) {
    log.warn(`[Till] Enrol refused — ${address} is not on this LAN`)
    return json(res, 403, { ok: false, error: 'هذا الجهاز ليس على نفس الشبكة' } satisfies EnrollResponse)
  }

  let body: EnrollRequest
  try {
    body = JSON.parse(await readBody(req))
  } catch {
    return json(res, 400, { ok: false, error: 'طلب غير صالح' } satisfies EnrollResponse)
  }
  if (!body?.token || !body?.fleetId || !body?.master?.machineName) {
    return json(res, 400, { ok: false, error: 'بيانات الربط ناقصة' } satisfies EnrollResponse)
  }

  const s = getSettings()
  if (s.net_mode === 'master') {
    return json(res, 409, {
      ok: false,
      error: 'هذا الجهاز هو الجهاز الرئيسي — لا يمكن ضمّه كتابع',
    } satisfies EnrollResponse)
  }
  if (!isAdoptable() && s.net_token !== body.token) {
    log.warn(`[Till] Enrol refused — already enrolled to ${s.net_master_name || 'another master'}`)
    return json(res, 403, {
      ok: false,
      error: `هذا الجهاز مرتبط بالفعل بـ «${s.net_master_name || 'جهاز رئيسي آخر'}» — افصله من هناك أولاً`,
    } satisfies EnrollResponse)
  }

  updateSettings({
    net_mode: 'node',
    net_token: body.token,
    net_fleet_id: body.fleetId,
    net_master_name: body.master.machineName,
  })
  log.info(`[Till] Enrolled by ${body.master.machineName} (${address})`)

  /*
    Become a node NOW, not at the next restart.

    Writing `net_mode: 'node'` records the decision; `startNodeMode()` is what acts on
    it by installing the forwarder that sends every call to the master. Without this
    the master dials in seconds later, the link comes up, both screens say connected —
    and this till goes on ringing its sales into its OWN database, because nothing ever
    told it to stop. Two sets of books, no warning, until somebody happened to restart
    the machine.

    Answered first, then applied: the master is waiting on this response, and applying
    the mode tears down and restarts the very server handling the request.
  */
  res.on('finish', () => {
    void applyModeNow().catch(err => {
      log.error('[Till] Could not switch into node mode after enrolment:', err)
    })
  })

  return json(res, 200, { ok: true, node: localIdentity() } satisfies EnrollResponse)
}

/**
 * The master dialling in. Validate, switch protocols, hand the raw socket over.
 *
 * Everything is refused before the 101: once the upgrade is acknowledged the socket
 * is no longer HTTP and there is no longer a tidy way to say no.
 */
async function serveUpgrade(req: http.IncomingMessage, socket: Socket): Promise<void> {
  const address = (socket.remoteAddress ?? 'unknown').replace(/^::ffff:/, '')

  const deny = (status: number, why: string): void => {
    log.warn(`[Till] Link from ${address} refused — ${why}`)
    try {
      socket.write(`HTTP/1.1 ${status} ${why}\r\nConnection: close\r\n\r\n`)
      socket.destroy()
    } catch { /* the caller has already gone */ }
  }

  if (!req.url?.startsWith(LINK_PATH)) return deny(404, 'unknown path')
  if (header(req, 'upgrade').toLowerCase() !== LINK_PROTOCOL) return deny(400, 'bad protocol')
  if (!isSameLan(address)) return deny(403, 'not on this LAN')

  const s = getSettings()
  if (s.net_mode !== 'node') return deny(409, 'this till is not a node')
  if (!s.net_token || header(req, TOKEN_HEADER) !== s.net_token) {
    return deny(401, 'bad token')
  }

  let master: Identity
  try {
    master = decodeIdentityHeader(header(req, MASTER_HEADER))
  } catch {
    return deny(400, 'master did not identify itself')
  }

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Connection: Upgrade\r\n' +
    `Upgrade: ${LINK_PROTOCOL}\r\n` +
    // Written straight onto the socket, so an Arabic name here does not throw — it
    // just puts raw UTF-8 in a header the master then reads back as Latin-1. Escaped
    // for the same reason the master escapes its own.
    `${NODE_HEADER}: ${encodeIdentityHeader(localIdentity())}\r\n` +
    '\r\n'
  )

  acceptMasterLink(socket, master, address)
}

export { lanAddresses, currentMasterName }
