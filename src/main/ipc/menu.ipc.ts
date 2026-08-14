import { ipcMain } from 'electron'
import * as menu from '../services/menuService'
import { requireRole } from '../services/authService'
import log from 'electron-log/main'
import type { IpcResponse } from '../../shared/types'

export function registerMenuIpc(): void {
  ipcMain.handle('menu:listCategories', async (): Promise<IpcResponse> => {
    try { return { success: true, data: menu.listCategories() } }
    catch (err: any) { return { success: false, error: err.message } }
  })

  ipcMain.handle('menu:upsertCategory', async (_e, data): Promise<IpcResponse> => {
    try {
      requireRole('owner')
      const cat = menu.upsertCategory(data.name, data.displayOrder ?? 0, data.categoryId)
      return { success: true, data: cat }
    } catch (err: any) { return { success: false, error: err.message } }
  })

  ipcMain.handle('menu:deleteCategory', async (_e, { categoryId }): Promise<IpcResponse> => {
    try {
      requireRole('owner')
      menu.deleteCategory(categoryId)
      return { success: true }
    } catch (err: any) { return { success: false, error: err.message } }
  })

  ipcMain.handle('menu:list', async (_e, { includeInactive } = {}): Promise<IpcResponse> => {
    try { return { success: true, data: menu.listMenuItems(includeInactive) } }
    catch (err: any) { return { success: false, error: err.message } }
  })

  ipcMain.handle('menu:get', async (_e, { itemId }): Promise<IpcResponse> => {
    try { return { success: true, data: menu.getMenuItem(itemId) } }
    catch (err: any) { return { success: false, error: err.message } }
  })

  ipcMain.handle('menu:upsert', async (_e, data): Promise<IpcResponse> => {
    try {
      requireRole('owner')
      const item = menu.upsertMenuItem(data)
      return { success: true, data: item }
    } catch (err: any) {
      log.error('[IPC] menu:upsert error:', err)
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('menu:setActive', async (_e, { itemId, isActive }): Promise<IpcResponse> => {
    try {
      requireRole('owner')
      menu.setMenuItemActive(itemId, isActive)
      return { success: true }
    } catch (err: any) { return { success: false, error: err.message } }
  })
}
