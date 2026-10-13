/**
 * Ties an installation to one physical PC.
 *
 * The program ships as a portable executable, which means copying it to another
 * machine is a drag-and-drop away. This makes that copy useless: the app derives an
 * id from the hardware it is running on, and will not work until it is shown a key
 * that was signed for THAT id.
 *
 * The signature is Ed25519 and the app holds only the public half, so the binary
 * contains nothing that can mint a key. Only the owner's `license-private.pem` can,
 * and that file never leaves the owner's own machine — see tools/license-keygen.mjs.
 *
 * What this does and does not buy:
 *
 *   - it stops the ordinary case entirely: someone copies the folder, or restores a
 *     backup of the database, onto a second PC and expects it to run;
 *   - it does NOT stop someone who can patch the executable. No client-side check
 *     can. Nothing here pretends otherwise, and it is not worth adding obfuscation
 *     that would only make the till harder to support.
 */

import crypto from 'node:crypto'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { execFileSync } from 'node:child_process'
import log from 'electron-log/main'

/**
 * The public half of the owner's signing pair. Replacing this invalidates every key
 * ever issued, so it changes only alongside a deliberate re-issue of all of them.
 */
const LICENSE_PUBLIC_KEY_B64 = 'MCowBQYDK2VwAyEA1eGLuc0ddykZCnXhMZeddATZZZ+kcZPzKsccqF4invg='

/**
 * The key lives in a file of its own, NOT in the database.
 *
 * Two reasons, both of which bit when it was a settings row. The showcase account
 * swaps to a different database file, which would have taken the licence with it and
 * locked the whole program. And restoring a backup taken on another till would have
 * carried that till's key in — which is precisely the copy this is meant to catch.
 */
/**
 * Where the key is looked for, best first.
 *
 * ProgramData is machine-wide, so activating once covers every Windows account on
 * that till — a cashier signing into their own account does not meet the activation
 * screen again. It is not always writable without administrator rights, which is why
 * the per-user path stays as a fallback rather than a replacement.
 */
function licenseFiles(): string[] {
  const files: string[] = []
  const shared = process.env.ProgramData
  if (shared) files.push(path.join(shared, 'CrispoPOS', 'license.key'))
  files.push(path.join(app.getPath('userData'), 'license.key'))
  return files
}

export interface LicenseStatus {
  activated: boolean
  /** Shown to the owner so they can read it down the phone. `A1B2-C3D4-…` */
  deviceId: string
  /** Why the stored key stopped working, when it did. */
  reason?: string
}

// ===== The machine's identity =====

/**
 * Run a command purely for its output, treating any failure as "this source is not
 * available here" rather than an error. A PC with WMI disabled should degrade to a
 * weaker fingerprint, not refuse to start.
 */
function quiet(cmd: string, args: string[]): string {
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf8',
      timeout: 8000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return ''
  }
}

/**
 * Windows' own installation id. Stable across reboots, hardware swaps and app
 * reinstalls; different on every Windows installation, including a fresh install on
 * the same PC. It is the single best-behaved identifier available without a driver.
 */
function machineGuid(): string {
  if (process.platform !== 'win32') return ''
  // /reg:64 pins the 64-bit view. Without it a 32-bit build would be redirected into
  // Wow6432Node, where MachineGuid is not, and every such machine would silently drop
  // to the host-name fallback.
  const out = quiet('reg', [
    'query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid', '/reg:64',
  ])
  const m = /MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]+)/.exec(out)
  return m ? m[1].toLowerCase() : ''
}

let cachedDeviceId: string | null = null

/**
 * This PC's id, as five groups of four hex characters.
 *
 * MachineGuid is the ONLY source, and that is a deliberate correction rather than a
 * simplification. It previously mixed in the motherboard serial, read by spawning
 * PowerShell — and every way of fetching that can fail transiently: an eight-second
 * timeout on a machine still booting, antivirus holding the process, a locked-down
 * execution policy. A transient failure is indistinguishable from a board that has no
 * serial, so the id silently changed shape between boots, and a till that had been
 * working for weeks would lock ITSELF out with a key that no longer matched. A
 * fingerprint that is not perfectly deterministic is worse than a weaker one.
 *
 * What that gives up: a full disk-image clone carries MachineGuid with it, so an
 * image restored onto a second PC would still be licensed. Copying the program
 * folder, the portable exe, or a database backup — the cases this exists for — is
 * unaffected, because none of them carry the key or the registry.
 */
export function deviceId(): string {
  if (cachedDeviceId) return cachedDeviceId

  const guid = machineGuid()

  // Every Windows since XP has this and any user can read it, so reaching the
  // fallback means something is genuinely unusual. The host name keeps such machines
  // distinct from one another instead of collapsing them onto one shared id — but it
  // can be changed by hand, which would invalidate the licence, so say so loudly.
  let source = guid
  if (!source) {
    source = os.hostname().toLowerCase()
    log.warn('[License] MachineGuid unavailable; falling back to host name — renaming this PC will require a new key')
  }

  const digest = crypto.createHash('sha256').update(source).digest('hex')
  cachedDeviceId = digest.slice(0, 20).toUpperCase()
  return cachedDeviceId
}

/** The id as the owner reads it aloud: `A1B2-C3D4-E5F6-7890-1234`. */
export function formattedDeviceId(): string {
  return (deviceId().match(/.{1,4}/g) || []).join('-')
}

// ===== Checking a key =====

/**
 * Keys get copied through WhatsApp, wrapped by mail clients and typed by hand, so
 * everything that is not a hex digit is discarded — line breaks, spaces, and the
 * dashes the tool prints to make the key readable.
 *
 * Hex rather than base64 for exactly that reason: base64url's own alphabet contains
 * `-`, so a key printed in dashed groups could not be told from its own separators.
 */
function normalizeKey(raw: string): string {
  return String(raw || '').replace(/[^0-9a-fA-F]/g, '').toLowerCase()
}

function verifySignature(key: string): boolean {
  const normalized = normalizeKey(key)
  // An Ed25519 signature is always 64 bytes, so a valid key is always 128 hex
  // characters. Anything else is a typo, not a licence.
  if (normalized.length !== 128) return false

  try {
    const publicKey = crypto.createPublicKey({
      key: Buffer.from(LICENSE_PUBLIC_KEY_B64, 'base64'),
      format: 'der',
      type: 'spki',
    })
    const signature = Buffer.from(normalized, 'hex')
    if (signature.length !== 64) return false
    return crypto.verify(null, Buffer.from(deviceId(), 'utf8'), publicKey, signature)
  } catch (err) {
    log.warn('[License] Key rejected:', (err as Error)?.message)
    return false
  }
}

// ===== Stored state =====

function readStoredKey(): string {
  for (const file of licenseFiles()) {
    try {
      const key = fs.readFileSync(file, 'utf8').trim()
      if (key) return key
    } catch { /* try the next location */ }
  }
  return ''
}

/**
 * Write to every location that will take it.
 *
 * Both, not the first that succeeds: writing only to ProgramData would leave the till
 * dependent on a path an administrator may later lock down, and writing only per-user
 * loses the machine-wide benefit. Succeeding anywhere is enough.
 */
function writeStoredKey(key: string): boolean {
  let wrote = false
  for (const file of licenseFiles()) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, key, 'utf8')
      wrote = true
    } catch (err) {
      log.warn(`[License] Could not store the key at ${file}: ${(err as Error)?.message}`)
    }
  }
  return wrote
}

/**
 * Verified state, held for the life of the process.
 *
 * The gate in net/router runs on EVERY ipc call, and re-reading a file plus checking
 * an Ed25519 signature per call is work for an answer that cannot change while the
 * app is running — the fingerprint is fixed hardware and the file only moves through
 * `activate()`, which clears this.
 */
let activatedMemo: boolean | null = null

/**
 * Whether this machine is licensed, recomputed rather than remembered.
 *
 * The stored key is re-verified against the live fingerprint on every call, so a
 * database carried to a different PC — by backup, by copying the data folder, by
 * cloning the disk — arrives with a key that no longer matches and does not unlock it.
 */
export function getLicenseStatus(): LicenseStatus {
  const stored = readStoredKey()
  if (!stored) {
    activatedMemo = false
    return { activated: false, deviceId: formattedDeviceId() }
  }
  if (!verifySignature(stored)) {
    activatedMemo = false
    return {
      activated: false,
      deviceId: formattedDeviceId(),
      reason: 'مفتاح التفعيل المحفوظ لا يخص هذا الجهاز',
    }
  }
  activatedMemo = true
  return { activated: true, deviceId: formattedDeviceId() }
}

export function isActivated(): boolean {
  if (activatedMemo === null) return getLicenseStatus().activated
  return activatedMemo
}

/** Returns the new status so the caller never has to ask twice. */
export function activate(key: string): { success: boolean; error?: string; status: LicenseStatus } {
  if (!normalizeKey(key)) {
    return { success: false, error: 'أدخل مفتاح التفعيل', status: getLicenseStatus() }
  }
  if (!verifySignature(key)) {
    log.warn(`[License] Failed activation attempt on device ${formattedDeviceId()}`)
    return {
      success: false,
      error: 'المفتاح غير صحيح أو صادر لجهاز آخر',
      status: getLicenseStatus(),
    }
  }

  // A key that verifies but cannot be saved would unlock the till until it is next
  // restarted, then quietly lock it again — so treat it as a failure now, while
  // somebody is standing in front of the screen and can act on it.
  if (!writeStoredKey(normalizeKey(key))) {
    return {
      success: false,
      error: 'المفتاح صحيح لكن تعذر حفظه على هذا الجهاز — شغّل البرنامج كمسؤول وحاول مرة أخرى',
      status: getLicenseStatus(),
    }
  }

  activatedMemo = null // recomputed from the file just written
  log.info(`[License] Activated on device ${formattedDeviceId()}`)
  return { success: true, status: getLicenseStatus() }
}
