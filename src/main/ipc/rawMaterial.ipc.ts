import { ipcMain } from 'electron'
import { handle } from '../net/router'
import * as rm from '../services/rawMaterialService'
import * as recipes from '../services/recipeService'
import { requireRole, requireAnyAuth, requireOwnerOrAccountant } from '../services/authService'
import { broadcastStockChanged } from './broadcast'
import log from 'electron-log/main'
import type { IpcResponse } from '../../shared/types'

export function registerRawMaterialIpc(): void {
  // ---- Materials ----

  // Cashiers need to read materials so the POS can flag what has run out.
  handle('rawMaterials:list', async (_e, { includeInactive } = {}): Promise<IpcResponse> => {
    try {
      requireAnyAuth()
      return { success: true, data: rm.listRawMaterials(includeInactive) }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  handle('rawMaterials:upsert', async (_e, data): Promise<IpcResponse> => {
    try {
      const session = requireRole('owner')
      // Pass the user through so an opening balance lands in the ledger attributed
      // to whoever entered it, like every other stock movement.
      const material = rm.upsertRawMaterial(data, session.userId)
      // A cost change ripples into every recipe that uses this material.
      recipes.refreshAllRecipeCosts()
      // A new material arrives with its opening count, and an edit can move the alert
      // level — either one changes what counts as "running low".
      broadcastStockChanged('material')
      return { success: true, data: material }
    } catch (err: any) {
      log.error('[IPC] rawMaterials:upsert error:', err)
      return { success: false, error: err.message }
    }
  })

  handle('rawMaterials:adjustStock', async (_e, data): Promise<IpcResponse> => {
    try {
      const session = requireRole('owner')
      const material = rm.adjustStock(data.rawMaterialId, data.quantity, data.reason, session.userId)
      broadcastStockChanged('adjustment')
      return { success: true, data: material }
    } catch (err: any) {
      log.error('[IPC] rawMaterials:adjustStock error:', err)
      return { success: false, error: err.message }
    }
  })

  handle('rawMaterials:lowStock', async (): Promise<IpcResponse> => {
    try {
      requireAnyAuth()
      return { success: true, data: rm.getLowStockMaterials() }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  handle('rawMaterials:history', async (_e, { rawMaterialId, limit } = {}): Promise<IpcResponse> => {
    try {
      requireOwnerOrAccountant()
      return { success: true, data: rm.getMaterialHistory(rawMaterialId, limit) }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // ---- Recipes ----

  handle('recipes:get', async (_e, { menuItemId }): Promise<IpcResponse> => {
    try {
      requireAnyAuth()
      return { success: true, data: recipes.getRecipe(menuItemId) }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  handle('recipes:set', async (_e, { menuItemId, lines }): Promise<IpcResponse> => {
    try {
      requireRole('owner')
      return { success: true, data: recipes.setRecipe(menuItemId, lines) }
    } catch (err: any) {
      log.error('[IPC] recipes:set error:', err)
      return { success: false, error: err.message }
    }
  })

  // ---- Prep conversions ----

  handle('prep:list', async (): Promise<IpcResponse> => {
    try {
      requireAnyAuth()
      return { success: true, data: rm.listPrepConversions() }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  handle('prep:upsert', async (_e, data): Promise<IpcResponse> => {
    try {
      requireRole('owner')
      const conv = rm.upsertPrepConversion(
        data.sourceMaterialId, data.outputMaterialId, data.yieldQuantity, data.prepConversionId
      )
      return { success: true, data: conv }
    } catch (err: any) {
      log.error('[IPC] prep:upsert error:', err)
      return { success: false, error: err.message }
    }
  })

  handle('prep:delete', async (_e, { prepConversionId }): Promise<IpcResponse> => {
    try {
      requireRole('owner')
      rm.deletePrepConversion(prepConversionId)
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // Running a prep batch is a daily kitchen action, not an admin one — but stock is
  // money, so it stays owner-gated like every other stock movement.
  handle('prep:run', async (_e, { prepConversionId, batches }): Promise<IpcResponse> => {
    try {
      const session = requireRole('owner')
      const result = rm.runPrep(prepConversionId, batches, session.userId)
      broadcastStockChanged('prep')
      return { success: true, data: result }
    } catch (err: any) {
      log.error('[IPC] prep:run error:', err)
      return { success: false, error: err.message }
    }
  })
}
