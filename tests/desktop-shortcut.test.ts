import { describe, it, expect } from 'vitest'
import {
  ensureDesktopShortcut, SHORTCUT_NAME, type ShortcutEnv, type ShortcutOptions,
} from '../src/main/services/desktopShortcut'

/**
 * «أبو الدهب» on the desktop, made by the program on its first run on Windows.
 *
 * Exercised against a pretend desktop: a map of .lnk files to the .exe they open.
 */

const EXE = 'C:\\Users\\Cashier\\Desktop\\aboeldahab\\AboElDahab.exe'
const DESKTOP = 'C:\\Users\\Cashier\\Desktop'
const LNK = `${DESKTOP}\\${SHORTCUT_NAME}.lnk`

function pretend(over: Partial<ShortcutEnv> = {}) {
  const desktop = new Map<string, string>()
  let offered = false
  const writes: { file: string; operation: string; options: ShortcutOptions }[] = []
  const env: ShortcutEnv = {
    platform: 'win32',
    isPackaged: true,
    target: EXE,
    desktopDir: DESKTOP,
    exists: f => desktop.has(f),
    readTarget: f => desktop.get(f) ?? null,
    write: (file, operation, options) => {
      writes.push({ file, operation, options })
      desktop.set(file, options.target)
      return true
    },
    alreadyOffered: () => offered,
    markOffered: () => { offered = true },
    ...over,
  }
  return { env, desktop, writes, isOffered: () => offered }
}

describe('the first run on a Windows till', () => {
  it('puts «أبو الدهب» on the desktop, opening the program with its own logo', () => {
    const { env, writes, isOffered } = pretend()
    expect(ensureDesktopShortcut(env)).toBe('created')
    expect(writes).toHaveLength(1)
    expect(writes[0].file).toBe(LNK)
    expect(writes[0].operation).toBe('create')
    expect(writes[0].options.target).toBe(EXE)
    expect(writes[0].options.icon).toBe(EXE)          // the .exe carries the logo
    expect(writes[0].options.cwd).toBe('C:\\Users\\Cashier\\Desktop\\aboeldahab')
    expect(isOffered()).toBe(true)
  })

  it('leaves it alone on the next run', () => {
    const { env, writes } = pretend()
    ensureDesktopShortcut(env)
    expect(ensureDesktopShortcut(env)).toBe('kept')
    expect(writes).toHaveLength(1)
  })
})

describe('a shortcut the owner deleted', () => {
  it('is not put back', () => {
    const { env, desktop, writes } = pretend()
    ensureDesktopShortcut(env)
    desktop.clear()
    expect(ensureDesktopShortcut(env)).toBe('declined')
    expect(writes).toHaveLength(1)
  })
})

describe('a program folder that was moved', () => {
  it('points the existing shortcut at where the program is now', () => {
    const { env, desktop, writes } = pretend()
    desktop.set(LNK, 'D:\\old\\AboElDahab.exe')
    expect(ensureDesktopShortcut(env)).toBe('repaired')
    expect(writes[0].operation).toBe('replace')
    expect(desktop.get(LNK)).toBe(EXE)
  })

  it('does not treat a difference of case or slashes as a move', () => {
    const { env, desktop, writes } = pretend()
    desktop.set(LNK, 'c:/users/cashier/desktop/aboeldahab/aboeldahab.exe')
    expect(ensureDesktopShortcut(env)).toBe('kept')
    expect(writes).toHaveLength(0)
  })

  it('leaves a shortcut it cannot read alone', () => {
    const { env, desktop, writes } = pretend({ readTarget: () => null })
    desktop.set(LNK, 'whatever')
    expect(ensureDesktopShortcut(env)).toBe('kept')
    expect(writes).toHaveLength(0)
  })
})

describe('when it does nothing', () => {
  it('a development run', () => {
    const { env, writes } = pretend({ isPackaged: false })
    expect(ensureDesktopShortcut(env)).toBe('skipped')
    expect(writes).toHaveLength(0)
  })

  it('anything but Windows', () => {
    const { env, writes } = pretend({ platform: 'linux' })
    expect(ensureDesktopShortcut(env)).toBe('skipped')
    expect(writes).toHaveLength(0)
  })
})

describe('when Windows refuses', () => {
  it('tries again next launch rather than giving up for good', () => {
    let fail = true
    const { env, isOffered } = pretend()
    const write = env.write
    env.write = (...a) => (fail ? false : write(...a))
    expect(ensureDesktopShortcut(env)).toBe('failed')
    expect(isOffered()).toBe(false)
    fail = false
    expect(ensureDesktopShortcut(env)).toBe('created')
  })

  it('never throws', () => {
    const { env } = pretend({ exists: () => { throw new Error('EACCES') } })
    expect(ensureDesktopShortcut(env)).toBe('failed')
  })
})
