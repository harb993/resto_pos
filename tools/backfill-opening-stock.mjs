#!/usr/bin/env node
/**
 * Give every raw material an opening-balance movement, so its ledger explains its count.
 *
 *   node tools/backfill-opening-stock.mjs <restaurant.db>            (dry run — shows the plan)
 *   node tools/backfill-opening-stock.mjs <restaurant.db> --apply    (writes it)
 *
 * Why this is needed: creating a material used to write its opening stock straight
 * into `raw_materials.stock_quantity` without a matching row in
 * `raw_material_transactions`. Every material was therefore out by exactly its opening
 * stock, and the history screen could not account for the number it was showing. The
 * code no longer does that — this repairs the rows made before the fix.
 *
 * What it writes: for each material whose balance disagrees with the sum of its own
 * movements, ONE 'adjustment' row for exactly the difference, dated to when the
 * material was created so it sorts before the sales that follow it.
 *
 * What it does NOT do: it never touches `stock_quantity`, never touches an order, a
 * price or a total. No figure anyone was charged, and no count on any shelf, changes.
 * It only makes the ledger add up to the count that is already there.
 */

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

function loadSqlite() {
  const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
  const root = path.resolve(here, '..')
  for (const p of [path.join(root, '.test-sqlite/node_modules/better-sqlite3'), 'better-sqlite3']) {
    try { return require(p) } catch { /* next */ }
  }
  console.error('better-sqlite3 could not be loaded for plain node. Run `npm test` once first.')
  process.exit(2)
}
const Database = loadSqlite()

const dbPath = process.argv[2]
const apply = process.argv.includes('--apply')
if (!dbPath || !fs.existsSync(dbPath)) {
  console.error('usage: node tools/backfill-opening-stock.mjs <restaurant.db> [--apply]')
  process.exit(2)
}

/**
 * A copy of the books before they are written to — but only when there is actually
 * something to write. Taking one unconditionally left a file named
 * `.before-opening-backfill-…` that in fact contained the state AFTER the backfill,
 * which is exactly the file someone would reach for to undo it.
 */
function backup() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const file = `${dbPath}.before-opening-backfill-${stamp}`
  const src = new Database(dbPath)
  src.pragma('wal_checkpoint(TRUNCATE)')
  src.exec(`VACUUM INTO '${file.replace(/\\/g, '/')}'`)
  src.close()
  console.log(`backup written: ${file}\n`)
}

const db = new Database(dbPath, { readonly: !apply })

const owner = db.prepare(`SELECT user_id FROM users WHERE role='owner' ORDER BY user_id LIMIT 1`).get()
if (!owner) { console.error('no owner account to attribute the entries to'); process.exit(2) }

const rows = db.prepare(`
  SELECT rm.raw_material_id, rm.name, rm.unit, rm.stock_quantity, rm.created_at,
         COALESCE((SELECT SUM(t.change_amount) FROM raw_material_transactions t
                   WHERE t.raw_material_id = rm.raw_material_id), 0) AS ledger
  FROM raw_materials rm
  ORDER BY rm.raw_material_id
`).all()

// Round the ledger sum for display as well as the difference: summing REALs leaves
// noise like -4.1000000000000005, which is alarming to read in a report about whether
// the books add up.
const r3 = n => Math.round(n * 1000) / 1000
const plan = rows
  .map(r => ({ ...r, ledger: r3(r.ledger), diff: r3(r.stock_quantity - r.ledger) }))
  .filter(r => Math.abs(r.diff) > 0.005)

if (plan.length === 0) {
  console.log('Nothing to do — every material balance is already explained by its movements.')
  db.close()
  process.exit(0)
}

console.log(`${plan.length} material(s) need an opening entry:\n`)
for (const p of plan) {
  console.log(`  ${p.name.padEnd(26)} balance ${String(p.stock_quantity).padStart(8)}  ` +
              `movements ${String(p.ledger).padStart(8)}  ->  opening entry ${p.diff > 0 ? '+' : ''}${p.diff} ${p.unit}`)
}

if (!apply) {
  console.log('\nDry run. Nothing was written. Re-run with --apply to write these entries.')
  db.close()
  process.exit(0)
}

// Let go of the read connection before copying the file, then do all the writing on
// one fresh connection. Backing up while another handle is open on the same database
// is what made the first attempts fail with SQLITE_ERROR.
db.close()
backup()

const wdb = new Database(dbPath)
const insert = wdb.prepare(`
  INSERT INTO raw_material_transactions (raw_material_id, change_amount, reason, created_by, created_at)
  VALUES (?, ?, 'adjustment', ?, ?)
`)

// One transaction: either the whole ledger is repaired or none of it is.
const write = wdb.transaction(() => {
  for (const p of plan) insert.run(p.raw_material_id, p.diff, owner.user_id, p.created_at)
})
write()

// Prove it, rather than assuming it.
const left = wdb.prepare(`
  SELECT COUNT(*) v FROM raw_materials rm
  WHERE ABS(rm.stock_quantity - COALESCE((SELECT SUM(t.change_amount) FROM raw_material_transactions t
                                          WHERE t.raw_material_id = rm.raw_material_id), 0)) > 0.005
`).get().v
console.log(`\nwrote ${plan.length} opening entries`)
console.log(`materials still unexplained: ${left}`)
console.log(left === 0 ? 'ledger now accounts for every unit on hand' : 'SOMETHING IS STILL OFF — restore the backup')
wdb.close()
process.exit(left === 0 ? 0 : 1)
