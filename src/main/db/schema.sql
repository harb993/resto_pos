PRAGMA foreign_keys = ON;

-- Settings (key-value store for app config)
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- Default settings
INSERT OR IGNORE INTO settings (key, value) VALUES
    ('tax_rate', '0.14'),
    ('currency_symbol', 'ج.م'),
    ('business_name', 'Crispo Fried Chicken'),
    ('business_address', ''),
    ('business_phone', ''),
    ('receipt_footer', 'شكراً لزيارتكم! بالهناء والشفاء ❤️'),
    ('max_cashier_discount', '10'),
    ('backup_folder', ''),
    ('invoice_seq', '0'),
    ('invoice_start', '1'),
    ('shifts_per_day', '2'),
    ('shift1_name', 'صباحية'),
    ('shift1_start', '09:00'),
    ('shift1_end', '17:00'),
    ('shift2_name', 'مسائية'),
    ('shift2_start', '17:00'),
    ('shift2_end', '01:00'),
    ('print_auto', '1'),
    ('print_logo', '1'),
    ('print_feed_lines', '2'),
    ('print_font_scale', '100'),
    ('net_mode', 'standalone'),
    ('net_port', '47615'),
    ('net_token', ''),
    ('net_fleet_id', ''),
    ('net_master_name', ''),
    ('net_locked', '0'),
    ('net_lock_reason', ''),
    ('net_tills', '[]'),
    ('backup_hour', '3'),
    ('backup_last_daily', ''),
    ('shift_export_auto', '1'),
    ('shift_export_folder', ''),
    ('whatsapp_group', '');

-- Users — the FOUR fixed people who operate the system.
-- `slot` names which of the four a row is, so the rest of the app can refer to
-- "the shift-1 cashier" rather than guessing between two rows with role='cashier'.
-- Staff who don't log in belong in `workers`, not here.
CREATE TABLE IF NOT EXISTS users (
    user_id       INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE,
    pin_hash      TEXT,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL CHECK (role IN ('cashier','owner','accountant')),
    slot          TEXT CHECK (slot IN ('cashier1','cashier2','owner','accountant')),
    full_name     TEXT NOT NULL,
    is_active     INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
-- NOTE: the UNIQUE index on `slot` is created in runMigrations(), not here. On an
-- existing database CREATE TABLE IF NOT EXISTS is a no-op, so `slot` does not exist
-- yet at this point and indexing it would fail before the migration can add it.

-- Categories
CREATE TABLE IF NOT EXISTS categories (
    category_id   INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL,
    display_order INTEGER NOT NULL DEFAULT 0,
    -- Which prep printer this category's items are sent to, chosen on the categories
    -- screen. NULL leaves it to the printers' own category lists (the old behaviour);
    -- 0 means no prep ticket at all — drinks handed over at the till. Deliberately not
    -- a foreign key: 0 is not a printer, and the shop-data import writes categories
    -- before printers. Deleting a printer clears it here — see printerService.
    printer_id    INTEGER
);

-- Menu items (simple stock model — stock_quantity on the item itself)
CREATE TABLE IF NOT EXISTS menu_items (
    item_id        INTEGER PRIMARY KEY AUTOINCREMENT,
    category_id    INTEGER NOT NULL REFERENCES categories(category_id),
    name           TEXT NOT NULL,
    price          REAL NOT NULL CHECK (price >= 0),
    cost_price     REAL NOT NULL DEFAULT 0 CHECK (cost_price >= 0),
    -- «التكلفة المبدئية» — what the dish was COSTED AT when the menu was priced, taken
    -- from «ملخص الريسبى» (the «التكلفة بعد الامان» row).
    --
    -- Kept apart from cost_price on purpose. cost_price is the working figure and
    -- moves: the owner edits it, and once the store is priced up the recipe takes
    -- over. This one is the plan the shelf price was set against, and it has to stay
    -- still — otherwise "are we still making what we thought we would?" has nothing
    -- to compare against. 0 means the dish was never costed from the sheet.
    baseline_cost  REAL NOT NULL DEFAULT 0 CHECK (baseline_cost >= 0),
    description    TEXT,
    image_path     TEXT,
    is_active      INTEGER NOT NULL DEFAULT 1,
    stock_quantity INTEGER NOT NULL DEFAULT 0,
    -- Whether this item is asked its category's questions. Off for the odd item that
    -- sits in a category but should not inherit its choices.
    inherit_category_variants INTEGER NOT NULL DEFAULT 1,
    -- Where this item sits on the POS grid within its category.
    --
    -- Alphabetical is the wrong order for a till. The cashier reaches for the same
    -- four things all day and should find them under their thumb, not hunt for them
    -- between «أصابع موزاريلا» and «بطاطس». 0 for everything until the owner arranges
    -- it, and ties fall back to the name so the grid never shuffles on its own.
    display_order  INTEGER NOT NULL DEFAULT 0,
    created_at     TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at     TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- Raw materials (المواد الخام) — the real inventory: whole chickens, rice, buns, sauces, oil.
-- stock_quantity is deliberately allowed to go negative: a miscount must never stop service,
-- it surfaces as a warning so the owner can correct the count later.
CREATE TABLE IF NOT EXISTS raw_materials (
    raw_material_id     INTEGER PRIMARY KEY AUTOINCREMENT,
    name                TEXT NOT NULL,
    unit                TEXT NOT NULL DEFAULT 'قطعة',
    stock_quantity      REAL NOT NULL DEFAULT 0,
    cost_per_unit       REAL NOT NULL DEFAULT 0 CHECK (cost_per_unit >= 0),
    low_stock_threshold REAL NOT NULL DEFAULT 5,
    is_active           INTEGER NOT NULL DEFAULT 1,
    created_at          TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- Recipes (BOM) — which raw materials, and how much of each, make ONE unit of a menu item.
-- A menu item with no recipe rows falls back to the simple menu_items.stock_quantity model.
CREATE TABLE IF NOT EXISTS recipe_items (
    recipe_item_id  INTEGER PRIMARY KEY AUTOINCREMENT,
    menu_item_id    INTEGER NOT NULL REFERENCES menu_items(item_id),
    raw_material_id INTEGER NOT NULL REFERENCES raw_materials(raw_material_id),
    quantity        REAL NOT NULL CHECK (quantity > 0),
    UNIQUE(menu_item_id, raw_material_id)
);

-- Raw material stock movements (audit trail).
-- 'sale' rows carry related_order_id so a void can reverse exactly what was consumed.
CREATE TABLE IF NOT EXISTS raw_material_transactions (
    rm_txn_id        INTEGER PRIMARY KEY AUTOINCREMENT,
    raw_material_id  INTEGER NOT NULL REFERENCES raw_materials(raw_material_id),
    change_amount    REAL NOT NULL,
    reason           TEXT NOT NULL CHECK (reason IN ('sale','restock','waste','adjustment','prep_out','prep_in','void')),
    related_order_id INTEGER REFERENCES orders(order_id),
    created_by       INTEGER NOT NULL REFERENCES users(user_id),
    created_at       TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- Prep conversions (التجهيز) — e.g. 1 whole chicken yields 8 ready pieces.
-- Running a prep deducts the source material and adds the yielded output material.
CREATE TABLE IF NOT EXISTS prep_conversions (
    prep_conversion_id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_material_id INTEGER NOT NULL REFERENCES raw_materials(raw_material_id),
    output_material_id INTEGER NOT NULL REFERENCES raw_materials(raw_material_id),
    yield_quantity     REAL NOT NULL CHECK (yield_quantity > 0),
    UNIQUE(source_material_id, output_material_id)
);

-- Delivery areas (delivery pricing per zone)
CREATE TABLE IF NOT EXISTS delivery_areas (
    delivery_area_id INTEGER PRIMARY KEY AUTOINCREMENT,
    area_name        TEXT NOT NULL,
    delivery_fee     REAL NOT NULL CHECK (delivery_fee >= 0),
    is_active        INTEGER NOT NULL DEFAULT 1
);

-- Delivery drivers
CREATE TABLE IF NOT EXISTS delivery_drivers (
    driver_id  INTEGER PRIMARY KEY AUTOINCREMENT,
    full_name  TEXT NOT NULL,
    phone      TEXT,
    is_active  INTEGER NOT NULL DEFAULT 1
);

-- One hand-over of cash from a driver to the restaurant.
--
-- A driver collects the money for every cash order he delivers and walks back with
-- it. This is the receipt for the moment he puts it on the counter: which orders it
-- covered, how much it came to, who counted it and when. The orders themselves point
-- back at their settlement, so "has this order been paid in?" is a column, not a
-- calculation someone has to redo.
--
-- Card orders never appear here. The customer paid the machine, not the driver, so
-- there is nothing for him to hand over.
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

-- Orders (extended with order type, delivery, soft-delete)
CREATE TABLE IF NOT EXISTS orders (
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
    -- Where a delivery order is in its journey. NULL on dine-in and takeaway, which
    -- never leave the shop. 'preparing' is with the kitchen, 'pending' is cooked and
    -- waiting for a driver, 'out' is with one, 'delivered' reached the customer,
    -- 'returned' came back undelivered.
    delivery_status  TEXT CHECK (delivery_status IN ('preparing','pending','out','delivered','returned')),
    dispatched_at    TEXT,
    delivered_at     TEXT,
    -- Which hand-over of cash this order's money was part of. NULL means the driver
    -- is still holding it (or there was never any cash to hold — a card order).
    settlement_id    INTEGER REFERENCES driver_settlements(settlement_id),
    deleted_at       TEXT,
    deleted_by       INTEGER REFERENCES users(user_id),
    invoice_number   TEXT,
    -- A free-text note for the kitchen or the counter: "بدون بصل", "ماتتأخرش".
    -- Printed on every ticket ONLY when it has something in it.
    notes            TEXT,
    created_at       TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- Order items (extended with variant label)
CREATE TABLE IF NOT EXISTS order_items (
    order_item_id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id      INTEGER NOT NULL REFERENCES orders(order_id),
    menu_item_id  INTEGER NOT NULL REFERENCES menu_items(item_id),
    quantity      INTEGER NOT NULL CHECK (quantity > 0),
    unit_price    REAL NOT NULL,
    unit_cost     REAL NOT NULL DEFAULT 0,
    variant_label TEXT
);

-- Stock transaction audit trail
CREATE TABLE IF NOT EXISTS stock_transactions (
    stock_txn_id      INTEGER PRIMARY KEY AUTOINCREMENT,
    menu_item_id      INTEGER NOT NULL REFERENCES menu_items(item_id),
    change_amount     REAL NOT NULL,
    reason            TEXT NOT NULL CHECK (reason IN ('sale','restock','waste','adjustment','conversion','void')),
    related_order_id  INTEGER REFERENCES orders(order_id),
    created_by        INTEGER NOT NULL REFERENCES users(user_id),
    created_at        TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- Stock conversions (yield: e.g. 1 whole chicken → 8 pieces)
CREATE TABLE IF NOT EXISTS stock_conversions (
    conversion_id       INTEGER PRIMARY KEY AUTOINCREMENT,
    source_inventory_id INTEGER NOT NULL REFERENCES menu_items(item_id),
    output_inventory_id INTEGER NOT NULL REFERENCES menu_items(item_id),
    yield_quantity      REAL NOT NULL CHECK (yield_quantity > 0)
);

-- Workers — the DAILY staff: kitchen, cleaning, help that changes day to day.
-- They never log into the system. They are paid per day worked, so the wage lives
-- here and the days come from worker_attendance.
CREATE TABLE IF NOT EXISTS workers (
    worker_id      INTEGER PRIMARY KEY AUTOINCREMENT,
    full_name      TEXT NOT NULL,
    role_title     TEXT,
    daily_wage     REAL NOT NULL DEFAULT 0 CHECK (daily_wage >= 0),
    -- The shift this person normally works. Only a default: the shift actually
    -- worked is recorded per day on worker_attendance.
    default_shift  INTEGER CHECK (default_shift IN (1, 2)),
    is_active      INTEGER NOT NULL DEFAULT 1,
    linked_user_id INTEGER REFERENCES users(user_id)
);

-- Worker attendance (day-worked log for staff who don't have POS logins)
CREATE TABLE IF NOT EXISTS worker_attendance (
    attendance_id INTEGER PRIMARY KEY AUTOINCREMENT,
    worker_id     INTEGER NOT NULL REFERENCES workers(worker_id),
    work_date     TEXT NOT NULL,
    -- Which shift they actually worked that day, so a chef who normally does
    -- mornings but covered an evening is recorded truthfully.
    shift_number  INTEGER CHECK (shift_number IN (1, 2)),
    created_by    INTEGER NOT NULL REFERENCES users(user_id),
    created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    UNIQUE(worker_id, work_date)
);

-- Expenses (day-to-day operational costs)
CREATE TABLE IF NOT EXISTS expenses (
    expense_id   INTEGER PRIMARY KEY AUTOINCREMENT,
    category     TEXT NOT NULL CHECK (category IN ('ingredients','utilities','maintenance','delivery','other')),
    description  TEXT,
    amount       REAL NOT NULL CHECK (amount >= 0),
    recorded_by  INTEGER NOT NULL REFERENCES users(user_id),
    expense_date TEXT NOT NULL DEFAULT (date('now','localtime')),
    created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- Salaries (worker pay records — owner only)
CREATE TABLE IF NOT EXISTS salaries (
    salary_id        INTEGER PRIMARY KEY AUTOINCREMENT,
    worker_id        INTEGER NOT NULL REFERENCES workers(worker_id),
    amount           REAL NOT NULL CHECK (amount >= 0),
    pay_period_start TEXT NOT NULL,
    pay_period_end   TEXT NOT NULL,
    paid_on          TEXT,
    created_by       INTEGER NOT NULL REFERENCES users(user_id),
    created_at       TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- Shifts — a RECORDED work session, not a rota.
-- A row opens when a user signs in and closes when they sign out (or at shutdown).
-- started_at/ended_at are full timestamps; hours are computed from them.
-- start_time/end_time keep the plain HH:MM for display.
CREATE TABLE IF NOT EXISTS shifts (
    shift_id     INTEGER PRIMARY KEY AUTOINCREMENT,
    cashier_id   INTEGER NOT NULL REFERENCES users(user_id),
    shift_date   TEXT NOT NULL,
    shift_number INTEGER NOT NULL DEFAULT 1 CHECK (shift_number IN (1, 2)),
    start_time   TEXT,
    end_time     TEXT,
    started_at   TEXT,
    ended_at     TEXT,
    -- When the close-out PDF and workbook were written for this shift. NULL means
    -- they have not been, which is exactly what the end-of-shift export sweeps for.
    -- A marker rather than a callback because a shift closes down four different
    -- paths — see shiftExportService.
    report_exported_at TEXT,
    set_by       INTEGER NOT NULL REFERENCES users(user_id),
    created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- Work shifts («الوردية») — the SHOP's trading period, as opposed to one person's
-- sign-in above. Opened and closed by the clock the owner set (or opened early by the
-- owner); every invoice, expense and payment belongs to one by when it happened.
-- See workShiftService.
CREATE TABLE IF NOT EXISTS work_shifts (
    work_shift_id INTEGER PRIMARY KEY AUTOINCREMENT,
    shift_number  INTEGER NOT NULL DEFAULT 1,
    opened_at     TEXT NOT NULL,
    closed_at     TEXT,
    -- Who started it by hand. NULL means it began by itself at its configured time.
    opened_by     INTEGER REFERENCES users(user_id),
    report_exported_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_work_shifts_opened ON work_shifts(opened_at);

-- Variant groups — one question the cashier is asked when ringing an item up.
--
--   water, cola     no groups anywhere, so it goes straight into the cart
--   chicken         a "النوع" group — عادي / حار, priced the same
--   burgers         a "عدد الطبقات" group — سنجل / دبل / تريبل
--   fries, meals    a "الحجم" group — صغير / وسط / كبير, each priced differently
--
-- A group belongs to EITHER one category or one item, never both — the CHECK below
-- enforces it. Setting it on the category is the normal way: "chicken asks spicy"
-- is said once and every chicken item inherits it, including ones added later.
-- An item-level group is the exception, for the one burger that also comes in sizes.
--
-- An item can opt out of its category's questions — see
-- menu_items.inherit_category_variants — for the odd item that sits in the chicken
-- category but is not fried, and so should not be asked about spice.
CREATE TABLE IF NOT EXISTS item_variant_groups (
    variant_group_id INTEGER PRIMARY KEY AUTOINCREMENT,
    menu_item_id     INTEGER REFERENCES menu_items(item_id),
    category_id      INTEGER REFERENCES categories(category_id),
    group_name       TEXT NOT NULL,
    display_order    INTEGER NOT NULL DEFAULT 0,
    CHECK ((menu_item_id IS NULL) <> (category_id IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_variant_groups_item ON item_variant_groups(menu_item_id);
-- NOTE: the index on category_id is created in runMigrations(), not here — same
-- reason as idx_users_slot above. On an existing database the CREATE TABLE is a
-- no-op, so category_id does not exist yet at this point and indexing it would fail
-- before the migration that adds it has had a chance to run.

-- The answers. `price_delta` is added to the item's base price when chosen, so a
-- large is +15 and a triple is +40; it may be 0 (عادي/حار cost the same) or negative
-- for a smaller size priced below the default.
CREATE TABLE IF NOT EXISTS item_variant_options (
    variant_option_id INTEGER PRIMARY KEY AUTOINCREMENT,
    variant_group_id  INTEGER NOT NULL REFERENCES item_variant_groups(variant_group_id),
    option_name       TEXT NOT NULL,
    price_delta       REAL NOT NULL DEFAULT 0,
    display_order     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_variant_options_group ON item_variant_options(variant_group_id);

-- Suppliers (الموردون) — who the restaurant buys its raw materials from.
CREATE TABLE IF NOT EXISTS suppliers (
    supplier_id INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    phone       TEXT,
    notes       TEXT,
    is_active   INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- One delivery from a supplier: the goods that arrived and what they came to.
--
-- Recording one ADDS THE GOODS TO STOCK — each line writes a 'restock' row into
-- raw_material_transactions — so a delivery is entered once, not once here and again
-- in the stock screen. `total_amount` is the sum of the lines, stored rather than
-- recomputed so a later price edit cannot silently rewrite an invoice already agreed.
CREATE TABLE IF NOT EXISTS supplier_invoices (
    supplier_invoice_id INTEGER PRIMARY KEY AUTOINCREMENT,
    supplier_id  INTEGER NOT NULL REFERENCES suppliers(supplier_id),
    invoice_date TEXT NOT NULL DEFAULT (date('now','localtime')),
    -- The supplier's own invoice number, when they give one.
    reference    TEXT,
    total_amount REAL NOT NULL CHECK (total_amount >= 0),
    notes        TEXT,
    created_by   INTEGER NOT NULL REFERENCES users(user_id),
    created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_supplier_invoices_supplier ON supplier_invoices(supplier_id);
CREATE INDEX IF NOT EXISTS idx_supplier_invoices_date ON supplier_invoices(invoice_date);

-- The goods on one delivery. Every line points at a real raw material, so a delivery
-- can never contain something nameless that stock could not be added to.
CREATE TABLE IF NOT EXISTS supplier_invoice_items (
    supplier_invoice_item_id INTEGER PRIMARY KEY AUTOINCREMENT,
    supplier_invoice_id INTEGER NOT NULL REFERENCES supplier_invoices(supplier_invoice_id),
    raw_material_id     INTEGER NOT NULL REFERENCES raw_materials(raw_material_id),
    quantity            REAL NOT NULL CHECK (quantity > 0),
    unit_cost           REAL NOT NULL CHECK (unit_cost >= 0),
    line_total          REAL NOT NULL CHECK (line_total >= 0)
);
CREATE INDEX IF NOT EXISTS idx_supplier_invoice_items_inv ON supplier_invoice_items(supplier_invoice_id);

-- Money actually handed to a supplier. What is still OWED is simply
-- (sum of their invoices) − (sum of their payments); no running balance is stored,
-- so it can never drift out of step with the rows it is derived from.
CREATE TABLE IF NOT EXISTS supplier_payments (
    supplier_payment_id INTEGER PRIMARY KEY AUTOINCREMENT,
    supplier_id INTEGER NOT NULL REFERENCES suppliers(supplier_id),
    amount      REAL NOT NULL CHECK (amount > 0),
    paid_on     TEXT NOT NULL DEFAULT (date('now','localtime')),
    method      TEXT NOT NULL DEFAULT 'cash' CHECK (method IN ('cash','card','transfer')),
    notes       TEXT,
    created_by  INTEGER NOT NULL REFERENCES users(user_id),
    created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_supplier_payments_supplier ON supplier_payments(supplier_id);
CREATE INDEX IF NOT EXISTS idx_supplier_payments_date ON supplier_payments(paid_on);

-- Customer feedback notes (from WhatsApp campaigns)
CREATE TABLE IF NOT EXISTS customer_notes (
    note_id    INTEGER PRIMARY KEY AUTOINCREMENT,
    phone      TEXT NOT NULL,
    note       TEXT NOT NULL,
    created_by INTEGER NOT NULL REFERENCES users(user_id),
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_customer_notes_phone ON customer_notes(phone);

-- Saved customers (العملاء) — the part of the client book that does NOT come from
-- this database's own invoices.
--
-- The client book is normally built by grouping delivery orders on the phone number,
-- so it can never disagree with what was sold. That stops working the day a shop
-- starts fresh books: the invoices stay behind, and every customer with them. This
-- table is what carries them across — who they are, and what they had ordered up to
-- then — and customerService adds whatever they order from here on top.
CREATE TABLE IF NOT EXISTS customers (
    phone            TEXT PRIMARY KEY,
    name             TEXT,
    address          TEXT,
    delivery_area_id INTEGER REFERENCES delivery_areas(delivery_area_id),
    -- What they had ordered in the books they were brought over from.
    prior_orders     INTEGER NOT NULL DEFAULT 0,
    prior_spent      REAL NOT NULL DEFAULT 0,
    first_order_at   TEXT,
    last_order_at    TEXT,
    created_at       TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- Printers (الطابعات) — the thermal printers on the counter and in the kitchen.
--
-- Deliberately NOT business data: `clearAllBusinessData` leaves this table alone, so
-- handing the system over or starting the books again does not also mean plugging
-- four printers back in and reconfiguring each one.
--
-- `category_ids` is a JSON array naming the categories a kitchen station is
-- responsible for; NULL or '[]' means "everything", which is what a restaurant with
-- one kitchen printer wants. It is only read for kitchen/bar tickets — a customer's
-- receipt is never split up by category.
CREATE TABLE IF NOT EXISTS printers (
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
    -- Sound the printer's buzzer once the ticket is cut, so a kitchen that cannot see
    -- the printer knows an order has landed. Off by default: the buzzer is a Xinye
    -- extension, not core ESC/POS, and a model without a beeper may print the command
    -- instead of obeying it. Proven per printer with the test button beside it.
    beep          INTEGER NOT NULL DEFAULT 0,
    category_ids  TEXT,
    -- Which machine this printer is physically plugged into. 'any' is a network
    -- printer with its own IP, reachable from either till; 'master' / 'node' are USB
    -- printers, which only the machine they are attached to can drive.
    station       TEXT NOT NULL DEFAULT 'any',
    auto_print    INTEGER NOT NULL DEFAULT 1,
    is_active     INTEGER NOT NULL DEFAULT 1,
    display_order INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_printers_active ON printers(is_active, display_order);

-- Schema migrations tracker
CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- Indexes for analytics queries
CREATE INDEX IF NOT EXISTS idx_orders_created_at        ON orders(created_at);
CREATE INDEX IF NOT EXISTS idx_orders_status            ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_cashier_id        ON orders(cashier_id);
-- NOTE: the indexes on order_type and deleted_at are created in runMigrations(),
-- not here — same reason as idx_users_slot. Both columns are added by an ALTER in
-- that function, so on a database old enough to predate delivery orders they do not
-- exist yet at this point and indexing them would fail before the migration runs.
CREATE INDEX IF NOT EXISTS idx_order_items_order_id     ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_order_items_menu_item_id ON order_items(menu_item_id);
CREATE INDEX IF NOT EXISTS idx_menu_items_category      ON menu_items(category_id);
CREATE INDEX IF NOT EXISTS idx_menu_items_active        ON menu_items(is_active);
CREATE INDEX IF NOT EXISTS idx_stock_txn_menu_item      ON stock_transactions(menu_item_id);
CREATE INDEX IF NOT EXISTS idx_stock_txn_created_at     ON stock_transactions(created_at);
CREATE INDEX IF NOT EXISTS idx_expenses_date            ON expenses(expense_date);
CREATE INDEX IF NOT EXISTS idx_salaries_period          ON salaries(pay_period_start, pay_period_end);
CREATE INDEX IF NOT EXISTS idx_shifts_cashier_date      ON shifts(cashier_id, shift_date);
CREATE INDEX IF NOT EXISTS idx_worker_attendance_worker ON worker_attendance(worker_id, work_date);
CREATE INDEX IF NOT EXISTS idx_recipe_items_menu_item   ON recipe_items(menu_item_id);
CREATE INDEX IF NOT EXISTS idx_recipe_items_material    ON recipe_items(raw_material_id);
CREATE INDEX IF NOT EXISTS idx_rm_txn_material          ON raw_material_transactions(raw_material_id);
CREATE INDEX IF NOT EXISTS idx_rm_txn_order            ON raw_material_transactions(related_order_id);
CREATE INDEX IF NOT EXISTS idx_rm_txn_created_at        ON raw_material_transactions(created_at);
