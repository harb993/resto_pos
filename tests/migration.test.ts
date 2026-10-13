import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '../src/main/db/db'

/**
 * A database as it looked BEFORE the money CHECK constraints and the 'void' stock
 * reason existed — i.e. what is sitting on a till that has been running for months.
 */
function legacyDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE users (
      user_id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, pin_hash TEXT,
      password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('cashier','owner','accountant')),
      full_name TEXT NOT NULL, is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE categories (category_id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, display_order INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE menu_items (
      item_id INTEGER PRIMARY KEY AUTOINCREMENT, category_id INTEGER NOT NULL REFERENCES categories(category_id),
      name TEXT NOT NULL, price REAL NOT NULL, cost_price REAL NOT NULL DEFAULT 0, description TEXT, image_path TEXT,
      is_active INTEGER NOT NULL DEFAULT 1, stock_quantity INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')), updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE delivery_areas (delivery_area_id INTEGER PRIMARY KEY AUTOINCREMENT, area_name TEXT NOT NULL, delivery_fee REAL NOT NULL, is_active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE delivery_drivers (driver_id INTEGER PRIMARY KEY AUTOINCREMENT, full_name TEXT NOT NULL, phone TEXT, is_active INTEGER NOT NULL DEFAULT 1);

    -- No money CHECKs, which is the point of the migration.
    CREATE TABLE orders (
      order_id INTEGER PRIMARY KEY AUTOINCREMENT, cashier_id INTEGER NOT NULL REFERENCES users(user_id),
      subtotal REAL NOT NULL, tax REAL NOT NULL DEFAULT 0, discount REAL NOT NULL DEFAULT 0, total_amount REAL NOT NULL,
      payment_type TEXT NOT NULL CHECK (payment_type IN ('cash','card')),
      status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed','voided')),
      voided_by INTEGER REFERENCES users(user_id), void_reason TEXT,
      order_type TEXT NOT NULL DEFAULT 'dine_in' CHECK (order_type IN ('dine_in','takeaway','delivery')),
      customer_name TEXT, customer_phone TEXT, customer_address TEXT,
      delivery_area_id INTEGER REFERENCES delivery_areas(delivery_area_id),
      delivery_fee REAL DEFAULT 0, driver_id INTEGER REFERENCES delivery_drivers(driver_id),
      deleted_at TEXT, deleted_by INTEGER REFERENCES users(user_id), invoice_number TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE order_items (
      order_item_id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL REFERENCES orders(order_id),
      menu_item_id INTEGER NOT NULL REFERENCES menu_items(item_id), quantity INTEGER NOT NULL CHECK (quantity > 0),
      unit_price REAL NOT NULL, unit_cost REAL NOT NULL DEFAULT 0, variant_label TEXT
    );
    -- Old CHECK: no 'void'.
    CREATE TABLE stock_transactions (
      stock_txn_id INTEGER PRIMARY KEY AUTOINCREMENT, menu_item_id INTEGER NOT NULL REFERENCES menu_items(item_id),
      change_amount REAL NOT NULL, reason TEXT NOT NULL CHECK (reason IN ('sale','restock','waste','adjustment','conversion')),
      related_order_id INTEGER REFERENCES orders(order_id), created_by INTEGER NOT NULL REFERENCES users(user_id),
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE shifts (
      shift_id INTEGER PRIMARY KEY AUTOINCREMENT, cashier_id INTEGER NOT NULL REFERENCES users(user_id),
      shift_date TEXT NOT NULL, shift_number INTEGER NOT NULL DEFAULT 1, start_time TEXT, end_time TEXT,
      set_by INTEGER NOT NULL REFERENCES users(user_id), created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );

    INSERT INTO users (username,password_hash,role,full_name) VALUES ('owner','h','owner','Owner');
    INSERT INTO categories (name) VALUES ('Meals');
    INSERT INTO menu_items (category_id,name,price,cost_price,stock_quantity) VALUES (1,'Meal',100,40,10);
  `)
  return db
}

const addOrder = (db: Database.Database, total: number, id?: number) =>
  db.prepare(
    `INSERT INTO orders (order_id,cashier_id,subtotal,tax,discount,total_amount,payment_type)
     VALUES (?,1,?,0,0,?,'cash')`
  ).run(id ?? null, Math.max(total, 0), total)

describe('orders money-CHECK migration', () => {
  it('rebuilds the table and preserves every row', () => {
    const db = legacyDb()
    addOrder(db, 100); addOrder(db, 250); addOrder(db, 0)
    db.prepare(`INSERT INTO order_items (order_id,menu_item_id,quantity,unit_price) VALUES (1,1,2,50)`).run()

    runMigrations(db)

    const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='orders'").get() as any).sql
    expect(sql).toContain('total_amount >= 0')
    expect(sql).toContain('subtotal >= 0')
    expect(sql).toContain('delivery_fee >= 0')

    expect((db.prepare('SELECT COUNT(*) c FROM orders').get() as any).c).toBe(3)
    expect((db.prepare('SELECT total_amount t FROM orders WHERE order_id=2').get() as any).t).toBe(250)
    // The child row still points at a live parent.
    expect(db.pragma('foreign_key_check')).toEqual([])
  })

  it('actually rejects a negative total afterwards', () => {
    const db = legacyDb()
    runMigrations(db)
    expect(() => addOrder(db, -500)).toThrow(/CHECK constraint failed/i)
  })

  it('restores the indexes the rebuild dropped', () => {
    const db = legacyDb()
    db.exec(`CREATE INDEX idx_orders_created_at ON orders(created_at);
             CREATE INDEX idx_orders_status ON orders(status);`)
    runMigrations(db)
    const idx = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='orders'"
    ).all() as any[]).map(r => r.name)
    expect(idx).toEqual(expect.arrayContaining([
      'idx_orders_created_at', 'idx_orders_status', 'idx_orders_cashier_id',
      'idx_orders_order_type', 'idx_orders_deleted_at',
    ]))
  })

  it('refuses to migrate — and changes nothing — when existing rows would violate the constraints', () => {
    const db = legacyDb()
    addOrder(db, 100)
    addOrder(db, -250) // written by the old client-trusted-totals code
    addOrder(db, 300)

    runMigrations(db)

    // Table left as it was: no CHECK, all three rows intact, negative preserved
    // rather than rewritten or dropped behind the owner's back.
    const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='orders'").get() as any).sql
    expect(sql).not.toContain('total_amount >= 0')
    expect((db.prepare('SELECT COUNT(*) c FROM orders').get() as any).c).toBe(3)
    expect((db.prepare('SELECT total_amount t FROM orders WHERE order_id=2').get() as any).t).toBe(-250)
  })

  it('migrates on a later run once the bad rows are cleaned up', () => {
    const db = legacyDb()
    addOrder(db, 100); addOrder(db, -250)

    runMigrations(db) // skipped
    expect((db.prepare("SELECT sql FROM sqlite_master WHERE name='orders'").get() as any).sql)
      .not.toContain('total_amount >= 0')

    db.prepare('DELETE FROM orders WHERE total_amount < 0').run()
    runMigrations(db) // now it can proceed

    expect((db.prepare("SELECT sql FROM sqlite_master WHERE name='orders'").get() as any).sql)
      .toContain('total_amount >= 0')
    expect((db.prepare('SELECT COUNT(*) c FROM orders').get() as any).c).toBe(1)
  })

  it('is idempotent — a second run is a no-op', () => {
    const db = legacyDb()
    addOrder(db, 100)
    runMigrations(db)
    const first = (db.prepare("SELECT sql FROM sqlite_master WHERE name='orders'").get() as any).sql
    runMigrations(db)
    expect((db.prepare("SELECT sql FROM sqlite_master WHERE name='orders'").get() as any).sql).toBe(first)
    expect((db.prepare('SELECT COUNT(*) c FROM orders').get() as any).c).toBe(1)
  })
})

describe("delivery_status widening to allow 'preparing'", () => {
  /**
   * A till running the FIRST delivery centre: the column exists, but its CHECK only
   * allows four states. Writing 'preparing' to it fails outright, so the migration
   * has to rebuild the table — and must not lose a row or a column doing it.
   */
  function firstDeliveryCentreDb(): Database.Database {
    const db = legacyDb()
    runMigrations(db) // brings it up to the four-state delivery centre
    // Sanity: this is the state being migrated FROM.
    const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE name='orders'").get() as any).sql
    expect(sql).toContain('delivery_status')
    // Re-create the narrow CHECK the first version shipped with.
    db.exec(`
      PRAGMA foreign_keys=OFF;
      ALTER TABLE orders RENAME TO orders_old;
      CREATE TABLE orders (
        order_id INTEGER PRIMARY KEY AUTOINCREMENT, cashier_id INTEGER NOT NULL REFERENCES users(user_id),
        subtotal REAL NOT NULL CHECK (subtotal >= 0), tax REAL NOT NULL DEFAULT 0 CHECK (tax >= 0),
        discount REAL NOT NULL DEFAULT 0 CHECK (discount >= 0), total_amount REAL NOT NULL CHECK (total_amount >= 0),
        payment_type TEXT NOT NULL CHECK (payment_type IN ('cash','card')),
        status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed','voided')),
        voided_by INTEGER REFERENCES users(user_id), void_reason TEXT,
        order_type TEXT NOT NULL DEFAULT 'dine_in' CHECK (order_type IN ('dine_in','takeaway','delivery')),
        customer_name TEXT, customer_phone TEXT, customer_address TEXT,
        delivery_area_id INTEGER REFERENCES delivery_areas(delivery_area_id),
        delivery_fee REAL DEFAULT 0 CHECK (delivery_fee >= 0),
        driver_id INTEGER REFERENCES delivery_drivers(driver_id),
        delivery_status TEXT CHECK (delivery_status IN ('pending','out','delivered','returned')),
        dispatched_at TEXT, delivered_at TEXT,
        settlement_id INTEGER REFERENCES driver_settlements(settlement_id),
        deleted_at TEXT, deleted_by INTEGER REFERENCES users(user_id),
        invoice_number TEXT, notes TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
      );
      DROP TABLE orders_old;
      PRAGMA foreign_keys=ON;
    `)
    return db
  }

  const addDelivery = (db: Database.Database, status: string, id?: number) =>
    db.prepare(
      `INSERT INTO orders (order_id,cashier_id,subtotal,tax,discount,total_amount,payment_type,
         order_type,customer_phone,delivery_status,invoice_number,notes)
       VALUES (?,1,100,0,0,100,'cash','delivery','0100',?,'0001','بدون بصل')`
    ).run(id ?? null, status)

  it("rejects 'preparing' before the migration and accepts it after", () => {
    const db = firstDeliveryCentreDb()
    expect(() => addDelivery(db, 'preparing')).toThrow(/CHECK constraint failed/i)

    runMigrations(db)

    expect(() => addDelivery(db, 'preparing')).not.toThrow()
    expect((db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='orders'"
    ).get() as any).sql).toContain("'preparing'")
    db.close()
  })

  it('carries every row and every column across the rebuild', () => {
    const db = firstDeliveryCentreDb()
    addDelivery(db, 'delivered', 41)
    addDelivery(db, 'out', 42)
    db.prepare(`UPDATE orders SET delivered_at = '2026-09-01 20:00:00' WHERE order_id = 41`).run()

    runMigrations(db)

    expect((db.prepare('SELECT COUNT(*) c FROM orders').get() as any).c).toBe(2)
    const kept = db.prepare('SELECT * FROM orders WHERE order_id = 41').get() as any
    expect(kept.delivery_status).toBe('delivered')
    expect(kept.delivered_at).toBe('2026-09-01 20:00:00')
    expect(kept.customer_phone).toBe('0100')
    expect(kept.notes).toBe('بدون بصل') // the column added by a LATER ALTER survives
    expect(kept.total_amount).toBe(100)
    expect(db.pragma('foreign_key_check')).toEqual([])
    db.close()
  })

  it('still rejects a value that is not a real state', () => {
    const db = firstDeliveryCentreDb()
    runMigrations(db)
    expect(() => addDelivery(db, 'nonsense')).toThrow(/CHECK constraint failed/i)
    db.close()
  })

  it('puts the indexes back and is a no-op on a second run', () => {
    const db = firstDeliveryCentreDb()
    runMigrations(db)

    const idx = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='orders'"
    ).all() as any[]).map(r => r.name)
    expect(idx).toEqual(expect.arrayContaining([
      'idx_orders_created_at', 'idx_orders_status', 'idx_orders_cashier_id',
      'idx_orders_order_type', 'idx_orders_deleted_at', 'idx_orders_delivery_status',
    ]))

    const before = (db.prepare("SELECT sql FROM sqlite_master WHERE name='orders'").get() as any).sql
    runMigrations(db)
    expect((db.prepare("SELECT sql FROM sqlite_master WHERE name='orders'").get() as any).sql).toBe(before)
    db.close()
  })
})

describe('stock_transactions void migration', () => {
  it("widens the reason CHECK and keeps existing rows", () => {
    const db = legacyDb()
    addOrder(db, 100)
    db.prepare(
      `INSERT INTO stock_transactions (menu_item_id,change_amount,reason,related_order_id,created_by)
       VALUES (1,-2,'sale',1,1)`
    ).run()

    expect(() => db.prepare(
      `INSERT INTO stock_transactions (menu_item_id,change_amount,reason,created_by) VALUES (1,2,'void',1)`
    ).run()).toThrow(/CHECK constraint failed/i)

    runMigrations(db)

    expect(() => db.prepare(
      `INSERT INTO stock_transactions (menu_item_id,change_amount,reason,created_by) VALUES (1,2,'void',1)`
    ).run()).not.toThrow()
    expect((db.prepare("SELECT COUNT(*) c FROM stock_transactions WHERE reason='sale'").get() as any).c).toBe(1)
    expect(db.pragma('foreign_key_check')).toEqual([])
  })
})

describe('variant groups gaining both display_order and category ownership', () => {
  /**
   * A till old enough to need BOTH variant migrations at once: item_variant_groups
   * predates display_order AND predates category ownership.
   *
   * This killed startup. The category migration rebuilds the table with a fixed
   * column list that copies display_order across by name, so running it before the
   * column exists threw "no such column: display_order" out of initDatabase — and
   * the app never opened a window at all.
   */
  function preVariantDb(): Database.Database {
    const db = legacyDb()
    db.exec(`
      CREATE TABLE item_variant_groups (
        variant_group_id INTEGER PRIMARY KEY AUTOINCREMENT,
        menu_item_id INTEGER NOT NULL REFERENCES menu_items(item_id),
        group_name TEXT NOT NULL
      );
      CREATE TABLE item_variant_options (
        variant_option_id INTEGER PRIMARY KEY AUTOINCREMENT,
        variant_group_id INTEGER NOT NULL REFERENCES item_variant_groups(variant_group_id),
        option_name TEXT NOT NULL, price_delta REAL NOT NULL DEFAULT 0
      );
      INSERT INTO item_variant_groups (variant_group_id, menu_item_id, group_name)
        VALUES (7, 1, 'الحجم');
      INSERT INTO item_variant_options (variant_group_id, option_name, price_delta)
        VALUES (7, 'كبير', 10);
    `)
    return db
  }

  it('migrates in an order that works, instead of throwing on startup', () => {
    const db = preVariantDb()
    expect(() => runMigrations(db)).not.toThrow()

    const cols = (db.prepare('PRAGMA table_info(item_variant_groups)').all() as any[]).map(c => c.name)
    expect(cols).toContain('display_order')
    expect(cols).toContain('category_id')
    db.close()
  })

  it('keeps the group, its id, and the option pointing at it', () => {
    const db = preVariantDb()
    runMigrations(db)

    // The id has to survive: item_variant_options rows reference it, and a rebuild
    // that renumbered would silently detach every option from its group.
    const group = db.prepare('SELECT * FROM item_variant_groups WHERE variant_group_id = 7').get() as any
    expect(group.group_name).toBe('الحجم')
    expect(group.menu_item_id).toBe(1)
    expect(group.category_id).toBeNull()

    const opt = db.prepare('SELECT * FROM item_variant_options WHERE variant_group_id = 7').get() as any
    expect(opt.option_name).toBe('كبير')
    expect(opt.display_order).toBe(0)
    db.close()
  })

  it('is idempotent — a second run is a no-op', () => {
    const db = preVariantDb()
    runMigrations(db)
    const before = (db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='item_variant_groups'"
    ).get() as any).sql
    expect(() => runMigrations(db)).not.toThrow()
    const after = (db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='item_variant_groups'"
    ).get() as any).sql
    expect(after).toBe(before)
    db.close()
  })
})