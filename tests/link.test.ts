import { describe, it, expect, afterEach } from 'vitest'
import net from 'node:net'
import crypto from 'node:crypto'
import { Link } from '../src/main/net/link'
import type { Identity } from '../src/main/net/protocol'

/**
 * The duplex link between two tills.
 *
 * This is the piece everything else now rides on, and its failure modes are the ones
 * a cashier feels: a call that never comes back is a till that looks frozen, and a
 * mirror that arrives corrupted is worse than one that never arrives at all. So these
 * tests are about the promises the link makes rather than its shape — an answer for
 * every request, a named failure when there cannot be one, and bytes that survive the
 * trip exactly as they left.
 */

const WHO: Identity = { machineName: 'PEER', appVersion: '1.0.0-test', businessName: 'Test' }

let server: net.Server | null = null
const open: Link[] = []

afterEach(async () => {
  for (const l of open.splice(0)) l.close('test over')
  if (server) {
    await new Promise<void>(r => server!.close(() => r()))
    server = null
  }
})

/**
 * A pair of Links joined by a real TCP socket — the same arrangement as a master and
 * a till, minus the HTTP upgrade.
 */
async function pair(
  serverHandlers: ConstructorParameters<typeof Link>[2] = {},
  clientHandlers: ConstructorParameters<typeof Link>[2] = {},
): Promise<{ a: Link; b: Link }> {
  const sockets: net.Socket[] = []
  server = net.createServer(s => sockets.push(s))
  await new Promise<void>(r => server!.listen(0, '127.0.0.1', () => r()))
  const port = (server.address() as net.AddressInfo).port

  const client = net.connect(port, '127.0.0.1')
  await new Promise<void>(r => client.once('connect', () => r()))
  // The server's 'connection' handler may not have run yet on the same tick.
  while (sockets.length === 0) await new Promise(r => setTimeout(r, 5))

  const a = new Link(sockets[0], WHO, serverHandlers, 'A')
  const b = new Link(client, WHO, clientHandlers, 'B')
  open.push(a, b)
  return { a, b }
}

describe('a request always comes back', () => {
  it('carries a call to the other end and brings the answer home', async () => {
    const { a, b } = await pair({
      onRequest: async (channel, payload) => ({
        success: true,
        data: { channel, echoed: payload },
      }),
    })
    void a

    const res = await b.request('menu:list', { includeInactive: true })
    expect(res.success).toBe(true)
    expect((res.data as any).channel).toBe('menu:list')
    expect((res.data as any).echoed).toEqual({ includeInactive: true })
  })

  it('answers even when the far handler throws, rather than hanging the caller', async () => {
    // A silent end is the worst outcome here: the till spins forever and the cashier
    // has no idea whether the sale went through.
    const { a, b } = await pair({
      onRequest: async () => { throw new Error('قاعدة البيانات مقفلة') },
    })
    void a

    const res = await b.request('order:create', {})
    expect(res.success).toBe(false)
    expect(res.code).toBe('handler-threw')
    expect(res.error).toContain('قاعدة البيانات مقفلة')
  })

  it('refuses in words when the far end serves no requests at all', async () => {
    const { a, b } = await pair({}) // no onRequest installed
    void a

    const res = await b.request('menu:list', {})
    expect(res.success).toBe(false)
    expect(res.code).toBe('forbidden')
  })

  it('fails everything in flight the moment the link drops', async () => {
    // Left pending, these are a till that looks frozen rather than one that says it
    // is offline — which is the difference between "wait" and "go and check the PC".
    const { a, b } = await pair({
      onRequest: () => new Promise(() => { /* never answers */ }),
    })

    const inFlight = b.request('order:create', {})
    await new Promise(r => setTimeout(r, 50))
    a.close('the master was switched off')

    const res = await inFlight
    expect(res.success).toBe(false)
    expect(res.code).toBe('no-link')
    expect(res.error).toContain('PEER')
  })

  it('refuses immediately once closed, instead of waiting for a timeout', async () => {
    const { a, b } = await pair()
    void a
    b.close('done')

    const res = await b.request('menu:list', {})
    expect(res.code).toBe('no-link')
  })
})

describe('commands', () => {
  it('reports what the till actually did, not merely that it was told', async () => {
    // This is why print is a command now. The old one-way push could only say "sent",
    // so an empty paper roll in the kitchen looked exactly like a successful print.
    const { a, b } = await pair({}, {
      onCommand: async cmd => cmd.kind === 'print'
        ? { success: false, error: 'الورق فرغ' }
        : { success: true },
    })

    expect((await a.command({ kind: 'unlock' })).success).toBe(true)

    const printed = await a.command({
      kind: 'print',
      job: { printerId: 1, printerName: 'Kitchen', deviceName: 'K', payloadBase64: '' },
    })
    expect(printed.success).toBe(false)
    expect(printed.error).toBe('الورق فرغ')
    void b
  })
})

describe('files', () => {
  it('delivers a multi-chunk file byte for byte', async () => {
    // Two megabytes of noise: several chunks, so this exercises the reassembly rather
    // than a single frame that happens to fit.
    const payload = crypto.randomBytes(2 * 1024 * 1024)
    let landed: Buffer | null = null

    const { a, b } = await pair({}, {
      onFile: async (_meta, data) => { landed = data; return { success: true } },
    })
    void b

    const res = await a.sendFile({
      kind: 'mirror',
      name: 'mirror.db',
      bytes: payload.length,
      digest: crypto.createHash('sha256').update(payload).digest('hex'),
    }, payload)

    expect(res.success).toBe(true)
    expect(landed).not.toBeNull()
    expect(Buffer.compare(landed!, payload)).toBe(0)
  }, 30_000)

  it('says so when the receiver will not take files', async () => {
    const { a, b } = await pair({}, {})
    void b
    const res = await a.sendFile(
      { kind: 'backup', name: 'x.db', bytes: 3, digest: 'x' },
      Buffer.from('abc'),
    )
    expect(res.success).toBe(false)
    expect(res.code).toBe('forbidden')
  })
})

describe('framing', () => {
  it('reassembles an Arabic message split across TCP chunks', async () => {
    // Every message in this app is Arabic, so a multi-byte character straddling a
    // chunk boundary is the normal case, not an edge one. Decoding each chunk
    // independently would turn it into replacement characters — and because the
    // socket cannot be put into utf8 mode (Node forbids it on an upgraded socket),
    // this is decoded by hand and therefore worth pinning down.
    const sockets: net.Socket[] = []
    server = net.createServer(s => sockets.push(s))
    await new Promise<void>(r => server!.listen(0, '127.0.0.1', () => r()))
    const port = (server.address() as net.AddressInfo).port

    const raw = net.connect(port, '127.0.0.1')
    await new Promise<void>(r => raw.once('connect', () => r()))
    while (sockets.length === 0) await new Promise(r => setTimeout(r, 5))

    let seen: unknown = null
    const link = new Link(sockets[0], WHO, {
      onEvent: (_e, data) => { seen = data },
    }, 'split')
    open.push(link)

    const message = 'لا يمكن الوصول إلى الجهاز الرئيسي — تحقق من الكابل والشبكة'
    const line = Buffer.from(JSON.stringify({ t: 'evt', event: 'x', data: message }) + '\n', 'utf8')

    // Cut the buffer at an odd byte so at least one Arabic character is torn in half.
    const cut = 41
    raw.write(line.subarray(0, cut))
    await new Promise(r => setTimeout(r, 30))
    raw.write(line.subarray(cut))
    await new Promise(r => setTimeout(r, 50))

    expect(seen).toBe(message)
    raw.destroy()
  })

  it('ignores an unreadable frame instead of tearing the link down', async () => {
    const { a, b } = await pair({
      onRequest: async () => ({ success: true, data: 'still here' }),
    })

    // A stray line that is not JSON. One bad frame must not cost the whole link —
    // that would turn a cosmetic bug into a till that stops trading.
    ;(b as unknown as { socket: net.Socket }).socket.write('this is not json\n')
    await new Promise(r => setTimeout(r, 30))

    const res = await b.request('menu:list', {})
    expect(res.data).toBe('still here')
    expect(a.alive).toBe(true)
  })
})
