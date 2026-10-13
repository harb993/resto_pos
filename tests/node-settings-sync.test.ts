import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import http from 'node:http'
import type { Socket } from 'node:net'
import { initDatabase, getDb } from '../src/main/db/db'
import { getSettings, updateSettings } from '../src/main/services/settingsService'
import { startServer, stopServer } from '../src/main/net/tillServer'
import { stopNodeMode, isNodeLinked } from '../src/main/net/nodeLink'
import { shiftWindows } from '../src/main/services/shiftService'
import {
  LINK_PROTOCOL, LINK_PATH, TOKEN_HEADER, NODE_HEADER,
  encodeIdentityHeader, decodeIdentityHeader, type Identity, type LinkFrame,
} from '../src/main/net/protocol'

/**
 * Does the node actually run the MASTER's settings?
 *
 * `settings:get` is answered locally on a node — it has to be, because the login
 * screen asks for the branding before anyone has signed in and before there is
 * necessarily a link. The cost was that a node ran its whole shift on whatever was in
 * its own database: its own VAT rate, its own discount cap, its own shift times. The
 * master pushed changes while both were running, so the two agreed right up until the
 * node was restarted, and then quietly did not.
 *
 * A unit test of the merge rule proves the arithmetic. It does not prove the node asks
 * the question at all. So this drives a REAL master over a REAL socket: it dials in,
 * answers the node's `settings:get`, and then the node's own database is read back to
 * see whether the shop's settings actually landed — and whether the things that
 * describe the machine itself were correctly left alone.
 */

const PORT = 47803
const TOKEN = 'tok-settings-sync'

const MASTER: Identity = {
  machineName: 'MASTER-PC',
  appVersion: '1.0.0-test',
  businessName: 'كريسبو بروست',
}

/** What the master claims its settings are when the node asks. */
const MASTER_SETTINGS: Record<string, unknown> = {
  business_name: 'كريسبو بروست',
  tax_rate: 0.14,
  max_cashier_discount: 7,
  shifts_per_day: 1,
  shift1_name: 'اليوم كامل',
  shift1_start: '12:00',
  shift1_end: '04:00',
  currency_symbol: 'ج.م',
  receipt_footer: 'شكراً لزيارتكم',
  print_auto: 1,
  whatsapp_group: '01000000000',
  // Things that describe the MASTER MACHINE. None of these may be copied — the first
  // one would tell this till it is the master.
  net_mode: 'master',
  net_token: 'master-own-token',
  net_port: 60000,
  net_master_name: 'SOMEONE-ELSE',
  backup_folder: 'D:\\master-backups',
  shift_export_folder: 'D:\\master-reports',
}

/** A master that dials the node and serves whatever the node asks for. */
function startDial(settings: Record<string, unknown>): Promise<{
  socket: Socket
  asked: string[]
  close: () => void
}> {
  return new Promise((resolve, reject) => {
    const asked: string[] = []
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: LINK_PATH, method: 'GET',
      headers: {
        connection: 'Upgrade',
        upgrade: LINK_PROTOCOL,
        [TOKEN_HEADER]: TOKEN,
        'x-resto-master': encodeIdentityHeader(MASTER),
      },
      timeout: 5000,
    })

    req.on('upgrade', (res, socket: Socket, head: Buffer) => {
      // The node introduced itself — prove that survived the wire too.
      const node = decodeIdentityHeader(res.headers[NODE_HEADER])
      expect(node.machineName).toBeTruthy()

      let buffer = ''

      const consume = (chunk: Buffer) => {
        buffer += chunk.toString('utf8')
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.trim()) continue
          let frame: LinkFrame
          try { frame = JSON.parse(line) } catch { continue }

          if (frame.t === 'ping') {
            socket.write(JSON.stringify({ t: 'pong', at: Date.now() }) + '\n')
          } else if (frame.t === 'req') {
            asked.push(frame.channel)
            // The master answers on behalf of the shop's own books.
            const result = frame.channel === 'settings:get'
              ? { success: true, data: settings }
              : { success: false, error: 'not served in this test' }
            socket.write(JSON.stringify({ t: 'res', id: frame.id, result }) + '\n')
          }
        }
      }

      socket.on('data', consume)
      // The node asks for the settings the instant the link is up, so its first frame
      // usually arrives glued to the 101 response — Node hands those bytes over as
      // `head`, not as a 'data' event. Dropping them loses the very request under
      // test, which is exactly what happened the first time this ran.
      if (head && head.length) consume(head)

      resolve({ socket, asked, close: () => socket.destroy() })
    })

    req.on('response', res => { res.resume(); reject(new Error(`upgrade refused: ${res.statusCode}`)) })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('dial timed out')) })
    req.end()
  })
}

const settle = (ms = 350) => new Promise(r => setTimeout(r, ms))

beforeAll(async () => {
  initDatabase()
  await startServer(PORT)
})

afterEach(() => { stopNodeMode() })
afterAll(async () => { await stopServer() })

/** Put this till back to a distinct set of values before each scenario. */
function makeNode(own: Record<string, unknown> = {}) {
  updateSettings({
    net_mode: 'node',
    net_token: TOKEN,
    net_master_name: MASTER.machineName,
    // Deliberately DIFFERENT from the master's, so adoption is visible.
    business_name: 'اسم قديم على الجهاز التابع',
    tax_rate: 0,
    max_cashier_discount: 50,
    shifts_per_day: 2,
    shift1_name: 'صباحية',
    shift1_start: '09:00',
    shift1_end: '17:00',
    net_port: 47803,
    backup_folder: 'C:\\node-own-backups',
    ...own,
  } as never)
}

describe('a node takes the master’s settings, over a real link', () => {
  it('asks for them as soon as the link comes up', async () => {
    makeNode()
    const master = await startDial(MASTER_SETTINGS)
    await settle()

    console.log('node asked the master for:', JSON.stringify(master.asked))
    expect(isNodeLinked()).toBe(true)
    expect(master.asked).toContain('settings:get')

    master.close()
  })

  it('adopts the shop settings into its OWN database', async () => {
    makeNode()
    const master = await startDial(MASTER_SETTINGS)
    await settle()

    const s = getSettings()
    console.log('node now has:', JSON.stringify({
      name: s.business_name, tax: s.tax_rate, cap: s.max_cashier_discount,
      shifts: s.shifts_per_day, s1: `${s.shift1_start}-${s.shift1_end}`, s1name: s.shift1_name,
    }))

    expect(s.business_name).toBe('كريسبو بروست')
    expect(s.tax_rate).toBeCloseTo(0.14)
    expect(s.max_cashier_discount).toBe(7)
    expect(s.shifts_per_day).toBe(1)
    expect(s.shift1_name).toBe('اليوم كامل')
    expect(s.shift1_start).toBe('12:00')
    expect(s.shift1_end).toBe('04:00')
    expect(s.receipt_footer).toBe('شكراً لزيارتكم')

    master.close()
  })

  it('the adopted shift times actually drive the node’s own shift logic', async () => {
    makeNode()
    const master = await startDial(MASTER_SETTINGS)
    await settle()

    // Not just stored — in use. One shift a day, 12:00→04:00.
    const windows = shiftWindows()
    console.log('node shift windows:', JSON.stringify(windows))
    expect(windows).toHaveLength(1)
    expect(windows[0].start).toBe('12:00')
    expect(windows[0].end).toBe('04:00')

    master.close()
  })

  it('does NOT take the master’s network identity — that would make it a second master', async () => {
    makeNode()
    const master = await startDial(MASTER_SETTINGS)
    await settle()

    const s = getSettings() as any
    console.log('node network settings after sync:', JSON.stringify({
      mode: s.net_mode, token: s.net_token, port: s.net_port,
      masterName: s.net_master_name, backup: s.backup_folder,
    }))

    expect(s.net_mode).toBe('node')                 // still a node
    expect(s.net_token).toBe(TOKEN)                 // its own token
    expect(s.net_port).toBe(47803)                  // its own port
    expect(s.net_master_name).toBe(MASTER.machineName)
    expect(s.backup_folder).toBe('C:\\node-own-backups')
    expect(s.shift_export_folder).not.toBe('D:\\master-reports')

    master.close()
  })

  it('keeps them after the master goes away — they are in its own database', async () => {
    makeNode()
    const master = await startDial(MASTER_SETTINGS)
    await settle()
    master.close()
    await settle()

    // The link is gone; the settings are not. This is the restart case.
    const s = getSettings()
    expect(s.tax_rate).toBeCloseTo(0.14)
    expect(s.shifts_per_day).toBe(1)
    expect(s.business_name).toBe('كريسبو بروست')
  })

  it('follows a later change the master makes, without a reconnect', async () => {
    makeNode()
    const master = await startDial(MASTER_SETTINGS)
    await settle()
    expect(getSettings().tax_rate).toBeCloseTo(0.14)

    // The owner changes VAT at the master; it pushes the new set to every till.
    master.socket.write(JSON.stringify({
      t: 'evt', event: 'app:settingsChanged',
      data: { ...MASTER_SETTINGS, tax_rate: 0.05, max_cashier_discount: 3 },
    }) + '\n')
    await settle()

    const s = getSettings()
    console.log('after a push:', JSON.stringify({ tax: s.tax_rate, cap: s.max_cashier_discount }))
    expect(s.tax_rate).toBeCloseTo(0.05)
    expect(s.max_cashier_discount).toBe(3)
    // …and still not the master's identity.
    expect((s as any).net_mode).toBe('node')

    master.close()
  })

  it('adopts a VAT rate of zero — the master charging none is a real instruction', async () => {
    makeNode({ tax_rate: 0.14 })
    const master = await startDial({ ...MASTER_SETTINGS, tax_rate: 0 })
    await settle()

    expect(getSettings().tax_rate).toBe(0)
    master.close()
  })
})
