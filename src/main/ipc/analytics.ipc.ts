import { ipcMain } from 'electron'
import { handle } from '../net/router'
import * as analytics from '../services/analyticsService'
import { requireOwnerOrAccountant } from '../services/authService'
import type { IpcResponse } from '../../shared/types'

export function registerAnalyticsIpc(): void {
  handle('analytics:summary', async (_e, { range }): Promise<IpcResponse> => {
    try {
      requireOwnerOrAccountant()
      return { success: true, data: analytics.getSummary(range) }
    } catch (err: any) { return { success: false, error: err.message } }
  })

  handle('analytics:trend', async (_e, { groupBy }): Promise<IpcResponse> => {
    try {
      requireOwnerOrAccountant()
      return { success: true, data: analytics.getTrend(groupBy) }
    } catch (err: any) { return { success: false, error: err.message } }
  })

  handle('analytics:topItems', async (_e, { limit, order }): Promise<IpcResponse> => {
    try {
      requireOwnerOrAccountant()
      return { success: true, data: analytics.getTopItems(limit, order) }
    } catch (err: any) { return { success: false, error: err.message } }
  })

  handle('analytics:menuEngineering', async (): Promise<IpcResponse> => {
    try {
      requireOwnerOrAccountant()
      return { success: true, data: analytics.getMenuEngineering() }
    } catch (err: any) { return { success: false, error: err.message } }
  })

  handle('analytics:peakHours', async (): Promise<IpcResponse> => {
    try {
      requireOwnerOrAccountant()
      return { success: true, data: analytics.getPeakHours() }
    } catch (err: any) { return { success: false, error: err.message } }
  })

  handle('analytics:categoryBreakdown', async (): Promise<IpcResponse> => {
    try {
      requireOwnerOrAccountant()
      return { success: true, data: analytics.getCategoryBreakdown() }
    } catch (err: any) { return { success: false, error: err.message } }
  })

  handle('analytics:aov', async (): Promise<IpcResponse> => {
    try {
      requireOwnerOrAccountant()
      return { success: true, data: analytics.getAverageOrderValue() }
    } catch (err: any) { return { success: false, error: err.message } }
  })
}
