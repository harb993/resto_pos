import { contextBridge, ipcRenderer } from 'electron'

const api = {
  // Auth
  login: (username: string, password: string) => ipcRenderer.invoke('auth:login', { username, password }),
  logout: () => ipcRenderer.invoke('auth:logout'),
  getSession: () => ipcRenderer.invoke('auth:getSession'),
  verifyOwnerPassword: (password: string) => ipcRenderer.invoke('auth:verifyOwnerPassword', { password }),
  getDefaultCredentialWarnings: () => ipcRenderer.invoke('auth:defaultCredentialWarnings'),
  changeOwnPassword: (currentPassword: string, newPassword: string) =>
    ipcRenderer.invoke('auth:changeOwnPassword', { currentPassword, newPassword }),
  listUsers: () => ipcRenderer.invoke('auth:listUsers'),
  toggleUserActive: (userId: number, isActive: boolean) => ipcRenderer.invoke('auth:toggleUserActive', { userId, isActive }),
  updateUserAccount: (data: any) => ipcRenderer.invoke('auth:updateUserAccount', data),

  // Menu
  listCategories: () => ipcRenderer.invoke('menu:listCategories'),
  upsertCategory: (data: any) => ipcRenderer.invoke('menu:upsertCategory', data),
  deleteCategory: (categoryId: number) => ipcRenderer.invoke('menu:deleteCategory', { categoryId }),
  getMenu: (includeInactive?: boolean) => ipcRenderer.invoke('menu:list', { includeInactive }),
  getMenuItem: (itemId: number) => ipcRenderer.invoke('menu:get', { itemId }),
  upsertMenuItem: (data: any) => ipcRenderer.invoke('menu:upsert', data),
  setMenuItemActive: (itemId: number, isActive: boolean) => ipcRenderer.invoke('menu:setActive', { itemId, isActive }),

  // Item variants (الاختيارات) — size, layers, spice level, or nothing at all
  getItemVariants: (itemId: number) => ipcRenderer.invoke('menu:getVariants', { itemId }),
  setItemVariants: (itemId: number, groups: any[]) => ipcRenderer.invoke('menu:setVariants', { itemId, groups }),
  /** Questions asked of EVERY item in a category — where spicy/size/layers belong. */
  getCategoryVariants: (categoryId: number) => ipcRenderer.invoke('menu:getCategoryVariants', { categoryId }),
  setCategoryVariants: (categoryId: number, groups: any[]) =>
    ipcRenderer.invoke('menu:setCategoryVariants', { categoryId, groups }),
  setItemInheritsVariants: (itemId: number, inherit: boolean) =>
    ipcRenderer.invoke('menu:setInheritVariants', { itemId, inherit }),

  // The costed menu from «ملخص الريسبى» — what it holds, and loading it in.
  previewMenuCatalog: () => ipcRenderer.invoke('menu:catalogPreview'),
  importMenuCatalog: (replacePrices?: boolean) =>
    ipcRenderer.invoke('menu:importCatalog', { replacePrices }),
  /** Arrange the POS grid — the whole order at once, as dragging produces it. */
  reorderMenuItems: (categoryId: number, itemIds: number[]) =>
    ipcRenderer.invoke('menu:reorderItems', { categoryId, itemIds }),
  reorderCategories: (categoryIds: number[]) =>
    ipcRenderer.invoke('menu:reorderCategories', { categoryIds }),

  /** The ingredients behind each dish — what a sale takes out of the store. */
  previewRecipeCatalog: () => ipcRenderer.invoke('menu:recipePreview'),
  importRecipeCatalog: (replaceExisting?: boolean) =>
    ipcRenderer.invoke('menu:importRecipes', { replaceExisting }),

  // Orders
  createOrder: (data: any) => ipcRenderer.invoke('order:create', data),
  voidOrder: (orderId: number, reason: string, ownerPassword?: string) => ipcRenderer.invoke('order:void', { orderId, reason, ownerPassword }),
  deleteOrder: (orderId: number) => ipcRenderer.invoke('order:delete', { orderId }),
  listOrders: (filters?: any) => ipcRenderer.invoke('order:list', filters),
  /** The invoices that were deleted, newest first — owner and accountant only. */
  listDeletedOrders: (filters?: any) =>
    ipcRenderer.invoke('order:list', { ...filters, deleted: 'only' }),
  getOrder: (orderId: number) => ipcRenderer.invoke('order:get', { orderId }),
  getInvoiceCounters: () => ipcRenderer.invoke('order:invoiceCounters'),
  setInvoiceStart: (orderType: string, nextNumber: number) =>
    ipcRenderer.invoke('order:setInvoiceStart', { orderType, nextNumber }),

  // NOTE: the old per-meal stock channels (stock:restock / lowStock / history) were
  // removed with the meal-stock model. Stock lives on raw materials now.

  // Raw materials (المواد الخام)
  listRawMaterials: (includeInactive?: boolean) => ipcRenderer.invoke('rawMaterials:list', { includeInactive }),
  upsertRawMaterial: (data: any) => ipcRenderer.invoke('rawMaterials:upsert', data),
  adjustRawMaterialStock: (rawMaterialId: number, quantity: number, reason: string) =>
    ipcRenderer.invoke('rawMaterials:adjustStock', { rawMaterialId, quantity, reason }),
  getLowStockMaterials: () => ipcRenderer.invoke('rawMaterials:lowStock'),
  getRawMaterialHistory: (rawMaterialId?: number, limit?: number) =>
    ipcRenderer.invoke('rawMaterials:history', { rawMaterialId, limit }),

  // Recipes (مكونات الأصناف)
  getRecipe: (menuItemId: number) => ipcRenderer.invoke('recipes:get', { menuItemId }),
  setRecipe: (menuItemId: number, lines: any[]) => ipcRenderer.invoke('recipes:set', { menuItemId, lines }),

  // Prep conversions (التجهيز)
  listPrepConversions: () => ipcRenderer.invoke('prep:list'),
  upsertPrepConversion: (data: any) => ipcRenderer.invoke('prep:upsert', data),
  deletePrepConversion: (prepConversionId: number) => ipcRenderer.invoke('prep:delete', { prepConversionId }),
  runPrep: (prepConversionId: number, batches: number) => ipcRenderer.invoke('prep:run', { prepConversionId, batches }),

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
  /** The settings screen opens on a PIN, and locks again when it is left. */
  unlockSettings: (pin: string) => ipcRenderer.invoke('settings:unlock', { pin }),
  lockSettings: () => ipcRenderer.invoke('settings:lock'),
  // The shop's own data — menu, stock, customers, settings — out to a file and back.
  getShopDataCounts: () => ipcRenderer.invoke('shopData:counts'),
  exportShopData: () => ipcRenderer.invoke('shopData:export'),
  pickShopDataImport: () => ipcRenderer.invoke('shopData:pickImport'),
  importShopData: () => ipcRenderer.invoke('shopData:import'),
  openShopDataFolder: (folder: string) => ipcRenderer.invoke('shopData:openFolder', { folder }),
  backup: () => ipcRenderer.invoke('app:backup'),
  getAppMode: () => ipcRenderer.invoke('app:mode'),

  // Licensing (تفعيل البرنامج) — this PC's id, and the key that unlocks it here.
  getLicenseStatus: () => ipcRenderer.invoke('license:status'),
  activateLicense: (key: string) => ipcRenderer.invoke('license:activate', { key }),

  listBackups: () => ipcRenderer.invoke('app:listBackups'),
  openBackupFolder: () => ipcRenderer.invoke('app:openBackupFolder'),
  verifyBackup: (filePath: string) => ipcRenderer.invoke('app:verifyBackup', { filePath }),
  restoreBackup: (filePath: string, ownerPassword: string) =>
    ipcRenderer.invoke('app:restoreBackup', { filePath, ownerPassword }),
  resetSystem: (ownerPassword: string) =>
    ipcRenderer.invoke('app:resetSystem', { ownerPassword }),

  // Expenses
  addExpense: (data: any) => ipcRenderer.invoke('expenses:add', data),
  listExpenses: (filters?: any) => ipcRenderer.invoke('expenses:list', filters),
  deleteExpense: (expenseId: number) => ipcRenderer.invoke('expenses:delete', { expenseId }),

  // Workers
  upsertWorker: (data: any) => ipcRenderer.invoke('workers:upsert', data),
  listWorkers: () => ipcRenderer.invoke('workers:list'),
  getWorkerPayForPeriod: (workerId: number, dateFrom: string, dateTo: string) =>
    ipcRenderer.invoke('workers:payForPeriod', { workerId, dateFrom, dateTo }),

  // Worker Attendance
  markAttendance: (workerId: number, workDate: string, shiftNumber?: number | null) =>
    ipcRenderer.invoke('workerAttendance:mark', { workerId, workDate, shiftNumber }),
  unmarkAttendance: (workerId: number, workDate: string) => ipcRenderer.invoke('workerAttendance:unmark', { workerId, workDate }),
  listAttendance: (workerId: number, dateFrom?: string, dateTo?: string) => ipcRenderer.invoke('workerAttendance:list', { workerId, dateFrom, dateTo }),
  countAttendance: (workerId: number, dateFrom: string, dateTo: string) => ipcRenderer.invoke('workerAttendance:count', { workerId, dateFrom, dateTo }),

  // Salaries
  upsertSalary: (data: any) => ipcRenderer.invoke('salaries:upsert', data),
  listSalaries: (filters?: any) => ipcRenderer.invoke('salaries:list', filters),
  deleteSalary: (salaryId: number) => ipcRenderer.invoke('salaries:delete', { salaryId }),

  // Shifts — recorded automatically at sign-in/sign-out, so there is no upsert
  listShifts: (filters?: any) => ipcRenderer.invoke('shifts:list', filters),
  getShiftHoursForPeriod: (userId: number, dateFrom: string, dateTo: string) =>
    ipcRenderer.invoke('shifts:hoursForPeriod', { userId, dateFrom, dateTo }),
  // work = the shop's whole shift (everyone's sales) rather than one cashier's session.
  getShiftReport: (shiftId: number, work?: boolean) => ipcRenderer.invoke('shifts:report', { shiftId, work }),
  exportShiftReportPdf: (shiftId: number, work?: boolean) =>
    ipcRenderer.invoke('shifts:exportReportPdf', { shiftId, work }),
  // The shop's shift itself: is one running, the list of them, and starting the next.
  getWorkShiftStatus: () => ipcRenderer.invoke('workShift:status'),
  listWorkShifts: () => ipcRenderer.invoke('workShift:list'),
  startWorkShift: () => ipcRenderer.invoke('workShift:start'),
  /** «تقفيل»: end the running shift now and print its slip. */
  closeWorkShiftAndPrint: (pin: string) => ipcRenderer.invoke('workShift:closeAndPrint', { pin }),
  onWorkShiftChanged: (cb: (data: any) => void) => {
    const handler = (_e: unknown, data: any) => cb(data)
    ipcRenderer.on('app:workShiftChanged', handler)
    return () => { ipcRenderer.removeListener('app:workShiftChanged', handler) }
  },
  /** PDF + Excel together, into the dated end-of-shift folder. No save dialog. */
  exportShiftFiles: (shiftId: number, work?: boolean) => ipcRenderer.invoke('shifts:exportFiles', { shiftId, work }),
  /** Opens the group chat with the summary typed, and the folder with both files. */
  shareShiftToGroup: (shiftId: number, exported?: any, work?: boolean) =>
    ipcRenderer.invoke('shifts:shareToGroup', { shiftId, exported, work }),
  openShiftExportFolder: (folder?: string) =>
    ipcRenderer.invoke('shifts:openExportFolder', { folder }),
  /** One WhatsApp window for the whole campaign: each call re-uses it. */
  openWhatsappChat: (phone: string, text: string) => ipcRenderer.invoke('whatsapp:openChat', { phone, text }),
  // A campaign that sends itself: the picture is chosen in the main process, the list
  // and the text go in once, and progress comes back as events.
  whatsappPickImage: () => ipcRenderer.invoke('whatsapp:pickImage'),
  whatsappClearImage: () => ipcRenderer.invoke('whatsapp:clearImage'),
  whatsappCampaignStart: (recipients: { phone: string; name?: string | null }[], text: string, withPicture: boolean) =>
    ipcRenderer.invoke('whatsapp:campaignStart', { recipients, text, withPicture }),
  whatsappCampaignStop: () => ipcRenderer.invoke('whatsapp:campaignStop'),
  whatsappCampaignAgain: () => ipcRenderer.invoke('whatsapp:campaignAgain'),
  whatsappShowWindow: () => ipcRenderer.invoke('whatsapp:showWindow'),
  whatsappCampaignStatus: () => ipcRenderer.invoke('whatsapp:campaignStatus'),
  onWhatsappProgress: (cb: (data: any) => void) => {
    const handler = (_e: unknown, data: any) => cb(data)
    ipcRenderer.on('app:whatsappProgress', handler)
    return () => { ipcRenderer.removeListener('app:whatsappProgress', handler) }
  },
  getWhatsappTarget: () => ipcRenderer.invoke('shifts:whatsappTarget'),
  /** «تقفيل الوردية» for a configured shift; no arguments means the one running now. */
  getClosingReport: (workShiftId?: number) => ipcRenderer.invoke('closing:report', { workShiftId }),
  printClosingReport: (workShiftId?: number) => ipcRenderer.invoke('closing:print', { workShiftId }),

  // Delivery
  listDeliveryAreas: () => ipcRenderer.invoke('delivery:areas:list'),
  upsertDeliveryArea: (data: any) => ipcRenderer.invoke('delivery:areas:upsert', data),
  /** Deletes a zone nothing was delivered to; retires one that past invoices used. */
  deleteDeliveryArea: (areaId: number) => ipcRenderer.invoke('delivery:areas:delete', { areaId }),
  listDeliveryDrivers: () => ipcRenderer.invoke('delivery:drivers:list'),
  upsertDeliveryDriver: (data: any) => ipcRenderer.invoke('delivery:drivers:upsert', data),
  /** Refuses while he is still holding cash; retires him once he has paid in. */
  deleteDeliveryDriver: (driverId: number) => ipcRenderer.invoke('delivery:drivers:delete', { driverId }),

  // Delivery centre — where the orders are, and who is still holding the money
  /** Counters, driver balances and the order list for one period, in one call. */
  getDeliveryBoard: (filters?: any) => ipcRenderer.invoke('delivery:board', filters),
  listDeliveryOrders: (filters?: any) => ipcRenderer.invoke('delivery:orders:list', filters),
  assignDeliveryDriver: (orderId: number, driverId: number) =>
    ipcRenderer.invoke('delivery:orders:assign', { orderId, driverId }),
  setDeliveryStatus: (orderId: number, status: string) =>
    ipcRenderer.invoke('delivery:orders:status', { orderId, status }),
  /** The cash orders this driver has delivered but not yet handed in. */
  listUnsettledDeliveries: (driverId: number) => ipcRenderer.invoke('delivery:unsettled', { driverId }),
  /** Count a driver's money in. Omit `orderIds` to take everything outstanding. */
  settleDriver: (driverId: number, opts?: { orderIds?: number[]; note?: string }) =>
    ipcRenderer.invoke('delivery:settle', { driverId, ...opts }),
  listDriverSettlements: (filters?: { driverId?: number; limit?: number }) =>
    ipcRenderer.invoke('delivery:settlements:list', filters),
  getSettlementOrders: (settlementId: number) =>
    ipcRenderer.invoke('delivery:settlements:orders', { settlementId }),

  // Deleting things other records depend on
  getDeleteImpact: (kind: string, id: number) => ipcRenderer.invoke('deletion:impact', { kind, id }),
  deleteEntity: (kind: string, id: number, force?: boolean, ownerPassword?: string) =>
    ipcRenderer.invoke('deletion:delete', { kind, id, force, ownerPassword }),

  // Delivery customers
  getCustomerByPhone: (phone: string) => ipcRenderer.invoke('customers:byPhone', { phone }),
  listCustomers: (filters?: any) => ipcRenderer.invoke('customers:list', filters),
  getCustomerOrders: (phone: string, limit?: number) => ipcRenderer.invoke('customers:orders', { phone, limit }),
  getCustomerStats: () => ipcRenderer.invoke('customers:stats'),

  // WhatsApp customer notes
  getCustomerNotes: (phone: string) => ipcRenderer.invoke('whatsapp:getNotes', { phone }),
  addCustomerNote: (data: any) => ipcRenderer.invoke('whatsapp:addNote', data),
  deleteCustomerNote: (noteId: number) => ipcRenderer.invoke('whatsapp:deleteNote', { noteId }),

  // Printers (الطابعات)
  listPrinters: () => ipcRenderer.invoke('printers:list'),
  listSystemPrinters: () => ipcRenderer.invoke('printers:listSystem'),
  upsertPrinter: (data: any) => ipcRenderer.invoke('printers:upsert', data),
  deletePrinter: (printerId: number) => ipcRenderer.invoke('printers:delete', { printerId }),
  testPrinter: (printerId: number) => ipcRenderer.invoke('printers:test', { printerId }),
  testPrinterConnection: (printerId: number) => ipcRenderer.invoke('printers:testConnection', { printerId }),
  /** Reprint an invoice. Omit `printerId` to send it to every printer that wants it. */
  printOrder: (orderId: number, opts?: { tenderedAmount?: number; reprint?: boolean; printerId?: number }) =>
    ipcRenderer.invoke('printers:printOrder', { orderId, ...opts }),
  openCashDrawer: (printerId?: number) => ipcRenderer.invoke('printers:openDrawer', { printerId }),
  /** Sound the buzzer on its own — proves the printer has one, uses no paper. */
  testPrinterBeep: (printerId: number) => ipcRenderer.invoke('printers:testBeep', { printerId }),

  // Two-till networking (الربط بين الأجهزة)
  getNetworkStatus: () => ipcRenderer.invoke('net:status'),
  setNetworkMode: (data: { mode: string; port?: number }) =>
    ipcRenderer.invoke('net:setMode', data),
  getLocalAddresses: () => ipcRenderer.invoke('net:localAddresses'),
  /** What is in THIS machine's database — so the right machine is made the master. */
  getBooksSummary: () => ipcRenderer.invoke('net:booksSummary'),
  /** Sweep the LAN for other tills and network printers. Takes a few seconds. */
  discoverDevices: () => ipcRenderer.invoke('net:discover'),
  /**
   * Take a till on, from the master, with one press. The other machine needs nobody
   * standing at it and no address typed into it — the master dials it from here on.
   */
  adoptTill: (host: string, port: number) => ipcRenderer.invoke('net:adopt', { host, port }),
  /** Let a till go: it forgets this master and goes back to standalone. */
  dropTill: (tillId: string) => ipcRenderer.invoke('net:drop', { tillId }),
  /**
   * Drive a till from the master's screen. `kind` is one of:
   * signOut | lock | unlock | refresh | restart
   */
  commandTill: (tillId: string, command: { kind: string; reason?: string }) =>
    ipcRenderer.invoke('net:command', { tillId, command }),

  // Backups (النسخ الاحتياطي)
  /** How the nightly backup is doing, and which machines hold last night's copy. */
  getBackupHealth: () => ipcRenderer.invoke('net:backupHealth'),
  /** Run tonight's backup now and push it to every till, without waiting for 3am. */
  runBackupNow: () => ipcRenderer.invoke('net:backupNow'),
  setBackupHour: (hour: number) => ipcRenderer.invoke('net:setBackupHour', { hour }),

  // Suppliers (الموردون) — goods bought, money paid, money owed
  listSuppliers: (includeInactive?: boolean) => ipcRenderer.invoke('suppliers:list', { includeInactive }),
  getSuppliersSummary: () => ipcRenderer.invoke('suppliers:summary'),
  getSupplierAccount: (supplierId: number) => ipcRenderer.invoke('suppliers:account', { supplierId }),
  upsertSupplier: (data: any) => ipcRenderer.invoke('suppliers:upsert', data),
  deleteSupplier: (supplierId: number) => ipcRenderer.invoke('suppliers:delete', { supplierId }),
  /** Records the invoice AND adds the goods to stock, in one transaction. */
  recordSupplierDelivery: (data: any) => ipcRenderer.invoke('suppliers:recordDelivery', data),
  recordSupplierPayment: (data: any) => ipcRenderer.invoke('suppliers:recordPayment', data),
  deleteSupplierPayment: (paymentId: number) => ipcRenderer.invoke('suppliers:deletePayment', { paymentId }),
  getSupplierInvoice: (invoiceId: number) => ipcRenderer.invoke('suppliers:invoice', { invoiceId }),
  /** Prints TWO copies on the cashier printer — supplier's and restaurant's. */
  printSupplierInvoice: (invoiceId: number, reprint?: boolean) =>
    ipcRenderer.invoke('suppliers:printInvoice', { invoiceId, reprint }),

  // Reports
  exportReport: (start: string, end: string) => ipcRenderer.invoke('reports:exportExcel', { start, end }),

  // «Sales Products» — how many of everything was sold, and what it consumed.
  getSalesProductsReport: (start: string, end: string) =>
    ipcRenderer.invoke('reports:salesProducts', { start, end }),
  /** Writes both the workbook and the PDF into the reports folder. */
  exportSalesProducts: (start: string, end: string) =>
    ipcRenderer.invoke('reports:salesProductsExport', { start, end }),
  /** Counter printer only — never a kitchen station. */
  printSalesProducts: (start: string, end: string, printerId?: number) =>
    ipcRenderer.invoke('reports:salesProductsPrint', { start, end, printerId }),
  openSalesReportFolder: () => ipcRenderer.invoke('reports:openSalesFolder'),
  /** The sheet's costing against today's ingredient prices. */
  getCostingReport: () => ipcRenderer.invoke('reports:costing'),

  // Finance (accountant)
  // `shift` narrows the report to one configured shift: 'current' for the one running
  // now, or the id of a shift from listWorkShifts.
  getFinanceReport: (start: string, end: string, shift?: 'current' | number) =>
    ipcRenderer.invoke('finance:report', { start, end, shift }),
  exportFinancePdf: (start: string, end: string, shift?: 'current' | number) =>
    ipcRenderer.invoke('finance:exportPdf', { start, end, shift }),
  exportFinanceExcel: (start: string, end: string, shift?: 'current' | number) =>
    ipcRenderer.invoke('finance:exportExcel', { start, end, shift }),
  openExportedFile: (filePath: string) => ipcRenderer.invoke('finance:openFile', { filePath }),

  // Push events (Main → Renderer)
  onSettingsChanged: (cb: (data: any) => void) => {
    const handler = (_e: any, data: any) => cb(data)
    ipcRenderer.on('app:settingsChanged', handler)
    return () => { ipcRenderer.removeListener('app:settingsChanged', handler) }
  },
  // Any stock movement anywhere — sale, void, delete, prep, adjustment. Screens
  // holding a cached copy of the materials use this to refresh themselves.
  onStockChanged: (cb: (data: any) => void) => {
    const handler = (_e: any, data: any) => cb(data)
    ipcRenderer.on('app:stockChanged', handler)
    return () => { ipcRenderer.removeListener('app:stockChanged', handler) }
  },
  onLowStockAlert: (cb: (data: any) => void) => {
    const handler = (_e: any, data: any) => cb(data)
    ipcRenderer.on('app:lowStockAlert', handler)
    return () => { ipcRenderer.removeListener('app:lowStockAlert', handler) }
  },
  // Automatic printing happens in the background after a sale, so a printer that
  // is out of paper or switched off reports itself this way rather than through
  // the checkout call — which has long since returned.
  onPrintResult: (cb: (data: any) => void) => {
    const handler = (_e: any, data: any) => cb(data)
    ipcRenderer.on('app:printResult', handler)
    return () => { ipcRenderer.removeListener('app:printResult', handler) }
  },
  // A shift closed and its close-out report has been written. Carries the two file
  // paths and the summary text, so the screen can offer "open the folder" and "send
  // it to the group" without going back for anything.
  onShiftExported: (cb: (data: any) => void) => {
    const handler = (_e: any, data: any) => cb(data)
    ipcRenderer.on('app:shiftExported', handler)
    return () => { ipcRenderer.removeListener('app:shiftExported', handler) }
  },
  // An order rung up on the OTHER till. Screens holding a list of orders use this to
  // refresh, so the two machines never disagree about what has been sold.
  onOrdersChanged: (cb: (data: any) => void) => {
    const handler = (_e: any, data: any) => cb(data)
    ipcRenderer.on('app:ordersChanged', handler)
    return () => { ipcRenderer.removeListener('app:ordersChanged', handler) }
  },
  // Node tills only: the state of the link the master holds to this machine â€”
  // connected or not, why not, whether the master has locked this till, and how
  // fresh the local read-only copy of the books is.
  onMasterLink: (cb: (data: {
    linked: boolean
    masterName: string
    masterAddress: string
    since: number | null
    locked: boolean
    lockReason: string
    reason: string
    mirror: { at: number; bytes: number } | null
    /** Add to this machine's clock to get the master's — see renderer/lib/clock.ts. */
    masterTimeOffsetMs: number
  }) => void) => {
    const handler = (_e: any, data: any) => cb(data)
    ipcRenderer.on('app:masterLink', handler)
    return () => { ipcRenderer.removeListener('app:masterLink', handler) }
  },
  // The master signed this till out from its own screen.
  onForceSignOut: (cb: (data: { reason: string }) => void) => {
    const handler = (_e: any, data: any) => cb(data)
    ipcRenderer.on('app:forceSignOut', handler)
    return () => { ipcRenderer.removeListener('app:forceSignOut', handler) }
  },
  // Whether the backup was written, and which machines hold a copy. A failure here
  // used to be silent, which is how a shop ran a whole day with no backups at all.
  onBackupResult: (cb: (data: {
    ok: boolean
    at: number
    name?: string
    error?: string
    copiedTo?: string[]
    notCopied?: { name: string; error: string }[]
    hourly?: boolean
  }) => void) => {
    const handler = (_e: any, data: any) => cb(data)
    ipcRenderer.on('app:backupResult', handler)
    return () => { ipcRenderer.removeListener('app:backupResult', handler) }
  },
}

contextBridge.exposeInMainWorld('api', api)

export type ElectronAPI = typeof api
