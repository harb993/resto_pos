import { describe, it, expect, beforeEach } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import {
  deviceId, formattedDeviceId, getLicenseStatus, isActivated, activate,
} from '../src/main/services/licenseService'

/** Every place activate() may have written, so a test can start from a clean slate. */
const keyFiles = [
  process.env.ProgramData ? path.join(process.env.ProgramData, 'CrispoPOS', 'license.key') : '',
  path.join(app.getPath('userData'), 'license.key'),
].filter(Boolean)
const keyFile = keyFiles[keyFiles.length - 1]

/**
 * Sign as the owner's tool would.
 *
 * A throwaway pair cannot be used — the app verifies against the public key baked
 * into it — so this reads the real private key. It is git-ignored and never packaged,
 * which is exactly the property under test: without it, no key can be minted.
 */
const PRIVATE_PEM = path.join(process.cwd(), 'license-private.pem')
const haveKeys = fs.existsSync(PRIVATE_PEM)

function ownerSigns(forDevice: string): string {
  const priv = crypto.createPrivateKey(fs.readFileSync(PRIVATE_PEM, 'utf8'))
  return crypto.sign(null, Buffer.from(forDevice, 'utf8'), priv).toString('hex').toUpperCase()
}

beforeEach(() => {
  for (const f of keyFiles) { try { fs.unlinkSync(f) } catch { /* already absent */ } }
})

describe('device identity', () => {
  it('is stable within a run and shaped for a person to read out', () => {
    expect(deviceId()).toBe(deviceId())
    expect(deviceId()).toMatch(/^[0-9A-F]{20}$/)
    expect(formattedDeviceId()).toMatch(/^([0-9A-F]{4}-){4}[0-9A-F]{4}$/)
  })
})

describe('activation', () => {
  it('starts locked, with the device id offered so a key can be requested', () => {
    const status = getLicenseStatus()
    expect(status.activated).toBe(false)
    expect(status.deviceId).toBe(formattedDeviceId())
    expect(isActivated()).toBe(false)
  })

  it.skipIf(!haveKeys)('accepts a key the owner signed for THIS machine', () => {
    const res = activate(ownerSigns(deviceId()))
    expect(res.success).toBe(true)
    expect(res.status.activated).toBe(true)
    expect(isActivated()).toBe(true)
  })

  it.skipIf(!haveKeys)('tolerates the spacing a key picks up being pasted around', () => {
    const key = ownerSigns(deviceId())
    const mangled = `  ${key.slice(0, 20)}-${key.slice(20, 50)}\n${key.slice(50)}  `
    expect(activate(mangled).success).toBe(true)
  })

  it.skipIf(!haveKeys)('refuses a key the owner signed for a DIFFERENT machine', () => {
    // The copied-to-another-PC case, from the far side: a perfectly valid key that
    // simply names someone else's hardware.
    const res = activate(ownerSigns('0123456789ABCDEF0123'))
    expect(res.success).toBe(false)
    expect(isActivated()).toBe(false)
  })

  it('refuses a key that was not signed by the owner at all', () => {
    // Anyone can generate a pair; only the owner's is baked into the app.
    const { privateKey } = crypto.generateKeyPairSync('ed25519')
    const forged = crypto.sign(null, Buffer.from(deviceId(), 'utf8'), privateKey)
    expect(activate(forged.toString('hex').toUpperCase()).success).toBe(false)
    expect(isActivated()).toBe(false)
  })

  it('refuses empty and malformed keys without throwing', () => {
    for (const bad of ['', '   ', 'not-a-key', 'AAAA', '!!!!']) {
      expect(activate(bad).success).toBe(false)
    }
    expect(isActivated()).toBe(false)
  })

  it.skipIf(!haveKeys)('locks again when the stored key belongs to another machine', () => {
    // Exactly what carrying the data folder to a second PC looks like from here:
    // a well-formed key on disk that does not match the hardware underneath it.
    fs.writeFileSync(keyFile, ownerSigns('FEDCBA98765432100000'), 'utf8')
    const status = getLicenseStatus()
    expect(status.activated).toBe(false)
    expect(status.reason).toBeTruthy()
  })
})

describe('the fingerprint is deterministic', () => {
  /**
   * The bug this pins: the id used to fold in a motherboard serial read by spawning
   * PowerShell, and every transient failure of that — a timeout on a booting machine,
   * antivirus, a locked-down execution policy — is indistinguishable from a board
   * with no serial. The id therefore changed shape between boots and a till that had
   * been working would lock ITSELF out with a key that no longer matched.
   *
   * So: no subprocess whose failure could change the answer, and the same id every
   * time it is asked, however many times that is.
   */
  it('gives the same id on repeated calls', () => {
    const ids = new Set(Array.from({ length: 50 }, () => deviceId()))
    expect(ids.size).toBe(1)
  })

  it('spawns nothing but the registry read', () => {
    // Comments still discuss the PowerShell call that was removed, so match the call
    // sites rather than the prose: every quiet() argument list in the file.
    const src = fs.readFileSync('src/main/services/licenseService.ts', 'utf8')
    const spawned = [...src.matchAll(/quiet\(\s*'([^']+)'/g)].map(m => m[1])
    expect(spawned).toEqual(['reg'])
  })
})

describe('key storage', () => {
  it.skipIf(!haveKeys)('survives losing the per-user copy, when a machine-wide one exists', () => {
    // A second Windows account on the same till reads the shared copy rather than
    // being sent back to the activation screen.
    activate(ownerSigns(deviceId()))
    const perUser = path.join(app.getPath('userData'), 'license.key')
    const shared = process.env.ProgramData
      ? path.join(process.env.ProgramData, 'CrispoPOS', 'license.key')
      : ''
    if (!shared || !fs.existsSync(shared)) return // ProgramData not writable here

    fs.unlinkSync(perUser)
    expect(getLicenseStatus().activated).toBe(true)
  })
})