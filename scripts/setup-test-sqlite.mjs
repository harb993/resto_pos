#!/usr/bin/env node
/**
 * Provide a Node-ABI build of better-sqlite3 for the test run.
 *
 * The copy in node_modules is compiled against Electron's ABI (see the postinstall
 * script), so vitest — which runs under plain node — cannot load it. Rather than
 * making every developer hand-build one and export an env var, stage a second copy
 * under .test-sqlite/. vitest.config.ts picks it up automatically when present.
 *
 * Two strategies, in order of fidelity:
 *   1. Reuse the project's OWN better-sqlite3 version, fetching its node prebuild.
 *      Preferred — the tests then run the exact version the app ships.
 *   2. Fall back to installing the latest better-sqlite3, which publishes prebuilds
 *      for current Node releases. (v11 has none for Node 24, for example.) The API
 *      surface these tests use — prepare/exec/pragma/transaction/backup/close — is
 *      unchanged across these versions, and what is under test is our SQL and our
 *      code, not the driver.
 *
 * Readiness is decided by actually LOADING the staged module, not by looking for a
 * file: v11 puts its binary in build/Release, while the N-API-based v13 ships one
 * in prebuilds/. Probing the load works for any of them.
 *
 * Never fatal: if neither strategy works, exit 0 and let the pure-logic suites run.
 */
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'

const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const source = path.join(root, 'node_modules', 'better-sqlite3')
// Kept OUTSIDE node_modules so `npm install` here cannot confuse npm's own
// tree resolution.
const stageRoot = path.join(root, '.test-sqlite')
const pkgDir = path.join(stageRoot, 'node_modules', 'better-sqlite3')
const entry = path.join(pkgDir, 'lib', 'index.js')

/** Can this staged copy actually open a database under the current node? */
function canLoad() {
  if (!fs.existsSync(entry)) return false
  const probe =
    `const {createRequire}=require('module');` +
    `const r=createRequire(${JSON.stringify(path.join(pkgDir, 'package.json'))});` +
    `const D=r(${JSON.stringify(entry)});` +
    `const db=new D(':memory:');db.exec('CREATE TABLE t(a)');db.close();`
  try {
    execFileSync(process.execPath, ['-e', probe], { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

function stagedVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf-8')).version
  } catch {
    return 'unknown'
  }
}

const ok = (msg) => { console.log(`[setup-test-sqlite] ${msg}`); process.exit(0) }
const giveUp = (msg) => {
  console.error(
    `[setup-test-sqlite] ${msg}\n` +
    `  Database-backed tests will be skipped; pure-logic tests still run.\n` +
    `  To run them, point RESTO_TEST_SQLITE at a Node-ABI better-sqlite3 entry point.`
  )
  process.exit(0) // not fatal by design
}

if (canLoad()) ok(`up to date — better-sqlite3 ${stagedVersion()} loads under node ${process.versions.node}`)

console.log(`[setup-test-sqlite] staging better-sqlite3 for node ${process.versions.node} (ABI ${process.versions.modules})`)
fs.rmSync(stageRoot, { recursive: true, force: true })
fs.mkdirSync(path.dirname(pkgDir), { recursive: true })

// ---- Strategy 1: the project's own version ----
let ownVersion = null
if (fs.existsSync(source)) {
  ownVersion = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf-8')).version }
    catch { return null }
  })()
  try {
    // Copy JS/package files but NOT build/, which holds the Electron-ABI binary.
    fs.cpSync(source, pkgDir, {
      recursive: true,
      filter: (src) => !src.split(path.sep).includes('build'),
    })
    const prebuildInstall = require.resolve('prebuild-install/bin.js')
    // Spawn the JS entry with the current node binary: on Windows, spawning npx.cmd
    // without a shell throws EINVAL under Node's CVE-2024-27980 hardening.
    execFileSync(process.execPath, [prebuildInstall, '--runtime', 'node', '--target', process.versions.node], {
      cwd: pkgDir,
      stdio: 'inherit',
    })
  } catch {
    // fall through to strategy 2
  }
  if (canLoad()) ok(`ready — better-sqlite3 ${stagedVersion()} (matches the app)`)

  console.log(
    `[setup-test-sqlite] no usable node build of better-sqlite3 ${ownVersion ?? '?'} for node ` +
    `${process.versions.node}; falling back to the latest release`
  )
  fs.rmSync(pkgDir, { recursive: true, force: true })
}

/**
 * Locate npm. It is NOT resolvable from the project's node_modules (npm is not a
 * dependency), so prefer npm_execpath — which npm itself sets for lifecycle
 * scripts — then the copy shipped beside the node binary, and only then fall back
 * to a shell lookup on PATH.
 */
function npmCommand() {
  const viaEnv = process.env.npm_execpath
  if (viaEnv && fs.existsSync(viaEnv) && viaEnv.endsWith('.js')) {
    return { file: process.execPath, prefix: [viaEnv], shell: false }
  }
  const beside = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (fs.existsSync(beside)) {
    return { file: process.execPath, prefix: [beside], shell: false }
  }
  // Last resort: PATH lookup. Needs a shell on Windows because npm is a .cmd.
  return { file: process.platform === 'win32' ? 'npm.cmd' : 'npm', prefix: [], shell: true }
}

// ---- Strategy 2: latest release, which does publish current-Node prebuilds ----
try {
  fs.mkdirSync(stageRoot, { recursive: true })
  fs.writeFileSync(
    path.join(stageRoot, 'package.json'),
    JSON.stringify({ name: 'resto-test-sqlite', version: '1.0.0', private: true }, null, 2)
  )
  const npm = npmCommand()
  execFileSync(
    npm.file,
    [...npm.prefix, 'install', 'better-sqlite3@latest', '--no-audit', '--no-fund', '--loglevel', 'error'],
    { cwd: stageRoot, stdio: 'inherit', shell: npm.shell }
  )
} catch (err) {
  giveUp(`could not install a Node-ABI better-sqlite3: ${err?.message ?? err}`)
}

// Some environments block package lifecycle scripts by policy, which leaves the JS
// in place but no binary. Fetch the prebuild explicitly rather than assuming.
if (!canLoad()) {
  const candidates = [
    path.join(stageRoot, 'node_modules', 'prebuild-install', 'bin.js'),
    (() => { try { return require.resolve('prebuild-install/bin.js') } catch { return null } })(),
  ].filter(Boolean)

  for (const bin of candidates) {
    try {
      execFileSync(process.execPath, [bin, '--runtime', 'node', '--target', process.versions.node], {
        cwd: pkgDir,
        stdio: 'inherit',
      })
      if (canLoad()) break
    } catch { /* try the next candidate */ }
  }
}

if (!canLoad()) giveUp('better-sqlite3 was installed but could not be loaded under this node version.')

ok(`ready — better-sqlite3 ${stagedVersion()} (app ships ${ownVersion ?? 'unknown'}; test harness only)`)
