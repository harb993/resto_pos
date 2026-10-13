#!/usr/bin/env node
/**
 * The owner's licence tool. Not shipped inside the app — see `build.files` in
 * package.json, which packages `out/` and nothing else.
 *
 * The app can only VERIFY a licence; it holds the public half of an Ed25519 pair.
 * Minting one needs the private half, which lives in `license-private.pem` next to
 * this repository and must never be copied onto a till. That is the whole point:
 * someone who copies the installed program to a second PC still cannot activate it,
 * because the file that authorises a machine is not on that PC and cannot be derived
 * from anything that is.
 *
 *   node tools/license-keygen.mjs init            — create the key pair (once, ever)
 *   node tools/license-keygen.mjs sign <DEVICE-ID> — authorise one machine
 *   node tools/license-keygen.mjs pubkey           — reprint the embeddable public key
 *
 * Keep `license-private.pem` backed up somewhere safe and off the tills. Losing it
 * means no NEW machine can ever be activated — already-activated tills keep working,
 * but you would have to ship a new build with a new public key to add another.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PRIVATE_FILE = path.join(ROOT, 'license-private.pem')

/** Strip the formatting a person sees, so a device id can be pasted back in any shape. */
function normalizeDeviceId(raw) {
  return String(raw || '').toUpperCase().replace(/[^0-9A-F]/g, '')
}

function groups(s, n) {
  return (s.match(new RegExp(`.{1,${n}}`, 'g')) || []).join('-')
}

function init() {
  if (fs.existsSync(PRIVATE_FILE)) {
    console.error(`Refusing to overwrite ${PRIVATE_FILE}.`)
    console.error('That file authorises every till you will ever activate — if you')
    console.error('replace it, no already-issued key can be re-issued. Delete it by')
    console.error('hand only if you are certain.')
    process.exit(1)
  }

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
  fs.writeFileSync(
    PRIVATE_FILE,
    privateKey.export({ type: 'pkcs8', format: 'pem' }),
    { mode: 0o600 },
  )
  console.log(`Private key written to ${PRIVATE_FILE}`)
  console.log('Back it up somewhere off this PC. Never put it on a till.\n')
  printPublic(publicKey)
}

function loadPrivate() {
  if (!fs.existsSync(PRIVATE_FILE)) {
    console.error(`No ${PRIVATE_FILE}. Run: node tools/license-keygen.mjs init`)
    process.exit(1)
  }
  return crypto.createPrivateKey(fs.readFileSync(PRIVATE_FILE, 'utf8'))
}

function printPublic(publicKey) {
  const raw = publicKey.export({ type: 'spki', format: 'der' })
  console.log('Public key (already embedded in src/main/services/licenseService.ts):')
  console.log(`  ${raw.toString('base64')}`)
}

function sign(deviceIdRaw) {
  const deviceId = normalizeDeviceId(deviceIdRaw)
  if (deviceId.length < 16) {
    console.error('That does not look like a device id. Copy it from the activation')
    console.error('screen on the till — it looks like A1B2-C3D4-E5F6-7890-1234.')
    process.exit(1)
  }

  const privateKey = loadPrivate()
  const signature = crypto.sign(null, Buffer.from(deviceId, 'utf8'), privateKey)
  // Hex, not base64: the till strips every non-hex character before checking, so the
  // key survives being wrapped by a mail client or broken up for legibility here.
  const key = signature.toString('hex').toUpperCase()

  console.log(`Device : ${groups(deviceId, 4)}`)
  console.log('Key    :')
  for (let i = 0; i < key.length; i += 32) {
    console.log(`  ${groups(key.slice(i, i + 32), 8)}`)
  }
  console.log('\nSend the key to that till and paste it into the activation screen.')
  console.log('Spaces, line breaks and dashes do not matter. It works on that machine')
  console.log('and no other.')
}

const [cmd, arg] = process.argv.slice(2)
switch (cmd) {
  case 'init': init(); break
  case 'sign': sign(arg); break
  case 'pubkey': printPublic(crypto.createPublicKey(loadPrivate())); break
  default:
    console.log('usage: node tools/license-keygen.mjs init | sign <DEVICE-ID> | pubkey')
    process.exit(1)
}
