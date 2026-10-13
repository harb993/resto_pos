import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import { initDatabase, getMirrorPath } from '../src/main/db/db'
import { updateSettings } from '../src/main/services/settingsService'
import { registerAuthIpc } from '../src/main/ipc/auth.ipc'
import { registerSettingsIpc } from '../src/main/ipc/settings.ipc'
import { registerMenuIpc } from '../src/main/ipc/menu.ipc'
import { registerOrderIpc } from '../src/main/ipc/order.ipc'
import { startNodeMode, stopNodeMode, __forwardForTest as forward } from '../src/main/net/nodeLink'
import { logout } from '../src/main/services/authService'

/**
 * What a node till can and cannot do while its master is away.
 *
 * The rule that matters most here is the one that was got wrong first time and
 * bricked a real till: SIGNING IN MUST ALWAYS WORK. Every network setting on a node
 * is guarded by an owner check, so a machine that refuses to let anyone in until its
 * master appears cannot be pointed at a different master, cannot be turned back into
 * a standalone till, and cannot be repaired at all — a locked room with the key
 * inside. It went out that way, and the till showed a login screen it could not get
 * past.
 *
 * The other two rules are the ones that keep the books honest: reads only from a copy
 * the master actually sent, and no writes at all.
 */

beforeAll(() => {
  initDatabase()
  registerAuthIpc()
  registerSettingsIpc()
  registerMenuIpc()
  registerOrderIpc()
})

beforeEach(() => {
  // A node that has never been dialled: enrolled, no link, no mirror on disk.
  try { fs.unlinkSync(getMirrorPath()) } catch { /* already absent */ }
  updateSettings({
    net_mode: 'node', net_token: 'shared-secret', net_master_name: 'MASTER-PC',
    net_locked: 0, net_lock_reason: '',
  } as never)
  startNodeMode()
})

afterEach(() => {
  logout()
  stopNodeMode()
})

describe('a node with no master and no mirror', () => {
  it('still lets the owner sign in, so the machine can be repaired', async () => {
    // The bug: this returned "no local copy on this device yet" and the till was
    // unusable — you could not even reach the screen that would fix it.
    const res = await forward('auth:login', { username: 'admin', password: 'admin123' })

    expect(res.success).toBe(true)
    expect((res.data as any)?.role).toBe('owner')
  })

  it('still rejects a wrong password — offline is not a way in', async () => {
    const res = await forward('auth:login', { username: 'admin', password: 'not-the-password' })
    expect(res.success).toBe(false)
  })

  it('still answers what this machine is, for the settings screen', async () => {
    const mode = await forward('app:mode', {})
    expect(mode.success).toBe(true)
  })

  it('refuses to show the books rather than showing its own stale copy', async () => {
    // The node has a full restaurant.db of its own from before it was enrolled.
    // Serving last month's prices as though they were today's is worse than saying
    // nothing, so a read is refused until the master has actually sent a copy.
    await forward('auth:login', { username: 'admin', password: 'admin123' })

    const res = await forward('menu:list', {})
    expect(res.success).toBe(false)
    expect(res.code).toBe('no-link')
    // And it points at the screen that fixes it, rather than blaming the cable.
    expect(res.error).toMatch(/الربط بين الأجهزة/)
  })

  it('refuses to ring anything up, in words, whoever is signed in', async () => {
    await forward('auth:login', { username: 'admin', password: 'admin123' })

    const res = await forward('order:create', { items: [] })
    expect(res.success).toBe(false)
    expect(res.code).toBe('offline-write')
    expect(res.error).toMatch(/لا يمكن تسجيل أي طلب/)
  })
})

describe('a node the master has locked', () => {
  beforeEach(() => {
    updateSettings({ net_locked: 1, net_lock_reason: 'جرد' } as never)
    startNodeMode()
  })

  it('comes back up locked after a restart', async () => {
    const res = await forward('order:create', { items: [] })
    expect(res.success).toBe(false)
    expect(res.code).toBe('locked')
    expect(res.error).toMatch(/جرد/)
  })

  it('still lets the owner in, or nobody could ever unlock it', async () => {
    const res = await forward('auth:login', { username: 'admin', password: 'admin123' })
    expect(res.success).toBe(true)
  })
})
