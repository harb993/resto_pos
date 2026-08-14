# 05 — Analytics Dashboard

This is the "cool ass analytics" part. Below is every metric worth showing, the actual SQL for it against the schema in `03-database-schema.md`, and what chart to put it in. Every query is written to run as-is via `better-sqlite3` (`db.prepare(sql).all()` / `.get()`).

## Summary cards (top of the dashboard, always visible)

```sql
-- Today
SELECT COUNT(*) AS order_count, COALESCE(SUM(total_amount), 0) AS revenue
FROM orders
WHERE status = 'completed' AND date(created_at) = date('now', 'localtime');

-- This week (Monday–today, adjust '%w' offset if your week starts Sunday)
SELECT COALESCE(SUM(total_amount), 0) AS revenue
FROM orders
WHERE status = 'completed'
  AND date(created_at) >= date('now', 'localtime', 'weekday 1', '-7 days');

-- This month
SELECT COALESCE(SUM(total_amount), 0) AS revenue
FROM orders
WHERE status = 'completed'
  AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now', 'localtime');
```

Show each with a small delta against the equivalent prior period (today vs. yesterday, this week vs. last week) — a bare number tells you where you are, a delta tells you whether that's good news:

```sql
-- Today vs. yesterday, in one query
SELECT
  SUM(CASE WHEN date(created_at) = date('now','localtime') THEN total_amount ELSE 0 END) AS today,
  SUM(CASE WHEN date(created_at) = date('now','localtime','-1 day') THEN total_amount ELSE 0 END) AS yesterday
FROM orders
WHERE status = 'completed'
  AND date(created_at) >= date('now','localtime','-1 day');
```

## The trend curve ("how the curve go up or down")

```sql
-- Daily revenue, last 30 days — feeds a line chart
SELECT date(created_at) AS day, SUM(total_amount) AS revenue, COUNT(*) AS order_count
FROM orders
WHERE status = 'completed' AND created_at >= datetime('now', '-30 days')
GROUP BY day
ORDER BY day;
```

Render with Recharts' `<LineChart>` (or `<ComposedChart>` if you overlay order count as a secondary line/bar). Give the owner a toggle: **Daily** (last 30 days) / **Weekly** (last 12 weeks, `GROUP BY strftime('%Y-%W', created_at)`) / **Monthly** (last 12 months, `GROUP BY strftime('%Y-%m', created_at)`) — same query shape, different `GROUP BY`.

## Best and worst sellers ("most sale item and the lasest")

```sql
-- Best sellers, last 30 days
SELECT mi.name, SUM(oi.quantity) AS units_sold, SUM(oi.quantity * oi.unit_price) AS revenue
FROM order_items oi
JOIN menu_items mi ON mi.item_id = oi.menu_item_id
JOIN orders o ON o.order_id = oi.order_id
WHERE o.status = 'completed' AND o.created_at >= datetime('now', '-30 days')
GROUP BY mi.item_id
ORDER BY units_sold DESC
LIMIT 10;

-- Worst sellers — same query, ASC. Only among items that HAVE sold at least once;
-- items with zero sales ever need a separate "never sold" list, not a spot at the bottom of this one.
SELECT mi.name, SUM(oi.quantity) AS units_sold
FROM order_items oi
JOIN menu_items mi ON mi.item_id = oi.menu_item_id
JOIN orders o ON o.order_id = oi.order_id
WHERE o.status = 'completed' AND o.created_at >= datetime('now', '-30 days')
GROUP BY mi.item_id
ORDER BY units_sold ASC
LIMIT 10;
```

**And the other reading of "lasest"** — most recently added menu items, in case that's what you meant instead of (or alongside) worst-sellers:

```sql
SELECT name, created_at FROM menu_items ORDER BY created_at DESC LIMIT 5;
```

Both are cheap to include. No reason to guess which you meant when you can just have both.

## The menu-engineering matrix (kept from your draft — this is a genuinely good idea)

Classic restaurant-management framework: plot every item on popularity vs. profit margin.

- **Stars** — high sales, high margin. Promote these, don't touch the recipe.
- **Plowhorses** — high sales, low margin. Popular but barely profitable; look for a price nudge or a cheaper ingredient swap.
- **Puzzles** — low sales, high margin. Profitable when sold, but nobody's ordering it — reposition on the menu or cut it.
- **Dogs** — low sales, low margin. Candidates to drop.

```sql
SELECT
  mi.name,
  SUM(oi.quantity) AS units_sold,
  ROUND(AVG(oi.unit_price - oi.unit_cost), 2) AS avg_margin,
  ROUND(100.0 * AVG(oi.unit_price - oi.unit_cost) / NULLIF(AVG(oi.unit_price), 0), 1) AS margin_pct
FROM order_items oi
JOIN menu_items mi ON mi.item_id = oi.menu_item_id
JOIN orders o ON o.order_id = oi.order_id
WHERE o.status = 'completed' AND o.created_at >= datetime('now', '-30 days')
GROUP BY mi.item_id;
```

Bucket the results client-side: compare each item's `units_sold` and `margin_pct` against the fleet averages (mean across all rows) to sort it into one of the four quadrants. Render as a scatter plot (Recharts `<ScatterChart>`), one dot per item, quadrant lines at the two averages — this is the "cool" chart of the dashboard, and it's genuinely more useful than a plain bar chart because it tells the owner *what to do*, not just what happened.

## Peak hours heatmap

```sql
SELECT
  CAST(strftime('%w', created_at) AS INTEGER) AS day_of_week,   -- 0=Sunday
  CAST(strftime('%H', created_at) AS INTEGER) AS hour_of_day,
  COUNT(*) AS order_count,
  SUM(total_amount) AS revenue
FROM orders
WHERE status = 'completed' AND created_at >= datetime('now', '-30 days')
GROUP BY day_of_week, hour_of_day;
```

A 7×24 grid, shaded by `order_count`. Genuinely useful for staffing decisions ("we're overstaffed on Tuesday mornings, understaffed Friday nights") in a way a revenue-only view can't tell you.

## Category breakdown

```sql
SELECT c.name, SUM(oi.quantity * oi.unit_price) AS revenue
FROM order_items oi
JOIN menu_items mi ON mi.item_id = oi.menu_item_id
JOIN categories c ON c.category_id = mi.category_id
JOIN orders o ON o.order_id = oi.order_id
WHERE o.status = 'completed' AND o.created_at >= datetime('now', '-30 days')
GROUP BY c.category_id;
```

Donut chart — "what fraction of revenue is chicken vs. sides vs. drinks."

## Average order value, over time

```sql
SELECT date(created_at) AS day, AVG(total_amount) AS avg_order_value
FROM orders
WHERE status = 'completed' AND created_at >= datetime('now', '-30 days')
GROUP BY day
ORDER BY day;
```

A slowly rising AOV usually means upselling/combos are working; a flat or falling one alongside rising order *count* tells a different story than the revenue chart alone would.

## Export

Owner-only "Export" button on any report → CSV (trivial: build the rows, write with Node's `fs`, no library needed) or a simple PDF via the `pdf` conventions your main deliverable pipeline already uses, if you want something a bit more presentable for taxes/bookkeeping.

## What I'd deliberately leave out of v1

Forecasting/prediction ("expected revenue next week") is a genuinely fun feature to reach for, but it needs months of clean historical data to be worth anything, and a bad forecast confidently displayed is worse than no forecast at all. Revisit this once you have a real season of data — not on day one.
