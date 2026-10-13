import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { initDatabase } from '../src/main/db/db'
import { getSettings, updateSettings } from '../src/main/services/settingsService'
import { startServer, stopServer } from '../src/main/net/tillServer'
import { adoptTill, tillSummaries, stopMasterMode, startMasterMode } from '../src/main/net/masterLink'
import { stopNodeMode } from '../src/main/net/nodeLink'
import { applyNetworkMode } from '../src/main/net/mode'

/**
 * Pair the two tills ONCE, and they find each other from then on.
 *
 * Adoption is the whole of the setup: one press at the master, nothing typed at the
 * other machine. What was missing is that it never said this machine had become a
 * master — and two things read that flag:
 *
 *   supervise()            returns immediately unless master mode is running, so on a
 *                          machine still set to «جهاز واحد» the adoption enrolled the
 *                          other PC and then never dialled it. Nothing connected, and
 *                          nothing said why.
 *   applyNetworkMode()     runs at every startup and starts master mode only when the
 *                          setting says master. Left standalone, the saved till list
 *                          was loaded by nobody — so a pair that HAD been connected
 *                          came up disconnected the next morning and stayed that way.
 *
 * Both are what "I connected it once, it should connect by itself" is about.
 */

const NODE_PORT = 47805

beforeAll(async () => {
  initDatabase()
  // A second machine on the LAN, waiting to be adopted: it is running the app and
  // nobody has claimed it yet.
  updateSettings({ net_mode: 'standalone', net_master_name: '', net_tills: '[]' } as never)
  await startServer(NODE_PORT)
})

afterEach(() => {
  stopMasterMode()
  stopNodeMode()
})

afterAll(async () => {
  stopMasterMode()
  stopNodeMode()
  await stopServer()
})

describe('adopting the second PC', () => {
  it('starts from a machine that is not a master', () => {
    expect(getSettings().net_mode).toBe('standalone')
    expect(getSettings().net_tills).toBe('[]')
  })

  it('turns this machine into the master AND starts dialling immediately', async () => {
    const res = await adoptTill('127.0.0.1', NODE_PORT)
    console.log('adopt:', JSON.stringify(res))
    expect(res.success).toBe(true)

    // THE fix: without this, supervise() bails and nothing is ever dialled.
    expect(getSettings().net_mode).toBe('master')

    // Asserted here rather than in a test of its own, because `afterEach` tears master
    // mode down between tests — a separate test would be checking a machine that had
    // just been switched off.
    const tills = tillSummaries()
    console.log('tills being supervised:', JSON.stringify(tills.map(t => ({
      name: t.machineName, state: t.state,
    }))))
    expect(tills).toHaveLength(1)
    // 'idle' would mean nobody is dialling it — the old behaviour.
    expect(['connecting', 'connected', 'relocating', 'retrying']).toContain(tills[0].state)
  })

  it('remembers the till, with the address it was found at', () => {
    const stored = JSON.parse(getSettings().net_tills) as any[]
    console.log('stored tills:', JSON.stringify(stored.map(t => ({
      name: t.machineName, host: t.host, port: t.port,
    }))))

    expect(stored).toHaveLength(1)
    expect(stored[0].machineName).toBeTruthy()
    expect(stored[0].port).toBe(NODE_PORT)
    expect(stored[0].id).toBeTruthy()
  })
})

describe('after a restart', () => {
  it('picks the till back up with nobody pressing anything', async () => {
    // Whatever the previous block left running, gone — this is a cold boot.
    stopMasterMode()
    expect(tillSummaries()).toHaveLength(0)

    // Exactly what startup does: read the settings and become whatever they say.
    await applyNetworkMode()

    const tills = tillSummaries()
    console.log('after restart:', JSON.stringify(tills.map(t => ({
      name: t.machineName, host: t.host, state: t.state,
    }))))

    expect(getSettings().net_mode).toBe('master')
    expect(tills).toHaveLength(1)
    expect(['connecting', 'connected', 'relocating', 'retrying']).toContain(tills[0].state)
  })

  it('would do nothing at all if the mode had not been saved', async () => {
    // The old behaviour, shown deliberately: the till list is still on the books, but
    // a machine that never recorded itself as a master supervises none of it.
    const saved = getSettings().net_tills
    updateSettings({ net_mode: 'standalone' } as never)

    await applyNetworkMode()

    console.log('standalone startup — tills supervised:', tillSummaries().length)
    expect(JSON.parse(saved)).toHaveLength(1)   // the record is still there…
    expect(tillSummaries()).toHaveLength(0)          // …and nothing is dialling it

    // Put it back for the rest of the run.
    updateSettings({ net_mode: 'master' } as never)
    await applyNetworkMode()
    expect(tillSummaries()).toHaveLength(1)
  })
})
