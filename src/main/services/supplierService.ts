import { getDb } from '../db/db'
import log from 'electron-log/main'
import type {
  Supplier, SupplierInput, SupplierAccount, SupplierSummary,
  SupplierDeliveryInput, SupplierInvoice, SupplierPayment, SupplierPaymentInput,
  SupplierTotals,
} from '../../shared/types'

/**
 * The money side of buying goods, and the goods side of it too.
 *
 * Recording a delivery does BOTH jobs at once: it books what the supplier is owed and
 * it puts the goods into stock, in one transaction. Entering a delivery in one screen
 * and then restocking in another is how the two end up disagreeing, and the count on
 * the shelf is the one nobody can reconstruct afterwards.
 *
 * What a supplier is OWED is never stored. It is always
 *   (sum of their invoices) − (sum of their payments)
 * computed on demand, so it cannot drift away from the rows it comes from — which is
 * exactly what a stored running balance does the first time anything is edited.
 */

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}
function round3(n: number): number {
  return Math.round((n + Number.EPSILON) * 1000) / 1000
}

// ===== Suppliers =====

export function listSuppliers(includeInactive = false): Supplier[] {
  return getDb().prepare(`
    SELECT * FROM suppliers
    ${includeInactive ? '' : 'WHERE is_active = 1'}
    ORDER BY name
  `).all() as Supplier[]
}

export function upsertSupplier(input: SupplierInput): Supplier {
  const db = getDb()
  const name = (input.name ?? '').trim()
  if (!name) throw new Error('اسم المورد مطلوب')

  const clash = db.prepare(
    'SELECT supplier_id FROM suppliers WHERE name = ? AND supplier_id != ?'
  ).get(name, input.supplierId ?? -1)
  if (clash) throw new Error('يوجد مورد بنفس الاسم بالفعل')

  const values = {
    name,
    phone: input.phone?.trim() || null,
    notes: input.notes?.trim() || null,
    is_active: input.isActive === false ? 0 : 1,
  }

  if (input.supplierId) {
    db.prepare(`
      UPDATE suppliers SET name = @name, phone = @phone, notes = @notes, is_active = @is_active
      WHERE supplier_id = @supplier_id
    `).run({ ...values, supplier_id: input.supplierId })
    log.info(`[Supplier] Updated #${input.supplierId} "${name}"`)
    return getSupplier(input.supplierId)
  }

  const res = db.prepare(
    'INSERT INTO suppliers (name, phone, notes, is_active) VALUES (@name, @phone, @notes, @is_active)'
  ).run(values)
  log.info(`[Supplier] Added "${name}"`)
  return getSupplier(Number(res.lastInsertRowid))
}

export function getSupplier(supplierId: number): Supplier {
  const row = getDb().prepare('SELECT * FROM suppliers WHERE supplier_id = ?')
    .get(supplierId) as Supplier | undefined
  if (!row) throw new Error('المورد غير موجود')
  return row
}

/**
 * A supplier can only be removed while they have no history. Once there are invoices
 * or payments against them, deleting the row would orphan the goods that came in and
 * the money that went out — so they are deactivated instead and stay in the books.
 */
export function deleteSupplier(supplierId: number): void {
  const db = getDb()
  const supplier = getSupplier(supplierId)

  const invoices = (db.prepare(
    'SELECT COUNT(*) c FROM supplier_invoices WHERE supplier_id = ?').get(supplierId) as any).c
  const payments = (db.prepare(
    'SELECT COUNT(*) c FROM supplier_payments WHERE supplier_id = ?').get(supplierId) as any).c

  if (invoices > 0 || payments > 0) {
    db.prepare('UPDATE suppliers SET is_active = 0 WHERE supplier_id = ?').run(supplierId)
    log.info(`[Supplier] Deactivated "${supplier.name}" — has ${invoices} invoice(s), ${payments} payment(s)`)
    return
  }

  db.prepare('DELETE FROM suppliers WHERE supplier_id = ?').run(supplierId)
  log.info(`[Supplier] Deleted "${supplier.name}"`)
}

// ===== Deliveries =====

/**
 * Record goods arriving from a supplier.
 *
 * Every line must name a raw material that already exists. That is the rule asked
 * for — nothing nameless is accepted — and it is also what makes the stock side
 * possible: goods can only be added to a material the inventory already knows about.
 * The Suppliers screen therefore picks from the existing materials rather than
 * offering a free-text box, with a "new material" route that demands a name.
 *
 * The whole thing is one transaction: either the invoice, its lines, the stock
 * movements and the new costs all land, or none of them do.
 */
export function recordDelivery(input: SupplierDeliveryInput, userId: number): SupplierInvoice {
  const db = getDb()

  getSupplier(input.supplierId) // throws if unknown

  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    throw new Error('أضف صنفاً واحداً على الأقل إلى الفاتورة')
  }

  // Validate everything BEFORE writing anything, so a bad last line cannot leave a
  // half-entered delivery behind.
  const priced = input.lines.map((line, i) => {
    const at = `السطر ${i + 1}`
    const material = db.prepare(
      'SELECT raw_material_id, name, unit FROM raw_materials WHERE raw_material_id = ?'
    ).get(line.rawMaterialId) as { raw_material_id: number; name: string; unit: string } | undefined

    // The "no nameless goods" rule, enforced where it actually matters.
    if (!material) throw new Error(`${at}: اختر صنفاً من المخزون`)
    if (!material.name?.trim()) throw new Error(`${at}: الصنف بدون اسم — صحّح بيانات المخزون أولاً`)

    const quantity = Number(line.quantity)
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new Error(`${at} (${material.name}): الكمية يجب أن تكون أكبر من صفر`)
    }
    const unitCost = Number(line.unitCost)
    if (!Number.isFinite(unitCost) || unitCost < 0) {
      throw new Error(`${at} (${material.name}): سعر الوحدة غير صحيح`)
    }

    return {
      material,
      quantity: round3(quantity),
      unitCost: round2(unitCost),
      lineTotal: round2(quantity * unitCost),
    }
  })

  const total = round2(priced.reduce((sum, l) => sum + l.lineTotal, 0))

  const run = db.transaction((): SupplierInvoice => {
    const res = db.prepare(`
      INSERT INTO supplier_invoices
        (supplier_id, invoice_date, reference, total_amount, notes, created_by)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      input.supplierId,
      input.invoiceDate || new Date().toISOString().slice(0, 10),
      input.reference?.trim() || null,
      total,
      input.notes?.trim() || null,
      userId,
    )
    const invoiceId = Number(res.lastInsertRowid)

    const insLine = db.prepare(`
      INSERT INTO supplier_invoice_items
        (supplier_invoice_id, raw_material_id, quantity, unit_cost, line_total)
      VALUES (?, ?, ?, ?, ?)
    `)
    const addStock = db.prepare(
      'UPDATE raw_materials SET stock_quantity = round(stock_quantity + ?, 3) WHERE raw_material_id = ?'
    )
    const logMove = db.prepare(`
      INSERT INTO raw_material_transactions (raw_material_id, change_amount, reason, created_by)
      VALUES (?, ?, 'restock', ?)
    `)
    // The newest price paid becomes the material's cost. Recipe costing — and so the
    // COGS on every future sale — is computed from this, so leaving it at whatever was
    // typed months ago would quietly report the wrong profit.
    const setCost = db.prepare(
      'UPDATE raw_materials SET cost_per_unit = ? WHERE raw_material_id = ?'
    )

    for (const line of priced) {
      insLine.run(invoiceId, line.material.raw_material_id, line.quantity, line.unitCost, line.lineTotal)
      addStock.run(line.quantity, line.material.raw_material_id)
      logMove.run(line.material.raw_material_id, line.quantity, userId)
      setCost.run(line.unitCost, line.material.raw_material_id)
    }

    log.info(
      `[Supplier] Delivery #${invoiceId} from ${input.supplierId}: ` +
      `${priced.length} line(s), total ${total} — stock updated`
    )
    return getInvoice(invoiceId)
  })

  return run()
}

export function getInvoice(invoiceId: number): SupplierInvoice {
  const db = getDb()
  const row = db.prepare(`
    SELECT si.*, s.name AS supplier_name, u.full_name AS created_by_name
    FROM supplier_invoices si
    JOIN suppliers s ON s.supplier_id = si.supplier_id
    LEFT JOIN users u ON u.user_id = si.created_by
    WHERE si.supplier_invoice_id = ?
  `).get(invoiceId) as SupplierInvoice | undefined
  if (!row) throw new Error('فاتورة المورد غير موجودة')

  row.items = db.prepare(`
    SELECT sii.*, rm.name AS material_name, rm.unit AS material_unit
    FROM supplier_invoice_items sii
    JOIN raw_materials rm ON rm.raw_material_id = sii.raw_material_id
    WHERE sii.supplier_invoice_id = ?
    ORDER BY sii.supplier_invoice_item_id
  `).all(invoiceId) as any[]

  return row
}

// ===== Payments =====

export function recordPayment(input: SupplierPaymentInput, userId: number): SupplierPayment {
  const db = getDb()
  getSupplier(input.supplierId)

  const amount = Number(input.amount)
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('المبلغ المدفوع يجب أن يكون أكبر من صفر')
  }
  const method = input.method ?? 'cash'
  if (!['cash', 'card', 'transfer'].includes(method)) {
    throw new Error('طريقة الدفع غير صحيحة')
  }

  const res = db.prepare(`
    INSERT INTO supplier_payments (supplier_id, amount, paid_on, method, notes, created_by)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    input.supplierId,
    round2(amount),
    input.paidOn || new Date().toISOString().slice(0, 10),
    method,
    input.notes?.trim() || null,
    userId,
  )

  log.info(`[Supplier] Payment of ${amount} to supplier ${input.supplierId}`)
  return db.prepare('SELECT * FROM supplier_payments WHERE supplier_payment_id = ?')
    .get(Number(res.lastInsertRowid)) as SupplierPayment
}

export function deletePayment(paymentId: number): void {
  const db = getDb()
  const row = db.prepare('SELECT * FROM supplier_payments WHERE supplier_payment_id = ?').get(paymentId)
  if (!row) throw new Error('الدفعة غير موجودة')
  db.prepare('DELETE FROM supplier_payments WHERE supplier_payment_id = ?').run(paymentId)
  log.info(`[Supplier] Payment ${paymentId} removed`)
}

// ===== What each supplier is owed =====

/**
 * One row per supplier: what they have supplied, what they have been paid, and what
 * is therefore still owed. This is the screen the owner actually looks at.
 */
export function getSuppliersSummary(): SupplierSummary[] {
  const rows = getDb().prepare(`
    SELECT
      s.supplier_id, s.name, s.phone, s.is_active,
      COALESCE(inv.total, 0)    AS supplied,
      COALESCE(pay.total, 0)    AS paid,
      inv.deliveries            AS deliveries,
      inv.last_date             AS last_delivery
    FROM suppliers s
    LEFT JOIN (
      SELECT supplier_id, SUM(total_amount) AS total, COUNT(*) AS deliveries,
             MAX(invoice_date) AS last_date
      FROM supplier_invoices GROUP BY supplier_id
    ) inv ON inv.supplier_id = s.supplier_id
    LEFT JOIN (
      SELECT supplier_id, SUM(amount) AS total
      FROM supplier_payments GROUP BY supplier_id
    ) pay ON pay.supplier_id = s.supplier_id
    ORDER BY (COALESCE(inv.total, 0) - COALESCE(pay.total, 0)) DESC, s.name
  `).all() as any[]

  return rows.map(r => ({
    supplierId: r.supplier_id,
    name: r.name,
    phone: r.phone,
    isActive: r.is_active,
    supplied: round2(r.supplied),
    paid: round2(r.paid),
    // Negative means the restaurant has paid ahead — worth showing, not hiding.
    owed: round2(r.supplied - r.paid),
    deliveries: r.deliveries ?? 0,
    lastDelivery: r.last_delivery ?? null,
  }))
}

/** One supplier's full history: every delivery and every payment. */
export function getSupplierAccount(supplierId: number): SupplierAccount {
  const db = getDb()
  const supplier = getSupplier(supplierId)

  const invoices = db.prepare(`
    SELECT si.*, u.full_name AS created_by_name
    FROM supplier_invoices si
    LEFT JOIN users u ON u.user_id = si.created_by
    WHERE si.supplier_id = ?
    ORDER BY si.invoice_date DESC, si.supplier_invoice_id DESC
  `).all(supplierId) as SupplierInvoice[]

  const itemsFor = db.prepare(`
    SELECT sii.*, rm.name AS material_name, rm.unit AS material_unit
    FROM supplier_invoice_items sii
    JOIN raw_materials rm ON rm.raw_material_id = sii.raw_material_id
    WHERE sii.supplier_invoice_id = ?
    ORDER BY sii.supplier_invoice_item_id
  `)
  for (const inv of invoices) inv.items = itemsFor.all(inv.supplier_invoice_id) as any[]

  const payments = db.prepare(`
    SELECT sp.*, u.full_name AS created_by_name
    FROM supplier_payments sp
    LEFT JOIN users u ON u.user_id = sp.created_by
    WHERE sp.supplier_id = ?
    ORDER BY sp.paid_on DESC, sp.supplier_payment_id DESC
  `).all(supplierId) as SupplierPayment[]

  const supplied = round2(invoices.reduce((s, i) => s + i.total_amount, 0))
  const paid = round2(payments.reduce((s, p) => s + p.amount, 0))

  return { supplier, invoices, payments, supplied, paid, owed: round2(supplied - paid) }
}

/**
 * Purchases and payments inside a date range, for the finance report.
 *
 * `owed` is deliberately the CURRENT total across all time, not something confined to
 * the range: what a supplier is owed today does not depend on which month you happen
 * to be looking at, and a figure that changed when you moved the dates would be
 * read as a bug.
 */
export function getSupplierTotals(start: string, end: string): SupplierTotals {
  const db = getDb()

  const purchased = (db.prepare(`
    SELECT COALESCE(SUM(total_amount), 0) t, COUNT(*) c
    FROM supplier_invoices WHERE invoice_date BETWEEN ? AND ?
  `).get(start, end) as any)

  const paid = (db.prepare(`
    SELECT COALESCE(SUM(amount), 0) t, COUNT(*) c
    FROM supplier_payments WHERE paid_on BETWEEN ? AND ?
  `).get(start, end) as any)

  const summary = getSuppliersSummary()

  return {
    purchasedInRange: round2(purchased.t),
    deliveriesInRange: purchased.c,
    paidInRange: round2(paid.t),
    paymentsInRange: paid.c,
    totalOwed: round2(summary.reduce((s, r) => s + Math.max(0, r.owed), 0)),
    bySupplier: summary.filter(r => r.supplied > 0 || r.paid > 0),
  }
}
