# 08 — Build Roadmap

A suggested order, not a schedule — I don't know your pace, so these are phases to complete in order, not weeks to block out. Each phase should be a working, runnable app; don't move on with a broken one.

## Phase 0 — Skeleton
- Scaffold with `electron-vite` (React + TypeScript template)
- Wire up `better-sqlite3` with the `postinstall` rebuild + `asarUnpack` + `external` config from `07-packaging-and-deployment.md` **now**, not when you first try to package — confirming this works on day one saves you a confusing debugging session in week six.
- Run the schema from `03-database-schema.md` against a fresh `.db` file at `app.getPath('userData')`
- One `BrowserWindow` with `contextIsolation: true` / `nodeIntegration: false`, a preload script exposing nothing yet, and a blank React screen that proves the pipe works end to end

## Phase 1 — MVP: someone can actually sell something
- `auth:login` (owner, full username/password) and `auth:loginByPin` (cashier)
- Menu management screen (owner): add/edit categories and items — start with **simple stock** (`menu_items.stock_quantity`), not the recipe system, per the note in `03-database-schema.md`
- POS screen (cashier): category tabs, item grid, cart, checkout
- `order:create` using the atomic transaction pattern from `06-reliability-engineering.md` — this is the one piece of business logic worth getting exactly right before anything else, since everything downstream (analytics, stock accuracy) depends on it being correct
- Basic receipt printing (even just "print to default printer" via Electron's built-in print, no ESC/POS yet)

*You have a usable till at the end of this phase. Everything after this is valuable but not blocking.*

## Phase 2 — Owner actually gets value beyond ringing up orders
- Order history screen, both roles
- Inventory screen (owner): restock, low-stock flag, `stock_transactions` logging
- Analytics dashboard from `05-analytics-dashboard.md` — start with the summary cards + trend chart, then best/worst sellers, then the menu-engineering scatter plot last (it's the most "cool," but also the least essential of the three)

## Phase 3 — Harden it
- WAL mode + backup routine (should already be in from Phase 0, but this is the checkpoint to verify it)
- Global error handling (`uncaughtException`, `render-process-gone`, React Error Boundary)
- `electron-log` wired into every service's catch blocks
- Vitest suite for `OrderService` specifically — including the "insufficient stock rolls back cleanly" test from `06-reliability-engineering.md`
- Void flow with owner-PIN gate

## Phase 4 — Ship it
- `electron-builder` NSIS installer, tested via a clean install on a machine that isn't your dev box
- Settings screen (tax rate, receipt header, discount limits)
- User management screen (owner creates/deactivates cashier logins)

## Phase 5 — Optional, later
- Recipe-based stock (migrate from simple stock once you know which items actually need ingredient-level tracking)
- A second networked terminal (see the note at the end of `01-architecture.md`)
- `electron-updater` auto-updates
- Export reports to CSV/PDF
- Forecasting — only once you have real historical data to forecast from

Nothing in Phase 5 blocks anything in Phases 0–4. Build in order, and you have a real, reliable POS running the till well before you need to think about any of it.
