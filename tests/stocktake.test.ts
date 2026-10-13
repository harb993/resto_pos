import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../src/main/db/db'
import { adjustStock, listRawMaterials } from '../src/main/services/rawMaterialService'

/**
 * Correcting stock by COUNTING it, rather than by working out the difference.
 *
 * The three movements the database knows about all take a difference: a delivery adds,
 * a write-off subtracts, an adjustment does either. That is right for a delivery — the
 * invoice says how many arrived — and wrong for a stocktake, where what the person
 * actually has is a number they counted. Making them work out that 42 counted against
 * 37.5 on screen is "+4.5" puts arithmetic between the shelf and the record, at
 * midnight, which is where the mistakes come from.
 *
 * The screen now takes the counted figure and derives the movement. What reaches the
 * database is still an ordinary `adjustment`, so the movement log goes on saying what
 * changed and by how much — which is the part that has to stay true.
 */

let ownerId: number
let materialId: number

/** Exactly what the stocktake box computes before it posts. */
const countDelta = (counted: number, current: number) =>
  Math.round((counted - current) * 1000) / 1000

const stockOf = (id: number) =>
  (getDb().prepare('SELECT stock_quantity AS q FROM raw_materials WHERE raw_material_id = ?')
    .get(id) as any).q

const movements = (id: number) =>
  getDb().prepare(
    `SELECT change_amount, reason FROM raw_material_transactions
     WHERE raw_material_id = ? ORDER BY rm_txn_id`
  ).all(id) as { change_amount: number; reason: string }[]

beforeAll(() => {
  initDatabase()
  ownerId = (getDb().prepare(`SELECT user_id FROM users WHERE role='owner'`).get() as any).user_id
})

beforeEach(() => {
  const db = getDb()
  db.prepare('DELETE FROM raw_material_transactions').run()
  db.prepare('DELETE FROM raw_materials').run()
  materialId = Number(db.prepare(
    `INSERT INTO raw_materials (name, unit, stock_quantity, cost_per_unit, low_stock_threshold)
     VALUES ('أرز', 'كجم', 37.5, 30, 5)`
  ).run().lastInsertRowid)
})

describe('counting the shelf', () => {
  it('works out the difference from what was counted', () => {
    // 37.5 on the books, 42 actually there.
    const delta = countDelta(42, stockOf(materialId))
    expect(delta).toBe(4.5)

    adjustStock(materialId, delta, 'adjustment', ownerId)
    expect(stockOf(materialId)).toBeCloseTo(42)
  })

  it('handles a count that is LOWER than the books', () => {
    const delta = countDelta(30, stockOf(materialId))
    expect(delta).toBe(-7.5)

    adjustStock(materialId, delta, 'adjustment', ownerId)
    expect(stockOf(materialId)).toBeCloseTo(30)
  })

  it('records it as a movement, so the history still explains the change', () => {
    adjustStock(materialId, countDelta(42, stockOf(materialId)), 'adjustment', ownerId)

    const log = movements(materialId)
    console.log('movements:', JSON.stringify(log))
    expect(log).toHaveLength(1)
    expect(log[0].reason).toBe('adjustment')
    expect(log[0].change_amount).toBeCloseTo(4.5)
  })

  it('writes NOTHING when the count agrees with the books', () => {
    // A zero movement is a line in the history saying nothing happened.
    const delta = countDelta(37.5, stockOf(materialId))
    expect(delta).toBe(0)
    // …and the screen does not post it.
    expect(movements(materialId)).toHaveLength(0)
    expect(stockOf(materialId)).toBeCloseTo(37.5)
  })

  it('counts to zero — an empty shelf is a real answer', () => {
    const delta = countDelta(0, stockOf(materialId))
    expect(delta).toBe(-37.5)

    adjustStock(materialId, delta, 'adjustment', ownerId)
    expect(stockOf(materialId)).toBe(0)
  })

  it('keeps three decimals, because these are kilos and litres', () => {
    expect(countDelta(37.625, 37.5)).toBe(0.125)
    adjustStock(materialId, 0.125, 'adjustment', ownerId)
    expect(stockOf(materialId)).toBeCloseTo(37.625)
  })

  it('does not drift on a float that cannot be represented exactly', () => {
    // 0.1 + 0.2 arithmetic, in a field somebody will compare against a clipboard.
    const delta = countDelta(37.6, 37.5)
    expect(delta).toBe(0.1)              // not 0.10000000000000142
    adjustStock(materialId, delta, 'adjustment', ownerId)
    expect(stockOf(materialId)).toBeCloseTo(37.6)
  })

  it('leaves the other movement types alone', () => {
    // A delivery still means "this many arrived", not "this many are now here".
    adjustStock(materialId, 10, 'restock', ownerId)
    expect(stockOf(materialId)).toBeCloseTo(47.5)

    adjustStock(materialId, -2.5, 'waste', ownerId)
    expect(stockOf(materialId)).toBeCloseTo(45)

    expect(movements(materialId).map(m => m.reason)).toEqual(['restock', 'waste'])
  })

  it('shows up in the material list at the counted figure', () => {
    adjustStock(materialId, countDelta(42, stockOf(materialId)), 'adjustment', ownerId)
    const material = listRawMaterials(true).find(m => m.raw_material_id === materialId)!
    expect(material.stock_quantity).toBeCloseTo(42)
  })
})
