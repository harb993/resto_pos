/**
 * The single choke point every IPC call passes through.
 *
 * Every `register*Ipc()` registers here instead of calling `ipcMain.handle` directly.
 * That buys two things from one place:
 *
 *   - on a MASTER (or standalone till) the call runs locally, exactly as before;
 *   - on a NODE it is forwarded to the master over the LAN, so the node never opens
 *     the database at all.
 *
 * Because the whole app already talks to the main process through these channels,
 * nothing above this layer has to know which machine it is running on.
 */

import { ipcMain } from 'electron'
import log from 'electron-log/main'
import type { IpcResponse } from '../../shared/types'
import { NODE_FORBIDDEN_CHANNELS } from './protocol'
import { isActivated } from '../services/licenseService'

export type IpcHandler = (event: unknown, payload: any) => Promise<IpcResponse> | IpcResponse

/**
 * The licence gate.
 *
 * Enforced HERE rather than in the interface, because the interface is the half an
 * unlicensed copy can edit. Every channel in the app is registered through this file,
 * so refusing at the choke point means an unactivated machine cannot ring up a sale,
 * read the books or serve a node, whatever is done to the screens in front of it.
 *
 * The licence channels themselves are exempt — they are how a machine stops being
 * unlicensed — and so is the app-mode probe the window asks before anything else.
 */
const LICENSE_EXEMPT = new Set(['license:status', 'license:activate', 'app:mode'])

const LICENSE_ERROR = 'هذا الجهاز غير مُفعَّل. من فضلك فعِّل البرنامج أولاً'

function licenseBlocks(channel: string): boolean {
  return !LICENSE_EXEMPT.has(channel) && !isActivated()
}

/** Every channel the app knows how to serve, so the master can invoke them for a node. */
const handlers = new Map<string, IpcHandler>()

/**
 * Set on a node till. When present, `handle()` sends the call down the wire instead
 * of running it — or answers it from the read-only mirror when the master is away.
 * Installed by nodeLink for as long as this machine is a node.
 */
let forwarder: ((channel: string, payload: unknown) => Promise<IpcResponse>) | null = null

export function setForwarder(fn: typeof forwarder): void {
  forwarder = fn
}

export function isForwarding(): boolean {
  return forwarder !== null
}

/**
 * Register an IPC channel. Drop-in replacement for `ipcMain.handle`.
 *
 * The handler is kept in `handlers` even on a node, because a machine can be
 * switched from node back to master without restarting the process.
 */
export function handle(channel: string, listener: IpcHandler): void {
  handlers.set(channel, listener)

  ipcMain.handle(channel, async (event, payload): Promise<IpcResponse> => {
    if (licenseBlocks(channel)) return { success: false, error: LICENSE_ERROR }
    if (forwarder) {
      if (NODE_FORBIDDEN_CHANNELS.has(channel)) {
        return { success: false, error: 'هذا الإجراء متاح على الجهاز الرئيسي فقط' }
      }
      try {
        return await forwarder(channel, payload)
      } catch (err: any) {
        log.error(`[Net] Forward failed for ${channel}:`, err?.message || err)
        return { success: false, error: err?.message || 'تعذر الاتصال بالجهاز الرئيسي' }
      }
    }
    return listener(event, payload)
  })
}

/**
 * Register a channel that ALWAYS runs on this machine, even in node mode.
 *
 * Networking settings are the obvious case: a node asking "what is my mode" or
 * "become standalone again" is talking about the machine in front of the owner, not
 * the master. Forwarded, those would report the master's state and reconfigure the
 * master — and a node could never be turned back into a standalone till, because the
 * instruction to stop being a node would be sent to the very machine it was trying
 * to stop talking to.
 */
export function handleLocal(channel: string, listener: IpcHandler): void {
  handlers.set(channel, listener)
  ipcMain.handle(channel, (event, payload) => {
    if (licenseBlocks(channel)) return { success: false, error: LICENSE_ERROR }
    return listener(event, payload)
  })
}

/**
 * Run a channel locally. This is what the master calls on behalf of a node — it
 * bypasses `forwarder` on purpose, or a misconfigured master would forward a node's
 * request straight back out again.
 */
export async function invokeLocal(channel: string, payload: unknown): Promise<IpcResponse> {
  // An unlicensed master must not become a way for licensed nodes to keep trading
  // through it — nor a way for an unlicensed node to borrow the master's activation.
  if (licenseBlocks(channel)) return { success: false, error: LICENSE_ERROR }

  const listener = handlers.get(channel)
  if (!listener) {
    return { success: false, error: `قناة غير معروفة: ${channel}` }
  }
  return listener(null, payload)
}

export function knownChannels(): string[] {
  return [...handlers.keys()].sort()
}
