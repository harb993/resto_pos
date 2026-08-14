import { getDb } from '../db/db'
import bcrypt from 'bcryptjs'
import log from 'electron-log/main'
import type { SessionUser, LoginResult } from '../../shared/types'

// In-memory session — the currently logged-in user
let currentSession: SessionUser | null = null

export function getCurrentSession(): SessionUser | null {
  return currentSession
}

export function requireRole(role: 'owner' | 'cashier'): SessionUser {
  if (!currentSession) {
    throw new Error('Not authenticated')
  }
  if (role === 'owner' && currentSession.role !== 'owner') {
    throw new Error('Insufficient permissions — owner access required')
  }
  return currentSession
}

export function requireAnyAuth(): SessionUser {
  if (!currentSession) {
    throw new Error('Not authenticated')
  }
  return currentSession
}

export function login(username: string, password: string): LoginResult {
  const db = getDb()
  const user = db.prepare(
    'SELECT * FROM users WHERE username = ? AND is_active = 1'
  ).get(username) as any

  if (!user) {
    log.warn(`[Auth] Failed login attempt for username: ${username}`)
    return { success: false, error: 'Invalid username or password' }
  }

  if (!bcrypt.compareSync(password, user.password_hash)) {
    log.warn(`[Auth] Invalid password for user: ${username}`)
    return { success: false, error: 'Invalid username or password' }
  }

  currentSession = {
    userId: user.user_id,
    role: user.role,
    fullName: user.full_name,
    username: user.username,
  }

  log.info(`[Auth] User logged in: ${username} (${user.role})`)
  return { success: true, user: currentSession }
}

export function loginByPin(pin: string): LoginResult {
  const db = getDb()
  // Get all active users with a pin_hash
  const users = db.prepare(
    'SELECT * FROM users WHERE pin_hash IS NOT NULL AND is_active = 1'
  ).all() as any[]

  for (const user of users) {
    if (bcrypt.compareSync(pin, user.pin_hash)) {
      currentSession = {
        userId: user.user_id,
        role: user.role,
        fullName: user.full_name,
        username: user.username,
      }
      log.info(`[Auth] PIN login: ${user.username} (${user.role})`)
      return { success: true, user: currentSession }
    }
  }

  log.warn('[Auth] Failed PIN login attempt')
  return { success: false, error: 'Invalid PIN' }
}

export function logout(): void {
  if (currentSession) {
    log.info(`[Auth] User logged out: ${currentSession.username}`)
  }
  currentSession = null
}

export function verifyOwnerPin(pin: string): boolean {
  const db = getDb()
  const owners = db.prepare(
    'SELECT * FROM users WHERE role = ? AND pin_hash IS NOT NULL AND is_active = 1'
  ).all('owner') as any[]

  for (const owner of owners) {
    if (bcrypt.compareSync(pin, owner.pin_hash)) {
      return true
    }
  }
  return false
}

export function createUser(
  username: string,
  password: string,
  pin: string | null,
  role: 'cashier' | 'owner',
  fullName: string
): { success: boolean; userId?: number; error?: string } {
  const db = getDb()

  // Check if username already exists
  const existing = db.prepare('SELECT user_id FROM users WHERE username = ?').get(username)
  if (existing) {
    return { success: false, error: 'Username already exists' }
  }

  const passwordHash = bcrypt.hashSync(password, 10)
  const pinHash = pin ? bcrypt.hashSync(pin, 10) : null

  const result = db.prepare(
    'INSERT INTO users (username, pin_hash, password_hash, role, full_name) VALUES (?, ?, ?, ?, ?)'
  ).run(username, pinHash, passwordHash, role, fullName)

  log.info(`[Auth] User created: ${username} (${role})`)
  return { success: true, userId: result.lastInsertRowid as number }
}

export function listUsers(): any[] {
  const db = getDb()
  return db.prepare(
    'SELECT user_id, username, role, full_name, is_active, created_at FROM users ORDER BY created_at DESC'
  ).all()
}

export function toggleUserActive(userId: number, isActive: boolean): void {
  const db = getDb()
  db.prepare('UPDATE users SET is_active = ? WHERE user_id = ?').run(isActive ? 1 : 0, userId)
  log.info(`[Auth] User ${userId} ${isActive ? 'activated' : 'deactivated'}`)
}

export function resetUserPin(userId: number, newPin: string): void {
  const db = getDb()
  const pinHash = bcrypt.hashSync(newPin, 10)
  db.prepare('UPDATE users SET pin_hash = ? WHERE user_id = ?').run(pinHash, userId)
  log.info(`[Auth] PIN reset for user ${userId}`)
}
