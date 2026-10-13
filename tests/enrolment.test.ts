import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import http from 'node:http'
import { initDatabase } from '../src/main/db/db'
import { getSettings, updateSettings } from '../src/main/services/settingsService'
import { startServer, stopServer } from '../src/main/net/tillServer'
import { stopNodeMode } from '../src/main/net/nodeLink'
import { LINK_PROTOCOL, LINK_PATH, TOKEN_HEADER, MASTER_HEADER } from '../src/main/net/protocol'

/**
 * Enrolment and the link handshake — the fences around a till accepting a master.
 *
 * The direction is now master→node: the master pushes "you are my till" and then
 * dials in. That moves the whole security question onto this file, because the till
 * is the side saying yes. Three things must hold, and these tests are about them
 * holding:
 *
 *   - a till nobody owns may be adopted, so setup is one press at the master;
 *   - a till that already has a master will NOT be taken over by a different one,
 *     or a second machine on the LAN could steal a working till mid-service;
 *   - the link itself is refused without the right token, whatever /enroll said.
 */

const PORT = 47799
const BASE = `http://127.0.0.1:${PORT}`

const MASTER = { machineName: 'MASTER-PC', appVersion: '1.0.0-test', businessName: 'Test' }

const enroll = (body: unknown) =>
  fetch(`${BASE}/enroll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

/** Try the upgrade the master uses, and report what the till answered. */
function tryLink(token: string): Promise<{ status: number; upgraded: boolean }> {
  return new Promise(resolve => {
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: LINK_PATH, method: 'GET',
      headers: {
        connection: 'Upgrade',
        upgrade: LINK_PROTOCOL,
        [TOKEN_HEADER]: token,
        [MASTER_HEADER]: JSON.stringify(MASTER),
      },
      timeout: 4000,
    })
    let settled = false
    const done = (status: number, upgraded: boolean) => {
      if (settled) return
      settled = true
      resolve({ status, upgraded })
    }
    req.on('upgrade', (_res, socket) => { socket.destroy(); done(101, true) })
    req.on('response', res => { res.resume(); done(res.statusCode ?? 0, false) })
    // A refusal is written as a bare status line and the socket closed, which node
    // surfaces here rather than as a parsed response.
    req.on('error', () => done(0, false))
    req.on('timeout', () => { req.destroy(); done(0, false) })
    req.end()
  })
}

beforeAll(() => { initDatabase() })

beforeEach(() => {
  updateSettings({
    net_mode: 'standalone', net_token: '', net_fleet_id: '', net_master_name: '',
  } as never)
})

afterEach(async () => {
  stopNodeMode()
  await stopServer()
})

describe('a till answers for itself in every mode', () => {
  it('says who it is when it is not a master, instead of staying invisible', async () => {
    // This is the bug that made "it didn't find the other PC" the normal experience:
    // a standalone till used to listen on nothing at all.
    await startServer(PORT)

    const res = await fetch(`${BASE}/health`)
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.ok).toBe(true)
    expect(body.role).toBe('standalone')
    expect(body.machineName).toBeTruthy()
    // Free to be taken on — which is what puts an "add" button next to it.
    expect(body.adoptable).toBe(true)
  })

  it('reports itself as a master once it is one, and is no longer adoptable', async () => {
    updateSettings({ net_mode: 'master', net_token: 'secret' } as never)
    await startServer(PORT)
    const body = await (await fetch(`${BASE}/health`)).json() as any
    expect(body.role).toBe('master')
    expect(body.adoptable).toBe(false)
  })
})

describe('enrolment', () => {
  it('accepts a master when nobody owns this till, and remembers it', async () => {
    await startServer(PORT)

    const res = await enroll({ token: 'shared-secret', fleetId: 'fleet-1', master: MASTER })
    expect(res.status).toBe(200)
    expect((await res.json() as any).ok).toBe(true)

    const s = getSettings()
    expect(s.net_mode).toBe('node')
    expect(s.net_token).toBe('shared-secret')
    expect(s.net_master_name).toBe('MASTER-PC')
  })

  it('refuses a DIFFERENT master once it already has one', async () => {
    updateSettings({
      net_mode: 'node', net_token: 'shared-secret', net_master_name: 'MASTER-PC',
    } as never)
    await startServer(PORT)

    const res = await enroll({ token: 'someone-elses', fleetId: 'fleet-2', master: MASTER })
    expect(res.status).toBe(403)
    // And it names the machine that already holds it, so the owner knows where to go.
    expect((await res.json() as any).error).toMatch(/MASTER-PC/)
    expect(getSettings().net_token).toBe('shared-secret')
  })

  it('accepts adoption when it holds a leftover token but no master', async () => {
    // The trap this closes: flipping a till to "master" mints it a token of its own.
    // If that survived a flip back to node, the till held a secret no master had ever
    // heard of, refused every enrolment as "already linked to another master", and
    // named no master it was linked to. It could never be added to anything again.
    // Belonging is decided by having a master's NAME, not by holding a token.
    updateSettings({
      net_mode: 'node', net_token: 'self-minted-while-it-was-a-master',
      net_fleet_id: 'its-own-fleet', net_master_name: '',
    } as never)
    await startServer(PORT)

    const health = await (await fetch(`${BASE}/health`)).json() as any
    expect(health.adoptable).toBe(true)

    const res = await enroll({ token: 'shared-secret', fleetId: 'fleet-1', master: MASTER })
    expect(res.status).toBe(200)
    expect(getSettings().net_token).toBe('shared-secret')
    expect(getSettings().net_master_name).toBe('MASTER-PC')
  })

  it('accepts its OWN master again, so a re-enrol is not an outage', async () => {
    updateSettings({ net_mode: 'node', net_token: 'shared-secret' } as never)
    await startServer(PORT)

    const res = await enroll({ token: 'shared-secret', fleetId: 'fleet-1', master: MASTER })
    expect(res.status).toBe(200)
  })

  it('refuses to enrol a machine that is itself a master', async () => {
    updateSettings({ net_mode: 'master', net_token: 'its-own' } as never)
    await startServer(PORT)

    const res = await enroll({ token: 'shared-secret', fleetId: 'fleet-1', master: MASTER })
    expect(res.status).toBe(409)
    expect(getSettings().net_token).toBe('its-own')
  })

  it('rejects a request with the token missing', async () => {
    await startServer(PORT)
    const res = await enroll({ fleetId: 'fleet-1', master: MASTER })
    expect(res.status).toBe(400)
    expect(getSettings().net_mode).toBe('standalone')
  })
})

describe('the link handshake', () => {
  it('lets the master in with the token it was enrolled with', async () => {
    updateSettings({ net_mode: 'node', net_token: 'shared-secret' } as never)
    await startServer(PORT)

    const { status, upgraded } = await tryLink('shared-secret')
    expect(upgraded).toBe(true)
    expect(status).toBe(101)
  })

  it('refuses a wrong token — /enroll succeeding does not make the link free', async () => {
    updateSettings({ net_mode: 'node', net_token: 'shared-secret' } as never)
    await startServer(PORT)

    const { upgraded } = await tryLink('wrong')
    expect(upgraded).toBe(false)
  })

  it('refuses a till that is not a node, whatever token is offered', async () => {
    updateSettings({ net_mode: 'standalone', net_token: 'shared-secret' } as never)
    await startServer(PORT)

    const { upgraded } = await tryLink('shared-secret')
    expect(upgraded).toBe(false)
  })
})
