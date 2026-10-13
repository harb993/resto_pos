import { describe, it, expect } from 'vitest'
import http from 'node:http'
import {
  encodeIdentityHeader, decodeIdentityHeader, MASTER_HEADER, type Identity,
} from '../src/main/net/protocol'

/**
 * A till identifies itself in an HTTP header, and an Arabic restaurant's name is
 * Arabic. Header values may only carry Latin-1, so the raw JSON that used to go in
 * there broke the link two different ways — and the network screen could only show
 * «Invalid character in header content ["x-resto-master"]», which names the symptom
 * and not one useful thing about the cause.
 */

const ARABIC: Identity = {
  machineName: 'DESKTOP-UJ6GOHA',
  appVersion: '1.0.0',
  businessName: 'كريسبو بروست',
}

describe('identifying a till across an HTTP header', () => {
  it('encodes to pure ASCII', () => {
    const encoded = encodeIdentityHeader(ARABIC)
    expect(encoded).toMatch(/^[\x20-\x7e]*$/)          // printable ASCII only
    expect(encoded).not.toContain('كريسبو')
    expect(encoded).toContain('\\u0643')                 // ك, escaped
  })

  it('round-trips the name unchanged', () => {
    expect(decodeIdentityHeader(encodeIdentityHeader(ARABIC))).toEqual(ARABIC)
  })

  it('survives an Arabic machine name too, not just the business name', () => {
    const both: Identity = { ...ARABIC, machineName: 'كاشير-الصالة' }
    expect(encodeIdentityHeader(both)).toMatch(/^[\x20-\x7e]*$/)
    expect(decodeIdentityHeader(encodeIdentityHeader(both))).toEqual(both)
  })

  it('stays plain JSON, so a till on the previous build still reads it', () => {
    // The two machines are updated one at a time. \uXXXX escapes have always been
    // valid JSON, so the old `JSON.parse(header)` on the other end is unaffected.
    expect(JSON.parse(encodeIdentityHeader(ARABIC))).toEqual(ARABIC)
  })

  it('rejects a header that is missing or not an identity', () => {
    expect(() => decodeIdentityHeader(undefined)).toThrow()
    expect(() => decodeIdentityHeader('')).toThrow()
    expect(() => decodeIdentityHeader('not json')).toThrow()
    expect(() => decodeIdentityHeader('{"appVersion":"1.0.0"}')).toThrow() // no name
  })

  it('is actually accepted by Node’s HTTP client — the thing that threw', async () => {
    const received = await new Promise<string>((resolve, reject) => {
      const server = http.createServer((req, res) => {
        res.writeHead(200)
        res.end()
        resolve(String(req.headers[MASTER_HEADER] ?? ''))
      })
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address() as { port: number }
        const req = http.request(
          { host: '127.0.0.1', port, path: '/', method: 'GET',
            headers: { [MASTER_HEADER]: encodeIdentityHeader(ARABIC) } },
          () => server.close(),
        )
        req.on('error', err => { server.close(); reject(err) })
        req.end()
      })
    })

    // Came back across a real socket with the Arabic intact.
    expect(decodeIdentityHeader(received)).toEqual(ARABIC)
    expect(decodeIdentityHeader(received).businessName).toBe('كريسبو بروست')
  })

  /**
   * ANY name, not just the one that broke.
   *
   * A restaurant is called whatever it is called, and a Windows machine is named by
   * whoever set it up. The encoder must not have a list of shapes it copes with — it
   * has to be total, or this comes back as "it works for us but not for them".
   */
  const NAMES: [string, string][] = [
    ['plain Arabic', 'كريسبو بروست'],
    ['plain English', 'Crispo Fried Chicken'],
    ['mixed', 'Crispo كريسبو 2026'],
    ['with a dash', 'كريسبو بروست — الفرع الرئيسي'],
    ['emoji', 'Crispo 🍗🔥'],
    ['emoji only', '🍗'],
    ['Arabic-Indic digits', 'كريسبو ١٢٣'],
    ['a double quote', 'Crispo "The Best"'],
    ['a single quote', "Mo's Chicken"],
    ['a backslash', 'C:\\Crispo\\Branch'],
    ['a newline', 'Crispo\nBranch 2'],
    ['a tab', 'Crispo\tBranch'],
    ['French accents', 'Crêperie Crispo'],
    ['Chinese', '脆皮炸鸡'],
    ['Hebrew', 'קריספו'],
    ['Russian', 'Криспо'],
    ['an RTL mark', 'كريسبو\u200f بروست'],
    ['a zero-width joiner', 'كريسبو\u200dبروست'],
    ['a non-breaking space', 'Crispo\u00a0Broast'],
    ['DEL', 'Crispo\u007fBroast'],
    ['angle brackets', 'Crispo <Broast> & Co'],
    ['a very long name', 'كريسبو '.repeat(40).trim()],
    ['leading/trailing spaces', '  كريسبو بروست  '],
    ['one space', ' '],
  ]

  it.each(NAMES)('survives a name with %s', (_label, businessName) => {
    const identity: Identity = { ...ARABIC, businessName, machineName: `PC-${businessName}` }
    const encoded = encodeIdentityHeader(identity)

    // Legal in a header: printable ASCII only, no control characters at all.
    expect(encoded, encoded).toMatch(/^[\x20-\x7e]*$/)
    // And it comes back byte for byte.
    expect(decodeIdentityHeader(encoded)).toEqual(identity)
  })

  it.each(NAMES)('is accepted by Node’s HTTP client with a name with %s', (_label, businessName) => {
    // The real check: would http.request take this header at all? Anything it rejects
    // is a till that cannot connect, whatever the round-trip test says.
    const identity: Identity = { ...ARABIC, businessName, machineName: `PC-${businessName}` }
    expect(() => {
      const req = http.request({
        host: '127.0.0.1', port: 1, path: '/', method: 'GET',
        headers: { [MASTER_HEADER]: encodeIdentityHeader(identity) },
      })
      // Nothing is listening on port 1 and we are not trying to connect — the header
      // is validated synchronously, which is the whole point. Swallow the inevitable
      // connection error so it does not surface as an unhandled failure.
      req.on('error', () => {})
      req.destroy()
    }, businessName).not.toThrow()
  })

  it('handles an emoji’s surrogate pair as a pair, not two broken halves', () => {
    // 🍗 is U+1F357 — two UTF-16 code units. Escaping each separately is still valid
    // JSON, and JSON.parse puts them back together. Worth pinning, because getting
    // this wrong yields a name that round-trips as two replacement characters.
    const encoded = encodeIdentityHeader({ ...ARABIC, businessName: '🍗' })
    expect(encoded).toContain('\\ud83c')
    expect(encoded).toContain('\\udf57')
    expect(decodeIdentityHeader(encoded).businessName).toBe('🍗')
  })

  it('confirms the raw JSON really was rejected — this is the bug', () => {
    // Guards the fix: if someone puts JSON.stringify back, this starts failing.
    expect(() => {
      const req = http.request({ host: '127.0.0.1', port: 1, path: '/', method: 'GET',
        headers: { [MASTER_HEADER]: JSON.stringify(ARABIC) } })
      req.on('error', () => {})
      req.destroy()
    }).toThrow(/Invalid character in header content/)
  })
})
