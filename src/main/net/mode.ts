/**
 * Bringing this machine into whatever role the settings say.
 *
 * Called at startup and again whenever the role changes, so switching between
 * standalone, master and node never needs a restart.
 *
 * The presence server starts in EVERY mode, including standalone. A till that is not
 * listening cannot be found and cannot be adopted — and a shop being set up for the
 * first time is all standalone tills, so a server that only ran once you were already
 * a master meant the one screen designed to connect two machines could only find
 * machines that had already been connected.
 */

import log from 'electron-log/main'
import { getSettings } from '../services/settingsService'
import { startServer, stopServer } from './tillServer'
import { startMasterMode, stopMasterMode, ensureFleetIdentity } from './masterLink'
import { startNodeMode, stopNodeMode, setModeApplier } from './nodeLink'
import type { NetworkMode } from './protocol'

export async function applyNetworkMode(): Promise<void> {
  const s = getSettings()
  // Settings are stored as free text; anything unrecognised is a till on its own.
  const mode: NetworkMode =
    s.net_mode === 'master' || s.net_mode === 'node' ? s.net_mode : 'standalone'

  // Tear the previous role down first — a machine is one thing at a time, and a
  // master that is now a node must stop answering for a database it no longer owns.
  stopNodeMode()
  stopMasterMode()
  await stopServer()

  try {
    // Non-fatal on purpose. A second copy of the app already holding the port must not
    // stop this one from trading — it only makes it undiscoverable.
    try {
      await startServer(s.net_port)
    } catch (err: any) {
      log.warn(`[Net] Presence server not started: ${err?.message || err}`)
    }

    if (mode === 'master') {
      ensureFleetIdentity()
      startMasterMode()
    } else if (mode === 'node') {
      startNodeMode()
    } else {
      log.info('[Net] Standalone — this till owns its own database')
    }
  } catch (err: any) {
    log.error('[Net] Could not apply network mode:', err?.message || err)
  }
}

/**
 * Let a node act on a `drop` command without importing this module — which would be
 * a cycle, since this one imports the node.
 */
setModeApplier(applyNetworkMode)
