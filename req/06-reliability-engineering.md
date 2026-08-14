# 06 — Reliability Engineering

## The honest framing, expanded

No shipped software is mathematically error-free — hardware fails, power cuts out mid-write, someone's finger slips on a touchscreen. What you're actually engineering toward is: **the error rate on anything touching money or stock approaches zero in practice, and when the rare failure does happen, you lose nothing and you can see exactly what occurred.** Everything below is in service of that, specifically for the Electron/React/Node stack, not generic advice.

## 1. Atomic transactions — the core of "no errors" for orders

The single most important reliability property this system needs: **an order and every stock deduction it triggers succeed or fail together, with nothing in between.** `better-sqlite3`'s `.transaction()` wrapper gives you this almost for free — if anything inside it throws, every change made so far inside that call is automatically rolled back.

```typescript
// src/main/services/orderService.ts
import db from '../db/db';

interface OrderLine { menuItemId: number; quantity: number }
interface CreateOrderInput {
  cashierId: number;
  items: OrderLine[];
  paymentType: 'cash' | 'card';
}

const insertOrder     = db.prepare(`INSERT INTO orders (cashier_id, subtotal, total_amount, payment_type) VALUES (?, 0, 0, ?)`);
const finalizeOrder    = db.prepare(`UPDATE orders SET subtotal = ?, total_amount = ? WHERE order_id = ?`);
const insertOrderItem  = db.prepare(`INSERT INTO order_items (order_id, menu_item_id, quantity, unit_price, unit_cost) VALUES (?, ?, ?, ?, ?)`);
const getMenuItem      = db.prepare(`SELECT * FROM menu_items WHERE item_id = ? AND is_active = 1`);
const getRecipe        = db.prepare(`SELECT * FROM recipes WHERE menu_item_id = ?`);
const getStock         = db.prepare(`SELECT current_stock FROM inventory WHERE inventory_id = ?`);
const deductStock      = db.prepare(`UPDATE inventory SET current_stock = current_stock - ? WHERE inventory_id = ?`);
const logStockTxn      = db.prepare(`INSERT INTO stock_transactions (inventory_id, change_amount, reason, related_order_id, created_by) VALUES (?, ?, 'sale', ?, ?)`);

// Everything inside this function is one atomic unit. Throw anywhere,
// and better-sqlite3 rolls back every INSERT/UPDATE made so far in this call —
// there is no state where the order exists but stock wasn't deducted, or vice versa.
export const createOrder = db.transaction((input: CreateOrderInput) => {
  const orderId = insertOrder.run(input.cashierId, input.paymentType).lastInsertRowid as number;
  let subtotal = 0;

  for (const line of input.items) {
    const menuItem = getMenuItem.get(line.menuItemId) as any;
    if (!menuItem) throw new Error(`Menu item ${line.menuItemId} not found or inactive`);

    insertOrderItem.run(orderId, line.menuItemId, line.quantity, menuItem.price, menuItem.cost_price);
    subtotal += menuItem.price * line.quantity;

    for (const ing of getRecipe.all(line.menuItemId) as any[]) {
      const needed = ing.quantity_required * line.quantity;
      const stock = getStock.get(ing.inventory_id) as any;
      if (!stock || stock.current_stock < needed) {
        // Throwing here rolls back the ENTIRE order, not just this line.
        // The cashier sees one clear error; nothing partial was ever saved.
        throw new Error(`Not enough stock for "${menuItem.name}"`);
      }
      deductStock.run(needed, ing.inventory_id);
      logStockTxn.run(ing.inventory_id, -needed, orderId, input.cashierId);
    }
  }

  finalizeOrder.run(subtotal, subtotal, orderId); // add tax/discount logic as needed
  return orderId;
});
```

The IPC handler that calls this wraps it in a try/catch and returns `{success: false, error: message}` rather than letting an exception cross the IPC boundary uncleanly — the renderer should always get a predictable shape back, never a raw stack trace.

## 2. WAL mode — surviving a crash or power loss without corruption

```typescript
// src/main/db/db.ts
import Database from 'better-sqlite3';
import path from 'node:path';
import { app } from 'electron';

const dbPath = path.join(app.getPath('userData'), 'restaurant.db');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');    // writes go to a separate log first; a crash mid-write can't corrupt the main file
db.pragma('synchronous = NORMAL');  // the standard, safe pairing with WAL — good durability without a heavy fsync on every write
db.pragma('foreign_keys = ON');     // SQLite doesn't enforce FKs by default — you have to ask for it, every connection

export default db;
```

## 3. The mistake almost everyone makes first: where the database file lives

**Do not** put the `.db` file next to the installed executable (e.g., under `Program Files`). Standard (non-admin) Windows users don't have write access there, and the folder can be wiped on reinstall or auto-update anyway. `app.getPath('userData')` resolves to a proper per-user, writable location (`C:\Users\<name>\AppData\Roaming\<YourAppName>` on Windows) and is the only correct place for a local database, log files, and backups. This single line (`path.join(app.getPath('userData'), 'restaurant.db')`, shown above) prevents an entire category of "works on my machine, breaks on the install" bugs.

## 4. Global error handling — don't let one bad exception take down the till

**Main process** — catch what would otherwise silently kill the app:
```typescript
process.on('uncaughtException', (err) => {
  log.error('Uncaught exception in main process:', err);
  // do NOT app.quit() here for a POS app — log it, keep the window alive if at all possible
});
process.on('unhandledRejection', (reason) => {
  log.error('Unhandled promise rejection:', reason);
});
```

**Renderer process** — a crashed renderer (e.g., an out-of-memory hiccup) doesn't have to mean a dead app:
```typescript
// in main.ts, after creating the BrowserWindow
mainWindow.webContents.on('render-process-gone', (event, details) => {
  log.error('Renderer process gone:', details.reason);
  mainWindow.reload(); // recover automatically instead of leaving the cashier staring at a black screen
});
```

Wrap the React tree in an Error Boundary so a component-level exception shows a friendly "something went wrong, your cart is safe" message instead of a blank white screen — the order data already lives in Main/SQLite by the time it's confirmed, so a renderer-side UI crash after checkout doesn't lose the sale.

## 5. Logging: `electron-log`

Generic Node loggers (Winston, Pino) don't know about Electron's per-OS file locations or that logs can come from *two* processes. `electron-log` does:

```typescript
import log from 'electron-log/main';
log.initialize();
log.info('App started', { version: app.getVersion() });
```

Point every `catch` block at `log.error(...)` with enough context to reconstruct what happened, not just the error message. When something goes wrong three weeks from now, "insufficient stock for item 47, order attempt at 14:32" is the difference between a five-minute fix and a guessing game.

## 6. Backups

`better-sqlite3` has a built-in hot-backup API — it doesn't lock the database or interrupt anyone mid-order:

```typescript
import path from 'node:path';
import { app } from 'electron';

export async function runBackup() {
  const backupDir = path.join(app.getPath('userData'), 'backups');
  const filename = `restaurant-${new Date().toISOString().slice(0, 10)}.db`;
  await db.backup(path.join(backupDir, filename));
  // keep the last 30; delete older ones
}
```

**Don't schedule this for "every night at closing time"** the way your draft did — that assumes the app is actually running at that exact moment, which won't always be true (the PC might be off). More robust: check on every app launch whether more than ~20 hours have passed since the last backup, and if so, run one then; also run one on clean app shutdown (`app.on('before-quit', ...)`). Add a manual "Back Up Now" button in Owner Settings for peace of mind before anything risky (an update, a bulk menu change).

## 7. Security — the Electron-specific part your original draft had zero coverage of

```typescript
// main.ts — the BrowserWindow config that matters most
new BrowserWindow({
  webPreferences: {
    preload: path.join(__dirname, 'preload.js'),
    contextIsolation: true,   // renderer and Node context are fully separated
    nodeIntegration: false,   // renderer NEVER gets direct Node access — no exceptions
    sandbox: true,
  },
});
```

```typescript
// preload.ts — the ONLY functions the renderer is allowed to call
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('api', {
  login: (username: string, password: string) => ipcRenderer.invoke('auth:login', { username, password }),
  getMenu: () => ipcRenderer.invoke('menu:list'),
  createOrder: (order: CreateOrderInput) => ipcRenderer.invoke('order:create', order),
  onLowStock: (cb: (data: LowStockEvent) => void) => ipcRenderer.on('app:lowStockAlert', (_e, data) => cb(data)),
});
```

Passwords/PINs: `bcryptjs`, never stored in plaintext, never logged (double-check your `electron-log` calls don't accidentally include a raw password object). Every IPC handler re-verifies the caller's role server-side (in Main), never trusting a role claim sent from the renderer — see the note in `01-architecture.md`.

## 8. Testing

- **Vitest** for the service layer — `OrderService`, `StockService`, etc. are plain functions against a real (temporary, file-based) SQLite database, so you're testing actual SQL behavior, not mocks. Write a test that specifically asserts: creating an order with insufficient stock throws, and afterward the stock level and order count are *unchanged* — proving the rollback actually works, not just trusting that it does.
- **Playwright** has first-class Electron support (`_electron.launch()`) — drive the actual packaged app through a full login → order → checkout flow before every release. This catches the class of bug that only shows up in the real Main/Renderer/IPC wiring, which unit tests on the service layer alone can't see.

## 9. Recovering from a crash mid-order

Because the transaction in section 1 is atomic, a crash mid-checkout leaves you in exactly one of two states: the order committed (cashier sees it on next launch, in `order:list`) or it didn't (nothing was saved, the cashier just re-enters the order). There is no third, corrupted state to recover from — which is the entire point of building it this way instead of writing the order and deducting stock as separate, non-transactional steps.
