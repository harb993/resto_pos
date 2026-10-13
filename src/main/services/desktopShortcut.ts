/**
 * «أبو الدهب» on the Windows desktop, with the restaurant's logo — put there by the
 * program itself the first time it runs.
 *
 * The till is shipped as a folder (or a portable .exe), not an installer, so nothing
 * else would ever create the shortcut: whoever set the PC up had to dig into the
 * folder for the .exe every morning, or make a shortcut by hand. The icon comes from
 * the .exe, which carries the logo.
 *
 * Once per machine. A shortcut the owner deletes stays deleted — the program does not
 * get to decide what lives on somebody's desktop twice. The one exception is a
 * shortcut that is still there but points at an old location of the program: moving
 * the folder would otherwise leave a logo on the desktop that opens nothing, so that
 * one is quietly pointed at where the program now is.
 *
 * Never throws. A shortcut is a convenience; failing to make one must not stop a sale.
 */

import path from 'node:path'

/** What the shortcut is called on the desktop. */
export const SHORTCUT_NAME = 'أبو الدهب'

/** Settings key recording that the shortcut has had its one turn on this machine. */
export const SHORTCUT_MARKER_KEY = 'desktop_shortcut_offered'

export interface ShortcutOptions {
  target: string
  cwd: string
  icon: string
  iconIndex: number
  description: string
}

/** Everything the decision touches, so it can be exercised without Windows. */
export interface ShortcutEnv {
  platform: NodeJS.Platform
  isPackaged: boolean
  /** The .exe a double-click should start — the portable wrapper, when there is one. */
  target: string
  desktopDir: string
  exists: (file: string) => boolean
  /** The target of an existing shortcut, or null when it cannot be read. */
  readTarget: (file: string) => string | null
  write: (file: string, operation: 'create' | 'replace', options: ShortcutOptions) => boolean
  alreadyOffered: () => boolean
  markOffered: () => void
}

export type ShortcutOutcome = 'created' | 'repaired' | 'kept' | 'declined' | 'skipped' | 'failed'

/** Windows paths compare case-insensitively and with either slash. */
const samePath = (a: string, b: string) =>
  path.win32.normalize(a).toLowerCase() === path.win32.normalize(b).toLowerCase()

export function ensureDesktopShortcut(env: ShortcutEnv): ShortcutOutcome {
  // A development run, or a till that is not on Windows: there is no installed .exe
  // to point at, and .lnk files mean nothing elsewhere.
  if (env.platform !== 'win32' || !env.isPackaged) return 'skipped'

  const file = path.win32.join(env.desktopDir, `${SHORTCUT_NAME}.lnk`)
  const options: ShortcutOptions = {
    target: env.target,
    cwd: path.win32.dirname(env.target),
    icon: env.target,
    iconIndex: 0,
    description: 'أبو الدهب — مشاوي شاورما كشري — نظام الكاشير',
  }

  try {
    if (env.exists(file)) {
      if (!env.alreadyOffered()) env.markOffered()
      const current = env.readTarget(file)
      // Unreadable is not the same as wrong — leave a shortcut we cannot inspect alone.
      if (current === null || samePath(current, env.target)) return 'kept'
      return env.write(file, 'replace', options) ? 'repaired' : 'failed'
    }

    if (env.alreadyOffered()) return 'declined'

    if (!env.write(file, 'create', options)) return 'failed'
    env.markOffered()
    return 'created'
  } catch {
    return 'failed'
  }
}
