import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest'
import http from 'node:http'
import { initDatabase } from '../src/main/db/db'
import { updateSettings } from '../src/main/services/settingsService'
import { startServer, stopServer } from '../src/main/net/tillServer'
import { stopNodeMode } from '../src/main/net/nodeLink'
import {
  LINK_PROTOCOL, LINK_PATH, TOKEN_HEADER, MASTER_HEADER, NODE_HEADER,
  encodeIdentityHeader, decodeIdentityHeader, type Identity,
} from '../src/main/net/protocol'

/**
 * The handshake, end to end, with the names a real Egyptian shop actually uses.
 *
 * This is the failure the restaurant hit: the two tills found each other on the
 * network and then would not connect, and the only thing on screen was
 * «Invalid character in header content ["x-resto-master"]». The cause was that both
 * ends put their identity — which contains the shop's Arabic name — into an HTTP
 * header, and a header may only carry Latin-1.
 *
 * So this drives the real server over a real socket with a real Arabic name in both
 * directions, and asserts the link actually upgrades and both sides read each other
 * correctly. A unit test of the encoder alone would not have caught the node's half:
 * it writes its answer straight onto the socket, which never throws — it just sends
 * bytes the other end reads back as mojibake.
 */

const PORT = 47801
const TOKEN = 'tok-arabic-handshake'

const ARABIC_MASTER: Identity = {
  machineName: 'MASTER-PC',
  appVersion: '1.0.0-test',
  businessName: 'كريسبو بروست',
}

/** Dial exactly as masterLink does, and report what came back. */
function dial(masterHeader: string): Promise<{
  status: number
  upgraded: boolean
  nodeHeader?: string
  threw?: string
}> {
  return new Promise(resolve => {
    let settled = false
    const done = (r: any) => { if (!settled) { settled = true; resolve(r) } }

    let req: http.ClientRequest
    try {
      req = http.request({
        host: '127.0.0.1', port: PORT, path: LINK_PATH, method: 'GET',
        headers: {
          connection: 'Upgrade',
          upgrade: LINK_PROTOCOL,
          [TOKEN_HEADER]: TOKEN,
          [MASTER_HEADER]: masterHeader,
        },
        timeout: 4000,
      })
    } catch (err: any) {
      // http.request throws synchronously on an illegal header value.
      return done({ status: 0, upgraded: false, threw: err?.message })
    }

    req.on('upgrade', (res, socket) => {
      socket.destroy()
      done({ status: 101, upgraded: true, nodeHeader: String(res.headers[NODE_HEADER] ?? '') })
    })
    req.on('response', res => { res.resume(); done({ status: res.statusCode ?? 0, upgraded: false }) })
    req.on('error', err => done({ status: 0, upgraded: false, threw: err.message }))
    req.on('timeout', () => { req.destroy(); done({ status: 0, upgraded: false, threw: 'timeout' }) })
    req.end()
  })
}

beforeAll(async () => {
  initDatabase()
  // This machine is the NODE: it has been adopted and is waiting to be dialled. Its
  // own name is Arabic too, which is the half that used to come back as mojibake.
  updateSettings({
    net_mode: 'node',
    net_token: TOKEN,
    net_master_name: ARABIC_MASTER.machineName,
    business_name: 'كريسبو بروست — فرع الدقي',
  } as never)
  await startServer(PORT)
})

afterEach(() => { stopNodeMode() })
afterAll(async () => { await stopServer() })

describe('master → node, with Arabic shop names', () => {
  it('upgrades the link', async () => {
    const res = await dial(encodeIdentityHeader(ARABIC_MASTER))
    console.log('dial:', JSON.stringify({ status: res.status, upgraded: res.upgraded, threw: res.threw }))

    expect(res.threw).toBeUndefined()
    expect(res.upgraded).toBe(true)
    expect(res.status).toBe(101)
  })

  it('the node identifies itself readably, not as mojibake', async () => {
    const res = await dial(encodeIdentityHeader(ARABIC_MASTER))
    expect(res.upgraded).toBe(true)

    const node = decodeIdentityHeader(res.nodeHeader)
    console.log('node said:', JSON.stringify(node))

    expect(node.machineName).toBeTruthy()
    expect(node.businessName).toBe('كريسبو بروست — فرع الدقي')
    // The bug's signature: UTF-8 bytes read back as Latin-1.
    expect(node.businessName).not.toContain('Ã')
    expect(node.businessName).not.toContain('Ù')
  })

  it('demonstrates the original failure — raw JSON never leaves the machine', async () => {
    // Guards the fix. If anyone puts JSON.stringify back into masterLink, the dial
    // starts throwing again before a single byte reaches the network.
    const res = await dial(JSON.stringify(ARABIC_MASTER) as never)
    console.log('raw JSON dial:', JSON.stringify({ upgraded: res.upgraded, threw: res.threw }))

    expect(res.upgraded).toBe(false)
    expect(res.threw).toMatch(/Invalid character in header content/)
  })

  it('still refuses a wrong token, Arabic name or not', async () => {
    const res = await new Promise<number>(resolve => {
      const req = http.request({
        host: '127.0.0.1', port: PORT, path: LINK_PATH, method: 'GET',
        headers: {
          connection: 'Upgrade', upgrade: LINK_PROTOCOL,
          [TOKEN_HEADER]: 'wrong-token',
          [MASTER_HEADER]: encodeIdentityHeader(ARABIC_MASTER),
        },
        timeout: 4000,
      })
      req.on('upgrade', (_r, s) => { s.destroy(); resolve(101) })
      req.on('response', r => { r.resume(); resolve(r.statusCode ?? 0) })
      req.on('error', () => resolve(0))
      req.end()
    })
    expect(res).toBe(401)
  })

  it('refuses a master that does not identify itself at all', async () => {
    const res = await dial('not json')
    expect(res.upgraded).toBe(false)
    expect(res.status).toBe(400)
  })

  it('answers /health while all this is going on', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/health`)
    const body = await res.json() as any
    console.log('health:', JSON.stringify(body))
    expect(res.status).toBe(200)
    // Discovery reads this to show the other till in the list — it is the reason the
    // two machines could SEE each other even while the link kept failing.
    expect(body.mode ?? body.role).toBeTruthy()
  })
})
