import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../src/main/db/db'
import * as auth from '../src/main/services/authService'

/**
 * Sign-in is username + password only. PIN sign-in was removed — along with
 * loginByPin, verifyOwnerPin, changeOwnPin, resetUserPin and createUser — and the
 * migration in db.ts now clears any pin_hash left behind, so there is nothing here
 * covering it. The user model is the four fixed slots seeded by db.ts:
 * admin / cashier1 / cashier2 / accountant.
 */
const OWNER = { username: 'admin', password: 'admin123' }
const CASHIER = { username: 'cashier1', password: 'cashier123' }

/** The lockout message is user-facing Arabic; match the stable part, not a translation. */
const LOCKED_OUT = /مقفل/

const userId = (username: string): number =>
  (getDb().prepare('SELECT user_id FROM users WHERE username = ?').get(username) as any).user_id

beforeAll(() => { initDatabase() })
beforeEach(() => { auth.__resetThrottles(); auth.logout() })

describe('authentication', () => {
  it('logs in with the seeded owner password', () => {
    const r = auth.login(OWNER.username, OWNER.password)
    expect(r.success).toBe(true)
    expect(r.user!.role).toBe('owner')
    expect(r.user!.username).toBe(OWNER.username)
  })

  it('logs in each of the four fixed accounts with its own role', () => {
    for (const [username, password, role] of [
      ['admin', 'admin123', 'owner'],
      ['cashier1', 'cashier123', 'cashier'],
      ['cashier2', 'cashier456', 'cashier'],
      ['accountant', 'account123', 'accountant'],
    ] as const) {
      auth.logout(); auth.__resetThrottles()
      const r = auth.login(username, password)
      expect(r.success, `${username} should sign in`).toBe(true)
      expect(r.user!.role).toBe(role)
    }
  })

  it('rejects a wrong password', () => {
    expect(auth.login(OWNER.username, 'nope').success).toBe(false)
  })

  it('rejects an unknown username', () => {
    expect(auth.login('nobody-here', 'whatever').success).toBe(false)
  })

  it('gives the same message for a bad username as for a bad password', () => {
    // Distinguishable errors would tell an attacker which usernames are real.
    const badUser = auth.login('nobody-here', 'whatever').error
    const badPass = auth.login(OWNER.username, 'definitely-wrong').error
    expect(badUser).toBe(badPass)
  })

  it('rejects a deactivated user', () => {
    const id = userId(CASHIER.username)
    auth.login(OWNER.username, OWNER.password)
    auth.toggleUserActive(id, false)
    auth.logout(); auth.__resetThrottles()

    expect(auth.login(CASHIER.username, CASHIER.password).success).toBe(false)

    auth.login(OWNER.username, OWNER.password)
    auth.toggleUserActive(id, true)
  })

  it('clears the session on logout', () => {
    auth.login(OWNER.username, OWNER.password)
    expect(auth.getCurrentSession()).not.toBeNull()
    auth.logout()
    expect(auth.getCurrentSession()).toBeNull()
  })
})

describe('authorisation', () => {
  it('requireRole admits the matching role and refuses the others', () => {
    auth.login(OWNER.username, OWNER.password)
    expect(auth.requireRole('owner').role).toBe('owner')
    expect(() => auth.requireRole('cashier')).toThrow()
  })

  it('requireAnyAuth refuses when nobody is signed in', () => {
    expect(() => auth.requireAnyAuth()).toThrow()
    auth.login(CASHIER.username, CASHIER.password)
    expect(auth.requireAnyAuth().username).toBe(CASHIER.username)
  })

  it('requireOwnerOrAccountant lets both in and keeps a cashier out', () => {
    auth.login(OWNER.username, OWNER.password)
    expect(auth.requireOwnerOrAccountant().role).toBe('owner')

    auth.logout(); auth.__resetThrottles()
    auth.login('accountant', 'account123')
    expect(auth.requireOwnerOrAccountant().role).toBe('accountant')

    auth.logout(); auth.__resetThrottles()
    auth.login(CASHIER.username, CASHIER.password)
    expect(() => auth.requireOwnerOrAccountant()).toThrow()
  })
})

describe('brute-force protection', () => {
  it('locks password login per-username', () => {
    for (let i = 0; i < 5; i++) auth.login(OWNER.username, `wrong${i}`)

    // The CORRECT password is refused too, or the lockout would be no protection.
    const locked = auth.login(OWNER.username, OWNER.password)
    expect(locked.success).toBe(false)
    expect(locked.error).toMatch(LOCKED_OUT)

    // A different account is unaffected — one user cannot lock out the whole till.
    expect(auth.login(CASHIER.username, CASHIER.password).success).toBe(true)
  })

  it('clears the lockout counter after a success', () => {
    auth.login(OWNER.username, 'wrong1')
    auth.login(OWNER.username, 'wrong2')
    expect(auth.login(OWNER.username, OWNER.password).success).toBe(true)

    // Four more failures would sit at 6 if the counter had not been reset.
    for (let i = 0; i < 4; i++) auth.login(OWNER.username, `wrong${i}`)
    expect(auth.login(OWNER.username, OWNER.password).success).toBe(true)
  })

  it('throttles the owner-password override on its own scope', () => {
    for (let i = 0; i < 5; i++) expect(auth.verifyOwnerPassword(`nope${i}`)).toBe(false)
    expect(() => auth.verifyOwnerPassword(OWNER.password)).toThrow(LOCKED_OUT)

    // Signing in still works — the override lockout is scoped to itself.
    expect(auth.login(OWNER.username, OWNER.password).success).toBe(true)
  })

  it('rejects an empty override password without consulting any hash', () => {
    expect(auth.verifyOwnerPassword('')).toBe(false)
  })
})

describe('the owner-password override', () => {
  it('accepts the owner password and nothing else', () => {
    expect(auth.verifyOwnerPassword(OWNER.password)).toBe(true)
    auth.__resetThrottles()
    // A cashier's own password must not authorise an owner-only action.
    expect(auth.verifyOwnerPassword(CASHIER.password)).toBe(false)
  })
})

describe('credential management', () => {
  beforeEach(() => { auth.login(OWNER.username, OWNER.password) })

  it('reports which seeded accounts still use factory credentials', () => {
    expect(auth.getDefaultCredentialWarnings()).toContain('admin')
  })

  it('lists the four fixed accounts, owner first', () => {
    const users = auth.listUsers()
    expect(users.length).toBeGreaterThanOrEqual(4)
    expect(users[0].slot).toBe('owner')
    expect(users.map(u => u.slot)).toEqual(
      expect.arrayContaining(['owner', 'cashier1', 'cashier2', 'accountant']),
    )
  })

  it('will not change a password without the current one', () => {
    expect(() => auth.changeOwnPassword('not-it', 'whatever123')).toThrow()
  })

  it('will not accept a new password under six characters', () => {
    expect(() => auth.changeOwnPassword(OWNER.password, 'short')).toThrow()
  })

  it('lets a user change their own password, and stops warning once they have', () => {
    auth.logout(); auth.__resetThrottles()
    auth.login('cashier2', 'cashier456')
    expect(auth.getDefaultCredentialWarnings()).toContain('cashier2')

    auth.changeOwnPassword('cashier456', 'a-better-password')

    auth.logout(); auth.__resetThrottles()
    expect(auth.login('cashier2', 'cashier456').success).toBe(false)
    auth.__resetThrottles()
    expect(auth.login('cashier2', 'a-better-password').success).toBe(true)
    expect(auth.getDefaultCredentialWarnings()).not.toContain('cashier2')

    // Put it back, so the order of the tests above cannot matter.
    auth.changeOwnPassword('a-better-password', 'cashier456')
  })

  it('refuses to rename an account onto a username already taken', () => {
    expect(() => auth.updateUserAccount(userId(CASHIER.username), { username: 'admin' }))
      .toThrow()
  })

  it('refuses a blank username or full name', () => {
    const id = userId(CASHIER.username)
    expect(() => auth.updateUserAccount(id, { username: '   ' })).toThrow()
    expect(() => auth.updateUserAccount(id, { fullName: '  ' })).toThrow()
  })

  it('refuses to set a password under six characters', () => {
    expect(() => auth.updateUserAccount(userId(CASHIER.username), { password: 'abc' }))
      .toThrow()
  })

  it('replaces the person in a slot without moving the slot', () => {
    const id = userId(CASHIER.username)
    const before = auth.listUsers().find(u => u.user_id === id)

    auth.updateUserAccount(id, { fullName: 'كاشير جديد', password: 'brand-new-pass' })

    const after = auth.listUsers().find(u => u.user_id === id)
    expect(after.slot).toBe(before.slot)
    expect(after.full_name).toBe('كاشير جديد')

    auth.logout(); auth.__resetThrottles()
    expect(auth.login(CASHIER.username, 'brand-new-pass').success).toBe(true)

    // Restore the seeded password so later runs of this file start where they expect.
    auth.changeOwnPassword('brand-new-pass', CASHIER.password)
  })

  it('shows the new name on the live session after editing your own account', () => {
    auth.logout(); auth.__resetThrottles()
    auth.login(OWNER.username, OWNER.password)

    auth.updateUserAccount(userId(OWNER.username), { fullName: 'صاحب المطعم' })

    // Without this the header, the shift log and every "who did this" line keep
    // showing the name you happened to log in under until somebody signs out.
    expect(auth.getCurrentSession()!.fullName).toBe('صاحب المطعم')
    auth.updateUserAccount(userId(OWNER.username), { fullName: 'المدير' })
  })
})

/**
 * A node till has no database. `auth:changeOwnPassword` is forwarded to the master and
 * runs there inside the node's own session scope — so it must read the session from
 * that scope, not from the module global, which on the master holds whoever is
 * standing at the master.
 *
 * Read from the global, the call either refused with "Not authenticated" when nobody
 * was signed in at the master, or — far worse — quietly changed the MASTER user's
 * password when somebody was.
 */
describe('changing a password from a node till', () => {
  beforeEach(() => { auth.__resetThrottles(); auth.logout() })

  it('changes the caller’s password, not the one signed in at the master', async () => {
    // Somebody is signed in at the master: the owner.
    auth.login(OWNER.username, OWNER.password)

    // Meanwhile a cashier signs in at the node. That session lives in the scope.
    const nodeSession = { userId: userId('cashier2'), role: 'cashier' as const, fullName: 'كاشير 2', username: 'cashier2' }
    await auth.runWithSession(nodeSession, () => {
      auth.changeOwnPassword('cashier456', 'node-set-password')
    })

    auth.logout(); auth.__resetThrottles()
    expect(auth.login('cashier2', 'node-set-password').success).toBe(true)

    // The owner standing at the master is untouched.
    auth.logout(); auth.__resetThrottles()
    expect(auth.login(OWNER.username, OWNER.password).success).toBe(true)

    // Put cashier2 back.
    auth.logout(); auth.__resetThrottles()
    auth.login('cashier2', 'node-set-password')
    auth.changeOwnPassword('node-set-password', 'cashier456')
  })

  it('refuses when nobody is signed in at either end', async () => {
    await auth.runWithSession(null, () => {
      expect(() => auth.changeOwnPassword('anything', 'whatever123')).toThrow(/تسجيل الدخول/)
    })
  })
})
