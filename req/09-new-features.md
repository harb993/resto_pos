# 09 — New Features (Update)

This is additive to `01-architecture.md` and `03-database-schema.md` — I haven't gone back and edited those files, since you asked for this as its own doc. Everything below is written the same way: schema first, reasoning where a real decision had to be made, then the IPC channels and a single migration file at the end you can drop straight into `/src/main/db/migrations/`.

## 1. Order types: dine-in, takeaway, delivery — with delivery capturing customer details

```sql
ALTER TABLE orders ADD COLUMN order_type TEXT NOT NULL DEFAULT 'dine_in'
    CHECK (order_type IN ('dine_in','takeaway','delivery'));
ALTER TABLE orders ADD COLUMN customer_name    TEXT;
ALTER TABLE orders ADD COLUMN customer_phone   TEXT;
ALTER TABLE orders ADD COLUMN customer_address TEXT;
ALTER TABLE orders ADD COLUMN delivery_area_id INTEGER REFERENCES delivery_areas(delivery_area_id);
ALTER TABLE orders ADD COLUMN delivery_fee     REAL DEFAULT 0;
ALTER TABLE orders ADD COLUMN driver_id        INTEGER REFERENCES delivery_drivers(driver_id);
```

On the POS screen, the cashier picks the order type first, before adding items — it changes what the checkout form asks for. Dine-in and takeaway need nothing extra. Delivery requires `customer_name` and `customer_phone` before checkout is allowed (make these required in the UI, not just the DB), with `customer_address` and area/driver selection following. The receipt template branches on `order_type`: dine-in/takeaway print the standard item list and total; delivery additionally prints the customer's name, phone, address, and the delivery fee as its own line item — the driver needs that printed slip in hand.

## 2. Ingredient-level stock: chicken pieces, rice, sauce

"Every chicken has 8 pieces" is a **yield conversion**, not a simple stock count — you receive/track whole chickens, but you cook and sell in pieces. Modeling this as its own table means the ratio isn't hardcoded anywhere in your code, and it generalizes to anything else you butcher, portion, or batch-cook later (rice by the pot, sauce by the batch).

```sql
CREATE TABLE stock_conversions (
    conversion_id       INTEGER PRIMARY KEY AUTOINCREMENT,
    source_inventory_id INTEGER NOT NULL REFERENCES inventory(inventory_id),  -- e.g. "Whole Chicken"
    output_inventory_id INTEGER NOT NULL REFERENCES inventory(inventory_id),  -- e.g. "Chicken Piece"
    yield_quantity       REAL NOT NULL CHECK (yield_quantity > 0)              -- 8
);
```

Set up three `inventory` rows: `Whole Chicken` (unit: pieces, meaning whole birds), `Chicken Piece` (unit: pieces, meaning ready-to-cook parts), `Rice` (unit: kg), `Sauce – [name]` (unit: ml or "batches", one row per sauce). One `stock_conversions` row: source = Whole Chicken, output = Chicken Piece, yield = 8. When someone in the kitchen breaks down 5 whole chickens, the owner (or a kitchen-staff login, if you add one later) records "5 conversions" — the system deducts 5 from Whole Chicken and adds 5 × 8 = 40 to Chicken Piece, both logged to `stock_transactions` with `reason = 'adjustment'`. Recipes for menu items (a "2-Piece Combo," say) then reference **Chicken Piece**, not Whole Chicken — `recipes.inventory_id` points at the Chicken Piece row, `quantity_required = 2`. Rice and sauce need no conversion step; they're just `inventory` rows consumed directly by recipes, in whatever unit you portion them in.

**This changes something I told you in `03-database-schema.md`.** I'd suggested starting with "simple stock" (a plain quantity on `menu_items`) and deferring the full `inventory`/`recipes` system. Given you specifically need piece-level chicken counting plus rice and sauce, that shortcut doesn't get you what you actually need — build the recipe-based system from Phase 1, not Phase 5. It's more setup work upfront (defining every item's recipe before stock tracking means anything), but there's no version of "count every chicken part" that works without it.

## 3. Expenses and salaries

**On permissions — this needed a judgment call, flagged up top.** Cashiers logging day-to-day expenses (bought more oil, paid for ice, gave the driver gas money) is completely normal and matches how small restaurants actually run their till. Cashiers *editing salary figures* is a different kind of risk — it's sensitive data about coworkers' pay, and a cashier who can edit it can inflate their own. So: cashiers can **add** expense entries (not edit or delete ones they didn't create — only the owner can correct/remove an expense), and salaries are **owner-only**, full stop, for both entry and viewing. If you actually want cashiers touching salary data too, say so and I'll change it — but I wouldn't ship it that way by default.

Salaries are tracked against a `workers` table, not `users` — your kitchen staff and cleaners get paid too, and they don't need a POS login to do it.

```sql
CREATE TABLE workers (
    worker_id      INTEGER PRIMARY KEY AUTOINCREMENT,
    full_name      TEXT NOT NULL,
    role_title     TEXT,                                   -- 'cashier', 'cook', 'cleaner' — free text, not the login role
    is_active      INTEGER NOT NULL DEFAULT 1,
    linked_user_id INTEGER REFERENCES users(user_id)        -- set only if this worker also logs into the POS
);

CREATE TABLE expenses (
    expense_id   INTEGER PRIMARY KEY AUTOINCREMENT,
    category     TEXT NOT NULL CHECK (category IN ('ingredients','utilities','maintenance','delivery','other')),
    description  TEXT,
    amount       REAL NOT NULL CHECK (amount >= 0),
    recorded_by  INTEGER NOT NULL REFERENCES users(user_id),
    expense_date TEXT NOT NULL DEFAULT (date('now')),
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE salaries (
    salary_id        INTEGER PRIMARY KEY AUTOINCREMENT,
    worker_id        INTEGER NOT NULL REFERENCES workers(worker_id),
    amount           REAL NOT NULL CHECK (amount >= 0),
    pay_period_start TEXT NOT NULL,
    pay_period_end   TEXT NOT NULL,
    paid_on          TEXT,
    created_by       INTEGER NOT NULL REFERENCES users(user_id),   -- always the owner
    created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
```

## 4. Excel reporting for the owner and accountant

One export feature, several report types, flexible period selection — day / week / month presets, or a custom start–end range ("form...to" → I read as "from...to").

```typescript
// src/main/services/reportService.ts
import ExcelJS from 'exceljs';
import { dialog } from 'electron';
import db from '../db/db';

interface Period { start: string; end: string } // 'YYYY-MM-DD'

export async function exportFinancialReport(period: Period) {
  const workbook = new ExcelJS.Workbook();

  const sales = workbook.addWorksheet('Sales');
  sales.columns = [
    { header: 'Date', key: 'date', width: 14 },
    { header: 'Orders', key: 'orders', width: 10 },
    { header: 'Revenue', key: 'revenue', width: 14 },
  ];
  sales.addRows(db.prepare(`
    SELECT date(created_at) AS date, COUNT(*) AS orders, SUM(total_amount) AS revenue
    FROM orders WHERE status = 'completed' AND date(created_at) BETWEEN ? AND ?
    GROUP BY date ORDER BY date
  `).all(period.start, period.end));

  const expenses = workbook.addWorksheet('Expenses');
  expenses.columns = [
    { header: 'Date', key: 'expense_date', width: 14 },
    { header: 'Category', key: 'category', width: 14 },
    { header: 'Description', key: 'description', width: 30 },
    { header: 'Amount', key: 'amount', width: 12 },
  ];
  expenses.addRows(db.prepare(`
    SELECT expense_date, category, description, amount FROM expenses
    WHERE expense_date BETWEEN ? AND ? ORDER BY expense_date
  `).all(period.start, period.end));

  const salaries = workbook.addWorksheet('Salaries');
  salaries.columns = [
    { header: 'Worker', key: 'full_name', width: 20 },
    { header: 'Period', key: 'period', width: 22 },
    { header: 'Amount', key: 'amount', width: 12 },
    { header: 'Paid On', key: 'paid_on', width: 14 },
  ];
  salaries.addRows(db.prepare(`
    SELECT w.full_name, s.pay_period_start || ' to ' || s.pay_period_end AS period, s.amount, s.paid_on
    FROM salaries s JOIN workers w ON w.worker_id = s.worker_id
    WHERE s.pay_period_start >= ? AND s.pay_period_end <= ?
  `).all(period.start, period.end));

  // Profit Summary — gross vs. net, the way an accountant actually wants to see it
  const revenue  = (db.prepare(`SELECT COALESCE(SUM(total_amount),0) AS v FROM orders WHERE status='completed' AND date(created_at) BETWEEN ? AND ?`).get(period.start, period.end) as any).v;
  const cogs     = (db.prepare(`SELECT COALESCE(SUM(oi.quantity * oi.unit_cost),0) AS v FROM order_items oi JOIN orders o ON o.order_id = oi.order_id WHERE o.status='completed' AND date(o.created_at) BETWEEN ? AND ?`).get(period.start, period.end) as any).v;
  const expTotal = (db.prepare(`SELECT COALESCE(SUM(amount),0) AS v FROM expenses WHERE expense_date BETWEEN ? AND ?`).get(period.start, period.end) as any).v;
  const salTotal = (db.prepare(`SELECT COALESCE(SUM(amount),0) AS v FROM salaries WHERE pay_period_start >= ? AND pay_period_end <= ?`).get(period.start, period.end) as any).v;

  const summary = workbook.addWorksheet('Profit Summary');
  summary.addRows([
    { label: 'Revenue',           value: revenue },
    { label: 'Cost of Goods Sold', value: -cogs },
    { label: 'Gross Profit',       value: revenue - cogs },
    { label: 'Operating Expenses', value: -expTotal },
    { label: 'Salaries',           value: -salTotal },
    { label: 'Net Profit',         value: revenue - cogs - expTotal - salTotal },
  ]);

  const { filePath } = await dialog.showSaveDialog({
    defaultPath: `report-${period.start}-to-${period.end}.xlsx`,
    filters: [{ name: 'Excel', extensions: ['xlsx'] }],
  });
  if (filePath) await workbook.xlsx.writeFile(filePath);
}
```

`npm install exceljs` — it's the standard, well-maintained library for generating real `.xlsx` files from Node (not CSV-with-an-.xlsx-extension). The period presets (day/week/month) just compute `{start, end}` before calling this same function — `day` → today's date twice, `week` → Monday of this week through today, `month` → the 1st through today (or the full prior month, your call), `custom` → whatever the owner picks in a date-range field.

**Profit, done properly:** Gross Profit = Revenue − Cost of Goods Sold (using the `unit_cost` captured on each order line, same field the analytics dashboard uses). Net Profit = Gross Profit − Operating Expenses − Salaries. This is why `order_items.unit_cost` being captured at time of sale (from `03-database-schema.md`) matters beyond the analytics dashboard — it's the number this whole report is built on.

## 5. Cashier shift tracking, and deleting an invoice

**Shifts** — since hours vary day to day rather than following a fixed schedule, this is the owner recording actual start/end times per cashier per day, not a recurring roster:

```sql
CREATE TABLE shifts (
    shift_id   INTEGER PRIMARY KEY AUTOINCREMENT,
    cashier_id INTEGER NOT NULL REFERENCES users(user_id),
    shift_date TEXT NOT NULL,
    start_time TEXT,     -- ISO datetime
    end_time   TEXT,     -- ISO datetime
    set_by     INTEGER NOT NULL REFERENCES users(user_id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

This also gives you "sales by shift," not just "sales by day," for free — filter the analytics queries in `05-analytics-dashboard.md` by joining `orders.cashier_id` + `created_at` against a shift's window, useful for seeing which shift is actually busy.

**Deleting an invoice — built as soft delete, and here's why.** A true `DELETE FROM orders` removes the row permanently: if a customer disputes a charge, if your numbers don't reconcile at month-end, or if you're ever audited, that record is just gone, with nothing to show what happened. If you're issuing invoices through Egypt's e-invoicing system (or any similar tax authority requirement), permanently deleting an already-issued invoice may not even be compliant — that's a question for your accountant, not for me, since I don't know your exact registration status or what the ETA requires in your case. What I built instead gets you the experience you asked for — the owner removes an invoice and it's gone from every list and report — while keeping the underlying row intact:

```sql
ALTER TABLE orders ADD COLUMN deleted_at TEXT;
ALTER TABLE orders ADD COLUMN deleted_by INTEGER REFERENCES users(user_id);
```

Every query in `05-analytics-dashboard.md` and the reports above should add `AND deleted_at IS NULL`. If you decide after talking to your accountant that true deletion is fine for your situation, that's a one-line change to the `order:delete` handler — but I'd rather hand you the safer default and let you consciously opt out of it than the other way around.

## 6. Low-stock notifications

Already designed — this is the `app:lowStockAlert` push channel and the `idx_inventory_reorder` index from `01-architecture.md` / `03-database-schema.md`. Two small additions worth making while you're in there: fire it off `stock_conversions` too, not just direct sales (breaking down your last few whole chickens should trigger the same alert as selling out), and pair the in-app badge with a native Windows toast via Electron's `Notification` API so a low-stock warning doesn't get missed if the owner's tabbed away from the dashboard:

```typescript
import { Notification } from 'electron';
new Notification({ title: 'Low Stock', body: `${itemName} is down to ${currentQty}` }).show();
```

## 7. Delivery pricing per area, and driver management

```sql
CREATE TABLE delivery_areas (
    delivery_area_id INTEGER PRIMARY KEY AUTOINCREMENT,
    area_name         TEXT NOT NULL,
    delivery_fee      REAL NOT NULL CHECK (delivery_fee >= 0),
    is_active         INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE delivery_drivers (
    driver_id  INTEGER PRIMARY KEY AUTOINCREMENT,
    full_name  TEXT NOT NULL,
    phone      TEXT,
    is_active  INTEGER NOT NULL DEFAULT 1
);
```

Owner manages both lists from Settings. On a delivery order, the cashier picks the area from a dropdown — the fee auto-fills onto the order (`orders.delivery_fee`, from section 1) — and assigns a driver, either at order time or later once someone's free to go.

## 8. Menu item variants (spicy / normal)

Built as a general variant system rather than a single hardcoded "spicy" flag, so you're not doing a schema change the next time you want a size option, an extra-sauce add-on, or anything else that isn't a whole new menu item:

```sql
CREATE TABLE item_variant_groups (
    variant_group_id INTEGER PRIMARY KEY AUTOINCREMENT,
    menu_item_id      INTEGER NOT NULL REFERENCES menu_items(item_id),
    group_name        TEXT NOT NULL              -- e.g. 'Spice Level'
);

CREATE TABLE item_variant_options (
    variant_option_id INTEGER PRIMARY KEY AUTOINCREMENT,
    variant_group_id   INTEGER NOT NULL REFERENCES item_variant_groups(variant_group_id),
    option_name         TEXT NOT NULL,            -- 'Spicy' / 'Normal'
    price_delta         REAL NOT NULL DEFAULT 0    -- non-zero if one option costs more
);

ALTER TABLE order_items ADD COLUMN variant_label TEXT;  -- e.g. "Spicy" — captured as text at time of sale
```

`variant_label` is stored as plain text on the order line, the same way `unit_price`/`unit_cost` are copied rather than looked up later — if you ever rename or remove "Spicy" as an option, last month's orders still read correctly.

## New IPC channels

| Channel | Direction | Purpose |
|---|---|---|
| `order:setType` | Renderer → Main | Set order type + customer/delivery details before checkout |
| `expenses:add` | Renderer → Main | Log an expense — any logged-in user |
| `expenses:list` / `expenses:delete` | Renderer → Main | View/remove expenses — **owner only** for delete |
| `salaries:upsert` / `salaries:list` | Renderer → Main | Full CRUD — **owner only** |
| `workers:upsert` / `workers:list` | Renderer → Main | Manage staff roster — **owner only** |
| `shifts:upsert` / `shifts:list` | Renderer → Main | Set/view cashier shift hours — **owner only** to write |
| `order:delete` | Renderer → Main | Soft-delete an invoice — **owner only** |
| `stock:convert` | Renderer → Main | Record a yield conversion (e.g. chicken → pieces) |
| `delivery:areas:upsert` / `list` | Renderer → Main | Manage delivery zones + pricing — **owner only** to write |
| `delivery:drivers:upsert` / `list` | Renderer → Main | Manage driver roster — **owner only** to write |
| `menu:variants:upsert` | Renderer → Main | Manage variant groups/options per item — **owner only** |
| `reports:exportExcel` | Renderer → Main | Generate and save the `.xlsx` report — **owner only** |

## Consolidated migration

Drop this as `009_new_features.sql` in `/src/main/db/migrations/`, per the migration practice from `03-database-schema.md`:

```sql
-- Order types & delivery
ALTER TABLE orders ADD COLUMN order_type TEXT NOT NULL DEFAULT 'dine_in'
    CHECK (order_type IN ('dine_in','takeaway','delivery'));
ALTER TABLE orders ADD COLUMN customer_name    TEXT;
ALTER TABLE orders ADD COLUMN customer_phone   TEXT;
ALTER TABLE orders ADD COLUMN customer_address TEXT;
ALTER TABLE orders ADD COLUMN delivery_fee     REAL DEFAULT 0;
ALTER TABLE orders ADD COLUMN deleted_at       TEXT;
ALTER TABLE orders ADD COLUMN deleted_by       INTEGER REFERENCES users(user_id);
ALTER TABLE order_items ADD COLUMN variant_label TEXT;

CREATE TABLE delivery_areas (
    delivery_area_id INTEGER PRIMARY KEY AUTOINCREMENT,
    area_name TEXT NOT NULL,
    delivery_fee REAL NOT NULL CHECK (delivery_fee >= 0),
    is_active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE delivery_drivers (
    driver_id INTEGER PRIMARY KEY AUTOINCREMENT,
    full_name TEXT NOT NULL,
    phone TEXT,
    is_active INTEGER NOT NULL DEFAULT 1
);
ALTER TABLE orders ADD COLUMN delivery_area_id INTEGER REFERENCES delivery_areas(delivery_area_id);
ALTER TABLE orders ADD COLUMN driver_id        INTEGER REFERENCES delivery_drivers(driver_id);

CREATE TABLE stock_conversions (
    conversion_id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_inventory_id INTEGER NOT NULL REFERENCES inventory(inventory_id),
    output_inventory_id INTEGER NOT NULL REFERENCES inventory(inventory_id),
    yield_quantity REAL NOT NULL CHECK (yield_quantity > 0)
);

CREATE TABLE workers (
    worker_id INTEGER PRIMARY KEY AUTOINCREMENT,
    full_name TEXT NOT NULL,
    role_title TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    linked_user_id INTEGER REFERENCES users(user_id)
);
CREATE TABLE expenses (
    expense_id INTEGER PRIMARY KEY AUTOINCREMENT,
    category TEXT NOT NULL CHECK (category IN ('ingredients','utilities','maintenance','delivery','other')),
    description TEXT,
    amount REAL NOT NULL CHECK (amount >= 0),
    recorded_by INTEGER NOT NULL REFERENCES users(user_id),
    expense_date TEXT NOT NULL DEFAULT (date('now')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE salaries (
    salary_id INTEGER PRIMARY KEY AUTOINCREMENT,
    worker_id INTEGER NOT NULL REFERENCES workers(worker_id),
    amount REAL NOT NULL CHECK (amount >= 0),
    pay_period_start TEXT NOT NULL,
    pay_period_end TEXT NOT NULL,
    paid_on TEXT,
    created_by INTEGER NOT NULL REFERENCES users(user_id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE shifts (
    shift_id INTEGER PRIMARY KEY AUTOINCREMENT,
    cashier_id INTEGER NOT NULL REFERENCES users(user_id),
    shift_date TEXT NOT NULL,
    start_time TEXT,
    end_time TEXT,
    set_by INTEGER NOT NULL REFERENCES users(user_id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE item_variant_groups (
    variant_group_id INTEGER PRIMARY KEY AUTOINCREMENT,
    menu_item_id INTEGER NOT NULL REFERENCES menu_items(item_id),
    group_name TEXT NOT NULL
);
CREATE TABLE item_variant_options (
    variant_option_id INTEGER PRIMARY KEY AUTOINCREMENT,
    variant_group_id INTEGER NOT NULL REFERENCES item_variant_groups(variant_group_id),
    option_name TEXT NOT NULL,
    price_delta REAL NOT NULL DEFAULT 0
);

CREATE INDEX idx_orders_order_type ON orders(order_type);
CREATE INDEX idx_orders_deleted_at ON orders(deleted_at);
CREATE INDEX idx_expenses_date ON expenses(expense_date);
CREATE INDEX idx_salaries_period ON salaries(pay_period_start, pay_period_end);
CREATE INDEX idx_shifts_cashier_date ON shifts(cashier_id, shift_date);
```
