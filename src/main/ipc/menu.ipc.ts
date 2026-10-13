import { ipcMain } from 'electron'
import { handle } from '../net/router'
import * as menu from '../services/menuService'
import { importMenuCatalog, describeMenuCatalog } from '../services/menuImportService'
import { importRecipeCatalog, previewRecipeCatalog } from '../services/recipeImportService'
import { requireRole, requireAnyAuth } from '../services/authService'
import { broadcastStockChanged } from './broadcast'
import log from 'electron-log/main'
import type { IpcResponse } from '../../shared/types'

export function registerMenuIpc(): void {
  handle('menu:listCategories', async (): Promise<IpcResponse> => {
    try {
      requireAnyAuth()
      return { success: true, data: menu.listCategories() }
    } catch (err: any) { return { success: false, error: err.message } }
  })

  handle('menu:upsertCategory', async (_e, data): Promise<IpcResponse> => {
    try {
      requireRole('owner')
      const cat = menu.upsertCategory(data.name, data.displayOrder ?? 0, data.categoryId)
      return { success: true, data: cat }
    } catch (err: any) { return { success: false, error: err.message } }
  })

  handle('menu:deleteCategory', async (_e, { categoryId }): Promise<IpcResponse> => {
    try {
      requireRole('owner')
      menu.deleteCategory(categoryId)
      return { success: true }
    } catch (err: any) { return { success: false, error: err.message } }
  })

  handle('menu:list', async (_e, { includeInactive } = {}): Promise<IpcResponse> => {
    try {
      const session = requireAnyAuth()
      // The till always shows the live menu; back-office roles may also see 86'd items.
      const withInactive = includeInactive === true && session.role !== 'cashier'
      return { success: true, data: menu.listMenuItems(withInactive) }
    } catch (err: any) { return { success: false, error: err.message } }
  })

  handle('menu:get', async (_e, { itemId }): Promise<IpcResponse> => {
    try {
      requireAnyAuth()
      return { success: true, data: menu.getMenuItem(itemId) }
    } catch (err: any) { return { success: false, error: err.message } }
  })

  handle('menu:upsert', async (_e, data): Promise<IpcResponse> => {
    try {
      requireRole('owner')
      const item = menu.upsertMenuItem(data)
      return { success: true, data: item }
    } catch (err: any) {
      log.error('[IPC] menu:upsert error:', err)
      return { success: false, error: err.message }
    }
  })

  handle('menu:setActive', async (_e, { itemId, isActive }): Promise<IpcResponse> => {
    try {
      requireRole('owner')
      menu.setMenuItemActive(itemId, isActive)
      return { success: true }
    } catch (err: any) { return { success: false, error: err.message } }
  })

  // Variants — what an item asks when it is rung up. Readable by anyone signed in,
  // because the till needs them on every card; only the owner defines them.
  handle('menu:getVariants', async (_e, { itemId }): Promise<IpcResponse> => {
    try {
      requireAnyAuth()
      return { success: true, data: menu.getItemVariants(itemId) }
    } catch (err: any) { return { success: false, error: err.message } }
  })

  handle('menu:setVariants', async (_e, { itemId, groups }): Promise<IpcResponse> => {
    try {
      requireRole('owner')
      return { success: true, data: menu.setItemVariants(itemId, groups ?? []) }
    } catch (err: any) {
      log.error('[IPC] menu:setVariants error:', err)
      return { success: false, error: err.message }
    }
  })

  // Category-level questions — asked of every item in the category, including any
  // added later. This is where "chicken asks spicy" is set, once.
  handle('menu:getCategoryVariants', async (_e, { categoryId }): Promise<IpcResponse> => {
    try {
      requireAnyAuth()
      return { success: true, data: menu.getCategoryVariants(categoryId) }
    } catch (err: any) { return { success: false, error: err.message } }
  })

  handle('menu:setCategoryVariants', async (_e, { categoryId, groups }): Promise<IpcResponse> => {
    try {
      requireRole('owner')
      return { success: true, data: menu.setCategoryVariants(categoryId, groups ?? []) }
    } catch (err: any) {
      log.error('[IPC] menu:setCategoryVariants error:', err)
      return { success: false, error: err.message }
    }
  })

  handle('menu:setInheritVariants', async (_e, { itemId, inherit }): Promise<IpcResponse> => {
    try {
      requireRole('owner')
      menu.setItemInheritsCategoryVariants(itemId, inherit !== false)
      return { success: true }
    } catch (err: any) { return { success: false, error: err.message } }
  })

  // The costed menu from «ملخص الريسبى». Read first so the owner is told what is
  // about to be added before anything is written.
  handle('menu:catalogPreview', async (): Promise<IpcResponse> => {
    try {
      requireRole('owner')
      return { success: true, data: describeMenuCatalog() }
    } catch (err: any) { return { success: false, error: err.message } }
  })

  handle('menu:importCatalog', async (_e, { replacePrices } = {}): Promise<IpcResponse> => {
    try {
      requireRole('owner')
      return { success: true, data: importMenuCatalog({ replacePrices: replacePrices === true }) }
    } catch (err: any) {
      log.error('[IPC] menu:importCatalog error:', err)
      return { success: false, error: err.message }
    }
  })

  // Arranging the POS grid — the whole order at once, as a drag produces it.
  handle('menu:reorderItems', async (_e, { categoryId, itemIds }): Promise<IpcResponse> => {
    try {
      requireRole('owner')
      if (!Array.isArray(itemIds)) throw new Error('ترتيب غير صالح')
      return { success: true, data: menu.reorderMenuItems(categoryId, itemIds) }
    } catch (err: any) { return { success: false, error: err.message } }
  })

  handle('menu:reorderCategories', async (_e, { categoryIds }): Promise<IpcResponse> => {
    try {
      requireRole('owner')
      if (!Array.isArray(categoryIds)) throw new Error('ترتيب غير صالح')
      return { success: true, data: menu.reorderCategories(categoryIds) }
    } catch (err: any) { return { success: false, error: err.message } }
  })

  // The ingredients behind the menu — what each dish takes out of the store.
  handle('menu:recipePreview', async (): Promise<IpcResponse> => {
    try {
      requireRole('owner')
      return { success: true, data: previewRecipeCatalog() }
    } catch (err: any) { return { success: false, error: err.message } }
  })

  handle('menu:importRecipes', async (_e, { replaceExisting } = {}): Promise<IpcResponse> => {
    try {
      requireRole('owner')
      const result = importRecipeCatalog({ replaceExisting: replaceExisting === true })
      broadcastStockChanged('recipe-import') // it can create materials
      return { success: true, data: result }
    } catch (err: any) {
      log.error('[IPC] menu:importRecipes error:', err)
      return { success: false, error: err.message }
    }
  })
}
