# Fried Chicken Restaurant — POS & Management System
### System Design & Engineering Docs — v2 (Electron + React + Node.js)

This replaces the draft you shared. That draft was architected for **.NET 8 (WPF/WinUI3, C#, SQLite via Dapper/EF Core)**. You've now told me the real stack is **Electron + React + Node.js**, and those two worlds don't share much below the UI layer — different process model, different security model, different database driver, different packaging story. So this isn't a find-and-replace; the parts that were stack-specific got rebuilt, and the parts that were good ideas regardless of stack got kept and sharpened.

## What changed from your draft, and why

| Your draft | This version | Why |
|---|---|---|
| .NET 8 WPF/WinUI3 + C# | Electron + React + TypeScript + Node.js | You told me this is what you're building in |
| Dapper / EF Core | `better-sqlite3`, raw SQL + a thin service layer | No .NET, no ORM needed at this scale — raw SQL is more transparent and easier to debug for a small app |
| No process/security architecture | Full Main / Preload / Renderer breakdown with `contextIsolation` | Electron has an entire security model .NET doesn't need. This was missing completely, not just "different" |
| Schema had an invalid line: `INTEGER FOREIGN KEY REFERENCES ...` | Fixed to valid SQLite syntax, added indexes and `CHECK` constraints | That line would throw a syntax error if you actually ran it |
| No audit trail for stock changes | Added a `stock_transactions` table | You'll eventually need to answer "why is the stock count wrong" — this is how |
| No packaging/installer guidance | Added `07-packaging-and-deployment.md` | A Windows desktop app isn't done until it installs cleanly on a PC that isn't yours |
| "100% success, no errors" stated as a goal, not really addressed | A dedicated, honest reliability doc with concrete code | See below |

The good parts I kept: the two-role split, the general shape of the schema, the "Stars / Plowhorses / Puzzles / Dogs" menu-engineering idea, WAL-mode SQLite, and the instinct that this needs to run standalone without depending on the internet.

## The one honest paragraph, up front

**"100% success, no errors" isn't a real state software reaches.** Anyone who tells you otherwise is either inexperienced or not being straight with you — power goes out mid-transaction, disks fill up, someone unplugs the printer, a cashier's finger slips. What *is* achievable is getting the error rate on money-and-stock operations close enough to zero that it essentially never bites you in practice, and — this is the part people skip — making sure that on the rare day something does go wrong, you lose no data and you can see exactly what happened. That's the actual engineering goal, and `06-reliability-engineering.md` is entirely about how to hit it in this specific stack. Read it before you write the checkout code, not after.

## Assumptions I'm making

- **Single restaurant, single till PC** to start. The architecture supports adding a second networked terminal later without a rewrite (noted in `01-architecture.md`), but I'm not building that complexity in on day one, because it's a real failure-point multiplier for no benefit until you actually have two registers.
- **"What is the most sale item and the lasest"** — I've built for both readings: best/worst *sellers* (sales performance) and most-recently-*added* menu items (menu freshness). They're both genuinely useful and cheap to include, so no need to guess which you meant.
- Cashier and Owner both log in to the *same installed app*; what they see is controlled by role, not by separate installers.
- You're comfortable with TypeScript, or willing to be — I explain why below, but the short version is that it directly serves your "no errors" goal more than any other single decision in this stack.

## Reading order

| File | What's in it |
|---|---|
| [`01-architecture.md`](./01-architecture.md) | Electron's process model, how Main/Preload/Renderer connect, the IPC contract, the order-creation data flow, folder structure |
| [`02-tech-stack.md`](./02-tech-stack.md) | Every library, why it and not the alternative, exact install commands |
| [`03-database-schema.md`](./03-database-schema.md) | Full corrected schema, ERD, indexes, simple-vs-recipe stock tracking |
| [`04-features-and-roles.md`](./04-features-and-roles.md) | Cashier and Owner feature lists, permission matrix, screen inventory |
| [`05-analytics-dashboard.md`](./05-analytics-dashboard.md) | Every metric, the SQL for it, chart choices, the "cool" extras |
| [`06-reliability-engineering.md`](./06-reliability-engineering.md) | Transactions, crash recovery, the Electron-specific gotchas that will actually bite you, backups, testing |
| [`07-packaging-and-deployment.md`](./07-packaging-and-deployment.md) | Building the Windows installer, the native-module packaging trap, code signing reality |
| [`08-roadmap.md`](./08-roadmap.md) | Suggested build order, phase by phase |

Start with `01`, skim `02`, and don't skip `06` — that's the one doing the most work toward your actual stated goal.
