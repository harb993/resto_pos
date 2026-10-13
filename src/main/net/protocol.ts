/**
 * The wire format between the master till and a node till.
 *
 * WHO DIALS WHOM
 *
 * The master dials the node. Every till listens; the master is the one that reaches
 * out, holds the link open, and gives the orders. That is the opposite of how this
 * started, and the reason for the change is that the old direction put the setup
 * burden on the wrong machine: the node had to be told the master's address, so the
 * owner had to walk to the second till and type an IP, and if the master's address
 * ever changed the node was dead until somebody went and retyped it. Worse, opening
 * the pairing window promoted whichever machine you pressed it on to master — press
 * it on the wrong PC and you have two masters on one wire and a till that will never
 * connect. That is exactly how a real shop lost a night of service.
 *
 * Now the node needs to know nothing at all. It listens, it accepts the master that
 * holds its token, and it does what it is told. The master keeps the list of tills,
 * finds them again when their address changes, and is the only place anyone has to
 * configure anything.
 *
 * ONE SOCKET, BOTH DIRECTIONS
 *
 * The link is a single duplex connection carrying framed JSON. It has to be duplex
 * because the traffic genuinely goes both ways: the master sends commands and events
 * down it, and the node sends data requests back up it. The node still has to ask —
 * it does not own the books. See `mirror.ts` for what it can answer by itself when
 * the master is away.
 *
 * WHY THERE IS STILL NO SYNC ENGINE
 *
 * The master owns the one `restaurant.db`. A node's mirror is READ-ONLY and never
 * merges back. SQLite's locking is unreliable over SMB and this database runs in WAL
 * mode, which needs shared memory a network share cannot provide — two machines
 * writing one file corrupts it quietly, usually days later. One writer, many readers.
 */

import type { IpcResponse, SessionUser } from '../../shared/types'

/** Which part this machine plays. Stored in settings, chosen by the owner. */
export type NetworkMode = 'standalone' | 'master' | 'node'

export const DEFAULT_PORT = 47615

// ===== The link handshake =====
//
// Carried as an HTTP upgrade on the till's ordinary port rather than a second
// listener. One port to think about, one port to let through a firewall, and
// /health stays exactly where discovery already looks for it.

export const LINK_PATH = '/link'
export const LINK_PROTOCOL = 'resto-link/1'
export const ENROLL_PATH = '/enroll'
export const HEALTH_PATH = '/health'

export const TOKEN_HEADER = 'x-resto-token'
/** The master introduces itself in the upgrade request; the node answers in kind. */
export const MASTER_HEADER = 'x-resto-master'
export const NODE_HEADER = 'x-resto-node'

/**
 * An identity, encoded so it can legally travel in an HTTP header.
 *
 * A header value may only contain Latin-1. `Identity` carries `businessName` and
 * `machineName`, both of which are whatever the owner typed — and in an Arabic
 * restaurant that is Arabic. `JSON.stringify` leaves those characters as they are, so
 * the two ends failed in two different ways and neither said why:
 *
 *   the master   http.request() threw ERR_INVALID_CHAR before the dial left the
 *                machine, surfacing on the network screen as
 *                «Invalid character in header content ["x-resto-master"]»
 *   the node     writes its answer straight onto the socket, which does not throw —
 *                it put raw UTF-8 bytes in the header, and the master's HTTP parser
 *                read them back as Latin-1, so a till called «كريسبو» came through as
 *                mojibake even when the link worked.
 *
 * Escaping every non-ASCII character as \uXXXX fixes both and stays plain JSON, so an
 * till still running the previous build parses it correctly — `JSON.parse` has always
 * understood those escapes. That matters because the two machines are updated one at
 * a time, and a fleet must not break in the gap.
 */
export function encodeIdentityHeader(identity: Identity): string {
  // Everything from DEL upwards — the whole range a header may not carry. The
  // pattern is built from a string so this source file stays ASCII itself.
  const NON_ASCII = new RegExp('[\\u007f-\\uffff]', 'g')
  return JSON.stringify(identity).replace(
    NON_ASCII,
    ch => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'),
  )
}

/** The other side of it. Throws if the header is missing or not an identity. */
export function decodeIdentityHeader(raw: unknown): Identity {
  const identity = JSON.parse(String(raw ?? '')) as Identity
  if (!identity?.machineName) throw new Error('no name')
  return identity
}

/** Who is calling, so each end can show a name rather than an address. */
export interface Identity {
  /** The Windows computer name — how a person tells one till from another. */
  machineName: string
  appVersion: string
  businessName: string
}

/**
 * POST /enroll — "you are my till now".
 *
 * The inverse of the old /pair. The master pushes this to a till it has found on the
 * LAN; the till accepts and stores the token, then waits to be dialled. Nobody walks
 * anywhere and nobody types an address.
 */
export interface EnrollRequest {
  token: string
  master: Identity
  /** Echoed back on every link so a till can refuse a master that is not its own. */
  fleetId: string
}

export interface EnrollResponse {
  ok: boolean
  node?: Identity
  error?: string
}

// ===== Frames =====

/**
 * One message on the link. Newline-delimited JSON: a shop LAN moves a few hundred
 * small objects a minute, and a text framing that can be read straight out of a log
 * is worth more here than the bytes a binary one would save.
 */
export type LinkFrame =
  /** A call to run on the other end. node→master for data; master→node never. */
  | { t: 'req'; id: number; channel: string; payload: unknown }
  /** The answer to a `req` or a `cmd`. */
  | { t: 'res'; id: number; result: IpcResponse }
  /** The request never reached a handler — bad channel, refused, link dropped. */
  | { t: 'fail'; id: number; code: LinkErrorCode; error: string }
  /** master→node. Mirrors what the master's own screens just received. */
  | { t: 'evt'; event: string; data: unknown }
  /** master→node. An instruction, not a question. */
  | { t: 'cmd'; id: number; command: NodeCommand }
  /** master→node, in chunks. The read-only mirror, and the nightly backup. */
  | { t: 'file'; id: number; meta: FileTransfer; seq: number; last: boolean; chunk: string }
  | { t: 'ping'; at: number }
  | { t: 'pong'; at: number }

/** Why a call could not be answered. The renderer turns these into real sentences. */
export type LinkErrorCode =
  | 'no-link'          // this till is not connected to its master right now
  | 'timeout'          // the other end took too long
  | 'unknown-channel'
  | 'forbidden'        // a node may not do this at all
  | 'locked'           // the master has locked this till
  | 'offline-write'    // readable from the mirror, but this one writes
  | 'unlicensed'
  | 'handler-threw'

/**
 * What the master can tell a till to do.
 *
 * Deliberately small and deliberately explicit. Every one of these is something an
 * owner standing at the master would otherwise have to walk across the shop to do.
 */
export type NodeCommand =
  /** Drop whoever is signed in at that till back to the login screen. */
  | { kind: 'signOut'; reason?: string }
  /** Refuse to trade until unlocked. Survives a restart — the master re-asserts it. */
  | { kind: 'lock'; reason?: string }
  | { kind: 'unlock' }
  /** Reload the interface. For picking up a settings change that missed an event. */
  | { kind: 'refresh' }
  /** Relaunch the whole app on that till. */
  | { kind: 'restart' }
  /** Stop being a node: forget the token, go back to standalone. */
  | { kind: 'drop' }
  /** Put a ticket on a printer plugged into that till, and say whether it printed. */
  | { kind: 'print'; job: RemotePrintJob }
  /** Keep the till's local copy of its own sign-in in step with the master's. */
  | { kind: 'session'; session: SessionUser | null }

/**
 * A file being pushed down the link, in base64 chunks.
 *
 * Used for two things that are really the same thing: the node's read-only mirror,
 * and the nightly backup copy. Both are a whole SQLite file, and both matter enough
 * that the receiver must be able to tell a complete transfer from a truncated one —
 * hence the byte count and the digest, checked before anything is put into place.
 */
export interface FileTransfer {
  kind: 'mirror' | 'backup'
  /** The name to save it under. For a backup this is the master's own filename. */
  name: string
  bytes: number
  /** sha256 of the whole file, hex. A half-written mirror is worse than none. */
  digest: string
}

/** 256 KB of base64 per frame — small enough to interleave with ordinary traffic. */
export const FILE_CHUNK_BYTES = 192 * 1024

/**
 * A frame bigger than this is a bug or an attack, not a message. Chunked transfers
 * keep every legitimate frame far below it.
 */
export const MAX_FRAME_BYTES = 1024 * 1024

// ===== Timing =====

/** A silent TCP connection can be dropped by a switch without either end noticing. */
export const HEARTBEAT_MS = 10_000
/** No traffic at all for this long and the link is treated as dead. */
export const LINK_IDLE_TIMEOUT_MS = 32_000
/** A forwarded call must not hang a till forever if the master goes away mid-request. */
export const REQUEST_TIMEOUT_MS = 20_000
/** Long enough for the node to write a mirror to disk and answer. */
export const FILE_TIMEOUT_MS = 120_000

/**
 * How long the master waits before dialling a till again, by consecutive failure.
 * Capped, so a till that is switched off overnight is retried twice a minute rather
 * than hammered — and is picked up within seconds of being switched back on.
 */
export const REDIAL_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000]

/**
 * After this many failed dials the master stops trusting the stored address and
 * sweeps the LAN for the till by name. Three is enough to rule out a reboot.
 */
export const RELOCATE_AFTER_FAILURES = 3

// ===== /health =====

/**
 * What a till says about itself to anyone who asks.
 *
 * EVERY till answers this, in every mode, which is the whole reason the network
 * screen can find anything. It is deliberately unauthenticated and deliberately
 * thin: a name, a role and a version. Enough to show a useful list, not enough to be
 * worth stealing — and it is what lets the master find a till again after its
 * address has changed underneath it.
 */
export interface HealthBody {
  ok: true
  role: NetworkMode
  machineName: string
  appVersion: string
  businessName: string
  /** master only — how many tills currently hold a live link. */
  connectedNodes: number
  /** node only — whether its master is dialled in right now. */
  linked: boolean
  /** True when this till has no master and would accept being adopted. */
  adoptable: boolean
}

// ===== Events pushed to nodes =====

/**
 * Events the master pushes to every linked till, mirroring exactly what the master's
 * own renderer receives. Without these a node shows stale stock and stale settings
 * until someone navigates away and back.
 */
export type PushEvent =
  | { type: 'app:stockChanged'; data: unknown }
  | { type: 'app:settingsChanged'; data: unknown }
  | { type: 'app:lowStockAlert'; data: unknown }
  | { type: 'app:printResult'; data: unknown }
  | { type: 'app:ordersChanged'; data: unknown }
  /** Whether last night's backup was written, and which machines hold a copy. */
  | { type: 'app:backupResult'; data: unknown }
  /**
   * A shift closed and its close-out PDF and workbook have been written.
   *
   * Goes to the nodes as well as the master's own screens: the master runs the export
   * for the whole shop, and the cashier whose shift it was may well be standing at
   * the other till — which is exactly where the "send it to the group" button needs
   * to appear.
   */
  | { type: 'app:shiftExported'; data: unknown }
  | { type: 'app:workShiftChanged'; data: unknown }

/**
 * A ticket the master has already rendered, handed to a till to put on paper.
 *
 * A USB printer can only be driven by the machine it is plugged into, so when the
 * kitchen printer hangs off a node the master cannot reach it. Rather than make the
 * node re-render the ticket — which would need it to have the database, the templates
 * and the fonts — the master renders as usual and sends the finished ESC/POS bytes
 * across. The node only has to write them to a port.
 *
 * Unlike the old one-way version this is a `cmd`, so it comes back with an answer.
 * A kitchen ticket that silently goes nowhere means food does not get made, and the
 * cashier who took the order is the person who needs to be told.
 */
export interface RemotePrintJob {
  printerId: number
  printerName: string
  /** The Windows queue name on the node — meaningless on any other machine. */
  deviceName: string
  /** base64, because this is a raster image on a text protocol. */
  payloadBase64: string
}

// ===== What a node may and may not do =====

/** Channels a node may never call, whatever its session says. */
export const NODE_FORBIDDEN_CHANNELS = new Set<string>([
  // Restoring or wiping the books is a stand-at-the-master decision. Doing it down a
  // network cable, while another till is mid-sale, is not something to make possible.
  'app:restoreBackup',
  'app:resetSystem',
  // The shop's data file is written to, and read from, a folder on the machine the
  // owner is sitting at. Forwarded, the folder picker would open on the master.
  'shopData:export',
  'shopData:pickImport',
  'shopData:import',
])

/**
 * Channels a node may answer from its own read-only mirror while the master is away.
 *
 * DEFAULT DENY. A channel that is not on this list is refused when the link is down,
 * even if it looks harmless — the cost of wrongly allowing a write here is a till
 * that quietly edits a copy nobody will ever merge, which is precisely the silent
 * divergence this design exists to prevent. Adding a channel is a deliberate act.
 *
 * Everything here reads and only reads. Anything that inserts, updates or deletes —
 * including ringing up a sale — stays off it forever.
 */
export const OFFLINE_READABLE_CHANNELS = new Set<string>([
  // Signing in. Without this the mirror is unreachable — the till would sit on a
  // login screen it cannot get past, which is the same useless machine as before.
  // `login` is pure reads (a SELECT and a bcrypt compare), so it runs against the
  // mirror unchanged; the session it establishes can then only reach the channels on
  // this list, so an offline sign-in buys the right to look and nothing else.
  'auth:login', 'auth:logout', 'auth:getSession',
  // What the till is
  'app:mode', 'license:status', 'settings:get',
  // The menu, and what it is made of
  'menu:list', 'menu:get', 'menu:listCategories',
  'menu:getVariants', 'menu:getCategoryVariants',
  'recipes:get', 'prep:list',
  // Stock, to look at
  'rawMaterials:list', 'rawMaterials:lowStock', 'rawMaterials:history',
  // Trading history
  'order:list', 'order:get', 'order:invoiceCounters',
  'customers:byPhone', 'customers:list', 'customers:orders', 'customers:stats',
  'whatsapp:getNotes',
  // Delivery, to look at
  'delivery:areas:list', 'delivery:drivers:list', 'delivery:board',
  'delivery:orders:list', 'delivery:unsettled',
  'delivery:settlements:list', 'delivery:settlements:orders',
  // People and money, read-only
  'workers:list', 'workers:payForPeriod',
  'workerAttendance:list', 'workerAttendance:count',
  'salaries:list', 'shifts:list', 'shifts:hoursForPeriod', 'shifts:report',
  'expenses:list',
  'suppliers:list', 'suppliers:summary', 'suppliers:account', 'suppliers:invoice',
  // Reporting
  'analytics:summary', 'analytics:trend', 'analytics:topItems',
  'analytics:menuEngineering', 'analytics:peakHours',
  'analytics:categoryBreakdown', 'analytics:aov',
  'finance:report',
  // Printers are local hardware — the list of them lives in the mirror
  'printers:list', 'printers:listSystem',
])

/**
 * The showcase account swaps the whole database out from under the process. On a
 * master serving a node that would silently move the other till onto the demo books
 * mid-service, so it stays a standalone-only feature.
 */
export const SHOWCASE_BLOCKED_OVER_NETWORK = true

export function isRetryableNetworkError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code
  return code === 'ECONNREFUSED' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH'
    || code === 'ETIMEDOUT' || code === 'ECONNRESET' || code === 'EAI_AGAIN'
    || code === 'EPIPE' || code === 'ENOTFOUND'
}

/**
 * Turn a failed dial into a sentence that names the real cause.
 *
 * The old code said "check the cable and the network" for every failure there was,
 * including "this till was never enrolled" and "the master's app is closed". An
 * owner following that advice goes and checks a cable that was never the problem —
 * which is a night of service lost to a bad error message.
 */
export function describeDialFailure(err: unknown, where: string): string {
  const code = (err as NodeJS.ErrnoException)?.code
  switch (code) {
    case 'ECONNREFUSED':
      return `${where} رد بالرفض — الجهاز يعمل لكن البرنامج مغلق عليه`
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return `${where} غير موجود على الشبكة — تحقق من الكابل أو من عنوان الجهاز`
    case 'ETIMEDOUT':
      return `${where} لم يرد خلال المهلة — قد يكون جدار الحماية يحجب المنفذ`
    case 'ECONNRESET':
    case 'EPIPE':
      return `انقطع الاتصال بـ ${where} فجأة`
    case 'ENOTFOUND':
      return `تعذر ترجمة اسم الجهاز ${where}`
    default:
      return `تعذر الاتصال بـ ${where}: ${(err as Error)?.message || 'سبب غير معروف'}`
  }
}
