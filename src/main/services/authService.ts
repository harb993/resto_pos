import { AsyncLocalStorage } from 'node:async_hooks'
import {
  getDb, getActiveProfile, switchProfile, isDemoLaunch, ensureDemoDataFresh, type DbProfile,
} from '../db/db'
import bcrypt from 'bcryptjs'
import log from 'electron-log/main'
import type { SessionUser, LoginResult, UserRole } from '../../shared/types'

const VALID_ROLES: UserRole[] = ['cashier', 'owner', 'accountant']

// The credentials db.ts seeds into a brand-new database. Detected (never
// re-seeded) so the UI can nag until someone actually changes them.
const SEEDED_CREDENTIALS: { username: string; password: string }[] = [
  { username: 'admin', password: 'admin123' },
  { username: 'cashier', password: 'cashier123' },
  { username: 'cashier1', password: 'cashier123' },
  { username: 'cashier2', password: 'cashier456' },
  { username: 'accountant', password: 'account123' },
]

// In-memory session — the currently logged-in user
let currentSession: SessionUser | null = null

// ===== Brute-force throttling =====
// A PIN is only 4 digits (10,000 combinations). bcrypt alone slows a sweep to
// ~25 minutes, which is not protection. These counters add a hard lockout so an
// unattended till cannot be walked open. State is in-memory: it resets when the
// app restarts, which is acceptable because restarting requires physical access
// to the machine anyway — and each restart still costs the attacker the wait.
const MAX_ATTEMPTS = 5
const LOCKOUT_MS = 60_000

interface Throttle { failures: number; lockedUntil: number }
const throttles: Record<string, Throttle> = {}

function checkThrottle(scope: string): void {
  const t = throttles[scope]
  if (t && t.lockedUntil > Date.now()) {
    const secs = Math.ceil((t.lockedUntil - Date.now()) / 1000)
    throw new Error(`محاولات خاطئة كثيرة — الحساب مقفل لمدة ${secs} ثانية`)
  }
}

function recordFailure(scope: string): void {
  const t = throttles[scope] ?? (throttles[scope] = { failures: 0, lockedUntil: 0 })
  t.failures++
  if (t.failures >= MAX_ATTEMPTS) {
    t.lockedUntil = Date.now() + LOCKOUT_MS
    t.failures = 0
    log.warn(`[Auth] Lockout triggered for "${scope}" — ${MAX_ATTEMPTS} failures`)
  }
}

function clearThrottle(scope: string): void {
  delete throttles[scope]
}

/** Test seam: drop all lockout state. */
export function __resetThrottles(): void {
  for (const k of Object.keys(throttles)) delete throttles[k]
}


/**
 * Whose sign-in the code currently running belongs to.
 *
 * On a standalone till there is one person at one screen, and `currentSession` above
 * is the whole story. A MASTER serving a second till has two people signed in at
 * once — the cashier standing at it, and the cashier at the node — and a module-level
 * global cannot hold both: whoever signed in last would own every request, so a
 * cashier's order could be attributed to the owner, or a node's request could pass an
 * owner-only check because the owner happened to be signed in at the master.
 *
 * So a request served on behalf of a node runs inside `runWithSession`, and every
 * `require*` below reads from there instead. Nothing else in the app changes.
 */
const sessionScope = new AsyncLocalStorage<{ current: SessionUser | null }>()

/**
 * Run `fn` as the given client's session, handing back whatever it ends up as.
 *
 * Awaited INSIDE the scope, not outside: the box is only in its final state once the
 * handler has finished, so reading it synchronously after `run()` returns would hand
 * back the session as it was before `auth:login` had a chance to change it. Async
 * context survives awaits, which is the whole reason this uses AsyncLocalStorage
 * rather than a plain global swapped around the call.
 */
export async function runWithSession<T>(
  session: SessionUser | null,
  fn: () => T | Promise<T>,
): Promise<{ result: T; session: SessionUser | null }> {
  const box = { current: session }
  const result = await sessionScope.run(box, async () => fn())
  return { result, session: box.current }
}

/** Where a sign-in should be recorded: the node's scoped box, or this machine's own. */
function sessionBox(): { current: SessionUser | null } | null {
  return sessionScope.getStore() ?? null
}

/**
 * Mirror the session a node just established on the master.
 *
 * On a node till the real sign-in happens on the master — `auth:login` is forwarded,
 * and it is the master that holds the session. But a handful of channels stay local
 * on purpose (the network settings themselves), and those still call `requireRole`.
 * Without a local copy the owner standing at the node could not open its own settings
 * to change the master's address, which is exactly when they would need to.
 *
 * This is a mirror, never the authority: every real permission check happens on the
 * master, against the session it holds for that client.
 */
export function mirrorRemoteSession(session: SessionUser | null): void {
  currentSession = session
}

export function getCurrentSession(): SessionUser | null {
  const scoped = sessionBox()
  return scoped ? scoped.current : currentSession
}

export function requireRole(role: UserRole): SessionUser {
  const session = getCurrentSession()
  if (!session) {
    throw new Error('لم يتم تسجيل الدخول')
  }
  if (session.role !== role) {
    throw new Error('ليس لديك صلاحية لهذا الإجراء')
  }
  return session
}

export function requireOwnerOrAccountant(): SessionUser {
  const session = getCurrentSession()
  if (!session) {
    throw new Error('لم يتم تسجيل الدخول')
  }
  if (session.role !== 'owner' && session.role !== 'accountant') {
    throw new Error('هذا الإجراء متاح للمدير والمحاسب فقط')
  }
  return session
}

export function requireAnyAuth(): SessionUser {
  const session = getCurrentSession()
  if (!session) {
    throw new Error('لم يتم تسجيل الدخول')
  }
  return session
}

/**
 * The account used to show the system to prospective customers.
 *
 * It is not a user of the restaurant's database at all — signing in under this name
 * closes the real books and opens a separate showcase database instead, and signing
 * out puts the real one back. That is why the switch happens on the *name*, before
 * any password is checked: the account does not exist in the real database to look up.
 */
export const SHOWCASE_USERNAME = 'fares'

function profileFor(username: string): DbProfile {
  if (isDemoLaunch()) return 'demo' // --demo pins everything to the showcase books
  return username.trim().toLowerCase() === SHOWCASE_USERNAME ? 'demo' : 'real'
}

export function login(username: string, password: string): LoginResult {
  const scope = `pw:${username}`

  try {
    checkThrottle(scope)
  } catch (err: any) {
    return { success: false, error: err.message }
  }

  // Open the right set of books before looking anybody up.
  const wanted = profileFor(username)

  // The showcase account swaps the entire database out from under the process. Done
  // from a node, that would move the MASTER — and therefore the other till, possibly
  // mid-sale — onto the demo books. It stays a stand-at-the-machine feature.
  if (wanted === 'demo' && sessionBox()) {
    return { success: false, error: 'حساب العرض التجريبي متاح على الجهاز الرئيسي فقط' }
  }
  const previous = getActiveProfile()
  if (wanted !== previous) {
    try {
      switchProfile(wanted)
    } catch (err: any) {
      log.error('[Auth] Could not switch database profile:', err)
      return { success: false, error: 'تعذر فتح قاعدة البيانات' }
    }
  }

  // A demonstration always opens on a shop that traded this morning. `switchProfile`
  // covers the usual route in, but it returns early when the profile has not changed —
  // which is every sign-in under `--demo`, and any second sign-in to the showcase while
  // it is already open. Asked explicitly so neither one shows last week's books.
  if (wanted === 'demo') {
    try {
      ensureDemoDataFresh()
    } catch (err) {
      // A stale demonstration is worth far less than a broken one: log it and carry on
      // with whatever data is already there.
      log.warn('[Auth] Could not refresh the showcase data:', err)
    }
  }

  /** A failed attempt must not leave the wrong database open. */
  const restore = () => {
    if (wanted !== previous) {
      try { switchProfile(previous) } catch { /* logged inside */ }
    }
  }

  const db = getDb()
  const user = db.prepare(
    'SELECT * FROM users WHERE username = ? AND is_active = 1'
  ).get(username) as any

  if (!user) {
    recordFailure(scope)
    restore()
    log.warn(`[Auth] Failed login attempt for username: ${username}`)
    return { success: false, error: 'اسم المستخدم أو كلمة المرور غير صحيحة' }
  }

  if (!bcrypt.compareSync(password, user.password_hash)) {
    recordFailure(scope)
    restore()
    log.warn(`[Auth] Invalid password for user: ${username}`)
    return { success: false, error: 'اسم المستخدم أو كلمة المرور غير صحيحة' }
  }

  clearThrottle(scope)
  const session: SessionUser = {
    userId: user.user_id,
    role: user.role,
    fullName: user.full_name,
    username: user.username,
  }

  // Record it against whoever asked — the node's own session when this request is
  // being served for one, otherwise this machine's.
  const scoped = sessionBox()
  if (scoped) scoped.current = session
  else currentSession = session

  log.info(`[Auth] User logged in: ${username} (${user.role})`)
  return { success: true, user: session }
}

export function logout(): void {
  const scoped = sessionBox()
  const leaving = scoped ? scoped.current : currentSession
  if (leaving) {
    log.info(`[Auth] User logged out: ${leaving.username}`)
  }

  if (scoped) {
    // A node signing out must not close the master's own session, nor move the
    // master's database — it only ends its own.
    scoped.current = null
    return
  }

  currentSession = null

  // Back to the restaurant's own books, so the next person to sign in — and every
  // backup taken from now on — is working on the real database.
  if (!isDemoLaunch() && getActiveProfile() !== 'real') {
    try {
      switchProfile('real')
    } catch (err) {
      log.error('[Auth] Could not return to the real database after sign-out:', err)
    }
  }
}

/**
 * The override a cashier needs to void an invoice: the owner types their own
 * password. Throttled on its own scope so hammering the override locks that prompt
 * rather than the owner out of signing in.
 */
export function verifyOwnerPassword(password: string): boolean {
  const db = getDb()
  const scope = 'ownerOverride'

  checkThrottle(scope) // throws while locked out; the IPC layer surfaces the message

  if (typeof password !== 'string' || password.length === 0) {
    recordFailure(scope)
    return false
  }

  const owners = db.prepare(
    'SELECT password_hash FROM users WHERE role = ? AND is_active = 1'
  ).all('owner') as { password_hash: string }[]

  for (const owner of owners) {
    if (bcrypt.compareSync(password, owner.password_hash)) {
      clearThrottle(scope)
      return true
    }
  }

  recordFailure(scope)
  return false
}

/**
 * Which seeded accounts still have their factory password.
 * Surfaced in the UI as a standing warning — the app ships with known credentials,
 * so until these are changed anyone who has seen the README can open the till.
 */
export function getDefaultCredentialWarnings(): string[] {
  const db = getDb()
  const stale: string[] = []

  for (const seed of SEEDED_CREDENTIALS) {
    const user = db.prepare(
      'SELECT username, password_hash FROM users WHERE username = ? AND is_active = 1'
    ).get(seed.username) as any
    if (!user) continue

    if (bcrypt.compareSync(seed.password, user.password_hash)) stale.push(user.username)
  }

  return stale
}

/**
 * Change your OWN password. Requires the current one, so a walk-up cannot lock the
 * owner out.
 *
 * Reads the session through `getCurrentSession()`, never the module global. On a node
 * till this call is forwarded and runs on the MASTER, where the global holds whoever
 * is standing at the master — so the old code either refused with "Not authenticated"
 * when nobody was signed in there, or, worse, changed the master user's password
 * instead of the caller's.
 */
export function changeOwnPassword(currentPassword: string, newPassword: string): void {
  const session = getCurrentSession()
  if (!session) throw new Error('لم يتم تسجيل الدخول')
  if (!currentPassword) throw new Error('أدخل كلمة المرور الحالية')
  if (!newPassword || newPassword.length < 6) {
    throw new Error('كلمة المرور الجديدة يجب أن تكون 6 أحرف على الأقل')
  }
  if (currentPassword === newPassword) {
    throw new Error('كلمة المرور الجديدة مطابقة للحالية')
  }

  const db = getDb()
  const user = db.prepare('SELECT password_hash FROM users WHERE user_id = ?').get(session.userId) as any
  if (!user) throw new Error('الحساب غير موجود')
  if (!bcrypt.compareSync(currentPassword, user.password_hash)) {
    throw new Error('كلمة المرور الحالية غير صحيحة')
  }

  db.prepare('UPDATE users SET password_hash = ? WHERE user_id = ?')
    .run(bcrypt.hashSync(newPassword, 10), session.userId)

  // A lockout is counted against the OLD password. Keeping it after a successful
  // change would lock somebody out of the password they had just set themselves.
  clearThrottle(`pw:${session.username}`)
  clearThrottle('ownerOverride')

  log.info(`[Auth] Password changed for ${session.username}`)
}

export function listUsers(): any[] {
  const db = getDb()
  // Ordered by slot so the four fixed accounts always present in the same sequence:
  // owner, the two cashiers, then the accountant.
  return db.prepare(`
    SELECT user_id, username, role, slot, full_name, is_active, created_at
    FROM users
    ORDER BY CASE slot
      WHEN 'owner' THEN 1 WHEN 'cashier1' THEN 2
      WHEN 'cashier2' THEN 3 WHEN 'accountant' THEN 4 ELSE 5 END,
      created_at
  `).all()
}

/**
 * Owner-driven edit of one of the four fixed accounts: who holds it and what they
 * log in with. Every field is optional — only what is supplied changes.
 *
 * This is how a cashier is *replaced*: the slot stays, the name and credentials
 * change. There is deliberately no way to add a fifth account or delete one of the
 * four, because the whole system is built around exactly these four operators.
 */
export function updateUserAccount(
  userId: number,
  changes: { username?: string; fullName?: string; password?: string }
): void {
  const db = getDb()

  const user = db.prepare('SELECT user_id, username, slot FROM users WHERE user_id = ?')
    .get(userId) as { user_id: number; username: string; slot: string | null } | undefined
  if (!user) throw new Error('المستخدم غير موجود')

  const sets: string[] = []
  const params: any[] = []

  if (changes.username !== undefined) {
    const username = changes.username.trim()
    if (!username) throw new Error('اسم المستخدم مطلوب')
    const clash = db.prepare('SELECT user_id FROM users WHERE username = ? AND user_id != ?')
      .get(username, userId)
    if (clash) throw new Error('اسم المستخدم مستخدم بالفعل')
    sets.push('username = ?')
    params.push(username)
  }

  if (changes.fullName !== undefined) {
    const fullName = changes.fullName.trim()
    if (!fullName) throw new Error('اسم الموظف مطلوب')
    sets.push('full_name = ?')
    params.push(fullName)
  }

  if (changes.password) {
    if (changes.password.length < 6) {
      throw new Error('كلمة المرور يجب أن تكون 6 أحرف على الأقل')
    }
    sets.push('password_hash = ?')
    params.push(bcrypt.hashSync(changes.password, 10))
  }

  if (sets.length === 0) return

  params.push(userId)
  db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE user_id = ?`).run(...params)

  // A lockout counted against the credentials that have just been replaced would
  // otherwise keep the new ones out for a minute for no reason the owner can see.
  clearThrottle(`pw:${user.username}`)
  if (changes.username) clearThrottle(`pw:${changes.username.trim()}`)
  clearThrottle('ownerOverride')

  // Editing your own account while signed in: the session still carries the name you
  // logged in with, so the header, the shift log and every "who did this" line would
  // keep showing the old one until a sign-out nobody thinks to do.
  const live = getCurrentSession()
  if (live && live.userId === userId) {
    const fresh = db.prepare('SELECT username, full_name FROM users WHERE user_id = ?')
      .get(userId) as { username: string; full_name: string }
    live.username = fresh.username
    live.fullName = fresh.full_name
  }

  const changed = Object.keys(changes).filter(k => (changes as any)[k])
  log.info(`[Auth] Account updated for slot ${user.slot ?? '—'} (${user.username}): ${changed.join(', ')}`)
}

export function toggleUserActive(userId: number, isActive: boolean): void {
  const db = getDb()
  db.prepare('UPDATE users SET is_active = ? WHERE user_id = ?').run(isActive ? 1 : 0, userId)
  log.info(`[Auth] User ${userId} ${isActive ? 'activated' : 'deactivated'}`)
}

