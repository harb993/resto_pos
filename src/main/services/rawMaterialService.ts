import { getDb } from '../db/db'
import log from 'electron-log/main'
import type {
  RawMaterial, RawMaterialInput, RawMaterialManualReason, RawMaterialTransaction, PrepConversion,
} from '../../shared/types'

const MANUAL_REASONS: RawMaterialManualReason[] = ['restock', 'waste', 'adjustment']

/** Rounds to 3 decimals — raw material quantities are fractional (0.15 kg of flour). */
function round3(n: number): number {
  return Math.round(n * 1000) / 1000
}

// ===== Materials =====

export function listRawMaterials(includeInactive = false): RawMaterial[] {
  const where = includeInactive ? '' : 'WHERE is_active = 1'
  return getDb().prepare(`
    SELECT * FROM raw_materials ${where} ORDER BY is_active DESC, name
  `).all() as RawMaterial[]
}

export function upsertRawMaterial(input: RawMaterialInput, userId?: number): RawMaterial {
  const db = getDb()

  const name = String(input.name ?? '').trim()
  if (!name) throw new Error('اسم المادة الخام مطلوب')

  const unit = String(input.unit ?? '').trim() || 'قطعة'
  const cost = Number(input.costPerUnit)
  if (!Number.isFinite(cost) || cost < 0) throw new Error('تكلفة الوحدة يجب أن تكون صفراً أو أكثر')

  const threshold = Number(input.lowStockThreshold)
  if (!Number.isFinite(threshold) || threshold < 0) {
    throw new Error('حد التنبيه يجب أن يكون صفراً أو أكثر')
  }

  if (input.rawMaterialId) {
    // Stock is NEVER edited here — it only moves through adjustStock/prep/sales so the
    // audit trail stays the single source of truth for how the count got where it is.
    db.prepare(`
      UPDATE raw_materials SET name = ?, unit = ?, cost_per_unit = ?, low_stock_threshold = ?, is_active = ?
      WHERE raw_material_id = ?
    `).run(name, unit, cost, threshold, input.isActive ?? 1, input.rawMaterialId)
    log.info(`[RawMaterial] Updated #${input.rawMaterialId}: ${name}`)
    return getRawMaterial(input.rawMaterialId)
  }

  const opening = Number(input.openingStock)
  const stock = Number.isFinite(opening) ? opening : 0

  // The opening balance is a stock movement like any other, and has to be written to
  // the ledger as one. Inserting it straight into stock_quantity — which is what this
  // used to do — left a balance the history screen could not explain, and made the
  // ledger useless for checking a count: every material's transactions summed to
  // something other than the number on the screen, by exactly its opening stock.
  //
  // Both rows go in one transaction, so a material can never exist with a balance the
  // ledger does not account for.
  const create = db.transaction((): number => {
    const res = db.prepare(`
      INSERT INTO raw_materials (name, unit, stock_quantity, cost_per_unit, low_stock_threshold, is_active)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(name, unit, stock, cost, threshold, input.isActive ?? 1)
    const newId = res.lastInsertRowid as number

    if (stock !== 0) {
      // 'adjustment' rather than 'restock': nothing was delivered, this is the count
      // the owner is starting from. Recorded against whoever created the material, or
      // the owner when the caller did not say — the column cannot be null.
      const by = userId ?? (db.prepare(
        `SELECT user_id FROM users WHERE role = 'owner' ORDER BY user_id LIMIT 1`
      ).get() as { user_id: number } | undefined)?.user_id
      if (by) {
        db.prepare(`
          INSERT INTO raw_material_transactions (raw_material_id, change_amount, reason, created_by)
          VALUES (?, ?, 'adjustment', ?)
        `).run(newId, stock, by)
      } else {
        log.warn(`[RawMaterial] No user to attribute the opening balance of #${newId} to; ledger entry skipped`)
      }
    }
    return newId
  })

  const id = create()
  log.info(`[RawMaterial] Created #${id}: ${name} (opening stock ${stock} ${unit})`)
  return getRawMaterial(id)
}

export function getRawMaterial(rawMaterialId: number): RawMaterial {
  const row = getDb().prepare('SELECT * FROM raw_materials WHERE raw_material_id = ?')
    .get(rawMaterialId) as RawMaterial | undefined
  if (!row) throw new Error('المادة الخام غير موجودة')
  return row
}

/**
 * Record a manual stock movement: a delivery arrived, something spoiled, or a
 * stocktake corrected the count.
 *
 * Unlike menu-item stock this is allowed to go negative — see the note on the
 * raw_materials table. A negative balance is a signal that the count is wrong,
 * not something to block the owner from recording.
 */
export function adjustStock(
  rawMaterialId: number,
  quantity: number,
  reason: RawMaterialManualReason,
  userId: number
): RawMaterial {
  const db = getDb()

  if (!MANUAL_REASONS.includes(reason)) {
    throw new Error(`نوع حركة غير معروف: ${reason}`)
  }
  if (!Number.isFinite(quantity) || quantity === 0) {
    throw new Error('الكمية يجب ألا تكون صفراً')
  }

  const txn = db.transaction(() => {
    const material = getRawMaterial(rawMaterialId)

    // 'waste' always removes; 'restock' always adds; 'adjustment' takes the sign given.
    let change: number
    if (reason === 'waste') change = -Math.abs(quantity)
    else if (reason === 'restock') change = Math.abs(quantity)
    else change = quantity

    change = round3(change)

    db.prepare('UPDATE raw_materials SET stock_quantity = round(stock_quantity + ?, 3) WHERE raw_material_id = ?')
      .run(change, rawMaterialId)
    db.prepare(`
      INSERT INTO raw_material_transactions (raw_material_id, change_amount, reason, created_by)
      VALUES (?, ?, ?, ?)
    `).run(rawMaterialId, change, reason, userId)

    log.info(`[RawMaterial] ${reason}: ${material.name} ${change > 0 ? '+' : ''}${change} ${material.unit}`)
    return getRawMaterial(rawMaterialId)
  })

  return txn()
}

export function getLowStockMaterials(): RawMaterial[] {
  return getDb().prepare(`
    SELECT * FROM raw_materials
    WHERE is_active = 1 AND stock_quantity <= low_stock_threshold
    ORDER BY (stock_quantity - low_stock_threshold) ASC
  `).all() as RawMaterial[]
}

export function getMaterialHistory(rawMaterialId?: number, limit = 100): RawMaterialTransaction[] {
  const db = getDb()
  const safeLimit = Number.isInteger(limit) && limit > 0 ? limit : 100
  const base = `
    SELECT t.*, rm.name as material_name, rm.unit, u.full_name as created_by_name
    FROM raw_material_transactions t
    JOIN raw_materials rm ON rm.raw_material_id = t.raw_material_id
    JOIN users u ON u.user_id = t.created_by`

  if (rawMaterialId) {
    return db.prepare(`${base} WHERE t.raw_material_id = ? ORDER BY t.created_at DESC, t.rm_txn_id DESC LIMIT ?`)
      .all(rawMaterialId, safeLimit) as RawMaterialTransaction[]
  }
  return db.prepare(`${base} ORDER BY t.created_at DESC, t.rm_txn_id DESC LIMIT ?`)
    .all(safeLimit) as RawMaterialTransaction[]
}

// ===== Prep conversions (1 whole chicken → 8 pieces) =====

export function listPrepConversions(): PrepConversion[] {
  return getDb().prepare(`
    SELECT pc.*,
      src.name as source_name, src.unit as source_unit, src.stock_quantity as source_stock,
      out.name as output_name, out.unit as output_unit, out.stock_quantity as output_stock
    FROM prep_conversions pc
    JOIN raw_materials src ON src.raw_material_id = pc.source_material_id
    JOIN raw_materials out ON out.raw_material_id = pc.output_material_id
    ORDER BY src.name
  `).all() as PrepConversion[]
}

export function upsertPrepConversion(
  sourceMaterialId: number,
  outputMaterialId: number,
  yieldQuantity: number,
  prepConversionId?: number
): PrepConversion {
  const db = getDb()

  if (sourceMaterialId === outputMaterialId) {
    throw new Error('يجب أن ينتج التجهيز مادة مختلفة عن المادة المستهلكة')
  }
  const qty = Number(yieldQuantity)
  if (!Number.isFinite(qty) || qty <= 0) throw new Error('الناتج يجب أن يكون أكبر من صفر')

  // Both must exist — surfaces a clear message instead of a foreign-key error.
  getRawMaterial(sourceMaterialId)
  getRawMaterial(outputMaterialId)

  if (prepConversionId) {
    db.prepare(`
      UPDATE prep_conversions SET source_material_id = ?, output_material_id = ?, yield_quantity = ?
      WHERE prep_conversion_id = ?
    `).run(sourceMaterialId, outputMaterialId, qty, prepConversionId)
    log.info(`[Prep] Updated conversion #${prepConversionId}`)
  } else {
    db.prepare(`
      INSERT INTO prep_conversions (source_material_id, output_material_id, yield_quantity)
      VALUES (?, ?, ?)
      ON CONFLICT(source_material_id, output_material_id) DO UPDATE SET yield_quantity = excluded.yield_quantity
    `).run(sourceMaterialId, outputMaterialId, qty)
    log.info(`[Prep] Saved conversion: ${sourceMaterialId} → ${outputMaterialId} × ${qty}`)
  }

  const row = db.prepare(`
    SELECT * FROM prep_conversions WHERE source_material_id = ? AND output_material_id = ?
  `).get(sourceMaterialId, outputMaterialId) as PrepConversion
  return row
}

export function deletePrepConversion(prepConversionId: number): void {
  getDb().prepare('DELETE FROM prep_conversions WHERE prep_conversion_id = ?').run(prepConversionId)
  log.info(`[Prep] Deleted conversion #${prepConversionId}`)
}

/**
 * Run a prep batch: consume `batches` of the source material and produce
 * `batches × yield` of the output material. This is the morning "we butchered
 * 10 chickens" step — one action, two balanced stock movements.
 */
export function runPrep(
  prepConversionId: number,
  batches: number,
  userId: number
): { sourceUsed: number; outputProduced: number; sourceName: string; outputName: string; outputUnit: string } {
  const db = getDb()

  const count = Number(batches)
  if (!Number.isFinite(count) || count <= 0) throw new Error('الكمية المُجهَّزة يجب أن تكون أكبر من صفر')

  const txn = db.transaction(() => {
    const conv = db.prepare('SELECT * FROM prep_conversions WHERE prep_conversion_id = ?')
      .get(prepConversionId) as PrepConversion | undefined
    if (!conv) throw new Error('عملية التجهيز غير موجودة')

    const source = getRawMaterial(conv.source_material_id)
    const output = getRawMaterial(conv.output_material_id)

    if (source.stock_quantity < count) {
      throw new Error(
        `لا يوجد رصيد كافٍ من "${source.name}" — المتاح ${source.stock_quantity} ${source.unit}، المطلوب ${count}`
      )
    }

    const produced = round3(count * conv.yield_quantity)

    db.prepare('UPDATE raw_materials SET stock_quantity = round(stock_quantity - ?, 3) WHERE raw_material_id = ?')
      .run(count, source.raw_material_id)
    db.prepare('UPDATE raw_materials SET stock_quantity = round(stock_quantity + ?, 3) WHERE raw_material_id = ?')
      .run(produced, output.raw_material_id)

    const logTxn = db.prepare(`
      INSERT INTO raw_material_transactions (raw_material_id, change_amount, reason, created_by)
      VALUES (?, ?, ?, ?)
    `)
    logTxn.run(source.raw_material_id, -count, 'prep_out', userId)
    logTxn.run(output.raw_material_id, produced, 'prep_in', userId)

    log.info(`[Prep] ${count} × "${source.name}" → ${produced} ${output.unit} of "${output.name}"`)
    return {
      sourceUsed: count,
      outputProduced: produced,
      sourceName: source.name,
      outputName: output.name,
      outputUnit: output.unit,
    }
  })

  return txn()
}
