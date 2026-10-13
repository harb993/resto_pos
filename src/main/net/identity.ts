/**
 * How this machine introduces itself to the other till.
 *
 * Its own module because both ends of the link need it and neither should have to
 * import the other to get it — the master needs it to say who is dialling, the till
 * server needs it to answer, and a cycle between those two is the kind of thing that
 * only shows up as an undefined function at startup.
 */

import os from 'node:os'
import { app } from 'electron'
import { getSettings } from '../services/settingsService'
import type { Identity } from './protocol'

export function localIdentity(): Identity {
  return {
    // The Windows computer name. Stable across address changes, which is what makes
    // it the thing a master uses to find one of its tills again.
    machineName: os.hostname(),
    appVersion: app.getVersion(),
    businessName: getSettings().business_name,
  }
}
