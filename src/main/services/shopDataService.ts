import fs from 'node:fs'
import path from 'node:path'
import log from 'electron-log/main'
import { getDb } from '../db/db'
import { listCustomers } from './customerService'
import type { ShopDataCounts, ShopDataExport } from '../../shared/types'

/**
 * The shop itself, as one file: the menu, the stock, the customers and the settings.
 *
 * Everything that makes this installation THIS restaurant and that somebody typed in
 * by hand — as opposed to what the till recorded by being used. It is what has to
 * survive starting the books again, moving to a new machine, or going from a trial
 * set-up to the real one, and none of those should mean re-entering fifty dishes and
 * their recipes.
 *
 * What is in it
 * -------------
 *   القائمة     categories, dishes, the questions the till asks (sizes, spicy…)
 *   المخزون     raw materials with what is on the shelf and what each costs, the
 *               recipe of every dish, and the prep conversions
 *   العملاء     the delivery client book, with each customer's history to date
 *   الإعدادات   shop details, tax, shift hours, printing — plus the delivery areas,
 *               the drivers and the printers, which live on the settings screen
 *
 * What is deliberately NOT in it
 * ------------------------------
 *   invoices, expenses, wages, shifts   the books. A backup carries those.
 *   user accounts                       a file meant to be copied about must not
 *                                       carry anybody's password, hashed or not.
 *   the link to the other till          the token and the list of tills belong to one
 *                                       machine. Two tills started from the same file
 *                                       would both believe they were the master.
 */

export const SHOP_DATA_FORMAT = 'crispo-shop-data'
export const SHOP_DATA_VERSION = 1

/** The settings that describe the shop, as opposed to this machine or its state. */
const SETTING_KEYS = [
  'business_name', 'business_address', 'business_phone', 'receipt_footer',
  'currency_symbol', 'tax_rate', 'max_cashier_discount',
  'shifts_per_day', 'shift1_name', 'shift1_start', 'shift1_end',
  'shift2_name', 'shift2_start', 'shift2_end',
  'print_auto', 'print_logo', 'print_feed_lines', 'print_font_scale',
  'backup_hour', 'shift_export_auto', 'whatsapp_group',
] as const

const SETTING_LABELS: Record<string, string> = {
  business_name: 'اسم المطعم', business_address: 'العنوان', business_phone: 'الهاتف',
  receipt_footer: 'تذييل الفاتورة', currency_symbol: 'العملة', tax_rate: 'نسبة الضريبة',
  max_cashier_discount: 'أقصى خصم للكاشير %', shifts_per_day: 'عدد الورديات في اليوم',
  shift1_name: 'اسم الوردية الأولى', shift1_start: 'بداية الوردية الأولى', shift1_end: 'نهاية الوردية الأولى',
  shift2_name: 'اسم الوردية الثانية', shift2_start: 'بداية الوردية الثانية', shift2_end: 'نهاية الوردية الثانية',
  print_auto: 'طباعة تلقائية', print_logo: 'طباعة الشعار', print_feed_lines: 'سطور فارغة بعد الفاتورة',
  print_font_scale: 'حجم الخط %', backup_hour: 'ساعة النسخ الاحتياطي',
  shift_export_auto: 'تقرير الوردية التلقائي', whatsapp_group: 'جروب واتساب',
}

/**
 * The tables that travel whole, parents before children.
 *
 * Rows keep their ids. The things in here point at each other — a recipe line at a
 * dish and a material, a kitchen printer at the categories it cooks — and keeping the
 * ids is what keeps every one of those pointers true without rewriting any of them.
 * It is also why an import replaces these tables rather than adding to them.
 */
const TABLES = [
  { key: 'categories', table: 'categories', columns: ['category_id', 'name', 'display_order', 'printer_id'] },
  {
    key: 'menuItems', table: 'menu_items',
    columns: ['item_id', 'category_id', 'name', 'price', 'cost_price', 'baseline_cost', 'description',
      'image_path', 'is_active', 'stock_quantity', 'inherit_category_variants', 'display_order'],
  },
  {
    key: 'variantGroups', table: 'item_variant_groups',
    columns: ['variant_group_id', 'menu_item_id', 'category_id', 'group_name', 'display_order'],
  },
  {
    key: 'variantOptions', table: 'item_variant_options',
    columns: ['variant_option_id', 'variant_group_id', 'option_name', 'price_delta', 'display_order'],
  },
  {
    key: 'rawMaterials', table: 'raw_materials',
    columns: ['raw_material_id', 'name', 'unit', 'stock_quantity', 'cost_per_unit', 'low_stock_threshold', 'is_active'],
  },
  { key: 'recipeItems', table: 'recipe_items', columns: ['recipe_item_id', 'menu_item_id', 'raw_material_id', 'quantity'] },
  {
    key: 'prepConversions', table: 'prep_conversions',
    columns: ['prep_conversion_id', 'source_material_id', 'output_material_id', 'yield_quantity'],
  },
  { key: 'deliveryAreas', table: 'delivery_areas', columns: ['delivery_area_id', 'area_name', 'delivery_fee', 'is_active'] },
  { key: 'deliveryDrivers', table: 'delivery_drivers', columns: ['driver_id', 'full_name', 'phone', 'is_active'] },
  {
    key: 'printers', table: 'printers',
    columns: ['printer_id', 'name', 'role', 'connection', 'device_name', 'host', 'port', 'paper_width', 'copies',
      'cut_paper', 'open_drawer', 'beep', 'category_ids', 'station', 'auto_print', 'is_active', 'display_order'],
  },
] as const

type TableKey = typeof TABLES[number]['key']
type Row = Record<string, unknown>

export interface ShopDataCustomer {
  phone: string
  name: string | null
  address: string | null
  deliveryAreaId: number | null
  orders: number
  spent: number
  firstOrderAt: string | null
  lastOrderAt: string | null
}

export type ShopDataPackage = {
  format: typeof SHOP_DATA_FORMAT
  version: number
  exportedAt: string
  businessName: string
  settings: Record<string, string>
  customers: ShopDataCustomer[]
  customerNotes: { phone: string; note: string; created_at: string }[]
} & Record<TableKey, Row[]>

const pad = (n: number) => String(n).padStart(2, '0')
function nowStamp(sep = ':'): string {
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${sep}${pad(d.getMinutes())}`
}

/** Gather the shop out of the database that is open now. */
export function buildShopData(): ShopDataPackage {
  const db = getDb()

  const settings: Record<string, string> = {}
  const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[]
  for (const r of rows) {
    if ((SETTING_KEYS as readonly string[]).includes(r.key)) settings[r.key] = String(r.value ?? '')
  }

  const tables = {} as Record<TableKey, Row[]>
  for (const t of TABLES) {
    tables[t.key] = db.prepare(`SELECT ${t.columns.join(', ')} FROM ${t.table} ORDER BY ${t.columns[0]}`).all() as Row[]
  }

  // The client book as the screens show it: this database's own delivery orders plus
  // anyone carried over before, each with their history to date.
  const customers: ShopDataCustomer[] = listCustomers({ limit: 1_000_000 }).map(c => ({
    phone: c.phone,
    name: c.name ?? null,
    address: c.address ?? null,
    deliveryAreaId: c.delivery_area_id ?? null,
    orders: c.order_count ?? 0,
    spent: c.total_spent ?? 0,
    firstOrderAt: c.first_order_at ?? null,
    lastOrderAt: c.last_order_at ?? null,
  }))

  const customerNotes = db.prepare(
    'SELECT phone, note, created_at FROM customer_notes ORDER BY note_id',
  ).all() as { phone: string; note: string; created_at: string }[]

  return {
    format: SHOP_DATA_FORMAT,
    version: SHOP_DATA_VERSION,
    exportedAt: nowStamp(),
    businessName: settings.business_name || '',
    settings,
    ...tables,
    customers,
    customerNotes,
  }
}

export function countShopData(pkg: ShopDataPackage): ShopDataCounts {
  return {
    categories: pkg.categories.length,
    menuItems: pkg.menuItems.length,
    rawMaterials: pkg.rawMaterials.length,
    recipeLines: pkg.recipeItems.length,
    customers: pkg.customers.length,
    deliveryAreas: pkg.deliveryAreas.length,
    printers: pkg.printers.length,
    settings: Object.keys(pkg.settings).length,
  }
}

/** What an export made right now would contain. */
export function currentShopDataCounts(): ShopDataCounts {
  return countShopData(buildShopData())
}

/**
 * Check a file is one of ours before anything in the database is touched.
 *
 * The file comes off a USB stick and may be anything — a different program's JSON, a
 * hand-edited copy, half a download. Everything is checked here, and nothing in it is
 * ever used as a column or table name: only the names in TABLES reach the SQL.
 */
export function parseShopData(input: unknown): ShopDataPackage {
  const pkg = input as Partial<ShopDataPackage> | null
  if (!pkg || typeof pkg !== 'object' || pkg.format !== SHOP_DATA_FORMAT) {
    throw new Error('هذا ليس ملف بيانات محل صادراً من البرنامج')
  }
  if (Number(pkg.version) !== SHOP_DATA_VERSION) {
    throw new Error('ملف البيانات من إصدار غير مدعوم')
  }
  for (const t of TABLES) {
    if (!Array.isArray(pkg[t.key])) throw new Error(`ملف البيانات ناقص: ${t.key}`)
    if ((pkg[t.key] as unknown[]).some(r => !r || typeof r !== 'object')) {
      throw new Error(`ملف البيانات تالف: ${t.key}`)
    }
  }
  if (!Array.isArray(pkg.customers)) throw new Error('ملف البيانات ناقص: customers')
  if (!pkg.settings || typeof pkg.settings !== 'object') throw new Error('ملف البيانات ناقص: settings')
  if (pkg.customers.some(c => !c || typeof c.phone !== 'string' || !c.phone.trim())) {
    throw new Error('ملف البيانات تالف: عميل بدون رقم هاتف')
  }
  return { ...pkg, customerNotes: Array.isArray(pkg.customerNotes) ? pkg.customerNotes : [] } as ShopDataPackage
}

/**
 * Replace the shop in the open database with the one in the package.
 *
 * Only on empty books. The menu and the stock are replaced row for row, and an invoice
 * that already points at dish 12 must go on meaning the dish it was rung up as — so
 * once anything has been sold, the way in is to start the books again first (which
 * takes its own backup) and then import.
 *
 * One transaction: either the whole shop arrives or none of it does.
 */
export function importShopData(input: unknown, actorUserId: number): ShopDataCounts {
  const pkg = parseShopData(input)
  const db = getDb()

  const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c
  if (count('orders') > 0 || count('supplier_invoice_items') > 0 || count('driver_settlements') > 0) {
    throw new Error(
      'لا يمكن استيراد بيانات المحل بعد تسجيل فواتير أو توريدات — ' +
      'صفّر النظام أولاً من تبويب «الأمان والنسخ الاحتياطي» ثم أعد الاستيراد',
    )
  }

  const run = db.transaction(() => {
    // Out with what is there — children before the rows they point at.
    for (const table of [
      'recipe_items', 'prep_conversions', 'raw_material_transactions', 'stock_transactions',
      'stock_conversions', 'item_variant_options', 'item_variant_groups', 'menu_items', 'categories',
      'raw_materials', 'customer_notes', 'customers', 'printers', 'delivery_drivers', 'delivery_areas',
    ]) {
      db.prepare(`DELETE FROM ${table}`).run()
    }

    for (const t of TABLES) {
      for (const row of pkg[t.key]) {
        // Only the columns this version knows, and only those the row actually has, so
        // a file from an older version leaves newer columns on their defaults.
        const cols = t.columns.filter(c => row[c] !== undefined)
        if (cols.length === 0) continue
        db.prepare(
          `INSERT INTO ${t.table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
        ).run(...cols.map(c => row[c] as never))
      }
    }

    // ---- The client book, with each customer's history as it stood ----
    const areaIds = new Set(pkg.deliveryAreas.map(a => Number(a.delivery_area_id)))
    const insertCustomer = db.prepare(`
      INSERT OR REPLACE INTO customers
        (phone, name, address, delivery_area_id, prior_orders, prior_spent, first_order_at, last_order_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    for (const c of pkg.customers) {
      const area = c.deliveryAreaId != null && areaIds.has(Number(c.deliveryAreaId)) ? Number(c.deliveryAreaId) : null
      insertCustomer.run(
        c.phone.trim(), c.name ?? null, c.address ?? null, area,
        Math.max(0, Math.round(Number(c.orders) || 0)), Math.max(0, Number(c.spent) || 0),
        c.firstOrderAt ?? null, c.lastOrderAt ?? null,
      )
    }
    const insertNote = db.prepare(
      `INSERT INTO customer_notes (phone, note, created_by, created_at) VALUES (?, ?, ?, COALESCE(?, datetime('now','localtime')))`,
    )
    for (const n of pkg.customerNotes) {
      if (n && typeof n.phone === 'string' && typeof n.note === 'string') {
        insertNote.run(n.phone, n.note, actorUserId, n.created_at ?? null)
      }
    }

    // ---- Settings: the shop's, never this machine's ----
    const upsert = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
    for (const key of SETTING_KEYS) {
      const value = (pkg.settings as Record<string, unknown>)[key]
      if (value !== undefined && value !== null) upsert.run(key, String(value))
    }

    // ---- An opening entry for every count that arrived ----
    //
    // The shelf count comes across as a number on the material. Without a movement
    // behind it the stock ledger would start out by exactly that number — a balance
    // nothing explains, on every material, from the first day.
    const opening = db.prepare(`
      INSERT INTO raw_material_transactions (raw_material_id, change_amount, reason, created_by)
      VALUES (?, ?, 'adjustment', ?)
    `)
    for (const m of pkg.rawMaterials) {
      const qty = Number(m.stock_quantity) || 0
      if (qty !== 0) opening.run(m.raw_material_id as never, qty, actorUserId)
    }
  })
  run()

  const counts = countShopData(pkg)
  log.info(
    `[ShopData] Imported by user ${actorUserId}: ${counts.menuItems} dishes, ${counts.rawMaterials} materials, ` +
    `${counts.customers} customers, ${counts.settings} settings`,
  )
  return counts
}

/**
 * Write the shop out: the file the program reads back, and a workbook a person can.
 *
 * Both into one dated folder, so the pair stays together on the stick. The JSON is the
 * complete one — it is what «استيراد» takes. The workbook is the same data laid out to
 * be looked at, checked or printed; nothing reads it back.
 */
export async function exportShopDataTo(parentFolder: string): Promise<ShopDataExport> {
  const pkg = buildShopData()

  const folder = path.join(parentFolder, `بيانات المحل ${nowStamp('-')}`)
  fs.mkdirSync(folder, { recursive: true })

  const jsonPath = path.join(folder, 'shop-data.json')
  fs.writeFileSync(jsonPath, JSON.stringify(pkg, null, 2), 'utf8')

  const excelPath = path.join(folder, 'بيانات المحل.xlsx')
  await writeShopWorkbook(pkg, excelPath)

  log.info(`[ShopData] Exported to ${folder}`)
  return { folder, jsonPath, excelPath, counts: countShopData(pkg) }
}

export async function writeShopWorkbook(pkg: ShopDataPackage, filePath: string): Promise<string> {
  const ExcelJS = require('exceljs')
  const wb = new ExcelJS.Workbook()
  wb.creator = pkg.businessName || 'Resto POS'
  wb.created = new Date()

  const MONEY = '#,##0.00'
  const style = (sheet: any) => {
    const header = sheet.getRow(1)
    header.font = { bold: true, size: 12, color: { argb: 'FFFFFFFF' } }
    header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFC41E2E' } }
    header.alignment = { horizontal: 'center' }
    sheet.views = [{ state: 'frozen', ySplit: 1, rightToLeft: true }]
  }
  const yesNo = (v: unknown) => (Number(v) ? 'نعم' : 'لا')

  const categoryName = new Map(pkg.categories.map(c => [Number(c.category_id), String(c.name)]))
  const itemName = new Map(pkg.menuItems.map(i => [Number(i.item_id), String(i.name)]))
  const material = new Map(pkg.rawMaterials.map(m => [Number(m.raw_material_id), m]))
  const areaName = new Map(pkg.deliveryAreas.map(a => [Number(a.delivery_area_id), String(a.area_name)]))

  // ===== القائمة =====
  const menu = wb.addWorksheet('القائمة')
  menu.columns = [
    { header: 'القسم', key: 'category', width: 26 },
    { header: 'الصنف', key: 'name', width: 40 },
    { header: 'السعر', key: 'price', width: 12, style: { numFmt: MONEY } },
    { header: 'التكلفة', key: 'cost', width: 12, style: { numFmt: MONEY } },
    { header: 'الوصف', key: 'description', width: 46 },
    { header: 'مفعّل', key: 'active', width: 9 },
  ]
  menu.addRows(pkg.menuItems.map(i => ({
    category: categoryName.get(Number(i.category_id)) ?? '—',
    name: i.name, price: Number(i.price) || 0, cost: Number(i.cost_price) || 0,
    description: i.description ?? '', active: yesNo(i.is_active),
  })))
  style(menu)

  // ===== الخامات والمخزون =====
  const stock = wb.addWorksheet('الخامات والمخزون')
  stock.columns = [
    { header: 'الخامة', key: 'name', width: 32 },
    { header: 'الوحدة', key: 'unit', width: 12 },
    { header: 'الرصيد', key: 'qty', width: 12 },
    { header: 'تكلفة الوحدة', key: 'cost', width: 14, style: { numFmt: MONEY } },
    { header: 'حد التنبيه', key: 'threshold', width: 12 },
    { header: 'مفعّلة', key: 'active', width: 9 },
  ]
  stock.addRows(pkg.rawMaterials.map(m => ({
    name: m.name, unit: m.unit, qty: Number(m.stock_quantity) || 0, cost: Number(m.cost_per_unit) || 0,
    threshold: Number(m.low_stock_threshold) || 0, active: yesNo(m.is_active),
  })))
  style(stock)

  // ===== مكونات الأصناف =====
  const recipes = wb.addWorksheet('مكونات الأصناف')
  recipes.columns = [
    { header: 'الصنف', key: 'item', width: 40 },
    { header: 'الخامة', key: 'material', width: 32 },
    { header: 'الكمية', key: 'qty', width: 12 },
    { header: 'الوحدة', key: 'unit', width: 12 },
  ]
  recipes.addRows(pkg.recipeItems.map(r => ({
    item: itemName.get(Number(r.menu_item_id)) ?? '—',
    material: String(material.get(Number(r.raw_material_id))?.name ?? '—'),
    qty: Number(r.quantity) || 0,
    unit: String(material.get(Number(r.raw_material_id))?.unit ?? ''),
  })))
  style(recipes)

  // ===== العملاء =====
  const customers = wb.addWorksheet('العملاء')
  customers.columns = [
    { header: 'رقم الهاتف', key: 'phone', width: 18 },
    { header: 'الاسم', key: 'name', width: 26 },
    { header: 'العنوان', key: 'address', width: 44 },
    { header: 'المنطقة', key: 'area', width: 20 },
    { header: 'عدد الطلبات', key: 'orders', width: 13 },
    { header: 'إجمالي المشتريات', key: 'spent', width: 17, style: { numFmt: MONEY } },
    { header: 'آخر طلب', key: 'last', width: 20 },
  ]
  customers.addRows(pkg.customers.map(c => ({
    phone: c.phone, name: c.name ?? '', address: c.address ?? '',
    area: c.deliveryAreaId != null ? (areaName.get(Number(c.deliveryAreaId)) ?? '') : '',
    orders: c.orders, spent: c.spent, last: c.lastOrderAt ?? '',
  })))
  // A phone number is a name, not a quantity: as a number it loses its leading zero.
  customers.getColumn('phone').numFmt = '@'
  style(customers)

  // ===== مناطق التوصيل =====
  const areas = wb.addWorksheet('مناطق التوصيل')
  areas.columns = [
    { header: 'المنطقة', key: 'name', width: 28 },
    { header: 'رسوم التوصيل', key: 'fee', width: 15, style: { numFmt: MONEY } },
    { header: 'مفعّلة', key: 'active', width: 9 },
  ]
  areas.addRows(pkg.deliveryAreas.map(a => ({
    name: a.area_name, fee: Number(a.delivery_fee) || 0, active: yesNo(a.is_active),
  })))
  style(areas)

  // ===== الإعدادات =====
  const settings = wb.addWorksheet('الإعدادات')
  settings.columns = [
    { header: 'الإعداد', key: 'label', width: 34 },
    { header: 'القيمة', key: 'value', width: 50 },
  ]
  settings.addRows(Object.entries(pkg.settings).map(([key, value]) => ({
    label: SETTING_LABELS[key] ?? key, value,
  })))
  for (const p of pkg.printers) {
    settings.addRow({
      label: `طابعة: ${p.name}`,
      value: `${p.role} · ${p.connection}${p.host ? ` · ${p.host}:${p.port}` : ''}${p.device_name ? ` · ${p.device_name}` : ''}`,
    })
  }
  style(settings)

  await wb.xlsx.writeFile(filePath)
  return filePath
}
