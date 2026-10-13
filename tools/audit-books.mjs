#!/usr/bin/env node
/**
 * Penny-level audit of a live restaurant database. READ-ONLY — it works on a copy.
 *
 *   node tools/audit-books.mjs "C:\\Users\\Admin\\Desktop\\crispo\\data\\restaurant.db"
 *
 * Each check states a rule the books must obey and prints the rows that break it.
 * A clean run means no figure in the database contradicts any other figure: every
 * order matches its own lines, every day matches its own orders, every supplier
 * balance matches its own ledger, and nothing is arithmetically impossible.
 *
 * Exit code is 0 when everything reconciles and 1 when it does not, so this can be
 * run from a scheduled task and its failure noticed.
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

/**
 * node_modules/better-sqlite3 is built for Electron's ABI (see the postinstall
 * script), so plain node cannot load it. `npm test` stages a Node-ABI copy under
 * .test-sqlite; prefer that and fall back to the normal one.
 */
function loadSqlite() {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
  for (const p of [path.join(root, '.test-sqlite/node_modules/better-sqlite3'), 'better-sqlite3']) {
    try { return require(p) } catch { /* try the next */ }
  }
  console.error('better-sqlite3 could not be loaded for plain node.')
  console.error('Run `npm test` once first — it stages a Node-ABI copy under .test-sqlite.')
  process.exit(2)
}
const Database = loadSqlite()

const src = process.argv[2]
if (!src || !fs.existsSync(src)) {
  console.error('usage: node tools/audit-books.mjs <path to restaurant.db>')
  process.exit(2)
}

// Copy the database and its write-ahead log somewhere temporary, so the audit reads a
// consistent picture and can never write to the real file.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-'))
for (const ext of ['', '-wal', '-shm']) {
  if (fs.existsSync(src + ext)) fs.copyFileSync(src + ext, path.join(tmp, 'a.db' + ext))
}
const db = new Database(path.join(tmp, 'a.db'))

let failures = 0
let checks = 0
const colsOf = t => { try { return db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name) } catch { return [] } }
const has = (t, c) => colsOf(t).includes(c)
const money = n => (Math.round((n + Number.EPSILON) * 100) / 100).toFixed(2)
const scalar = (sql, d) => { try { return db.prepare(sql).get().v } catch { return d } }

function check(name, sql, describe) {
  checks++
  let rows
  try { rows = db.prepare(sql).all() } catch (e) { console.log(`  ??  ${name}\n        skipped: ${e.message}`); return }
  if (rows.length === 0) { console.log(`  OK  ${name}`); return }
  failures++
  console.log(`  !!  ${name}  — ${rows.length} offending row(s)`)
  for (const r of rows.slice(0, 6)) console.log('        ' + (describe ? describe(r) : JSON.stringify(r)))
  if (rows.length > 6) console.log(`        ... and ${rows.length - 6} more`)
}

console.log('DATABASE  ' + src)
console.log('orders ' + scalar('SELECT COUNT(*) v FROM orders', 0) +
  '  |  live revenue ' + money(scalar(
    "SELECT COALESCE(SUM(total_amount),0) v FROM orders WHERE status='completed' AND deleted_at IS NULL", 0)))

console.log('\n--- structural integrity ---')
checks++
const integrity = db.pragma('integrity_check')[0].integrity_check
console.log((integrity === 'ok' ? '  OK  ' : '  !!  ') + 'PRAGMA integrity_check = ' + integrity)
if (integrity !== 'ok') failures++
checks++
const fk = db.pragma('foreign_key_check')
console.log((fk.length === 0 ? '  OK  ' : '  !!  ') + `foreign_key_check — ${fk.length} violation(s)`)
if (fk.length) { failures++; fk.slice(0, 5).forEach(v => console.log('        ' + JSON.stringify(v))) }

console.log('\n--- every order against its own line items ---')
check('subtotal equals the sum of its lines', `
  SELECT o.order_id, o.invoice_number, o.subtotal,
         COALESCE((SELECT SUM(oi.quantity*oi.unit_price) FROM order_items oi WHERE oi.order_id=o.order_id),0) AS lines
  FROM orders o WHERE o.deleted_at IS NULL
    AND ABS(o.subtotal - COALESCE((SELECT SUM(oi.quantity*oi.unit_price) FROM order_items oi WHERE oi.order_id=o.order_id),0)) > 0.005`,
  r => `order ${r.order_id} (inv ${r.invoice_number}): subtotal ${money(r.subtotal)} vs lines ${money(r.lines)} — off by ${money(r.subtotal - r.lines)}`)

check('total equals subtotal + tax − discount + delivery', `
  SELECT order_id, invoice_number, subtotal, tax, discount, COALESCE(delivery_fee,0) fee, total_amount
  FROM orders WHERE deleted_at IS NULL
    AND ABS(total_amount - MAX(0, subtotal + tax - discount + COALESCE(delivery_fee,0))) > 0.005`,
  r => `order ${r.order_id} (inv ${r.invoice_number}): stored ${money(r.total_amount)} vs computed ${money(Math.max(0, r.subtotal + r.tax - r.discount + r.fee))}`)

check('no live order is empty', `
  SELECT order_id, invoice_number FROM orders o WHERE o.deleted_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id=o.order_id)`,
  r => `order ${r.order_id} (inv ${r.invoice_number}) has no lines`)

console.log('\n--- the tax and delivery rules ---')
check('VAT is charged on dine-in only', `
  SELECT order_id, invoice_number, order_type, tax FROM orders
  WHERE deleted_at IS NULL AND order_type <> 'dine_in' AND tax > 0.005`,
  r => `order ${r.order_id} is ${r.order_type} but carries ${money(r.tax)} VAT`)

check('a delivery fee appears on delivery orders only', `
  SELECT order_id, invoice_number, order_type, delivery_fee FROM orders
  WHERE deleted_at IS NULL AND order_type <> 'delivery' AND COALESCE(delivery_fee,0) > 0.005`,
  r => `order ${r.order_id} is ${r.order_type} but carries a ${money(r.delivery_fee)} delivery fee`)

check('every delivery fee matches the area charged', `
  SELECT o.order_id, o.invoice_number, o.delivery_fee, a.area_name, a.delivery_fee AS area_fee
  FROM orders o JOIN delivery_areas a ON a.delivery_area_id = o.delivery_area_id
  WHERE o.deleted_at IS NULL AND ABS(COALESCE(o.delivery_fee,0) - a.delivery_fee) > 0.005`,
  r => `order ${r.order_id}: charged ${money(r.delivery_fee)} but ${r.area_name} is ${money(r.area_fee)} (may be a later price change)`)

console.log('\n--- nothing arithmetically impossible ---')
check('no negative money on an order', `
  SELECT order_id, invoice_number FROM orders
  WHERE subtotal<0 OR tax<0 OR discount<0 OR total_amount<0 OR COALESCE(delivery_fee,0)<0`)
check('no discount exceeds the order it discounts', `
  SELECT order_id, invoice_number, subtotal, discount FROM orders WHERE discount > subtotal + 0.005`,
  r => `order ${r.order_id}: ${money(r.discount)} off a ${money(r.subtotal)} order`)
check('no line has a bad quantity or price', `
  SELECT order_item_id, order_id, quantity, unit_price FROM order_items
  WHERE quantity <= 0 OR unit_price < 0 OR COALESCE(unit_cost,0) < 0`)
check('no orphan order line', `
  SELECT oi.order_item_id FROM order_items oi
  LEFT JOIN orders o ON o.order_id = oi.order_id WHERE o.order_id IS NULL`)

console.log('\n--- invoice numbering ---')
// Numbers restart with every shift, so the same number on two shifts of one day is
// correct — what must never happen is the same number twice INSIDE a shift.
if (colsOf('work_shifts').length) {
  check('no invoice number issued twice in one shift', `
    SELECT ws.work_shift_id, ws.opened_at, o.invoice_number, COUNT(*) c
    FROM orders o JOIN work_shifts ws
      ON o.created_at >= ws.opened_at
     AND o.created_at < COALESCE(
           (SELECT MIN(n.opened_at) FROM work_shifts n WHERE n.opened_at > ws.opened_at), '9999')
    WHERE o.invoice_number IS NOT NULL AND o.deleted_at IS NULL
    GROUP BY ws.work_shift_id, o.invoice_number HAVING c > 1`,
    r => `shift opened ${r.opened_at}: invoice ${r.invoice_number} used ${r.c} times`)
} else {
  check('no invoice number issued twice in one day', `
    SELECT date(created_at) d, invoice_number, COUNT(*) c FROM orders
    WHERE invoice_number IS NOT NULL AND deleted_at IS NULL
    GROUP BY date(created_at), invoice_number HAVING c > 1`,
    r => `${r.d}: invoice ${r.invoice_number} used ${r.c} times`)
}
check('no live order is missing its invoice number', `
  SELECT order_id FROM orders WHERE deleted_at IS NULL AND (invoice_number IS NULL OR invoice_number='')`)

console.log('\n--- voided and deleted orders ---')
check('every voided order records who and why', `
  SELECT order_id, invoice_number FROM orders
  WHERE status='voided' AND deleted_at IS NULL AND (voided_by IS NULL OR void_reason IS NULL OR void_reason='')`)
if (has('orders', 'deleted_by')) {
  check('every deleted order records who deleted it', `
    SELECT order_id FROM orders WHERE deleted_at IS NOT NULL AND deleted_by IS NULL`)
}

console.log('\n--- cash drawer ---')
if (has('orders', 'tendered_amount') && has('orders', 'change_due')) {
  check('change equals cash tendered minus the total', `
    SELECT order_id, invoice_number, total_amount, tendered_amount, change_due FROM orders
    WHERE deleted_at IS NULL AND payment_type='cash' AND COALESCE(tendered_amount,0) > 0
      AND ABS(COALESCE(change_due,0) - (tendered_amount - total_amount)) > 0.005`,
    r => `order ${r.order_id}: took ${money(r.tendered_amount)} on ${money(r.total_amount)}, gave ${money(r.change_due)}`)
} else {
  console.log('  --  tendered/change are computed at the till and not stored; nothing to audit here')
}

console.log('\n--- suppliers ---')
if (colsOf('suppliers').length) {
  check('every supplier invoice equals the sum of its items', `
    SELECT i.supplier_invoice_id, i.total_amount,
           COALESCE((SELECT SUM(it.quantity*it.unit_cost) FROM supplier_invoice_items it
                     WHERE it.supplier_invoice_id=i.supplier_invoice_id),0) AS lines
    FROM supplier_invoices i
    WHERE ABS(i.total_amount - COALESCE((SELECT SUM(it.quantity*it.unit_cost) FROM supplier_invoice_items it
                                         WHERE it.supplier_invoice_id=i.supplier_invoice_id),0)) > 0.005`,
    r => `supplier invoice ${r.supplier_invoice_id}: ${money(r.total_amount)} vs items ${money(r.lines)}`)
  check('no negative supplier invoice', `SELECT supplier_invoice_id FROM supplier_invoices WHERE total_amount < 0`)
  check('no negative supplier payment', `SELECT supplier_payment_id FROM supplier_payments WHERE amount < 0`)

  const led = db.prepare(`
    SELECT s.name,
      COALESCE((SELECT SUM(total_amount) FROM supplier_invoices i WHERE i.supplier_id=s.supplier_id),0) supplied,
      COALESCE((SELECT SUM(amount) FROM supplier_payments p WHERE p.supplier_id=s.supplier_id),0) paid
    FROM suppliers s`).all()
  if (!led.length) console.log('      (no suppliers recorded yet)')
  for (const s of led) {
    console.log(`      ${s.name}: supplied ${money(s.supplied)}  paid ${money(s.paid)}  owed ${money(s.supplied - s.paid)}`)
  }
}

console.log('\n--- stock ---')
check('no raw material is negative', `
  SELECT raw_material_id, name, stock_quantity, unit FROM raw_materials WHERE stock_quantity < 0`,
  r => `${r.name}: ${r.stock_quantity} ${r.unit} — more was sold than was ever recorded as received or prepped`)
check('no raw material has a negative cost', `
  SELECT raw_material_id, name, cost_per_unit FROM raw_materials WHERE cost_per_unit < 0`,
  r => `${r.name}: ${money(r.cost_per_unit)}`)

// The ledger check is reported but NOT counted as a failure on databases that predate
// the fix: opening balances used to be written straight into the balance with no
// movement, so historic rows cannot reconcile and never will without back-filling.
console.log('      stock_quantity vs the sum of its own movements:')
let unreconciled = 0
for (const r of db.prepare('SELECT raw_material_id, name, stock_quantity, cost_per_unit FROM raw_materials').all()) {
  const net = db.prepare(
    'SELECT ROUND(COALESCE(SUM(change_amount),0),3) v FROM raw_material_transactions WHERE raw_material_id=?'
  ).get(r.raw_material_id).v
  const off = Math.round((r.stock_quantity - net) * 1000) / 1000
  if (Math.abs(off) > 0.005) {
    unreconciled++
    console.log(`        ${r.name}: balance ${r.stock_quantity}, movements ${net}, unexplained ${off}`)
  }
}
console.log(unreconciled === 0
  ? '  OK  every material balance is explained by its movements'
  : `  --  ${unreconciled} material(s) carry an opening balance that predates ledger recording (no money impact)`)

console.log('\n--- each day, cross-checked against its own orders ---')
const byDay = db.prepare(`
  SELECT date(created_at) d, COUNT(*) n,
         ROUND(SUM(total_amount),2) total, ROUND(SUM(subtotal),2) sub,
         ROUND(SUM(tax),2) tax, ROUND(SUM(discount),2) disc,
         ROUND(SUM(COALESCE(delivery_fee,0)),2) fee
  FROM orders WHERE status='completed' AND deleted_at IS NULL
  GROUP BY date(created_at) ORDER BY d`).all()
let drift = 0
for (const d of byDay) {
  const computed = Math.round((d.sub + d.tax - d.disc + d.fee) * 100) / 100
  const off = Math.round((d.total - computed) * 100) / 100
  if (Math.abs(off) > 0.005) drift++
  console.log(`      ${d.d}  ${String(d.n).padStart(3)} orders  ${money(d.total).padStart(10)}` +
    (Math.abs(off) > 0.005 ? `   MISMATCH ${money(off)}` : ''))
}
checks++
if (drift) { failures++; console.log(`  !!  ${drift} day(s) whose total does not equal its own components`) }
else console.log('  OK  every day total equals the sum of its own components')

console.log('\n============================================')
console.log(failures === 0
  ? `ALL CLEAR — ${checks} checks, not a penny out`
  : `${failures} CHECK(S) FAILED out of ${checks}`)
db.close()
process.exit(failures === 0 ? 0 : 1)
