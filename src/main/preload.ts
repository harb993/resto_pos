import { contextBridge, ipcRenderer } from 'electron'

const api = {
  // Auth
  login: (username: string, password: string) => ipcRenderer.invoke('auth:login', { username, password }),
  loginByPin: (pin: string) => ipcRenderer.invoke('auth:loginByPin', { pin }),
  logout: () => ipcRenderer.invoke('auth:logout'),
  getSession: () => ipcRenderer.invoke('auth:getSession'),
  verifyOwnerPin: (pin: string) => ipcRenderer.invoke('auth:verifyOwnerPin', { pin }),
  createUser: (data: any) => ipcRenderer.invoke('auth:createUser', data),
  listUsers: () => ipcRenderer.invoke('auth:listUsers'),
  toggleUserActive: (userId: number, isActive: boolean) => ipcRenderer.invoke('auth:toggleUserActive', { userId, isActive }),
  resetPin: (userId: number, newPin: string) => ipcRenderer.invoke('auth:resetPin', { userId, newPin }),

  // Menu
  listCategories: () => ipcRenderer.invoke('menu:listCategories'),
  upsertCategory: (data: any) => ipcRenderer.invoke('menu:upsertCategory', data),
  deleteCategory: (categoryId: number) => ipcRenderer.invoke('menu:deleteCategory', { categoryId }),
  getMenu: (includeInactive?: boolean) => ipcRenderer.invoke('menu:list', { includeInactive }),
  getMenuItem: (itemId: number) => ipcRenderer.invoke('menu:get', { itemId }),
  upsertMenuItem: (data: any) => ipcRenderer.invoke('menu:upsert', data),
  setMenuItemActive: (itemId: number, isActive: boolean) => ipcRenderer.invoke('menu:setActive', { itemId, isActive }),

  // Orders
  createOrder: (data: any) => ipcRenderer.invoke('order:create', data),
  voidOrder: (orderId: number, reason: string, ownerPin?: string) => ipcRenderer.invoke('order:void', { orderId, reason, ownerPin }),
  listOrders: (filters?: any) => ipcRenderer.invoke('order:list', filters),
  getOrder: (orderId: number) => ipcRenderer.invoke('order:get', { orderId }),

  // Stock
  restockItem: (menuItemId: number, quantity: number, reason: string) => ipcRenderer.invoke('stock:restock', { menuItemId, quantity, reason }),
  getLowStock: (threshold?: number) => ipcRenderer.invoke('stock:lowStock', { threshold }),
  getStockHistory: (menuItemId?: number, limit?: number) => ipcRenderer.invoke('stock:history', { menuItemId, limit }),

  // Analytics
  getAnalyticsSummary: (range: string) => ipcRenderer.invoke('analytics:summary', { range }),
  getAnalyticsTrend: (groupBy: string) => ipcRenderer.invoke('analytics:trend', { groupBy }),
  getTopItems: (limit: number, order: string) => ipcRenderer.invoke('analytics:topItems', { limit, order }),
  getMenuEngineering: () => ipcRenderer.invoke('analytics:menuEngineering'),
  getPeakHours: () => ipcRenderer.invoke('analytics:peakHours'),
  getCategoryBreakdown: () => ipcRenderer.invoke('analytics:categoryBreakdown'),
  getAOV: () => ipcRenderer.invoke('analytics:aov'),

  // Settings
  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (data: any) => ipcRenderer.invoke('settings:update', data),
  backup: () => ipcRenderer.invoke('app:backup'),

  // Push events (Main → Renderer)
  onLowStockAlert: (cb: (data: any) => void) => {
    ipcRenderer.on('app:lowStockAlert', (_e, data) => cb(data))
    return () => { ipcRenderer.removeAllListeners('app:lowStockAlert') }
  },
}

contextBridge.exposeInMainWorld('api', api)

export type ElectronAPI = typeof api
