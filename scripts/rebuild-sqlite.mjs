#!/usr/bin/env node
/**
 * Fetch the better-sqlite3 native binary that matches the Electron version this
 * project actually depends on.
 *
 * This used to be an inline `prebuild-install --target 31.0.0`. The version was
 * hardcoded, so bumping Electron in package.json produced a binary built for the
 * wrong ABI and the app died at startup with NODE_MODULE_VERSION mismatch. Read
 * the installed Electron version instead so the two can never drift.
 */
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

let electronVersion
try {
  electronVersion = require('electron/package.json').version
} catch {
  console.warn('[rebuild-sqlite] electron is not installed — skipping native rebuild.')
  process.exit(0)
}

const cwd = path.join(root, 'node_modules', 'better-sqlite3')

// Run prebuild-install's JS entry point with the current node binary rather than
// shelling out to `npx`. On Windows, spawning npx.cmd without a shell throws
// EINVAL (the CVE-2024-27980 hardening in modern Node), and spawning it WITH a
// shell drags in quoting problems — resolving the script directly avoids both.
let prebuildInstall
try {
  prebuildInstall = require.resolve('prebuild-install/bin.js')
} catch {
  console.error('[rebuild-sqlite] prebuild-install is not installed — run `npm install` first.')
  process.exit(1)
}

// Native prebuilds are published per Electron ABI, and the ABI is fixed by the MAJOR
// version — prebuild-install cannot always resolve an exact patch release (there is
// no published artifact for 31.7.7, for example). Try the exact version first in case
// it exists, then fall back to <major>.0.0, which is the ABI-defining release.
const major = electronVersion.split('.')[0]
const targets = [...new Set([electronVersion, `${major}.0.0`])]

for (const target of targets) {
  process.stdout.write(`[rebuild-sqlite] trying prebuilt better-sqlite3 for Electron ${target}\n`)
  try {
    execFileSync(process.execPath, [prebuildInstall, '--runtime', 'electron', '--target', target], {
      cwd,
      stdio: 'inherit',
    })
    console.log(`[rebuild-sqlite] OK — installed binary for Electron ${target} (ABI of ${major}.x)`)
    process.exit(0)
  } catch {
    // try the next candidate
  }
}

console.error(
  `[rebuild-sqlite] No prebuilt better-sqlite3 for Electron ${electronVersion} (tried ${targets.join(', ')}).\n` +
  `  Build it from source instead:\n` +
  `    npx electron-rebuild -f -w better-sqlite3\n` +
  `  (needs the Visual Studio C++ build tools on Windows.)`
)
process.exit(1)
