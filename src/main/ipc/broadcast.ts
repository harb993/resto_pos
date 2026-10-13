import { BrowserWindow } from 'electron'
import { broadcastToNodes } from '../net/masterLink'
import type { PushEvent } from '../net/protocol'

/**
 * Announce a change to every screen that should see it.
 *
 * "Every screen" now means two things: the windows on this machine, and — when this
 * machine is the master — the screens on every node till. A second till showing stock
 * and settings from whenever it last loaded them is exactly the sort of quiet
 * disagreement between two tills that this whole feature exists to avoid, so both go
 * through here rather than each caller remembering to do the second half.
 */
export function broadcast(type: PushEvent['type'], data: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(type, data)
  }
  // A no-op unless this machine is serving nodes.
  broadcastToNodes({ type, data } as PushEvent)
}

/**
 * Tell every open window that stock moved.
 *
 * Screens load raw materials once when they mount and then hold that copy, so a sale,
 * a void, a delete, a prep run or a manual adjustment left the numbers on screen
 * stale — the balance had really changed, but the owner was still looking at the old
 * figure and concluded nothing had happened.
 */
export function broadcastStockChanged(reason: string): void {
  broadcast('app:stockChanged', { reason, at: Date.now() })
}

/**
 * Tell every screen that the order list changed — a sale, a void, a deletion.
 *
 * On one machine the screen that caused it already knows. Across two tills it does
 * not: an order rung up at the master must appear in the node's history without
 * someone navigating away and back, which is precisely what was asked for.
 */
export function broadcastOrdersChanged(reason: string): void {
  broadcast('app:ordersChanged', { reason, at: Date.now() })
}
