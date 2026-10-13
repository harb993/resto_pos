import Database from 'better-sqlite3'
import path from 'node:path'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { app } from 'electron'
import log from 'electron-log/main'
// Statically imported so the bundler resolves it; it does nothing unless --demo is set.
import { seedDemoData } from './demoSeed'

let db: Database.Database

/**
 * Which set of books is open.
 *
 * 'real' is the restaurant. 'demo' is the showcase account's own database, in its own
 * folder, opened only while that account is signed in. Only one is ever open at a
 * time: the real file is closed before the demo one opens, so nothing done during a
 * demonstration can reach real trading data even by accident.
 *
 * Everything else — schema, migrations, every line of business logic — is identical
 * between them, so what a customer is shown is genuinely this system running.
 */
export type DbProfile = 'real' | 'demo'

/**
 * `--demo` pins the whole app to the showcase database, whoever signs in. It exists
 * for testing the system against a full month of data; normal operation never uses it,
 * and the account is what decides the profile there.
 */
const LAUNCHED_IN_DEMO = process.argv.includes('--demo') || process.env.CRISPO_DEMO === '1'

export function isDemoLaunch(): boolean {
  return LAUNCHED_IN_DEMO
}

let activeProfile: DbProfile = LAUNCHED_IN_DEMO ? 'demo' : 'real'

export function getActiveProfile(): DbProfile {
  return activeProfile
}

export function isDemoMode(): boolean {
  return activeProfile === 'demo'
}

/** `data` for real trading, `data-demo` for the showcase account. */
function dataFolderName(): string {
  return activeProfile === 'demo' ? 'data-demo' : 'data'
}

/**
 * Close the current database and open the other profile's.
 *
 * Called when the showcase account signs in and again when it signs out. Safe to call
 * with the profile already active — it does nothing.
 */
export function switchProfile(profile: DbProfile): void {
  if (profile === activeProfile && db) return

  if (db) {
    try {
      db.close()
      log.info(`[DB] Closed the ${activeProfile} database`)
    } catch (err) {
      log.warn('[DB] Error closing database before switch:', err)
    }
  }

  activeProfile = profile
  if (profile === 'demo') refreshDemoDatabaseIfStale()
  initDatabase()
  log.info(`[DB] Now using the ${profile} database`)
}

/**
 * The showcase database is rebuilt whenever its newest sale is not from today.
 *
 * The generator lays a month of trading onto the thirty days ending today, so a
 * demonstration always opens on a shop that traded this morning rather than one that
 * stopped last Tuesday. Anything typed during a previous demonstration goes with it,
 * which is the point.
 *
 * The figures are drawn fresh each day — see demoSeed.ts. Random between days, fixed
 * within one: a demo that reshuffled itself every time a screen was refreshed would be
 * showing output, not records, and it would do it in front of the customer.
 */
/**
 * Make sure the showcase books reach TODAY, whatever route got us here.
 *
 * `switchProfile` does this on the way in, but only when the profile actually changes.
 * Two routes skip it: a `--demo` launch, where the demo profile is active from the
 * first line and never switches; and signing in as the showcase account while it is
 * already open. Either one leaves a demonstration running on whatever day the data was
 * last built — which for a machine left switched on is "some time last week", and
 * every screen opens on an empty today.
 *
 * So the check is also made explicitly, on every showcase sign-in. Cheap when the data
 * is current: one query, then nothing.
 */
export function ensureDemoDataFresh(): void {
  if (activeProfile !== 'demo') return // never the restaurant's own books

  const today = new Date()
  const todayStr = `${today.getFullYear()}-${pad2(today.getMonth() + 1)}-${pad2(today.getDate())}`

  try {
    const row = getDb().prepare(
      `SELECT MAX(date(created_at)) AS newest FROM orders WHERE deleted_at IS NULL`
    ).get() as { newest: string | null }
    if (row?.newest === todayStr) return // already today's
  } catch {
    // Unreadable or an older shape — fall through and rebuild rather than guess.
  }

  log.info('[Demo] Showcase books are not from today — rebuilding')
  try {
    db.close()
  } catch (err) {
    log.warn('[Demo] Could not close the showcase database before rebuilding:', err)
  }
  refreshDemoDatabaseIfStale()
  initDatabase()
}

export function refreshDemoDatabaseIfStale(): void {
  const dbPath = getDbPath()
  if (!fs.existsSync(dbPath)) return // nothing there yet; initDatabase will build it

  let stale = true
  let probe: Database.Database | null = null
  try {
    probe = new Database(dbPath, { readonly: true, fileMustExist: true })
    const row = probe.prepare(
      `SELECT MAX(date(created_at)) AS newest FROM orders WHERE deleted_at IS NULL`
    ).get() as { newest: string | null }
    const today = new Date()
    const todayStr = `${today.getFullYear()}-${pad2(today.getMonth() + 1)}-${pad2(today.getDate())}`
    stale = row?.newest !== todayStr
  } catch {
    stale = true // unreadable or an older shape — rebuild rather than guess
  } finally {
    try { probe?.close() } catch { /* nothing to close */ }
  }

  if (!stale) {
    log.info('[Demo] Showcase data is already current for today')
    return
  }

  for (const suffix of ['', '-wal', '-shm']) {
    const f = dbPath + suffix
    try {
      if (fs.existsSync(f)) fs.unlinkSync(f)
    } catch (err) {
      log.warn(`[Demo] Could not remove ${f}:`, err)
    }
  }
  log.info('[Demo] Showcase data rebuilt for the thirty days ending today')
}

const pad2 = (n: number) => String(n).padStart(2, '0')

export function getDataDirectory(): string {
  const folder = dataFolderName()

  // 1. If running as electron-builder portable exe:
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    const portableDataDir = path.join(process.env.PORTABLE_EXECUTABLE_DIR, folder)
    if (!fs.existsSync(portableDataDir)) fs.mkdirSync(portableDataDir, { recursive: true })
    return portableDataDir
  }

  // 2. If running packaged app from a portable USB / unpacked folder:
  if (app.isPackaged) {
    const exeDir = path.dirname(process.execPath)
    const localDataDir = path.join(exeDir, folder)
    if (fs.existsSync(localDataDir)) {
      return localDataDir
    }
    // Test if directory is writable (e.g. USB flash drive or custom folder)
    try {
      const testFile = path.join(exeDir, '.writable_test')
      fs.writeFileSync(testFile, '1')
      fs.unlinkSync(testFile)
      if (!fs.existsSync(localDataDir)) fs.mkdirSync(localDataDir, { recursive: true })
      return localDataDir
    } catch {
      // Not writable (e.g., Program Files), fallback to standard userData
    }
  }

  // 3. Fallback to standard AppData directory
  const base = app.getPath('userData')
  if (!isDemoMode()) return base
  const demoDir = path.join(base, 'demo')
  if (!fs.existsSync(demoDir)) fs.mkdirSync(demoDir, { recursive: true })
  return demoDir
}

export function getDbPath(): string {
  const dataDir = getDataDirectory()
  return path.join(dataDir, 'restaurant.db')
}

export function initDatabase(): Database.Database {
  const dbPath = getDbPath()
  log.info(`[DB] Opening database at: ${dbPath}`)

  // Ensure the directory exists
  const dir = path.dirname(dbPath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }

  db = new Database(dbPath)

  // Critical PRAGMAs
  db.pragma('journal_mode = WAL')       // crash-safe writes
  db.pragma('synchronous = NORMAL')     // safe pairing with WAL
  db.pragma('foreign_keys = ON')        // enforce foreign keys every connection

  // Run schema - try multiple candidate paths
  const candidatePaths = [
    path.join(__dirname, '..', 'db', 'schema.sql'),
    path.join(__dirname, 'schema.sql'),
    path.join(app.getAppPath(), 'src', 'main', 'db', 'schema.sql'),
    path.join(process.cwd(), 'src', 'main', 'db', 'schema.sql'),
    path.join(app.getAppPath(), 'out', 'main', 'schema.sql'),
    path.join(app.getAppPath(), 'schema.sql')
  ]

  let schemaSQL = ''
  for (const p of candidatePaths) {
    if (fs.existsSync(p)) {
      schemaSQL = fs.readFileSync(p, 'utf-8')
      log.info(`[DB] Loaded schema from: ${p}`)
      break
    }
  }

  if (!schemaSQL) {
    // Fallback embedded schema
    log.warn('[DB] schema.sql not found on disk, using embedded fallback schema')
    schemaSQL = getEmbeddedSchema()
  }

  db.exec(schemaSQL)
  log.info('[DB] Schema applied successfully')

  // Run migrations for existing databases (add new columns if missing)
  runMigrations()

  seedFixedUsers()

  // Seed default categories & menu items if none exist.
  //
  // An emptied system must stay empty: once the starter menu has been dealt with —
  // either seeded here or deliberately cleared — this marker stops it coming back on
  // the next launch and quietly refilling a menu somebody has just emptied.
  const catCount = db.prepare('SELECT COUNT(*) as count FROM categories').get() as { count: number }
  if (catCount.count === 0 && !starterContentHandled()) {
    const insertCat = db.prepare('INSERT INTO categories (name, display_order) VALUES (?, ?)')
    const insertItem = db.prepare(
      `INSERT INTO menu_items (category_id, name, price, cost_price, description, stock_quantity, is_active)
       VALUES (?, ?, ?, ?, ?, ?, 1)`
    )

    const cats = [
      {
        name: 'وجبات الدجاج المقرمش',
        order: 1,
        items: [
          { name: 'وجبة 4 قطع دجاج مقرمش', price: 135, cost: 60, desc: '4 قطع دجاج مقرمش + بطاطس + كول سلو + خبز', stock: 50 },
          { name: 'وجبة التوفير العائلية (8 قطع)', price: 260, cost: 110, desc: '8 قطع دجاج + 2 بطاطس كبير + 2 كول سلو + 4 خبز', stock: 35 },
          { name: 'باكت الحفلات واللمة (12 قطعة)', price: 375, cost: 165, desc: '12 قطعة دجاج + 3 بطاطس + 3 صوص + 6 خبز', stock: 25 },
          { name: 'وجبة ستريبس دجاج (4 قطع)', price: 110, cost: 45, desc: '4 أصابع ستريبس مقرمشة + بطاطس + صوص هوني ماسترد', stock: 60 },
        ]
      },
      {
        name: 'البرجر والسندوتشات',
        order: 2,
        items: [
          { name: 'ساندوتش زنجر سوبريم كلاسيك', price: 95, cost: 40, desc: 'صدر دجاج مقرمش + خس + مايونيز + خبز بريوش محمص', stock: 40 },
          { name: 'برجر فاير سبايسي حار 🌶️', price: 105, cost: 45, desc: 'فيليه متبل حار + صوص باربكيو حار + جبنة شيدر + هالبينو', stock: 30 },
          { name: 'دبل كرانش ستاك العملاق', price: 140, cost: 65, desc: 'قطعتين فيليه مقرمش + دبل جبنة + صوص تشيكن كينج الخاص', stock: 20 },
          { name: 'تشيكن راب تورتيلا باربكيو', price: 85, cost: 35, desc: 'قطع ستريبس مقرمشة + بيف بيكون + صوص باربكيو مدخن', stock: 45 },
        ]
      },
      {
        name: 'المقبلات والبطاطس',
        order: 3,
        items: [
          { name: 'بطاطس شيدر وهالبينو لوديد', price: 55, cost: 20, desc: 'بطاطس مقلية مغطاة بصلصة الجبنة الشيدر وشرائح الهالبينو', stock: 75 },
          { name: 'حلقات بصل مقرمشة (8 قطع)', price: 40, cost: 15, desc: 'حلقات بصل ذهبية مقرمشة مع صوص الثومية الخاص', stock: 50 },
          { name: 'سلطة كول سلو كلاسيك كبيرة', price: 30, cost: 10, desc: 'سلطة كرنب وجزر طازجة بالمايونيز وصوص العسل', stock: 80 },
          { name: 'أصابع جبنة موزاريلا مقلية (4 قطع)', price: 60, cost: 25, desc: 'أصابع موزاريلا سايحة مع صوص المارينارا الإيطالي', stock: 40 },
        ]
      },
      {
        name: 'المشروبات والحلويات',
        order: 4,
        items: [
          { name: 'بيبسي كانز 330 مل', price: 20, cost: 10, desc: 'مشروب غازي بارد منعش', stock: 120 },
          { name: 'سفن آب كانز 330 مل', price: 20, cost: 10, desc: 'مشروب غازي ليمون منعش', stock: 100 },
          { name: 'عصير برتقال فريش طازج', price: 35, cost: 15, desc: 'عصير برتقال طبيعي 100% بدون سكر مضاف', stock: 40 },
          { name: 'مولتن تشوكلت لافا كيك', price: 65, cost: 25, desc: 'كيك الشوكولاتة الساخن مع صوص الشوكولاتة الذائب', stock: 25 },
        ]
      }
    ]

    for (const cat of cats) {
      const res = insertCat.run(cat.name, cat.order)
      const catId = res.lastInsertRowid as number
      for (const it of cat.items) {
        insertItem.run(catId, it.name, it.price, it.cost, it.desc, it.stock)
      }
    }

    markStarterContentHandled()
    log.info('[DB] Seeded initial Arabic categories and menu items with stock')
  }

  // Seed the example delivery areas — ONCE, on a database that has never had any.
  //
  // "If the table is empty" was not the same question, and the difference deleted a
  // shop's work: the owner removed the areas they do not deliver to, restarted, and
  // every one of them was back, fees and all. Cairo districts this restaurant has
  // never heard of, reappearing on the counter screen after being deleted by hand.
  // Observed here — الدقي came back twice.
  //
  // Its own marker rather than the menu's: they are set at different moments during a
  // first run, and sharing one made whichever ran second think it had already had its
  // turn. The flag is written even when nothing is seeded, so a shop that already has
  // areas is equally protected the first time it starts on this build.
  if (!deliveryAreasHandled()) {
    const areaCount = db.prepare('SELECT COUNT(*) as count FROM delivery_areas').get() as { count: number }
    if (areaCount.count === 0) {
      const insertArea = db.prepare('INSERT INTO delivery_areas (area_name, delivery_fee) VALUES (?, ?)')
      const areas = [
        { name: 'وسط البلد', fee: 15 },
        { name: 'المعادي', fee: 25 },
        { name: 'مدينة نصر', fee: 20 },
        { name: 'المهندسين', fee: 30 },
        { name: 'الدقي', fee: 25 },
        { name: 'حلوان', fee: 35 },
      ]
      for (const a of areas) {
        insertArea.run(a.name, a.fee)
      }
      log.info('[DB] Seeded default delivery areas')
    }
    markDeliveryAreasHandled()
  }

  seedRawMaterials()

  // Only ever touches the demo database — see isDemoMode().
  if (isDemoMode()) {
    seedDemoData(db)
  }

  return db
}

/**
 * The four people who operate the system: two cashiers (one per shift), the owner
 * and the accountant. This is the whole staff list as far as *logins* go — everyone
 * else is a daily worker in `workers`, paid per day and never given an account.
 *
 * Runs on every startup so all four always exist: a database created before slots
 * shipped has only 'admin' and 'cashier', which are adopted into the owner and
 * cashier1 slots rather than being duplicated.
 *
 * Only ever ADDS what is missing — an existing account's name, password or PIN is
 * never touched, because the owner may have already changed them.
 */
export const FIXED_USER_SLOTS = [
  { slot: 'owner', role: 'owner', username: 'admin', password: 'admin123', fullName: 'المدير' },
  { slot: 'cashier1', role: 'cashier', username: 'cashier1', password: 'cashier123', fullName: 'كاشير الوردية الأولى' },
  { slot: 'cashier2', role: 'cashier', username: 'cashier2', password: 'cashier456', fullName: 'كاشير الوردية الثانية' },
  { slot: 'accountant', role: 'accountant', username: 'accountant', password: 'account123', fullName: 'المحاسب' },
] as const

function seedFixedUsers(): void {
  const bcrypt = require('bcryptjs')

  const bySlot = db.prepare('SELECT user_id FROM users WHERE slot = ?')
  const byUsername = db.prepare('SELECT user_id FROM users WHERE username = ?')
  const claimSlot = db.prepare('UPDATE users SET slot = ? WHERE user_id = ?')
  // pin_hash stays NULL — sign-in is username + password only.
  const insertUser = db.prepare(
    `INSERT INTO users (username, password_hash, role, slot, full_name)
     VALUES (?, ?, ?, ?, ?)`
  )

  // Adopt the two accounts the old seed created into their matching slots, so the
  // owner keeps the credentials they have been using.
  const legacy: [string, string][] = [['admin', 'owner'], ['cashier', 'cashier1']]
  for (const [username, slot] of legacy) {
    if (bySlot.get(slot)) continue
    const existing = byUsername.get(username) as { user_id: number } | undefined
    if (existing) {
      claimSlot.run(slot, existing.user_id)
      log.info(`[DB] Adopted existing user "${username}" into slot ${slot}`)
    }
  }

  let created = 0
  for (const u of FIXED_USER_SLOTS) {
    if (bySlot.get(u.slot)) continue // slot already filled
    if (byUsername.get(u.username)) continue // name taken by an unslotted row
    insertUser.run(
      u.username,
      bcrypt.hashSync(u.password, 10),
      u.role,
      u.slot,
      u.fullName
    )
    created++
  }

  if (created > 0) log.info(`[DB] Created ${created} of the four fixed system accounts`)
}

/**
 * Seed a starter raw-material list, the whole-chicken → pieces prep conversion, and
 * recipes for the seeded menu items. Only runs on a database with no raw materials
 * yet, so it never overwrites a real inventory the owner has built up.
 */
function seedRawMaterials(): void {
  const count = db.prepare('SELECT COUNT(*) as count FROM raw_materials').get() as { count: number }
  if (count.count > 0) return
  if (starterContentHandled()) return // emptied on purpose — do not refill it

  const insertMaterial = db.prepare(
    `INSERT INTO raw_materials (name, unit, stock_quantity, cost_per_unit, low_stock_threshold)
     VALUES (?, ?, ?, ?, ?)`
  )

  // [name, unit, opening stock, cost per unit, low-stock threshold]
  const materials: [string, string, number, number, number][] = [
    ['دجاج كامل', 'دجاجة', 40, 90, 10],
    ['قطع دجاج جاهزة', 'قطعة', 0, 11.25, 24],
    ['صدور دجاج (فيليه)', 'قطعة', 60, 22, 15],
    ['أرز', 'كجم', 25, 30, 5],
    ['بطاطس مجمدة', 'كجم', 30, 45, 6],
    ['خبز برجر', 'رغيف', 120, 3.5, 30],
    ['خبز عيش', 'رغيف', 150, 1.5, 40],
    ['خبز تورتيلا', 'رغيف', 80, 4, 20],
    ['زيت قلي', 'لتر', 40, 55, 8],
    ['دقيق تغطية (بقسماط)', 'كجم', 20, 25, 5],
    ['صوص باربكيو', 'لتر', 10, 70, 2],
    ['صوص هوني ماسترد', 'لتر', 8, 75, 2],
    ['صوص ثومية', 'لتر', 8, 60, 2],
    ['مايونيز', 'لتر', 12, 65, 3],
    ['جبنة شيدر', 'كجم', 8, 180, 2],
    ['جبنة موزاريلا', 'كجم', 6, 190, 2],
    ['كرنب (كول سلو)', 'كجم', 15, 12, 3],
    ['خس', 'كجم', 10, 20, 2],
    ['بصل', 'كجم', 15, 15, 3],
    ['هالبينو', 'كجم', 4, 90, 1],
    ['بيبسي كانز', 'كانز', 120, 10, 24],
    ['سفن آب كانز', 'كانز', 100, 10, 24],
    ['برتقال', 'كجم', 20, 18, 5],
    ['كيك شوكولاتة', 'قطعة', 25, 25, 6],
    // Packaging — consumed on every order, so it belongs in stock like any ingredient
    ['علبة وجبة كرتون', 'علبة', 200, 4, 50],
    ['علبة باكت كبير', 'علبة', 80, 7, 20],
    ['كيس ورقي ساندوتش', 'كيس', 300, 1, 60],
    ['كيس تيك أواي بلاستيك', 'كيس', 250, 1.5, 50],
    ['علبة بطاطس', 'علبة', 200, 2, 50],
    ['علبة صوص صغيرة', 'علبة', 400, 0.75, 80],
    ['كوب مشروبات', 'كوب', 150, 2, 40],
    ['مناديل', 'باكيت', 100, 3, 20],
  ]

  const ids: Record<string, number> = {}
  for (const [name, unit, stock, cost, threshold] of materials) {
    const res = insertMaterial.run(name, unit, stock, cost, threshold)
    ids[name] = res.lastInsertRowid as number
  }

  // The prep step the owner asked for: butchering 1 whole chicken yields 8 ready pieces.
  db.prepare(
    `INSERT INTO prep_conversions (source_material_id, output_material_id, yield_quantity)
     VALUES (?, ?, ?)`
  ).run(ids['دجاج كامل'], ids['قطع دجاج جاهزة'], 8)

  // Recipes for the seeded menu items, keyed by menu item name.
  const recipes: Record<string, [string, number][]> = {
    'وجبة 4 قطع دجاج مقرمش': [
      ['قطع دجاج جاهزة', 4], ['بطاطس مجمدة', 0.2], ['كرنب (كول سلو)', 0.1],
      ['خبز عيش', 1], ['زيت قلي', 0.1], ['دقيق تغطية (بقسماط)', 0.15],
      ['علبة وجبة كرتون', 1], ['مناديل', 0.1],
    ],
    'وجبة التوفير العائلية (8 قطع)': [
      ['قطع دجاج جاهزة', 8], ['بطاطس مجمدة', 0.4], ['كرنب (كول سلو)', 0.2],
      ['خبز عيش', 4], ['زيت قلي', 0.2], ['دقيق تغطية (بقسماط)', 0.3],
      ['علبة باكت كبير', 1], ['مناديل', 0.2],
    ],
    'باكت الحفلات واللمة (12 قطعة)': [
      ['قطع دجاج جاهزة', 12], ['بطاطس مجمدة', 0.6], ['صوص باربكيو', 0.09],
      ['خبز عيش', 6], ['زيت قلي', 0.3], ['دقيق تغطية (بقسماط)', 0.45],
      ['علبة باكت كبير', 1], ['علبة صوص صغيرة', 3], ['مناديل', 0.3],
    ],
    'وجبة ستريبس دجاج (4 قطع)': [
      ['صدور دجاج (فيليه)', 1], ['بطاطس مجمدة', 0.2], ['صوص هوني ماسترد', 0.03],
      ['زيت قلي', 0.08], ['دقيق تغطية (بقسماط)', 0.12],
      ['علبة وجبة كرتون', 1], ['علبة صوص صغيرة', 1], ['مناديل', 0.1],
    ],
    'ساندوتش زنجر سوبريم كلاسيك': [
      ['صدور دجاج (فيليه)', 1], ['خبز برجر', 1], ['خس', 0.03],
      ['مايونيز', 0.02], ['زيت قلي', 0.05], ['دقيق تغطية (بقسماط)', 0.08],
      ['كيس ورقي ساندوتش', 1],
    ],
    'برجر فاير سبايسي حار 🌶️': [
      ['صدور دجاج (فيليه)', 1], ['خبز برجر', 1], ['جبنة شيدر', 0.02],
      ['صوص باربكيو', 0.02], ['هالبينو', 0.02], ['زيت قلي', 0.05],
      ['كيس ورقي ساندوتش', 1],
    ],
    'دبل كرانش ستاك العملاق': [
      ['صدور دجاج (فيليه)', 2], ['خبز برجر', 1], ['جبنة شيدر', 0.04],
      ['مايونيز', 0.03], ['زيت قلي', 0.1], ['دقيق تغطية (بقسماط)', 0.16],
      ['كيس ورقي ساندوتش', 1],
    ],
    'تشيكن راب تورتيلا باربكيو': [
      ['صدور دجاج (فيليه)', 1], ['خبز تورتيلا', 1], ['خس', 0.03],
      ['صوص باربكيو', 0.02], ['زيت قلي', 0.05], ['كيس ورقي ساندوتش', 1],
    ],
    'بطاطس شيدر وهالبينو لوديد': [
      ['بطاطس مجمدة', 0.3], ['جبنة شيدر', 0.05], ['هالبينو', 0.03], ['زيت قلي', 0.06],
      ['علبة بطاطس', 1],
    ],
    'حلقات بصل مقرمشة (8 قطع)': [
      ['بصل', 0.2], ['دقيق تغطية (بقسماط)', 0.08], ['صوص ثومية', 0.02], ['زيت قلي', 0.05],
      ['علبة بطاطس', 1], ['علبة صوص صغيرة', 1],
    ],
    'سلطة كول سلو كلاسيك كبيرة': [
      ['كرنب (كول سلو)', 0.2], ['مايونيز', 0.04], ['علبة بطاطس', 1],
    ],
    'أصابع جبنة موزاريلا مقلية (4 قطع)': [
      ['جبنة موزاريلا', 0.12], ['دقيق تغطية (بقسماط)', 0.05], ['زيت قلي', 0.05],
      ['علبة بطاطس', 1], ['علبة صوص صغيرة', 1],
    ],
    'بيبسي كانز 330 مل': [['بيبسي كانز', 1]],
    'سفن آب كانز 330 مل': [['سفن آب كانز', 1]],
    'عصير برتقال فريش طازج': [['برتقال', 0.5], ['كوب مشروبات', 1]],
    'مولتن تشوكلت لافا كيك': [['كيك شوكولاتة', 1], ['علبة بطاطس', 1]],
  }

  const getItem = db.prepare('SELECT item_id FROM menu_items WHERE name = ?')
  const insertRecipe = db.prepare(
    `INSERT OR IGNORE INTO recipe_items (menu_item_id, raw_material_id, quantity) VALUES (?, ?, ?)`
  )

  let linked = 0
  for (const [itemName, lines] of Object.entries(recipes)) {
    const item = getItem.get(itemName) as { item_id: number } | undefined
    if (!item) continue // menu was customised — skip rather than guess
    for (const [materialName, qty] of lines) {
      const materialId = ids[materialName]
      if (materialId) insertRecipe.run(item.item_id, materialId, qty)
    }
    linked++
  }

  markStarterContentHandled()
  log.info(`[DB] Seeded ${materials.length} raw materials, chicken prep conversion, and ${linked} recipes`)
}

/** Settings key recording that the starter menu and inventory have had their one turn. */
const STARTER_CONTENT_KEY = 'starter_content_handled'

function starterContentHandled(database: Database.Database = db): boolean {
  const row = database.prepare('SELECT value FROM settings WHERE key = ?')
    .get(STARTER_CONTENT_KEY) as { value: string } | undefined
  return row?.value === '1'
}

function markStarterContentHandled(database: Database.Database = db): void {
  database.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
    .run(STARTER_CONTENT_KEY, '1')
}

/** The same, for the example delivery areas — see the seeder for why it is separate. */
const DELIVERY_AREAS_KEY = 'starter_delivery_areas_handled'

function deliveryAreasHandled(database: Database.Database = db): boolean {
  const row = database.prepare('SELECT value FROM settings WHERE key = ?')
    .get(DELIVERY_AREAS_KEY) as { value: string } | undefined
  return row?.value === '1'
}

function markDeliveryAreasHandled(database: Database.Database = db): void {
  database.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
    .run(DELIVERY_AREAS_KEY, '1')
}

/**
 * What EVERY reset keeps: the software's own configuration, not anybody's trading.
 *
 * Written as "what survives" rather than "what to empty" on purpose. It used to be a
 * hand-written list of tables to clear, and a table added later — the supplier ledger —
 * was simply forgotten. Because `supplier_invoice_items` points at `raw_materials`,
 * emptying the materials while those rows survived aborted the whole transaction with
 * `FOREIGN KEY constraint failed`, and SQLite rolled it back: the owner pressed reset,
 * saw an error, and everything they had just tried to clear was still there — which is
 * exactly how a category deleted moments earlier came back. Listing what survives means
 * a table added tomorrow is cleared by default and cannot reintroduce that.
 */
const RESET_ALWAYS_KEEPS = new Set([
  'settings',            // the shop's own configuration
  'users',               // the four sign-ins, with whatever passwords the owner set
  'printers',            // hardware, not business data — see the table's own comment
  'schema_migrations',   // what this database has already been upgraded through
  'sqlite_sequence',     // handled separately, below
])

/**
 * What the ordinary in-app reset ALSO keeps: the menu as it stands, and the stock.
 *
 * "Start the books again" is not the same as "set the shop up from scratch". A menu is
 * weeks of work — every dish, its price, its cost, its ingredients and the questions
 * the till asks about it — and the stock figures are a physical count somebody walked
 * round the store room to take. Clearing those with the year's sales meant a reset was
 * something an owner could not afford to do, so the takings they wanted rid of stayed
 * in the books instead.
 *
 * So the trading history goes and the shop stays: after a reset the till opens on the
 * same menu, with the same ingredients on the same shelves, and invoice number 1.
 *
 * The stock COUNTS survive with the materials; the movement log does not. That is the
 * deliberate consequence of resetting — the balances become the new opening position
 * and the ledger starts again underneath them.
 */
const RESET_KEEPS_SHOP = new Set([
  // The menu
  'categories', 'menu_items', 'recipe_items',
  'item_variant_groups', 'item_variant_options',
  'stock_conversions',
  // The stock
  'raw_materials', 'prep_conversions',
  // Who the shop deals with and delivers to. Set-up, like the printers — not takings.
  'delivery_areas', 'delivery_drivers', 'suppliers', 'workers',
])

export function clearAllBusinessData(
  opts: { keepMenuAndStock?: boolean } = {},
): { cleared: Record<string, number>; kept: string[] } {
  const database = getDb()
  const cleared: Record<string, number> = {}

  // Default ON: the button in the settings screen is the one people press.
  // `--reset-data`, the commissioning step that hands the software to somebody else,
  // passes false and takes the menu and stock with it.
  const keepShop = opts.keepMenuAndStock !== false

  const keeps = new Set(RESET_ALWAYS_KEEPS)
  if (keepShop) for (const t of RESET_KEEPS_SHOP) keeps.add(t)

  const present = (database.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`
  ).all() as { name: string }[]).map(r => r.name)

  const tables = present.filter(name => !keeps.has(name))

  const wipe = database.transaction(() => {
    // Order stops mattering: foreign keys are checked at COMMIT rather than per
    // statement, so a parent may be emptied before its children as long as both go.
    // `PRAGMA foreign_keys` cannot be changed inside a transaction; this one can.
    database.pragma('defer_foreign_keys = ON')

    for (const t of tables) {
      const before = (database.prepare(`SELECT COUNT(*) AS c FROM "${t}"`).get() as { c: number }).c
      database.prepare(`DELETE FROM "${t}"`).run()
      if (before > 0) cleared[t] = before
    }

    // Row ids start from 1 again — but only for the tables that were emptied. Clearing
    // the whole counter while menu_items still holds row 40 would hand the next dish
    // an id that is already taken.
    const seq = database.prepare(
      `SELECT 1 FROM sqlite_master WHERE type='table' AND name='sqlite_sequence'`
    ).get()
    if (seq) {
      const drop = database.prepare('DELETE FROM sqlite_sequence WHERE name = ?')
      for (const t of tables) drop.run(t)
    }

    // Invoice numbering goes back to the beginning: both the running counters and the
    // daily starting numbers, so the first sale of the new system is number 1.
    for (const key of ['invoice_seq']) {
      database.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, '0')
    }
    for (const key of ['invoice_start']) {
      database.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, '1')
    }
    database.prepare('DELETE FROM settings WHERE key = ?').run('invoice_seq_day')

    // Only when the menu went with it: the printers stay either way, and their kitchen
    // routing would then be naming categories that no longer exist — a station
    // filtering on ids that match nothing prints no tickets at all.
    if (!keepShop &&
        database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='printers'").get()) {
      database.prepare('UPDATE printers SET category_ids = NULL WHERE category_ids IS NOT NULL').run()
    }

    markStarterContentHandled(database)
  })

  wipe()

  const violations = database.pragma('foreign_key_check') as unknown[]
  if (violations.length > 0) {
    log.error(`[DB] Wipe left ${violations.length} foreign-key violation(s)`, violations)
    throw new Error('تعذر تصفير البيانات — راجع السجل')
  }

  const kept = present.filter(name => keeps.has(name) && name !== 'sqlite_sequence')

  log.info(
    `[DB] Business data cleared (${keepShop ? 'menu and stock kept' : 'full wipe'}): ` +
    JSON.stringify(cleared)
  )
  return { cleared, kept }
}

/** Migration 1: packaging materials, added after the first raw-material seed shipped. */
const MIGRATION_PACKAGING = 1

/**
 * Boxes, bags and napkins are consumed on every order, so they belong in stock like
 * any other ingredient — but they were missing from the original seed. Databases
 * created before this shipped skip seedRawMaterials() entirely (it only runs on an
 * empty table), so they need the packaging added separately.
 *
 * Recorded in schema_migrations so it runs exactly once ever: re-adding materials the
 * owner has since renamed or stopped using would be worse than not adding them.
 */
function addPackagingMaterials(database: Database.Database): void {
  // A schema old enough to predate raw materials entirely has nothing to add them to.
  // Leave it — and leave the migration unrecorded, so it runs once the table arrives.
  const hasMaterials = database.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='raw_materials'"
  ).get()
  if (!hasMaterials) return

  const applied = database
    .prepare('SELECT 1 FROM schema_migrations WHERE version = ?')
    .get(MIGRATION_PACKAGING)
  if (applied) return

  // A database with no materials at all is brand new — seedRawMaterials() will put
  // the full list in, packaging included. Just record the migration as done.
  const count = database.prepare('SELECT COUNT(*) as c FROM raw_materials').get() as { c: number }

  if (count.c > 0) {
    const packaging: [string, string, number, number, number][] = [
      ['علبة وجبة كرتون', 'علبة', 200, 4, 50],
      ['علبة باكت كبير', 'علبة', 80, 7, 20],
      ['كيس ورقي ساندوتش', 'كيس', 300, 1, 60],
      ['كيس تيك أواي بلاستيك', 'كيس', 250, 1.5, 50],
      ['علبة بطاطس', 'علبة', 200, 2, 50],
      ['علبة صوص صغيرة', 'علبة', 400, 0.75, 80],
      ['كوب مشروبات', 'كوب', 150, 2, 40],
      ['مناديل', 'باكيت', 100, 3, 20],
    ]

    const exists = database.prepare('SELECT 1 FROM raw_materials WHERE name = ?')
    const insert = database.prepare(
      `INSERT INTO raw_materials (name, unit, stock_quantity, cost_per_unit, low_stock_threshold)
       VALUES (?, ?, ?, ?, ?)`
    )

    let added = 0
    for (const [name, unit, stock, cost, threshold] of packaging) {
      if (exists.get(name)) continue // owner already has one by this name
      insert.run(name, unit, stock, cost, threshold)
      added++
    }
    if (added > 0) log.info(`[DB] Migration: added ${added} packaging material(s)`)
  }

  database.prepare('INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)')
    .run(MIGRATION_PACKAGING)
}

/**
 * Run incremental migrations for databases that already exist
 * with the old schema (before new columns were added).
 *
 * Takes the connection as a parameter so the migration path can be exercised
 * against a purpose-built old-schema database in tests, rather than only ever
 * running against whatever happens to be on the machine.
 */
export function runMigrations(database: Database.Database = db): void {
  /**
   * PRAGMA table_info on a table that does not exist returns an EMPTY LIST rather
   * than failing — which reads identically to "the table is there but has none of
   * these columns". Every `if (!cols.includes(x)) ALTER TABLE` below would then try
   * to alter a table that is not there and throw, aborting the whole migration run
   * and every migration after it. Ask the catalogue first.
   */
  const tableExists = (name: string): boolean =>
    !!database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?"
    ).get(name)

  /** Columns of `table`, or null when there is no such table to migrate. */
  const columnsOf = (name: string): string[] | null =>
    tableExists(name)
      ? (database.prepare(`PRAGMA table_info('${name}')`).all() as { name: string }[]).map(c => c.name)
      : null

  // The migration ledger is this function's own bookkeeping, so it creates it rather
  // than assuming schema.sql got there first. That ordering holds at startup but not
  // when migrating a database from anywhere else — a restored backup, or an old till
  // whose schema predates the table.
  database.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version INTEGER PRIMARY KEY,
       applied_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
     );`
  )

  // Check if orders table has the new columns
  const colNames = columnsOf('orders') ?? []

  if (!colNames.includes('order_type')) {
    log.info('[DB] Running migration: adding order_type and delivery columns to orders')
    database.exec(`
      ALTER TABLE orders ADD COLUMN order_type TEXT NOT NULL DEFAULT 'dine_in';
      ALTER TABLE orders ADD COLUMN customer_name TEXT;
      ALTER TABLE orders ADD COLUMN customer_phone TEXT;
      ALTER TABLE orders ADD COLUMN customer_address TEXT;
      ALTER TABLE orders ADD COLUMN delivery_area_id INTEGER;
      ALTER TABLE orders ADD COLUMN delivery_fee REAL DEFAULT 0;
      ALTER TABLE orders ADD COLUMN driver_id INTEGER;
      ALTER TABLE orders ADD COLUMN deleted_at TEXT;
      ALTER TABLE orders ADD COLUMN deleted_by INTEGER;
    `)
  }

  // Check order_items for variant_label
  const oiCols = columnsOf('order_items')
  if (oiCols && !oiCols.includes('variant_label')) {
    log.info('[DB] Running migration: adding variant_label to order_items')
    database.exec(`ALTER TABLE order_items ADD COLUMN variant_label TEXT;`)
  }

  // Check orders for invoice_number (the daily invoice counter, shared by every type)
  if (tableExists('orders') && !colNames.includes('invoice_number')) {
    log.info('[DB] Running migration: adding invoice_number to orders')
    database.exec(`ALTER TABLE orders ADD COLUMN invoice_number TEXT;`)
  }

  // Check shifts for shift_number (fixed shift 1 / shift 2 assignment)
  const shiftColNames = columnsOf('shifts')
  if (shiftColNames && !shiftColNames.includes('shift_number')) {
    log.info('[DB] Running migration: adding shift_number to shifts')
    database.exec(`ALTER TABLE shifts ADD COLUMN shift_number INTEGER NOT NULL DEFAULT 1;`)
  }

  // users.slot — identifies which of the four fixed people a row is
  const userCols = columnsOf('users')
  if (userCols && !userCols.includes('slot')) {
    log.info('[DB] Running migration: adding slot to users')
    database.exec(`ALTER TABLE users ADD COLUMN slot TEXT;`)
  }

  if (userCols) {
    // Created here rather than in schema.sql: that file runs before this function, and
    // on an existing database the column does not exist yet at that point.
    database.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_slot ON users(slot) WHERE slot IS NOT NULL;`
    )

    // PIN sign-in was removed. Nothing reads pin_hash any more, and the UI offers no
    // way to change one, so clear them rather than leave working 4-digit credentials
    // sitting in the database where nobody can rotate them.
    if (userCols.includes('pin_hash')) {
      const withPins = database.prepare(
        'SELECT COUNT(*) as c FROM users WHERE pin_hash IS NOT NULL'
      ).get() as { c: number }
      if (withPins.c > 0) {
        log.info(`[DB] Running migration: clearing ${withPins.c} unused PIN hash(es)`)
        database.exec('UPDATE users SET pin_hash = NULL WHERE pin_hash IS NOT NULL;')
      }
    }
  }

  // shifts.started_at / ended_at — sessions are now clocked automatically on
  // sign-in and sign-out instead of being typed in by the owner.
  if (shiftColNames && !shiftColNames.includes('started_at')) {
    log.info('[DB] Running migration: adding started_at/ended_at to shifts')
    database.exec(`
      ALTER TABLE shifts ADD COLUMN started_at TEXT;
      ALTER TABLE shifts ADD COLUMN ended_at TEXT;
    `)
  }

  // shifts.report_exported_at — when the end-of-shift PDF and workbook were written.
  //
  // Back-filled with the shift's own end time for every session that closed before
  // this shipped. Left NULL, the first launch after an upgrade would try to export
  // every shift the restaurant has ever worked — hundreds of PDF renders — and would
  // then push each one at the group as if it had just happened.
  if (shiftColNames && !shiftColNames.includes('report_exported_at')) {
    log.info('[DB] Running migration: adding report_exported_at to shifts')
    database.exec(`ALTER TABLE shifts ADD COLUMN report_exported_at TEXT;`)
    const backfilled = database.prepare(
      `UPDATE shifts SET report_exported_at = ended_at WHERE ended_at IS NOT NULL`
    ).run()
    if (backfilled.changes > 0) {
      log.info(`[DB] Marked ${backfilled.changes} past shift(s) as already exported`)
    }
  }

  // workers.daily_wage — daily staff are paid per day worked
  const workerColNames = columnsOf('workers')
  if (workerColNames && !workerColNames.includes('daily_wage')) {
    log.info('[DB] Running migration: adding daily_wage to workers')
    database.exec(`ALTER TABLE workers ADD COLUMN daily_wage REAL NOT NULL DEFAULT 0;`)
  }
  // workers.default_shift — which shift a chef or helper normally works
  if (workerColNames && !workerColNames.includes('default_shift')) {
    log.info('[DB] Running migration: adding default_shift to workers')
    database.exec(`ALTER TABLE workers ADD COLUMN default_shift INTEGER;`)
  }

  /**
   * printers.role gained 'counter' — the station that assembles and hands the order
   * over, which is neither the till nor a cook.
   *
   * SQLite cannot ALTER a CHECK constraint, so widening the allowed values means
   * rebuilding the table. `CREATE TABLE IF NOT EXISTS` in schema.sql is a no-op on an
   * existing database, so without this a till that has already run once would reject
   * a counter printer with a bare constraint error.
   */
  const printersSchema = database.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='printers'"
  ).get() as { sql: string } | undefined

  if (printersSchema && !printersSchema.sql.includes("'counter'")) {
    log.info("[DB] Running migration: widening printers.role to allow 'counter'")
    database.exec(`
      PRAGMA foreign_keys=OFF;
      BEGIN TRANSACTION;
      CREATE TABLE printers_new (
          printer_id    INTEGER PRIMARY KEY AUTOINCREMENT,
          name          TEXT NOT NULL,
          role          TEXT NOT NULL DEFAULT 'receipt' CHECK (role IN ('receipt','counter','kitchen','bar','delivery')),
          connection    TEXT NOT NULL DEFAULT 'windows_raw' CHECK (connection IN ('windows_raw','windows_driver','network')),
          device_name   TEXT,
          host          TEXT,
          port          INTEGER NOT NULL DEFAULT 9100,
          paper_width   INTEGER NOT NULL DEFAULT 80 CHECK (paper_width IN (58, 80)),
          copies        INTEGER NOT NULL DEFAULT 1 CHECK (copies BETWEEN 1 AND 5),
          cut_paper     INTEGER NOT NULL DEFAULT 1,
          open_drawer   INTEGER NOT NULL DEFAULT 0,
          category_ids  TEXT,
          auto_print    INTEGER NOT NULL DEFAULT 1,
          is_active     INTEGER NOT NULL DEFAULT 1,
          display_order INTEGER NOT NULL DEFAULT 0,
          created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
      );
      INSERT INTO printers_new
        SELECT printer_id, name, role, connection, device_name, host, port, paper_width,
               copies, cut_paper, open_drawer, category_ids, auto_print, is_active,
               display_order, created_at
        FROM printers;
      DROP TABLE printers;
      ALTER TABLE printers_new RENAME TO printers;
      COMMIT;
      PRAGMA foreign_keys=ON;
    `)
    // DROP TABLE took the index with it — put it back.
    database.exec(
      `CREATE INDEX IF NOT EXISTS idx_printers_active ON printers(is_active, display_order);`
    )
  }

  // menu_items.inherit_category_variants — whether an item is asked its category's
  // questions. On by default, which is what every existing item wants.
  const miCols = columnsOf('menu_items')
  if (miCols && !miCols.includes('inherit_category_variants')) {
    log.info('[DB] Running migration: adding inherit_category_variants to menu_items')
    database.exec(
      `ALTER TABLE menu_items ADD COLUMN inherit_category_variants INTEGER NOT NULL DEFAULT 1;`
    )
  }

  // Variant groups and their options gained an explicit order. Without it they came
  // back in insertion order, so a size group could offer كبير before صغير — which on
  // a touch screen a cashier reaches for without reading.
  //
  // This MUST stay ahead of the category rebuild below, which copies display_order
  // across by name. Run the other way round, a database old enough to need both
  // migrations dies on startup with "no such column: display_order" — the rebuild
  // reads a column that this block has not added yet.
  const vgCols = columnsOf('item_variant_groups')
  if (vgCols && !vgCols.includes('display_order')) {
    log.info('[DB] Running migration: adding display_order to item_variant_groups')
    database.exec(`ALTER TABLE item_variant_groups ADD COLUMN display_order INTEGER NOT NULL DEFAULT 0;`)
  }
  const voCols = columnsOf('item_variant_options')
  if (voCols && !voCols.includes('display_order')) {
    log.info('[DB] Running migration: adding display_order to item_variant_options')
    database.exec(`ALTER TABLE item_variant_options ADD COLUMN display_order INTEGER NOT NULL DEFAULT 0;`)
  }

  /**
   * Variant groups moved from "always belongs to one item" to "belongs to one item OR
   * one category", so "chicken asks spicy" can be said once instead of on every
   * chicken item.
   *
   * menu_item_id has to stop being NOT NULL and category_id has to appear, neither of
   * which SQLite can do with ALTER — so the table is rebuilt. Existing rows are all
   * item-level and carry across untouched, keeping their ids, which matters because
   * the options table points at them.
   */
  const vgSchema = database.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='item_variant_groups'"
  ).get() as { sql: string } | undefined

  if (vgSchema && !vgSchema.sql.includes('category_id')) {
    log.info('[DB] Running migration: variant groups can now belong to a category')
    database.exec(`
      PRAGMA foreign_keys=OFF;
      BEGIN TRANSACTION;
      CREATE TABLE item_variant_groups_new (
          variant_group_id INTEGER PRIMARY KEY AUTOINCREMENT,
          menu_item_id     INTEGER REFERENCES menu_items(item_id),
          category_id      INTEGER REFERENCES categories(category_id),
          group_name       TEXT NOT NULL,
          display_order    INTEGER NOT NULL DEFAULT 0,
          CHECK ((menu_item_id IS NULL) <> (category_id IS NULL))
      );
      INSERT INTO item_variant_groups_new
            (variant_group_id, menu_item_id, category_id, group_name, display_order)
        SELECT variant_group_id, menu_item_id, NULL, group_name, display_order
        FROM item_variant_groups;
      DROP TABLE item_variant_groups;
      ALTER TABLE item_variant_groups_new RENAME TO item_variant_groups;
      COMMIT;
      PRAGMA foreign_keys=ON;
    `)
  }

  if (tableExists('item_variant_groups')) {
    database.exec(`
      CREATE INDEX IF NOT EXISTS idx_variant_groups_item ON item_variant_groups(menu_item_id);
      CREATE INDEX IF NOT EXISTS idx_variant_groups_cat ON item_variant_groups(category_id);
    `)
  }

  // printers.station — which machine a printer is plugged into, once two tills share
  // one database. Existing rows default to 'any', which is right for a network
  // printer and right for a single-machine till; only a USB printer moved onto a node
  // needs changing, and the owner does that from the settings screen.
  const printerCols = columnsOf('printers')
  if (printerCols && !printerCols.includes('station')) {
    log.info('[DB] Running migration: adding station to printers')
    database.exec(`ALTER TABLE printers ADD COLUMN station TEXT NOT NULL DEFAULT 'any';`)
  }

  /*
    menu_items.baseline_cost — what the dish was costed at when the menu was priced.
    Seeded from cost_price, because on a database that predates this column the cost
    sitting there IS the sheet's figure: it is what the import wrote and what nothing
    has replaced yet. Doing it now, before the store is priced up and the recipe cost
    takes over, is the only moment that number is still recoverable.
  */
  const miBaselineCols = columnsOf('menu_items')
  if (miBaselineCols && !miBaselineCols.includes('baseline_cost')) {
    log.info('[DB] Running migration: adding baseline_cost to menu_items')
    database.exec(`
      ALTER TABLE menu_items ADD COLUMN baseline_cost REAL NOT NULL DEFAULT 0;
      UPDATE menu_items SET baseline_cost = cost_price WHERE cost_price > 0;
    `)
  }

  // menu_items.display_order — where an item sits on the POS grid within its
  // category. Everything starts at 0, which keeps the existing alphabetical order
  // until the owner arranges it: ties fall back to the name.
  const miOrderCols = columnsOf('menu_items')
  if (miOrderCols && !miOrderCols.includes('display_order')) {
    log.info('[DB] Running migration: adding display_order to menu_items')
    database.exec(`ALTER TABLE menu_items ADD COLUMN display_order INTEGER NOT NULL DEFAULT 0;`)
  }

  // printers.beep — sound the buzzer when a ticket lands, for a kitchen that cannot
  // see the printer. Added as 0 for every existing printer rather than switched on for
  // the kitchen ones: the command is a Xinye extension and a printer without a beeper
  // may print it as characters, which is not something to discover on a live service.
  // The owner turns it on per printer, with a test button beside the checkbox.
  const printerBeepCols = columnsOf('printers')
  if (printerBeepCols && !printerBeepCols.includes('beep')) {
    log.info('[DB] Running migration: adding beep to printers')
    database.exec(`ALTER TABLE printers ADD COLUMN beep INTEGER NOT NULL DEFAULT 0;`)
  }

  // categories.printer_id — the prep printer a category prints on, picked on the
  // categories screen. Existing categories come in as NULL, which keeps routing exactly
  // as the printers' own category lists already had it.
  const catPrinterCols = columnsOf('categories')
  if (catPrinterCols && !catPrinterCols.includes('printer_id')) {
    log.info('[DB] Running migration: adding printer_id to categories')
    database.exec(`ALTER TABLE categories ADD COLUMN printer_id INTEGER;`)
  }

  // worker_attendance.shift_number — the shift actually worked that day
  const attCols = columnsOf('worker_attendance')
  if (attCols && !attCols.includes('shift_number')) {
    log.info('[DB] Running migration: adding shift_number to worker_attendance')
    database.exec(`ALTER TABLE worker_attendance ADD COLUMN shift_number INTEGER;`)
  }

  addPackagingMaterials(database)

  // orders: add the non-negative money CHECK constraints to databases created
  // before they existed. SQLite cannot ALTER a CHECK, so the table is rebuilt.
  migrateOrdersMoneyChecks(database)

  /**
   * Indexes on `orders` columns that only exist after the ALTERs above.
   *
   * They cannot live in schema.sql, which runs first: on an existing database
   * `CREATE TABLE IF NOT EXISTS` is a no-op, so the column is not there yet and the
   * index fails — taking the whole startup with it, before the migration that would
   * have added it ever runs. Same reason as idx_users_slot.
   *
   * And they go AFTER the rebuild above, not before: rebuilding the table drops every
   * index on it, so creating them earlier would silently lose them again.
   */
  // orders.notes — a free-text line for the kitchen or the counter. Added AFTER the
  // rebuild above, not before: that rebuild copies a fixed column list, so a column
  // introduced ahead of it would be silently dropped along with everything in it.
  if (tableExists('orders') && !columnsOf('orders')!.includes('notes')) {
    log.info('[DB] Running migration: adding notes to orders')
    database.exec(`ALTER TABLE orders ADD COLUMN notes TEXT;`)
  }

  addDeliveryTracking(database, tableExists, columnsOf)
  // After the columns exist, and after the money rebuild that would have dropped
  // them — this one rebuilds the table again to widen a CHECK the first version of
  // the delivery centre was too narrow about.
  migrateDeliveryStatusCheck(database, tableExists, columnsOf)

  if (tableExists('orders')) {
    database.exec(`
      CREATE INDEX IF NOT EXISTS idx_orders_order_type ON orders(order_type);
      CREATE INDEX IF NOT EXISTS idx_orders_deleted_at ON orders(deleted_at);
    `)
  }

  // stock_transactions: SQLite cannot ALTER a CHECK constraint, so widening the
  // allowed `reason` values means rebuilding the table. Voids are logged as 'void'
  // (previously 'adjustment'), which an older CHECK would reject at insert time.
  const stSchema = database.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='stock_transactions'"
  ).get() as { sql: string } | undefined

  if (stSchema && !stSchema.sql.includes("'void'")) {
    log.info('[DB] Running migration: widening stock_transactions.reason to allow void')
    database.exec(`
      PRAGMA foreign_keys=OFF;
      BEGIN TRANSACTION;
      CREATE TABLE stock_transactions_new (
          stock_txn_id      INTEGER PRIMARY KEY AUTOINCREMENT,
          menu_item_id      INTEGER NOT NULL REFERENCES menu_items(item_id),
          change_amount     REAL NOT NULL,
          reason            TEXT NOT NULL CHECK (reason IN ('sale','restock','waste','adjustment','conversion','void')),
          related_order_id  INTEGER REFERENCES orders(order_id),
          created_by        INTEGER NOT NULL REFERENCES users(user_id),
          created_at        TEXT NOT NULL DEFAULT (datetime('now','localtime'))
      );
      INSERT INTO stock_transactions_new
        SELECT stock_txn_id, menu_item_id, change_amount, reason, related_order_id, created_by, created_at
        FROM stock_transactions;
      DROP TABLE stock_transactions;
      ALTER TABLE stock_transactions_new RENAME TO stock_transactions;
      COMMIT;
      PRAGMA foreign_keys=ON;
    `)
    // DROP TABLE took the indexes with it — put them back.
    database.exec(`
      CREATE INDEX IF NOT EXISTS idx_stock_txn_menu_item  ON stock_transactions(menu_item_id);
      CREATE INDEX IF NOT EXISTS idx_stock_txn_created_at ON stock_transactions(created_at);
    `)
  }

  // Check if users table supports 'accountant' role
  const usersSchema = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get() as { sql: string }
  if (usersSchema && !usersSchema.sql.includes("'accountant'")) {
    log.info('[DB] Running migration: rebuilding users table to support accountant role')
    database.exec(`
      PRAGMA foreign_keys=OFF;
      BEGIN TRANSACTION;
      CREATE TABLE users_new (
          user_id       INTEGER PRIMARY KEY AUTOINCREMENT,
          username      TEXT NOT NULL UNIQUE,
          pin_hash      TEXT,
          password_hash TEXT NOT NULL,
          role          TEXT NOT NULL CHECK (role IN ('cashier','owner','accountant')),
          full_name     TEXT NOT NULL,
          is_active     INTEGER NOT NULL DEFAULT 1,
          created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
      );
      INSERT INTO users_new SELECT * FROM users;
      DROP TABLE users;
      ALTER TABLE users_new RENAME TO users;
      COMMIT;
      PRAGMA foreign_keys=ON;
    `)
  }
}

/** Columns copied when rebuilding `orders`. Named explicitly so a future column
 *  added to schema.sql cannot silently shift a positional `SELECT *` copy. */
const ORDERS_COLUMNS = [
  'order_id', 'cashier_id', 'subtotal', 'tax', 'discount', 'total_amount',
  'payment_type', 'status', 'voided_by', 'void_reason', 'order_type',
  'customer_name', 'customer_phone', 'customer_address', 'delivery_area_id',
  'delivery_fee', 'driver_id', 'deleted_at', 'deleted_by', 'invoice_number',
  'created_at',
].join(', ')

const NEGATIVE_MONEY_PREDICATE = `
  subtotal < 0 OR tax < 0 OR discount < 0 OR total_amount < 0
  OR COALESCE(delivery_fee, 0) < 0
`

/**
 * Rebuild `orders` with CHECK (… >= 0) on every money column.
 *
 * Databases created before those constraints existed may contain rows that
 * violate them — the old code inserted whatever total the renderer sent, negatives
 * included. `INSERT INTO … SELECT` enforces CHECKs, so such a row would abort the
 * copy. Rather than rewrite or discard somebody's order history to force the
 * migration through, this detects violations, logs the offending order numbers,
 * and leaves the table alone. The app is still protected either way: createOrder
 * computes and validates every figure in the main process.
 */
/**
 * Give an existing till the delivery centre's bookkeeping.
 *
 * Two things that were never recorded before: where a delivery order got to, and
 * whether the driver has handed over the cash he collected for it.
 *
 * Every order already in the database is left with `delivery_status` NULL rather
 * than being back-filled as 'delivered'. Nobody watched those orders go out, so
 * claiming they were delivered would be inventing a fact; and back-filling them as
 * outstanding would open the new screen with months of imaginary debt against
 * drivers who settled up long ago. NULL reads as "from before this was tracked",
 * which is the only true answer, and the screen shows those separately.
 *
 * Runs AFTER migrateOrdersMoneyChecks for the same reason `notes` does: that rebuild
 * copies a fixed column list, so a column added ahead of it is silently dropped.
 */
function addDeliveryTracking(
  database: Database.Database,
  tableExists: (name: string) => boolean,
  columnsOf: (name: string) => string[] | null,
): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS driver_settlements (
        settlement_id INTEGER PRIMARY KEY AUTOINCREMENT,
        driver_id     INTEGER NOT NULL REFERENCES delivery_drivers(driver_id),
        order_count   INTEGER NOT NULL CHECK (order_count > 0),
        total_amount  REAL NOT NULL CHECK (total_amount >= 0),
        note          TEXT,
        settled_by    INTEGER NOT NULL REFERENCES users(user_id),
        settled_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_settlements_driver ON driver_settlements(driver_id);
  `)

  if (!tableExists('orders')) return
  const cols = columnsOf('orders')!

  // One ALTER each, guarded separately: a till that has had a half-finished upgrade
  // must be able to pick up whichever columns it is missing.
  if (!cols.includes('delivery_status')) {
    log.info('[DB] Running migration: adding delivery tracking to orders')
    database.exec(
      `ALTER TABLE orders ADD COLUMN delivery_status TEXT
         CHECK (delivery_status IN ('preparing','pending','out','delivered','returned'));`
    )
  }
  if (!cols.includes('dispatched_at')) {
    database.exec(`ALTER TABLE orders ADD COLUMN dispatched_at TEXT;`)
  }
  if (!cols.includes('delivered_at')) {
    database.exec(`ALTER TABLE orders ADD COLUMN delivered_at TEXT;`)
  }
  if (!cols.includes('settlement_id')) {
    database.exec(
      `ALTER TABLE orders ADD COLUMN settlement_id INTEGER REFERENCES driver_settlements(settlement_id);`
    )
  }

  // The two questions the delivery screen asks constantly: what is still out, and
  // what has this driver not paid in yet.
  database.exec(DELIVERY_INDEXES)
}

/** Every index on `orders`. Named once, because a rebuild drops the lot. */
const ORDERS_INDEXES = `
  CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at);
  CREATE INDEX IF NOT EXISTS idx_orders_status     ON orders(status);
  CREATE INDEX IF NOT EXISTS idx_orders_cashier_id ON orders(cashier_id);
  CREATE INDEX IF NOT EXISTS idx_orders_order_type ON orders(order_type);
  CREATE INDEX IF NOT EXISTS idx_orders_deleted_at ON orders(deleted_at);
`

const DELIVERY_INDEXES = `
  CREATE INDEX IF NOT EXISTS idx_orders_delivery_status ON orders(delivery_status);
  CREATE INDEX IF NOT EXISTS idx_orders_driver_settlement ON orders(driver_id, settlement_id);
`

/**
 * The `orders` table as it should look now — used to rebuild it when a CHECK has to
 * change, which is the only way SQLite will accept one.
 */
const ORDERS_TABLE_DDL = `
  CREATE TABLE orders_new (
      order_id         INTEGER PRIMARY KEY AUTOINCREMENT,
      cashier_id       INTEGER NOT NULL REFERENCES users(user_id),
      subtotal         REAL NOT NULL CHECK (subtotal >= 0),
      tax              REAL NOT NULL DEFAULT 0 CHECK (tax >= 0),
      discount         REAL NOT NULL DEFAULT 0 CHECK (discount >= 0),
      total_amount     REAL NOT NULL CHECK (total_amount >= 0),
      payment_type     TEXT NOT NULL CHECK (payment_type IN ('cash','card')),
      status           TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed','voided')),
      voided_by        INTEGER REFERENCES users(user_id),
      void_reason      TEXT,
      order_type       TEXT NOT NULL DEFAULT 'dine_in' CHECK (order_type IN ('dine_in','takeaway','delivery')),
      customer_name    TEXT,
      customer_phone   TEXT,
      customer_address TEXT,
      delivery_area_id INTEGER REFERENCES delivery_areas(delivery_area_id),
      delivery_fee     REAL DEFAULT 0 CHECK (delivery_fee >= 0),
      driver_id        INTEGER REFERENCES delivery_drivers(driver_id),
      delivery_status  TEXT CHECK (delivery_status IN ('preparing','pending','out','delivered','returned')),
      dispatched_at    TEXT,
      delivered_at     TEXT,
      settlement_id    INTEGER REFERENCES driver_settlements(settlement_id),
      deleted_at       TEXT,
      deleted_by       INTEGER REFERENCES users(user_id),
      invoice_number   TEXT,
      notes            TEXT,
      created_at       TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );
`

/** The columns that rebuild knows how to carry across. */
const ORDERS_FULL_COLUMNS = [
  'order_id', 'cashier_id', 'subtotal', 'tax', 'discount', 'total_amount',
  'payment_type', 'status', 'voided_by', 'void_reason', 'order_type',
  'customer_name', 'customer_phone', 'customer_address', 'delivery_area_id',
  'delivery_fee', 'driver_id', 'delivery_status', 'dispatched_at', 'delivered_at',
  'settlement_id', 'deleted_at', 'deleted_by', 'invoice_number', 'notes', 'created_at',
]

/**
 * Widen `delivery_status` so it also allows 'preparing'.
 *
 * The first delivery centre had four states and started an order at 'pending' —
 * waiting for a driver — which quietly claimed the food was ready the moment the
 * invoice printed. It is not; it is with the kitchen. 'preparing' is that missing
 * first state, and without it the app cannot write one: the CHECK rejects the value.
 *
 * SQLite cannot ALTER a CHECK, so the table is rebuilt, exactly as the money-
 * constraint migration below does. Only columns that actually exist are copied, so a
 * till that skipped a version and has no `notes` still migrates rather than failing
 * on a column the SELECT names.
 */
function migrateDeliveryStatusCheck(
  database: Database.Database,
  tableExists: (name: string) => boolean,
  columnsOf: (name: string) => string[] | null,
): void {
  if (!tableExists('orders')) return

  const schema = (database.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='orders'"
  ).get() as { sql: string } | undefined)?.sql
  if (!schema) return

  // Nothing to widen if the column is not there, and nothing to do if the CHECK
  // already allows the new value (or there is no CHECK to fight with).
  if (!schema.includes('delivery_status')) return
  if (schema.includes("'preparing'") || !schema.includes("delivery_status IN")) return

  log.info("[DB] Running migration: allowing 'preparing' as a delivery status")

  const present = new Set(columnsOf('orders') ?? [])
  const carried = ORDERS_FULL_COLUMNS.filter(c => present.has(c)).join(', ')

  database.exec(`
    PRAGMA foreign_keys=OFF;
    BEGIN TRANSACTION;
    ${ORDERS_TABLE_DDL}
    INSERT INTO orders_new (${carried}) SELECT ${carried} FROM orders;
    DROP TABLE orders;
    ALTER TABLE orders_new RENAME TO orders;
    COMMIT;
    PRAGMA foreign_keys=ON;
  `)

  // DROP TABLE took every index with it.
  database.exec(ORDERS_INDEXES + DELIVERY_INDEXES)

  const violations = database.pragma('foreign_key_check') as unknown[]
  if (violations.length > 0) {
    log.error(`[DB] delivery_status migration left ${violations.length} foreign-key violation(s)`, violations)
  } else {
    log.info('[DB] delivery_status migration complete — foreign keys intact')
  }
}

function migrateOrdersMoneyChecks(database: Database.Database): void {
  const schema = database.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='orders'"
  ).get() as { sql: string } | undefined

  if (!schema || schema.sql.includes('total_amount >= 0')) return // absent or already migrated

  const bad = database.prepare(
    `SELECT order_id FROM orders WHERE ${NEGATIVE_MONEY_PREDICATE} ORDER BY order_id LIMIT 20`
  ).all() as { order_id: number }[]

  if (bad.length > 0) {
    const total = (database.prepare(
      `SELECT COUNT(*) AS c FROM orders WHERE ${NEGATIVE_MONEY_PREDICATE}`
    ).get() as { c: number }).c
    log.error(
      `[DB] SKIPPING orders CHECK migration — ${total} existing order(s) have negative money ` +
      `values and would be rejected by the new constraints. Order IDs (first 20): ` +
      `${bad.map(r => r.order_id).join(', ')}. Review or void these rows, then restart to migrate. ` +
      `New orders are validated in the main process regardless.`
    )
    return
  }

  log.info('[DB] Running migration: adding non-negative money constraints to orders')
  database.exec(`
    PRAGMA foreign_keys=OFF;
    BEGIN TRANSACTION;
    CREATE TABLE orders_new (
        order_id         INTEGER PRIMARY KEY AUTOINCREMENT,
        cashier_id       INTEGER NOT NULL REFERENCES users(user_id),
        subtotal         REAL NOT NULL CHECK (subtotal >= 0),
        tax              REAL NOT NULL DEFAULT 0 CHECK (tax >= 0),
        discount         REAL NOT NULL DEFAULT 0 CHECK (discount >= 0),
        total_amount     REAL NOT NULL CHECK (total_amount >= 0),
        payment_type     TEXT NOT NULL CHECK (payment_type IN ('cash','card')),
        status           TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed','voided')),
        voided_by        INTEGER REFERENCES users(user_id),
        void_reason      TEXT,
        order_type       TEXT NOT NULL DEFAULT 'dine_in' CHECK (order_type IN ('dine_in','takeaway','delivery')),
        customer_name    TEXT,
        customer_phone   TEXT,
        customer_address TEXT,
        delivery_area_id INTEGER REFERENCES delivery_areas(delivery_area_id),
        delivery_fee     REAL DEFAULT 0 CHECK (delivery_fee >= 0),
        driver_id        INTEGER REFERENCES delivery_drivers(driver_id),
        deleted_at       TEXT,
        deleted_by       INTEGER REFERENCES users(user_id),
        invoice_number   TEXT,
        created_at       TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    INSERT INTO orders_new (${ORDERS_COLUMNS}) SELECT ${ORDERS_COLUMNS} FROM orders;
    DROP TABLE orders;
    ALTER TABLE orders_new RENAME TO orders;
    COMMIT;
    PRAGMA foreign_keys=ON;
  `)

  // DROP TABLE took the orders indexes with it — put ALL of them back. The rebuilt
  // table has every column, so order_type and deleted_at can be indexed here too.
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at);
    CREATE INDEX IF NOT EXISTS idx_orders_status     ON orders(status);
    CREATE INDEX IF NOT EXISTS idx_orders_cashier_id ON orders(cashier_id);
    CREATE INDEX IF NOT EXISTS idx_orders_order_type ON orders(order_type);
    CREATE INDEX IF NOT EXISTS idx_orders_deleted_at ON orders(deleted_at);
  `)

  const violations = database.pragma('foreign_key_check') as unknown[]
  if (violations.length > 0) {
    log.error(`[DB] orders migration left ${violations.length} foreign-key violation(s)`, violations)
  } else {
    log.info('[DB] orders migration complete — foreign keys intact')
  }
}

function getEmbeddedSchema(): string {
  return `
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT OR IGNORE INTO settings (key, value) VALUES
      ('tax_rate', '0.14'), ('currency_symbol', 'ج.م'), ('business_name', 'Crispo Fried Chicken'),
      ('business_address', ''), ('business_phone', ''),
      ('receipt_footer', 'شكراً لزيارتكم! بالهناء والشفاء ❤️'), ('max_cashier_discount', '10'), ('backup_folder', ''),
      ('invoice_seq', '0'), ('invoice_start', '1'),
      ('shifts_per_day', '2'),
      ('shift1_name', 'صباحية'), ('shift1_start', '09:00'), ('shift1_end', '17:00'),
      ('shift2_name', 'مسائية'), ('shift2_start', '17:00'), ('shift2_end', '01:00'),
      ('print_auto', '1'), ('print_logo', '1'), ('print_feed_lines', '2'), ('print_font_scale', '100'),
      ('net_mode', 'standalone'), ('net_port', '47615'), ('net_token', ''),
      ('net_fleet_id', ''), ('net_master_name', ''), ('net_tills', '[]'),
      ('net_locked', '0'), ('net_lock_reason', ''),
      ('backup_hour', '3'), ('backup_last_daily', ''),
      ('shift_export_auto', '1'), ('shift_export_folder', ''), ('whatsapp_group', '');
    CREATE TABLE IF NOT EXISTS users (
      user_id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, pin_hash TEXT,
      password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('cashier','owner','accountant')),
      slot TEXT CHECK (slot IN ('cashier1','cashier2','owner','accountant')),
      full_name TEXT NOT NULL, is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS categories (
      category_id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, display_order INTEGER NOT NULL DEFAULT 0,
      printer_id INTEGER
    );
    CREATE TABLE IF NOT EXISTS menu_items (
      item_id INTEGER PRIMARY KEY AUTOINCREMENT, category_id INTEGER NOT NULL REFERENCES categories(category_id),
      name TEXT NOT NULL, price REAL NOT NULL CHECK (price >= 0), cost_price REAL NOT NULL DEFAULT 0 CHECK (cost_price >= 0),
      baseline_cost REAL NOT NULL DEFAULT 0 CHECK (baseline_cost >= 0),
      description TEXT, image_path TEXT, is_active INTEGER NOT NULL DEFAULT 1, stock_quantity INTEGER NOT NULL DEFAULT 0,
      inherit_category_variants INTEGER NOT NULL DEFAULT 1,
      display_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')), updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS delivery_areas (
      delivery_area_id INTEGER PRIMARY KEY AUTOINCREMENT, area_name TEXT NOT NULL,
      delivery_fee REAL NOT NULL CHECK (delivery_fee >= 0), is_active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS delivery_drivers (
      driver_id INTEGER PRIMARY KEY AUTOINCREMENT, full_name TEXT NOT NULL, phone TEXT, is_active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS driver_settlements (
      settlement_id INTEGER PRIMARY KEY AUTOINCREMENT,
      driver_id INTEGER NOT NULL REFERENCES delivery_drivers(driver_id),
      order_count INTEGER NOT NULL CHECK (order_count > 0),
      total_amount REAL NOT NULL CHECK (total_amount >= 0),
      note TEXT, settled_by INTEGER NOT NULL REFERENCES users(user_id),
      settled_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_settlements_driver ON driver_settlements(driver_id);
    CREATE TABLE IF NOT EXISTS orders (
      order_id INTEGER PRIMARY KEY AUTOINCREMENT, cashier_id INTEGER NOT NULL REFERENCES users(user_id),
      subtotal REAL NOT NULL CHECK (subtotal >= 0), tax REAL NOT NULL DEFAULT 0 CHECK (tax >= 0),
      discount REAL NOT NULL DEFAULT 0 CHECK (discount >= 0), total_amount REAL NOT NULL CHECK (total_amount >= 0),
      payment_type TEXT NOT NULL CHECK (payment_type IN ('cash','card')),
      status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed','voided')),
      voided_by INTEGER REFERENCES users(user_id), void_reason TEXT,
      order_type TEXT NOT NULL DEFAULT 'dine_in' CHECK (order_type IN ('dine_in','takeaway','delivery')),
      customer_name TEXT, customer_phone TEXT, customer_address TEXT,
      delivery_area_id INTEGER REFERENCES delivery_areas(delivery_area_id),
      delivery_fee REAL DEFAULT 0 CHECK (delivery_fee >= 0), driver_id INTEGER REFERENCES delivery_drivers(driver_id),
      delivery_status TEXT CHECK (delivery_status IN ('preparing','pending','out','delivered','returned')),
      dispatched_at TEXT, delivered_at TEXT,
      settlement_id INTEGER REFERENCES driver_settlements(settlement_id),
      deleted_at TEXT, deleted_by INTEGER REFERENCES users(user_id), invoice_number TEXT, notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS order_items (
      order_item_id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL REFERENCES orders(order_id),
      menu_item_id INTEGER NOT NULL REFERENCES menu_items(item_id), quantity INTEGER NOT NULL CHECK (quantity > 0),
      unit_price REAL NOT NULL, unit_cost REAL NOT NULL DEFAULT 0, variant_label TEXT
    );
    CREATE TABLE IF NOT EXISTS stock_transactions (
      stock_txn_id INTEGER PRIMARY KEY AUTOINCREMENT, menu_item_id INTEGER NOT NULL REFERENCES menu_items(item_id),
      change_amount REAL NOT NULL, reason TEXT NOT NULL CHECK (reason IN ('sale','restock','waste','adjustment','conversion','void')),
      related_order_id INTEGER REFERENCES orders(order_id), created_by INTEGER NOT NULL REFERENCES users(user_id),
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS stock_conversions (
      conversion_id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_inventory_id INTEGER NOT NULL REFERENCES menu_items(item_id),
      output_inventory_id INTEGER NOT NULL REFERENCES menu_items(item_id),
      yield_quantity REAL NOT NULL CHECK (yield_quantity > 0)
    );
    CREATE TABLE IF NOT EXISTS raw_materials (
      raw_material_id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
      unit TEXT NOT NULL DEFAULT 'قطعة', stock_quantity REAL NOT NULL DEFAULT 0,
      cost_per_unit REAL NOT NULL DEFAULT 0 CHECK (cost_per_unit >= 0),
      low_stock_threshold REAL NOT NULL DEFAULT 5, is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS recipe_items (
      recipe_item_id INTEGER PRIMARY KEY AUTOINCREMENT,
      menu_item_id INTEGER NOT NULL REFERENCES menu_items(item_id),
      raw_material_id INTEGER NOT NULL REFERENCES raw_materials(raw_material_id),
      quantity REAL NOT NULL CHECK (quantity > 0), UNIQUE(menu_item_id, raw_material_id)
    );
    CREATE TABLE IF NOT EXISTS raw_material_transactions (
      rm_txn_id INTEGER PRIMARY KEY AUTOINCREMENT,
      raw_material_id INTEGER NOT NULL REFERENCES raw_materials(raw_material_id),
      change_amount REAL NOT NULL,
      reason TEXT NOT NULL CHECK (reason IN ('sale','restock','waste','adjustment','prep_out','prep_in','void')),
      related_order_id INTEGER REFERENCES orders(order_id), created_by INTEGER NOT NULL REFERENCES users(user_id),
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS prep_conversions (
      prep_conversion_id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_material_id INTEGER NOT NULL REFERENCES raw_materials(raw_material_id),
      output_material_id INTEGER NOT NULL REFERENCES raw_materials(raw_material_id),
      yield_quantity REAL NOT NULL CHECK (yield_quantity > 0),
      UNIQUE(source_material_id, output_material_id)
    );
    CREATE TABLE IF NOT EXISTS workers (
      worker_id INTEGER PRIMARY KEY AUTOINCREMENT, full_name TEXT NOT NULL, role_title TEXT,
      daily_wage REAL NOT NULL DEFAULT 0 CHECK (daily_wage >= 0),
      default_shift INTEGER CHECK (default_shift IN (1, 2)),
      is_active INTEGER NOT NULL DEFAULT 1, linked_user_id INTEGER REFERENCES users(user_id)
    );
    CREATE TABLE IF NOT EXISTS worker_attendance (
      attendance_id INTEGER PRIMARY KEY AUTOINCREMENT, worker_id INTEGER NOT NULL REFERENCES workers(worker_id),
      work_date TEXT NOT NULL, shift_number INTEGER CHECK (shift_number IN (1, 2)),
      created_by INTEGER NOT NULL REFERENCES users(user_id),
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')), UNIQUE(worker_id, work_date)
    );
    CREATE TABLE IF NOT EXISTS expenses (
      expense_id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL CHECK (category IN ('ingredients','utilities','maintenance','delivery','other')),
      description TEXT, amount REAL NOT NULL CHECK (amount >= 0),
      recorded_by INTEGER NOT NULL REFERENCES users(user_id),
      expense_date TEXT NOT NULL DEFAULT (date('now','localtime')),
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS salaries (
      salary_id INTEGER PRIMARY KEY AUTOINCREMENT, worker_id INTEGER NOT NULL REFERENCES workers(worker_id),
      amount REAL NOT NULL CHECK (amount >= 0), pay_period_start TEXT NOT NULL, pay_period_end TEXT NOT NULL,
      paid_on TEXT, created_by INTEGER NOT NULL REFERENCES users(user_id),
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS shifts (
      shift_id INTEGER PRIMARY KEY AUTOINCREMENT, cashier_id INTEGER NOT NULL REFERENCES users(user_id),
      shift_date TEXT NOT NULL, shift_number INTEGER NOT NULL DEFAULT 1 CHECK (shift_number IN (1, 2)),
      start_time TEXT, end_time TEXT, started_at TEXT, ended_at TEXT,
      report_exported_at TEXT,
      set_by INTEGER NOT NULL REFERENCES users(user_id),
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS work_shifts (
      work_shift_id INTEGER PRIMARY KEY AUTOINCREMENT,
      shift_number INTEGER NOT NULL DEFAULT 1,
      opened_at TEXT NOT NULL, closed_at TEXT,
      opened_by INTEGER REFERENCES users(user_id),
      report_exported_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_work_shifts_opened ON work_shifts(opened_at);
    CREATE TABLE IF NOT EXISTS customers (
      phone TEXT PRIMARY KEY, name TEXT, address TEXT,
      delivery_area_id INTEGER REFERENCES delivery_areas(delivery_area_id),
      prior_orders INTEGER NOT NULL DEFAULT 0, prior_spent REAL NOT NULL DEFAULT 0,
      first_order_at TEXT, last_order_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS item_variant_groups (
      variant_group_id INTEGER PRIMARY KEY AUTOINCREMENT,
      menu_item_id INTEGER REFERENCES menu_items(item_id),
      category_id INTEGER REFERENCES categories(category_id),
      group_name TEXT NOT NULL, display_order INTEGER NOT NULL DEFAULT 0,
      CHECK ((menu_item_id IS NULL) <> (category_id IS NULL))
    );
    CREATE INDEX IF NOT EXISTS idx_variant_groups_item ON item_variant_groups(menu_item_id);
    CREATE TABLE IF NOT EXISTS item_variant_options (
      variant_option_id INTEGER PRIMARY KEY AUTOINCREMENT,
      variant_group_id INTEGER NOT NULL REFERENCES item_variant_groups(variant_group_id),
      option_name TEXT NOT NULL, price_delta REAL NOT NULL DEFAULT 0,
      display_order INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_variant_options_group ON item_variant_options(variant_group_id);
    CREATE TABLE IF NOT EXISTS suppliers (
      supplier_id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, phone TEXT, notes TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS supplier_invoices (
      supplier_invoice_id INTEGER PRIMARY KEY AUTOINCREMENT,
      supplier_id INTEGER NOT NULL REFERENCES suppliers(supplier_id),
      invoice_date TEXT NOT NULL DEFAULT (date('now','localtime')), reference TEXT,
      total_amount REAL NOT NULL CHECK (total_amount >= 0), notes TEXT,
      created_by INTEGER NOT NULL REFERENCES users(user_id),
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_supplier_invoices_supplier ON supplier_invoices(supplier_id);
    CREATE INDEX IF NOT EXISTS idx_supplier_invoices_date ON supplier_invoices(invoice_date);
    CREATE TABLE IF NOT EXISTS supplier_invoice_items (
      supplier_invoice_item_id INTEGER PRIMARY KEY AUTOINCREMENT,
      supplier_invoice_id INTEGER NOT NULL REFERENCES supplier_invoices(supplier_invoice_id),
      raw_material_id INTEGER NOT NULL REFERENCES raw_materials(raw_material_id),
      quantity REAL NOT NULL CHECK (quantity > 0),
      unit_cost REAL NOT NULL CHECK (unit_cost >= 0),
      line_total REAL NOT NULL CHECK (line_total >= 0)
    );
    CREATE INDEX IF NOT EXISTS idx_supplier_invoice_items_inv ON supplier_invoice_items(supplier_invoice_id);
    CREATE TABLE IF NOT EXISTS supplier_payments (
      supplier_payment_id INTEGER PRIMARY KEY AUTOINCREMENT,
      supplier_id INTEGER NOT NULL REFERENCES suppliers(supplier_id),
      amount REAL NOT NULL CHECK (amount > 0),
      paid_on TEXT NOT NULL DEFAULT (date('now','localtime')),
      method TEXT NOT NULL DEFAULT 'cash' CHECK (method IN ('cash','card','transfer')),
      notes TEXT, created_by INTEGER NOT NULL REFERENCES users(user_id),
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_supplier_payments_supplier ON supplier_payments(supplier_id);
    CREATE INDEX IF NOT EXISTS idx_supplier_payments_date ON supplier_payments(paid_on);
    CREATE TABLE IF NOT EXISTS customer_notes (
      note_id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT NOT NULL, note TEXT NOT NULL,
      created_by INTEGER NOT NULL REFERENCES users(user_id),
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_customer_notes_phone ON customer_notes(phone);
    CREATE TABLE IF NOT EXISTS printers (
      printer_id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'receipt' CHECK (role IN ('receipt','counter','kitchen','bar','delivery')),
      connection TEXT NOT NULL DEFAULT 'windows_raw' CHECK (connection IN ('windows_raw','windows_driver','network')),
      device_name TEXT, host TEXT, port INTEGER NOT NULL DEFAULT 9100,
      paper_width INTEGER NOT NULL DEFAULT 80 CHECK (paper_width IN (58, 80)),
      copies INTEGER NOT NULL DEFAULT 1 CHECK (copies BETWEEN 1 AND 5),
      cut_paper INTEGER NOT NULL DEFAULT 1, open_drawer INTEGER NOT NULL DEFAULT 0,
      beep INTEGER NOT NULL DEFAULT 0,
      category_ids TEXT, station TEXT NOT NULL DEFAULT 'any', auto_print INTEGER NOT NULL DEFAULT 1,
      is_active INTEGER NOT NULL DEFAULT 1, display_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_printers_active ON printers(is_active, display_order);
    CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now','localtime')));
    CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at);
    CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
    CREATE INDEX IF NOT EXISTS idx_orders_cashier_id ON orders(cashier_id);
    CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items(order_id);
    CREATE INDEX IF NOT EXISTS idx_order_items_menu_item_id ON order_items(menu_item_id);
    CREATE INDEX IF NOT EXISTS idx_menu_items_category ON menu_items(category_id);
    CREATE INDEX IF NOT EXISTS idx_menu_items_active ON menu_items(is_active);
    CREATE INDEX IF NOT EXISTS idx_stock_txn_menu_item ON stock_transactions(menu_item_id);
    CREATE INDEX IF NOT EXISTS idx_stock_txn_created_at ON stock_transactions(created_at);
    CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(expense_date);
    CREATE INDEX IF NOT EXISTS idx_salaries_period ON salaries(pay_period_start, pay_period_end);
    CREATE INDEX IF NOT EXISTS idx_shifts_cashier_date ON shifts(cashier_id, shift_date);
    CREATE INDEX IF NOT EXISTS idx_worker_attendance_worker ON worker_attendance(worker_id, work_date);
    CREATE INDEX IF NOT EXISTS idx_recipe_items_menu_item ON recipe_items(menu_item_id);
    CREATE INDEX IF NOT EXISTS idx_recipe_items_material ON recipe_items(raw_material_id);
    CREATE INDEX IF NOT EXISTS idx_rm_txn_material ON raw_material_transactions(raw_material_id);
    CREATE INDEX IF NOT EXISTS idx_rm_txn_order ON raw_material_transactions(related_order_id);
    CREATE INDEX IF NOT EXISTS idx_rm_txn_created_at ON raw_material_transactions(created_at);
  `
}

/**
 * The connection the code currently running should use.
 *
 * Normally there is one: this machine's own `restaurant.db`. A NODE till with a
 * read-only mirror has a second, and a report being answered from that mirror must
 * reach it without every service in the app learning that mirrors exist.
 *
 * AsyncLocalStorage rather than swapping a global around the call, for the same
 * reason the session scope uses it: handlers are async, the swap would have to
 * survive an await, and a plain global would leak the mirror into whatever else ran
 * in between — which on a till means a sale written to a copy nobody will ever read.
 */
const dbScope = new AsyncLocalStorage<Database.Database>()

export function getDb(): Database.Database {
  const scoped = dbScope.getStore()
  if (scoped) return scoped
  if (!db) {
    throw new Error('Database not initialized. Call initDatabase() first.')
  }
  return db
}

// ===== The node's read-only mirror =====
//
// A node owns no books. But a node whose master has been switched off used to show
// nothing at all — no menu, no prices, no history, not even yesterday's takings —
// which makes the second till useless exactly when somebody is standing at it
// wondering what went wrong. The mirror is a copy of the master's database, pushed
// down the link and refreshed while the link is up, that the node may READ when the
// master is away. It is never written to and never merged back.

export function getMirrorPath(): string {
  return path.join(getDataDirectory(), 'mirror.db')
}

let mirror: Database.Database | null = null

export function hasMirror(): boolean {
  return fs.existsSync(getMirrorPath())
}

/** When the mirror was last refreshed, or null if there has never been one. */
export function mirrorAge(): { at: number; bytes: number } | null {
  try {
    const st = fs.statSync(getMirrorPath())
    return { at: st.mtimeMs, bytes: st.size }
  } catch {
    return null
  }
}

/**
 * Put a freshly received snapshot in place.
 *
 * Written to a temp name and renamed, so a transfer cut off half way leaves the
 * previous good mirror untouched rather than replacing it with a truncated file that
 * every later read would fail on. The digest is checked before any of that.
 */
export function applyMirrorSnapshot(data: Buffer, digest: string): void {
  const actual = crypto.createHash('sha256').update(data).digest('hex')
  if (actual !== digest) {
    throw new Error('النسخة المستلمة تالفة — البصمة غير مطابقة')
  }

  const target = getMirrorPath()
  const temp = `${target}.incoming`
  fs.writeFileSync(temp, data)

  // Prove it opens and has the tables we expect before trusting it. A file that is
  // the right size and the wrong contents is the failure worth catching here.
  const probe = new Database(temp, { readonly: true, fileMustExist: true })
  try {
    probe.prepare('SELECT COUNT(*) AS n FROM settings').get()
  } finally {
    probe.close()
  }

  closeMirror()
  for (const suffix of ['-wal', '-shm']) {
    const sidecar = target + suffix
    try { if (fs.existsSync(sidecar)) fs.unlinkSync(sidecar) } catch { /* fine */ }
  }
  fs.renameSync(temp, target)
  log.info(`[DB] Mirror updated — ${(data.length / 1024 / 1024).toFixed(1)} MB`)
}

function openMirror(): Database.Database {
  if (mirror) return mirror
  mirror = new Database(getMirrorPath(), { readonly: true, fileMustExist: true })
  // A read-only handle cannot be told to use WAL, and does not need to.
  mirror.pragma('query_only = 1')
  return mirror
}

export function closeMirror(): void {
  if (!mirror) return
  try { mirror.close() } catch { /* already gone */ }
  mirror = null
}

/**
 * Run `fn` against the mirror instead of the live database.
 *
 * The handle is read-only at the SQLite level as well as by convention, so a channel
 * that was wrongly allowed offline fails loudly with "attempt to write a readonly
 * database" rather than quietly editing a copy that will never be merged.
 */
export async function runOnMirror<T>(fn: () => T | Promise<T>): Promise<T> {
  const handle = openMirror()
  return dbScope.run(handle, async () => fn())
}

/**
 * A consistent snapshot of the live database as bytes, for pushing to a node.
 *
 * Goes through SQLite's own backup API rather than reading the file, because the
 * file on disk is only half the truth while WAL mode has uncommitted pages in the
 * -wal sidecar. Copying it directly hands the node a database missing whatever was
 * rung up most recently — which is the part that matters.
 */
export async function snapshotDatabase(): Promise<Buffer> {
  const temp = path.join(getDataDirectory(), `snapshot-${Date.now()}.tmp`)
  try {
    await getDb().backup(temp)
    return fs.readFileSync(temp)
  } finally {
    try { if (fs.existsSync(temp)) fs.unlinkSync(temp) } catch { /* best effort */ }
  }
}

/**
 * Snapshot the database into `<dataDir>/backups`, keeping the newest 30.
 *
 * Pass `minIntervalHours` to skip the snapshot when a recent one already exists —
 * without it, a few restarts in a row would roll every older backup off the
 * 30-file retention window. Returns the path written, or null when skipped.
 */
export async function runBackup(opts: { minIntervalHours?: number } = {}): Promise<string | null> {
  // Each profile keeps its own backups folder, so a demonstration can be shown the
  // backup and restore screens working without any of it touching — or crowding out —
  // the restaurant's own snapshots.
  const backupDir = path.join(getDataDirectory(), 'backups')
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true })
  }

  if (opts.minIntervalHours && opts.minIntervalHours > 0) {
    const newest = fs.readdirSync(backupDir)
      .filter(f => f.startsWith('restaurant-') && f.endsWith('.db'))
      .map(f => fs.statSync(path.join(backupDir, f)).mtimeMs)
      .sort((a, b) => b - a)[0]

    if (newest !== undefined) {
      const ageHours = (Date.now() - newest) / 3_600_000
      if (ageHours < opts.minIntervalHours) {
        log.info(`[DB] Backup skipped — newest is ${ageHours.toFixed(1)}h old (min ${opts.minIntervalHours}h)`)
        return null
      }
    }
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const filename = `restaurant-${timestamp}.db`
  const backupPath = path.join(backupDir, filename)

  await getDb().backup(backupPath)
  log.info(`[DB] Backup created: ${backupPath}`)

  pruneBackups(backupDir)
  return backupPath
}

/**
 * Tiered retention: every snapshot from the last 48 hours, then the newest one per
 * day for 60 days.
 *
 * A flat "keep the newest N" would be wrong now that snapshots are hourly — 30 files
 * would cover barely a day, so a mistake noticed on Monday could not be undone back
 * to Friday. This keeps fine detail while it is likely to matter and a daily trail
 * long after.
 */
function pruneBackups(backupDir: string): void {
  const RECENT_HOURS = 48
  const DAILY_DAYS = 60

  const files = fs.readdirSync(backupDir)
    .filter(f => f.startsWith('restaurant-') && f.endsWith('.db'))
    .map(f => ({ name: f, mtime: fs.statSync(path.join(backupDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)

  const now = Date.now()
  const keep = new Set<string>()
  const dayKept = new Set<string>()

  for (const f of files) {
    const ageHours = (now - f.mtime) / 3_600_000
    if (ageHours <= RECENT_HOURS) {
      keep.add(f.name)
      continue
    }
    if (ageHours / 24 > DAILY_DAYS) continue // too old for either tier

    // Files are newest-first, so the first one seen for a day is that day's keeper.
    const day = new Date(f.mtime).toISOString().slice(0, 10)
    if (!dayKept.has(day)) {
      dayKept.add(day)
      keep.add(f.name)
    }
  }

  for (const f of files) {
    if (keep.has(f.name)) continue
    try {
      fs.unlinkSync(path.join(backupDir, f.name))
    } catch (err) {
      log.warn(`[DB] Could not delete old backup ${f.name}:`, err)
    }
  }

  const removed = files.length - keep.size
  if (removed > 0) log.info(`[DB] Pruned ${removed} old backup(s); ${keep.size} kept`)
}

export function closeDatabase(): void {
  if (db) {
    db.close()
    log.info('[DB] Database closed')
  }
}

// ===== Backup catalogue & restore =====

export interface BackupFile {
  fileName: string
  filePath: string
  sizeBytes: number
  createdAt: string
  /** Set on the safety copies taken automatically just before a restore. */
  isPreRestore: boolean
}

export function getBackupDir(): string {
  const dir = path.join(getDataDirectory(), 'backups')
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** Every snapshot on disk, newest first. */
export function listBackups(): BackupFile[] {
  const dir = getBackupDir()
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.db') && (f.startsWith('restaurant-') || f.startsWith('pre-restore-')))
    .map(f => {
      const filePath = path.join(dir, f)
      const st = fs.statSync(filePath)
      return {
        fileName: f,
        filePath,
        sizeBytes: st.size,
        createdAt: new Date(st.mtimeMs).toISOString(),
        isPreRestore: f.startsWith('pre-restore-'),
      }
    })
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
}

/**
 * Check a file really is one of our databases before it is allowed to replace the
 * live one. A truncated or unrelated file would otherwise take the restaurant down.
 */
export function verifyBackupFile(filePath: string): { ok: boolean; error?: string; orders?: number } {
  if (!fs.existsSync(filePath)) return { ok: false, error: 'الملف غير موجود' }

  let probe: Database.Database | null = null
  try {
    probe = new Database(filePath, { readonly: true, fileMustExist: true })

    const integrity = probe.pragma('integrity_check', { simple: true })
    if (integrity !== 'ok') return { ok: false, error: `الملف تالف (${integrity})` }

    // Must look like this application's database, not just any SQLite file.
    const required = ['orders', 'order_items', 'menu_items', 'users', 'settings']
    const present = (probe.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table'`
    ).all() as { name: string }[]).map(r => r.name)

    const missing = required.filter(t => !present.includes(t))
    if (missing.length > 0) {
      return { ok: false, error: `ليس نسخة من هذا النظام (ناقص: ${missing.join(', ')})` }
    }

    const orders = (probe.prepare('SELECT COUNT(*) AS c FROM orders').get() as any).c
    return { ok: true, orders }
  } catch (err: any) {
    return { ok: false, error: err.message }
  } finally {
    try { probe?.close() } catch { /* nothing to close */ }
  }
}

/**
 * Replace the live database with a backup.
 *
 * Ordered so the restaurant is never left without a usable database:
 *   1. verify the candidate BEFORE touching anything
 *   2. snapshot what is there now, so a mistaken restore is itself reversible
 *   3. close, swap the file, drop the stale -wal/-shm, reopen
 *
 * Reopening runs the normal migrations, so restoring an older backup upgrades it.
 */
export async function restoreBackup(filePath: string): Promise<{ safetyCopy: string }> {
  const check = verifyBackupFile(filePath)
  if (!check.ok) throw new Error(check.error || 'نسخة احتياطية غير صالحة')

  const dbPath = getDbPath()
  const dir = getBackupDir()
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const safetyCopy = path.join(dir, `pre-restore-${stamp}.db`)

  // Snapshot the CURRENT data first — restoring is destructive, and the owner may
  // pick the wrong file.
  await getDb().backup(safetyCopy)
  log.info(`[DB] Pre-restore safety copy: ${safetyCopy}`)

  closeDatabase()

  // The WAL and shared-memory files belong to the database being replaced; leaving
  // them would let SQLite replay them over the restored data.
  for (const suffix of ['-wal', '-shm']) {
    const sidecar = dbPath + suffix
    if (fs.existsSync(sidecar)) fs.unlinkSync(sidecar)
  }

  fs.copyFileSync(filePath, dbPath)
  log.info(`[DB] Restored from: ${filePath}`)

  initDatabase()
  log.info('[DB] Database reopened after restore')

  return { safetyCopy }
}

export default { initDatabase, getDb, getDbPath, runBackup, closeDatabase, listBackups, restoreBackup }
