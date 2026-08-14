# 02 — Tech Stack

Your call was Electron + React + Node.js. Everything here fits inside that — I'm not second-guessing the stack, just filling in the specific libraries and explaining the ones where the choice actually matters.

A note on version numbers: I checked current versions while writing this (August 2026) rather than relying on possibly-stale memory, since this ecosystem moves fast. I'm giving you the real current ballpark, not guesses — but check npm yourself before you `npm install`, because "current" has a shelf life of about a week in this world.

## The stack, at a glance

| Layer | Choice | Current version (Aug 2026) |
|---|---|---|
| Shell | Electron | 42.x stable (v41.x also still maintained) |
| UI | React + TypeScript | React 18/19 line, TS 5.x |
| Build tool | electron-vite | fast HMR, purpose-built for Electron's main/preload/renderer split |
| Database | SQLite via `better-sqlite3` | see the honest discussion below |
| State/data | Zustand (UI state) + TanStack Query (server state) | — |
| Charts | Recharts | — |
| Logging | electron-log | — |
| Packaging | electron-builder | NSIS target for Windows |
| Password hashing | bcryptjs | pure JS — see why below |
| Testing | Vitest (unit) + Playwright (E2E, has Electron support) | — |

## Why TypeScript, specifically (this is the highest-leverage single decision here)

You asked for a system that runs "with 100% success, no error." No single tool gets you closer to that than switching from JavaScript to TypeScript. A large share of real-world JS bugs — `undefined is not a function`, a typo in an object property name, passing a string where a number was expected, forgetting a field when building an order object — are **caught at compile time by TypeScript and would otherwise only surface at runtime, in front of a cashier, mid-order.** It costs you a bit of upfront learning if you haven't used it. It is worth that cost for a system that touches money. I'm writing every code example in these docs in TypeScript for this reason.

## Database driver: `better-sqlite3` vs the newer built-in `node:sqlite` — the honest version

This is worth explaining rather than just asserting, because the "right" answer here has been shifting under everyone's feet:

- **`better-sqlite3`** is a mature, battle-tested native module. Synchronous API, a built-in `.transaction()` helper (which is exactly what you want for the order+stock-deduction pattern — see `06-reliability-engineering.md`), a `.backup()` method for hot backups, and years of production use behind it.
- **`node:sqlite`** is Node.js's own built-in SQLite module — no npm install, no native compilation. As of early 2026 it reached Release Candidate status (Node's "Stability 1.2") in standalone Node.js 25.7+. That's a real, fast-moving upgrade in credibility.
- **The catch for Electron specifically:** Electron bundles its *own* copy of Node.js, and that bundled version tends to lag several months behind the Node.js you'd install standalone. Whether the Electron version you're building against ships a `node:sqlite` mature enough to trust in production is genuinely something you need to check yourself, not something I can promise you from here — run `process.versions.node` in your Main process and compare it against Node's current `node:sqlite` stability notes for that exact version.
- **My recommendation right now: `better-sqlite3`.** It's the safer bet today specifically *because* of the native-module packaging pain, not despite it — that pain is well-documented, has a known fix (covered in `07-packaging-and-deployment.md`), and is a one-time setup cost. `node:sqlite`'s zero-install story is genuinely appealing and worth revisiting in 6–12 months as Electron's bundled Node version catches up to the RC/stable releases — but "genuinely appealing later" isn't the same as "ready to bet a restaurant's checkout flow on today."

No ORM (no Prisma, no TypeORM). At this schema size, an ORM buys you convenience and costs you an abstraction layer that makes bugs harder to see — and Prisma specifically has its own native-binary packaging problems inside Electron, which is exactly the class of problem you're trying to minimize. Raw parameterized SQL, in a thin `services/` layer, is more code upfront and much easier to debug at 11pm when something's wrong. If the schema grows a lot later, **Drizzle ORM** is the one worth a second look — it's just TypeScript (no separate native engine), and it works directly on top of `better-sqlite3`.

## Password hashing: `bcryptjs`, not `bcrypt` or `argon2`

Both `bcrypt` and `argon2` are native modules — meaning you'd have *two* native dependencies to fight through Electron's rebuild/packaging process instead of one. `bcryptjs` is a well-regarded pure-JavaScript implementation, slightly slower per hash, which is irrelevant here — you're authenticating a cashier a few times a shift, not serving a public API. One fewer native module is one fewer way for `npm install` to fail on someone else's machine. Use it for both the Owner's password and the Cashier's PIN.

## Charts: Recharts

Composable, works naturally with React (each chart is just JSX), handles the line/bar/pie charts you need for the analytics dashboard without fighting the library. Alternatives worth knowing about: **Chart.js** (canvas-based, slightly better raw performance on very large datasets, less "React-native" API), **Nivo** (prettier defaults, heavier). For a restaurant dashboard's data volumes, this difference is cosmetic — Recharts is the pragmatic default.

## State management: Zustand + TanStack Query, not Redux

Redux is more machinery than this app needs. Split state into two honest categories:
- **Server state** (menu items, orders, stock, analytics — anything that lives in the database) → **TanStack Query**, which handles caching, refetching, and loading/error states for you, wrapping calls to `window.api.*`.
- **UI-only state** (the current cart before checkout, which screen is active) → **Zustand**, a few lines of setup, no boilerplate.

## Install commands

```bash
# Scaffold
npm create @quick-start/electron@latest -- --template react-ts
# (or: npm create electron-vite@latest -- --template react-ts)

cd your-app-name

# Runtime dependencies
npm install better-sqlite3 bcryptjs electron-log zustand @tanstack/react-query recharts

# Dev dependencies
npm install -D typescript @electron/rebuild vitest playwright electron-builder
```

## What to actively avoid

- **`nodeIntegration: true`** on any `BrowserWindow`. Ever. This hands the renderer (your React UI, running Chromium) direct access to Node.js and the filesystem, which defeats the entire point of the Main/Renderer split covered in `01-architecture.md`. There is no version of this app where that trade-off makes sense.
- **Storing the database file next to the installed app** (e.g., in `Program Files`). Standard Windows users don't have write access there, and the folder gets wiped on reinstall/update anyway. Use `app.getPath('userData')` — covered in detail in `06-reliability-engineering.md`, because it's the single most common first-timer mistake in Electron apps that touch a local database.
- **A local Express server "just because it's familiar,"** on a single-machine app. Covered in `01-architecture.md` — it adds a firewall-prompt failure mode for zero benefit until you actually have a second terminal.
