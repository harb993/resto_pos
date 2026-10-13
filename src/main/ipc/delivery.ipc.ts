import { handle } from '../net/router'
import * as delivery from '../services/deliveryService'
import { requireRole, requireAnyAuth, requireOwnerOrAccountant } from '../services/authService'
import { broadcastOrdersChanged } from './broadcast'
import log from 'electron-log/main'
import type { IpcResponse } from '../../shared/types'

export function registerDeliveryIpc(): void {
  // Areas
  handle('delivery:areas:list', async (): Promise<IpcResponse> => {
    try {
      requireAnyAuth()
      return { success: true, data: delivery.listAreas() }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  handle('delivery:areas:upsert', async (_e, data): Promise<IpcResponse> => {
    try {
      requireRole('owner')
      const result = delivery.upsertArea(
        data.areaName, data.deliveryFee, data.isActive ?? 1, data.areaId
      )
      return { success: true, data: result }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  handle('delivery:areas:delete', async (_e, { areaId }): Promise<IpcResponse> => {
    try {
      requireRole('owner')
      return { success: true, data: delivery.deleteArea(areaId) }
    } catch (err: any) { return { success: false, error: err.message } }
  })

  // Drivers
  handle('delivery:drivers:list', async (): Promise<IpcResponse> => {
    try {
      requireAnyAuth()
      return { success: true, data: delivery.listDrivers() }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  handle('delivery:drivers:upsert', async (_e, data): Promise<IpcResponse> => {
    try {
      requireRole('owner')
      const result = delivery.upsertDriver(
        data.fullName, data.phone || null, data.isActive ?? 1, data.driverId
      )
      return { success: true, data: result }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  handle('delivery:drivers:delete', async (_e, { driverId }): Promise<IpcResponse> => {
    try {
      requireRole('owner')
      return { success: true, data: delivery.deleteDriver(driverId) }
    } catch (err: any) { return { success: false, error: err.message } }
  })

  // ---- The delivery centre ----
  //
  // All of it is open to the cashier, counting the cash in included.
  //
  // That last part was owner-and-accountant only, on the reasoning that taking money
  // from a driver is the moment it becomes the restaurant's and deserves a senior
  // hand. In a real shop it is the cashier standing at the counter at 1am when the
  // driver walks back in, and the owner is not there. The rule did not add control —
  // it just meant the cash went in a drawer and the screen was never updated, so the
  // system's record of who owed what drifted away from the truth within a day.
  //
  // The control that actually works is the record: every settlement stores who took
  // it, when, and exactly which orders it covered, and the owner reads that back in
  // «سجل التحصيل». A truthful log of what happened beats a permission that stops the
  // screen matching reality.

  handle('delivery:orders:list', async (_e, filters = {}): Promise<IpcResponse> => {
    try {
      requireAnyAuth()
      return { success: true, data: delivery.listDeliveryOrders(filters) }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  handle('delivery:board', async (_e, filters = {}): Promise<IpcResponse> => {
    try {
      requireAnyAuth()
      // One round trip for the whole screen: the counters, the drivers and the
      // orders are one picture of one moment, and fetching them separately lets the
      // three disagree — a total that does not match the rows under it.
      return {
        success: true,
        data: {
          summary: delivery.deliverySummary(filters),
          drivers: delivery.driverBalances(filters),
          orders: delivery.listDeliveryOrders(filters),
        },
      }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  handle('delivery:orders:assign', async (_e, { orderId, driverId }): Promise<IpcResponse> => {
    try {
      const session = requireAnyAuth()
      const order = delivery.assignDriver(orderId, driverId, session.userId)
      broadcastOrdersChanged('delivery-assign')
      return { success: true, data: order }
    } catch (err: any) {
      log.error('[IPC] delivery:orders:assign error:', err)
      return { success: false, error: err.message }
    }
  })

  handle('delivery:orders:status', async (_e, { orderId, status }): Promise<IpcResponse> => {
    try {
      const session = requireAnyAuth()
      const order = delivery.setDeliveryStatus(orderId, status, session.userId)
      broadcastOrdersChanged('delivery-status')
      return { success: true, data: order }
    } catch (err: any) {
      log.error('[IPC] delivery:orders:status error:', err)
      return { success: false, error: err.message }
    }
  })

  handle('delivery:unsettled', async (_e, { driverId }): Promise<IpcResponse> => {
    try {
      requireAnyAuth()
      return { success: true, data: delivery.unsettledOrders(driverId) }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  handle('delivery:settle', async (_e, { driverId, orderIds, note }): Promise<IpcResponse> => {
    try {
      const session = requireAnyAuth()
      const settlement = delivery.settleDriver(driverId, session.userId, { orderIds, note })
      log.info(`[Delivery] ${session.fullName} (${session.role}) settled driver ${driverId}`)
      broadcastOrdersChanged('delivery-settle')
      return { success: true, data: settlement }
    } catch (err: any) {
      log.error('[IPC] delivery:settle error:', err)
      return { success: false, error: err.message }
    }
  })

  handle('delivery:settlements:list', async (_e, filters = {}): Promise<IpcResponse> => {
    try {
      requireAnyAuth()
      return { success: true, data: delivery.listSettlements(filters) }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  handle('delivery:settlements:orders', async (_e, { settlementId }): Promise<IpcResponse> => {
    try {
      requireAnyAuth()
      return { success: true, data: delivery.settlementOrders(settlementId) }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })
}
