PRAGMA foreign_keys = ON;

-- Settings (key-value store for app config)
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- Default settings
INSERT OR IGNORE INTO settings (key, value) VALUES
    ('tax_rate', '0.14'),
    ('currency_symbol', 'EGP'),
    ('business_name', 'Fried Chicken Restaurant'),
    ('business_address', ''),
    ('business_phone', ''),
    ('receipt_footer', 'Thank you! See you again!'),
    ('max_cashier_discount', '10'),
    ('backup_folder', '');

-- Users
CREATE TABLE IF NOT EXISTS users (
    user_id       INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE,
    pin_hash      TEXT,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL CHECK (role IN ('cashier','owner')),
    full_name     TEXT NOT NULL,
    is_active     INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- Categories
CREATE TABLE IF NOT EXISTS categories (
    category_id   INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL,
    display_order INTEGER NOT NULL DEFAULT 0
);

-- Menu items (simple stock model — stock_quantity on the item itself)
CREATE TABLE IF NOT EXISTS menu_items (
    item_id        INTEGER PRIMARY KEY AUTOINCREMENT,
    category_id    INTEGER NOT NULL REFERENCES categories(category_id),
    name           TEXT NOT NULL,
    price          REAL NOT NULL CHECK (price >= 0),
    cost_price     REAL NOT NULL DEFAULT 0 CHECK (cost_price >= 0),
    description    TEXT,
    image_path     TEXT,
    is_active      INTEGER NOT NULL DEFAULT 1,
    stock_quantity INTEGER NOT NULL DEFAULT 0,
    created_at     TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at     TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- Orders
CREATE TABLE IF NOT EXISTS orders (
    order_id      INTEGER PRIMARY KEY AUTOINCREMENT,
    cashier_id    INTEGER NOT NULL REFERENCES users(user_id),
    subtotal      REAL NOT NULL,
    tax           REAL NOT NULL DEFAULT 0,
    discount      REAL NOT NULL DEFAULT 0,
    total_amount  REAL NOT NULL,
    payment_type  TEXT NOT NULL CHECK (payment_type IN ('cash','card')),
    status        TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed','voided')),
    voided_by     INTEGER REFERENCES users(user_id),
    void_reason   TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- Order items
CREATE TABLE IF NOT EXISTS order_items (
    order_item_id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id      INTEGER NOT NULL REFERENCES orders(order_id),
    menu_item_id  INTEGER NOT NULL REFERENCES menu_items(item_id),
    quantity      INTEGER NOT NULL CHECK (quantity > 0),
    unit_price    REAL NOT NULL,
    unit_cost     REAL NOT NULL DEFAULT 0
);

-- Stock transaction audit trail (for simple stock model, references menu_item_id)
CREATE TABLE IF NOT EXISTS stock_transactions (
    stock_txn_id      INTEGER PRIMARY KEY AUTOINCREMENT,
    menu_item_id      INTEGER NOT NULL REFERENCES menu_items(item_id),
    change_amount     REAL NOT NULL,
    reason            TEXT NOT NULL CHECK (reason IN ('sale','restock','waste','adjustment')),
    related_order_id  INTEGER REFERENCES orders(order_id),
    created_by        INTEGER NOT NULL REFERENCES users(user_id),
    created_at        TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- Schema migrations tracker
CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- Indexes for analytics queries
CREATE INDEX IF NOT EXISTS idx_orders_created_at        ON orders(created_at);
CREATE INDEX IF NOT EXISTS idx_orders_status            ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_cashier_id        ON orders(cashier_id);
CREATE INDEX IF NOT EXISTS idx_order_items_order_id     ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_order_items_menu_item_id ON order_items(menu_item_id);
CREATE INDEX IF NOT EXISTS idx_menu_items_category      ON menu_items(category_id);
CREATE INDEX IF NOT EXISTS idx_menu_items_active        ON menu_items(is_active);
CREATE INDEX IF NOT EXISTS idx_stock_txn_menu_item      ON stock_transactions(menu_item_id);
CREATE INDEX IF NOT EXISTS idx_stock_txn_created_at     ON stock_transactions(created_at);
