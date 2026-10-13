import React, { useState, useEffect, useCallback, useMemo } from 'react'
import type {
  RawMaterial, Supplier, SupplierAccount, SupplierSummary, SupplierPaymentMethod,
} from '../../../shared/types'
import { useSettingsStore } from '../../state/stores'
import NumberInput from '../../components/NumberInput'
import { todayStr } from '../../lib/clock'

/**
 * Suppliers: what they delivered, what they have been paid, and what is still owed.
 *
 * Recording a delivery here ALSO puts the goods into stock — one entry, not two — so
 * the shelf and the books cannot drift apart. Every line is picked from the raw
 * materials the restaurant already has, which is what stops anything nameless being
 * bought: goods with no name could not be added to stock in the first place.
 */

const METHOD_LABELS: Record<SupplierPaymentMethod, string> = {
  cash: 'نقدي',
  card: 'بطاقة',
  transfer: 'تحويل بنكي',
}

interface DraftLine {
  rawMaterialId: number | null
  quantity: number
  unitCost: number
}

const today = () => todayStr()

export default function SuppliersScreen() {
  const currency = useSettingsStore(s => s.settings.currency_symbol) || 'ج.م'

  const [summary, setSummary] = useState<SupplierSummary[]>([])
  const [materials, setMaterials] = useState<RawMaterial[]>([])
  const [account, setAccount] = useState<SupplierAccount | null>(null)
  const [toast, setToast] = useState<{ msg: string; type: string } | null>(null)
  const [busy, setBusy] = useState(false)

  // Add / edit a supplier
  const [supplierDraft, setSupplierDraft] = useState<Partial<Supplier> | null>(null)

  // Record a delivery
  const [deliveryFor, setDeliveryFor] = useState<SupplierSummary | null>(null)
  const [deliveryDate, setDeliveryDate] = useState(today())
  const [deliveryRef, setDeliveryRef] = useState('')
  const [lines, setLines] = useState<DraftLine[]>([])
  // Printing the voucher as the delivery is saved is the normal case — the supplier
  // is standing there waiting to be handed their copy.
  const [printOnSave, setPrintOnSave] = useState(true)
  const [printingId, setPrintingId] = useState<number | null>(null)

  // Record a payment
  const [paymentFor, setPaymentFor] = useState<SupplierSummary | null>(null)
  const [payAmount, setPayAmount] = useState(0)
  const [payMethod, setPayMethod] = useState<SupplierPaymentMethod>('cash')
  const [payDate, setPayDate] = useState(today())
  const [payNotes, setPayNotes] = useState('')

  const showToast = (msg: string, type = 'success') => {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3500)
  }

  const load = useCallback(async () => {
    const [s, m] = await Promise.all([
      window.api.getSuppliersSummary(),
      window.api.listRawMaterials(),
    ])
    if (s.success) setSummary(s.data)
    if (m.success) setMaterials(m.data)
  }, [])

  useEffect(() => { load() }, [load])

  // A delivery moves stock, so the material list has to follow along.
  useEffect(() => {
    if (!window.api?.onStockChanged) return
    return window.api.onStockChanged(() => { load() })
  }, [load])

  const totals = useMemo(() => ({
    supplied: summary.reduce((t, r) => t + r.supplied, 0),
    paid: summary.reduce((t, r) => t + r.paid, 0),
    owed: summary.reduce((t, r) => t + Math.max(0, r.owed), 0),
  }), [summary])

  const materialById = useMemo(
    () => new Map(materials.map(m => [m.raw_material_id, m])), [materials])

  // ---- Suppliers ----------------------------------------------------------

  const saveSupplier = async () => {
    if (!supplierDraft) return
    setBusy(true)
    const res = await window.api.upsertSupplier({
      supplierId: supplierDraft.supplier_id,
      name: supplierDraft.name ?? '',
      phone: supplierDraft.phone ?? '',
      notes: supplierDraft.notes ?? '',
    })
    setBusy(false)
    if (res.success) { showToast('تم حفظ المورد'); setSupplierDraft(null); load() }
    else showToast(res.error || 'تعذر حفظ المورد', 'error')
  }

  const removeSupplier = async (row: SupplierSummary) => {
    const res = await window.api.deleteSupplier(row.supplierId)
    if (res.success) { showToast(`تم حذف/إيقاف "${row.name}"`); load() }
    else showToast(res.error || 'تعذر الحذف', 'error')
  }

  // ---- Deliveries ---------------------------------------------------------

  const openDelivery = (row: SupplierSummary) => {
    setDeliveryFor(row)
    setDeliveryDate(today())
    setDeliveryRef('')
    setLines([{ rawMaterialId: null, quantity: 0, unitCost: 0 }])
  }

  const patchLine = (i: number, patch: Partial<DraftLine>) =>
    setLines(ls => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)))

  const deliveryTotal = lines.reduce(
    (t, l) => t + (Number(l.quantity) || 0) * (Number(l.unitCost) || 0), 0)

  const saveDelivery = async () => {
    if (!deliveryFor) return

    // Refuse nameless goods before the round trip, so the message points at the row.
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]
      if (!l.rawMaterialId) {
        showToast(`السطر ${i + 1}: اختر الصنف من المخزون`, 'error'); return
      }
      if (!(Number(l.quantity) > 0)) {
        showToast(`السطر ${i + 1}: أدخل كمية أكبر من صفر`, 'error'); return
      }
    }

    setBusy(true)
    const res = await window.api.recordSupplierDelivery({
      supplierId: deliveryFor.supplierId,
      invoiceDate: deliveryDate,
      reference: deliveryRef,
      lines: lines.map(l => ({
        rawMaterialId: l.rawMaterialId!,
        quantity: Number(l.quantity),
        unitCost: Number(l.unitCost),
      })),
    })
    setBusy(false)

    if (res.success) {
      showToast(`تم تسجيل التوريد وإضافة ${lines.length} صنف إلى المخزون`)
      setDeliveryFor(null)
      load()
      if (account?.supplier.supplier_id === deliveryFor.supplierId) openAccount(deliveryFor.supplierId)

      // Print the voucher straight away when the box is ticked. Fire-and-forget: the
      // delivery is already recorded and the stock already moved, so a printer out of
      // paper must not look like a failed delivery.
      if (printOnSave && res.data?.supplier_invoice_id) {
        void printVoucher(res.data.supplier_invoice_id)
      }
    } else {
      showToast(res.error || 'تعذر تسجيل التوريد', 'error')
    }
  }

  /** Two copies on the cashier printer — the supplier's and ours. */
  const printVoucher = async (invoiceId: number, reprint = false) => {
    setPrintingId(invoiceId)
    const res = await window.api.printSupplierInvoice(invoiceId, reprint)
    setPrintingId(null)

    if (!res.success) {
      showToast(res.error || 'تعذرت طباعة الإيصال', 'error')
      return
    }
    const failed = (res.data || []).filter((r: any) => !r.ok)
    if (failed.length > 0) {
      showToast(`تعذرت الطباعة على "${failed[0].printerName}" — ${failed[0].error ?? ''}`, 'error')
    } else {
      showToast('تمت طباعة نسختين: نسخة المورد ونسخة المطعم')
    }
  }

  // ---- Payments -----------------------------------------------------------

  const openPayment = (row: SupplierSummary) => {
    setPaymentFor(row)
    // Pre-filled with what is outstanding: paying the balance in full is the common case.
    setPayAmount(Math.max(0, row.owed))
    setPayMethod('cash')
    setPayDate(today())
    setPayNotes('')
  }

  const savePayment = async () => {
    if (!paymentFor) return
    if (!(payAmount > 0)) { showToast('أدخل مبلغاً أكبر من صفر', 'error'); return }

    setBusy(true)
    const res = await window.api.recordSupplierPayment({
      supplierId: paymentFor.supplierId,
      amount: payAmount,
      paidOn: payDate,
      method: payMethod,
      notes: payNotes,
    })
    setBusy(false)

    if (res.success) {
      showToast(`تم تسجيل دفعة ${payAmount.toFixed(2)} ${currency}`)
      setPaymentFor(null)
      load()
      if (account?.supplier.supplier_id === paymentFor.supplierId) openAccount(paymentFor.supplierId)
    } else {
      showToast(res.error || 'تعذر تسجيل الدفعة', 'error')
    }
  }

  const openAccount = async (supplierId: number) => {
    const res = await window.api.getSupplierAccount(supplierId)
    if (res.success) setAccount(res.data)
    else showToast(res.error || 'تعذر فتح كشف الحساب', 'error')
  }

  const money = (n: number) => `${n.toFixed(2)} ${currency}`

  return (
    <div className="animate-fade" dir="rtl" style={{ overflowY: 'auto', maxHeight: '100%' }}>
      <div className="page-header">
        <div>
          <h1 className="page-title">الموردون والمشتريات</h1>
          <p className="page-subtitle">
            البضاعة الموردة، المدفوع، والمستحق لكل مورد — والتوريد يُضاف للمخزون تلقائياً
          </p>
        </div>
        <button
          className="btn btn-primary"
          onClick={() => setSupplierDraft({ name: '', phone: '', notes: '' })}
        >
          ➕ إضافة مورد
        </button>
      </div>

      {/* Headline figures */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 14, marginBottom: 20 }}>
        <div className="card" style={{ margin: 0 }}>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>إجمالي البضاعة الموردة</div>
          <div style={{ fontSize: 24, fontWeight: 900 }}>{money(totals.supplied)}</div>
        </div>
        <div className="card" style={{ margin: 0 }}>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>إجمالي المدفوع</div>
          <div style={{ fontSize: 24, fontWeight: 900, color: 'var(--success)' }}>{money(totals.paid)}</div>
        </div>
        <div className="card" style={{ margin: 0, border: totals.owed > 0 ? '1px solid rgba(217,45,32,0.4)' : undefined }}>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>المستحق علينا الآن</div>
          <div style={{ fontSize: 24, fontWeight: 900, color: totals.owed > 0 ? 'var(--danger)' : 'var(--success)' }}>
            {money(totals.owed)}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-header"><span className="card-title">🚚 الموردون ({summary.length})</span></div>
        <div className="table-container">
          <table>
            <thead>
              <tr>
                <th>المورد</th><th>الهاتف</th><th>عدد التوريدات</th><th>آخر توريد</th>
                <th>الموردة</th><th>المدفوع</th><th>المستحق</th><th>إجراءات</th>
              </tr>
            </thead>
            <tbody>
              {summary.map(row => (
                <tr key={row.supplierId} style={{ opacity: row.isActive ? 1 : 0.5 }}>
                  <td style={{ fontWeight: 800 }}>{row.name}</td>
                  <td dir="ltr" style={{ textAlign: 'right' }}>{row.phone || '—'}</td>
                  <td>{row.deliveries}</td>
                  <td style={{ color: 'var(--text-muted)' }}>{row.lastDelivery || '—'}</td>
                  <td>{money(row.supplied)}</td>
                  <td style={{ color: 'var(--success)' }}>{money(row.paid)}</td>
                  <td style={{ fontWeight: 900, color: row.owed > 0 ? 'var(--danger)' : 'var(--success)' }}>
                    {row.owed < 0 ? `${money(Math.abs(row.owed))} (مقدماً)` : money(row.owed)}
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button className="btn btn-sm btn-primary" onClick={() => openDelivery(row)}>📦 توريد</button>
                    <button className="btn btn-sm btn-secondary" onClick={() => openPayment(row)}>💵 دفعة</button>
                    <button className="btn btn-sm btn-ghost" onClick={() => openAccount(row.supplierId)}>كشف حساب</button>
                    <button
                      className="btn btn-sm btn-ghost"
                      onClick={() => setSupplierDraft(summaryToSupplier(row))}
                    >
                      تعديل
                    </button>
                    <button className="btn btn-sm btn-ghost" style={{ color: 'var(--danger)' }}
                      onClick={() => removeSupplier(row)}>حذف</button>
                  </td>
                </tr>
              ))}
              {summary.length === 0 && (
                <tr><td colSpan={8} style={{ textAlign: 'center', padding: 32, color: 'var(--text-muted)' }}>
                  لا يوجد موردون بعد — اضغط "إضافة مورد" للبدء.
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Add / edit supplier */}
      {supplierDraft && (
        <div className="modal-overlay" onClick={() => !busy && setSupplierDraft(null)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 460 }}>
            <h2 className="modal-title">{supplierDraft.supplier_id ? 'تعديل المورد' : 'إضافة مورد'}</h2>
            <div className="form-group">
              <label className="form-label">اسم المورد *</label>
              <input className="input" autoFocus value={supplierDraft.name ?? ''}
                onChange={e => setSupplierDraft(d => ({ ...d!, name: e.target.value }))}
                placeholder="مثال: مزارع الدلتا للدواجن" />
            </div>
            <div className="form-group">
              <label className="form-label">الهاتف</label>
              <input className="input" dir="ltr" value={supplierDraft.phone ?? ''}
                onChange={e => setSupplierDraft(d => ({ ...d!, phone: e.target.value }))} />
            </div>
            <div className="form-group">
              <label className="form-label">ملاحظات</label>
              <input className="input" value={supplierDraft.notes ?? ''}
                onChange={e => setSupplierDraft(d => ({ ...d!, notes: e.target.value }))} />
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn btn-primary" style={{ flex: 1 }} disabled={busy || !supplierDraft.name?.trim()}
                onClick={saveSupplier}>{busy ? 'جاري الحفظ...' : '💾 حفظ'}</button>
              <button className="btn btn-secondary" disabled={busy} onClick={() => setSupplierDraft(null)}>إلغاء</button>
            </div>
          </div>
        </div>
      )}

      {/* Record a delivery */}
      {deliveryFor && (
        <div className="modal-overlay" onClick={() => !busy && setDeliveryFor(null)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 780, maxHeight: '90vh', overflowY: 'auto' }}>
            <h2 className="modal-title">تسجيل توريد من: {deliveryFor.name}</h2>
            <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 16, lineHeight: 1.8 }}>
              اختر الأصناف من <b>مخزونك الحالي</b> — الكميات تُضاف إلى المخزون فور الحفظ،
              ويُحدَّث سعر التكلفة بآخر سعر شراء. لا يمكن تسجيل صنف بدون اسم.
            </p>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <div className="form-group">
                <label className="form-label">تاريخ التوريد</label>
                <input className="input" type="date" value={deliveryDate}
                  onChange={e => setDeliveryDate(e.target.value)} />
              </div>
              <div className="form-group">
                <label className="form-label">رقم فاتورة المورد (اختياري)</label>
                <input className="input" value={deliveryRef} onChange={e => setDeliveryRef(e.target.value)} />
              </div>
            </div>

            <div className="table-container" style={{ marginBottom: 12 }}>
              <table>
                <thead>
                  <tr><th style={{ width: '40%' }}>الصنف</th><th>الكمية</th><th>سعر الوحدة</th><th>الإجمالي</th><th></th></tr>
                </thead>
                <tbody>
                  {lines.map((line, i) => {
                    const mat = line.rawMaterialId ? materialById.get(line.rawMaterialId) : null
                    return (
                      <tr key={i}>
                        <td>
                          <select
                            className="input"
                            value={line.rawMaterialId ?? ''}
                            onChange={e => {
                              const id = Number(e.target.value) || null
                              const m = id ? materialById.get(id) : null
                              // Pre-fill the last price paid — usually right, always editable.
                              patchLine(i, { rawMaterialId: id, unitCost: m?.cost_per_unit ?? 0 })
                            }}
                          >
                            <option value="">— اختر صنفاً —</option>
                            {materials.map(m => (
                              <option key={m.raw_material_id} value={m.raw_material_id}>
                                {m.name} ({m.unit}) — رصيد {m.stock_quantity}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td>
                          <NumberInput value={line.quantity} decimals={3}
                            onValueChange={v => patchLine(i, { quantity: v })} />
                          {mat && <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{mat.unit}</div>}
                        </td>
                        <td>
                          <NumberInput value={line.unitCost}
                            onValueChange={v => patchLine(i, { unitCost: v })} />
                        </td>
                        <td style={{ fontWeight: 800 }}>
                          {((Number(line.quantity) || 0) * (Number(line.unitCost) || 0)).toFixed(2)}
                        </td>
                        <td>
                          <button className="btn btn-ghost btn-sm" style={{ color: 'var(--danger)' }}
                            onClick={() => setLines(ls => ls.filter((_, j) => j !== i))}>✕</button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            <button className="btn btn-ghost btn-sm" style={{ marginBottom: 14 }}
              onClick={() => setLines(ls => [...ls, { rawMaterialId: null, quantity: 0, unitCost: 0 }])}>
              ➕ إضافة سطر
            </button>

            <div style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: 14, marginBottom: 16, borderRadius: 'var(--radius-sm)',
              background: 'var(--bg-card-hover)', fontWeight: 900, fontSize: 19,
            }}>
              <span>إجمالي الفاتورة</span>
              <span style={{ color: 'var(--accent)' }}>{money(deliveryTotal)}</span>
            </div>

            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', marginBottom: 12 }}>
              <input type="checkbox" checked={printOnSave} onChange={e => setPrintOnSave(e.target.checked)} />
              <span>🖨️ اطبع الإيصال فور الحفظ — <b>نسختان</b>: نسخة للمورد ونسخة للمطعم</span>
            </label>

            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn btn-primary" style={{ flex: 1 }} disabled={busy || lines.length === 0}
                onClick={saveDelivery}>{busy ? 'جاري الحفظ...' : '📦 تسجيل التوريد وإضافته للمخزون'}</button>
              <button className="btn btn-secondary" disabled={busy} onClick={() => setDeliveryFor(null)}>إلغاء</button>
            </div>
          </div>
        </div>
      )}

      {/* Record a payment */}
      {paymentFor && (
        <div className="modal-overlay" onClick={() => !busy && setPaymentFor(null)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 460 }}>
            <h2 className="modal-title">دفعة إلى: {paymentFor.name}</h2>
            <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 14 }}>
              المستحق حالياً: <b style={{ color: 'var(--danger)' }}>{money(Math.max(0, paymentFor.owed))}</b>
            </p>
            <div className="form-group">
              <label className="form-label">المبلغ *</label>
              <NumberInput value={payAmount} onValueChange={setPayAmount} />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <div className="form-group">
                <label className="form-label">التاريخ</label>
                <input className="input" type="date" value={payDate} onChange={e => setPayDate(e.target.value)} />
              </div>
              <div className="form-group">
                <label className="form-label">طريقة الدفع</label>
                <select className="input" value={payMethod}
                  onChange={e => setPayMethod(e.target.value as SupplierPaymentMethod)}>
                  {(Object.keys(METHOD_LABELS) as SupplierPaymentMethod[]).map(m => (
                    <option key={m} value={m}>{METHOD_LABELS[m]}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="form-group">
              <label className="form-label">ملاحظات</label>
              <input className="input" value={payNotes} onChange={e => setPayNotes(e.target.value)} />
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn btn-primary" style={{ flex: 1 }} disabled={busy || !(payAmount > 0)}
                onClick={savePayment}>{busy ? 'جاري الحفظ...' : '💵 تسجيل الدفعة'}</button>
              <button className="btn btn-secondary" disabled={busy} onClick={() => setPaymentFor(null)}>إلغاء</button>
            </div>
          </div>
        </div>
      )}

      {/* Full account statement */}
      {account && (
        <div className="modal-overlay" onClick={() => setAccount(null)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 820, maxHeight: '90vh', overflowY: 'auto' }}>
            <h2 className="modal-title">كشف حساب: {account.supplier.name}</h2>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 18 }}>
              <div style={{ padding: 12, background: 'var(--bg-card-hover)', borderRadius: 'var(--radius-sm)' }}>
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>الموردة</div>
                <div style={{ fontSize: 19, fontWeight: 900 }}>{money(account.supplied)}</div>
              </div>
              <div style={{ padding: 12, background: 'var(--bg-card-hover)', borderRadius: 'var(--radius-sm)' }}>
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>المدفوع</div>
                <div style={{ fontSize: 19, fontWeight: 900, color: 'var(--success)' }}>{money(account.paid)}</div>
              </div>
              <div style={{ padding: 12, background: 'var(--bg-card-hover)', borderRadius: 'var(--radius-sm)' }}>
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>المستحق</div>
                <div style={{ fontSize: 19, fontWeight: 900, color: account.owed > 0 ? 'var(--danger)' : 'var(--success)' }}>
                  {money(account.owed)}
                </div>
              </div>
            </div>

            <div style={{ fontWeight: 800, marginBottom: 8 }}>📦 التوريدات ({account.invoices.length})</div>
            <div className="table-container" style={{ marginBottom: 18, maxHeight: 260 }}>
              <table>
                <thead><tr><th>التاريخ</th><th>المرجع</th><th>الأصناف</th><th>الإجمالي</th><th></th></tr></thead>
                <tbody>
                  {account.invoices.map(inv => (
                    <tr key={inv.supplier_invoice_id}>
                      <td>{inv.invoice_date}</td>
                      <td>{inv.reference || '—'}</td>
                      <td style={{ fontSize: 12 }}>
                        {(inv.items ?? []).map(it =>
                          `${it.material_name} ${it.quantity} ${it.material_unit}`).join('، ') || '—'}
                      </td>
                      <td style={{ fontWeight: 800 }}>{money(inv.total_amount)}</td>
                      <td>
                        <button
                          className="btn btn-sm btn-ghost"
                          disabled={printingId === inv.supplier_invoice_id}
                          onClick={() => printVoucher(inv.supplier_invoice_id, true)}
                        >
                          {printingId === inv.supplier_invoice_id ? '...' : '🖨️ طباعة'}
                        </button>
                      </td>
                    </tr>
                  ))}
                  {account.invoices.length === 0 && (
                    <tr><td colSpan={5} style={{ textAlign: 'center', padding: 18, color: 'var(--text-muted)' }}>
                      لا توجد توريدات
                    </td></tr>
                  )}
                </tbody>
              </table>
            </div>

            <div style={{ fontWeight: 800, marginBottom: 8 }}>💵 الدفعات ({account.payments.length})</div>
            <div className="table-container" style={{ maxHeight: 220 }}>
              <table>
                <thead><tr><th>التاريخ</th><th>الطريقة</th><th>ملاحظات</th><th>المبلغ</th></tr></thead>
                <tbody>
                  {account.payments.map(p => (
                    <tr key={p.supplier_payment_id}>
                      <td>{p.paid_on}</td>
                      <td>{METHOD_LABELS[p.method]}</td>
                      <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{p.notes || '—'}</td>
                      <td style={{ fontWeight: 800, color: 'var(--success)' }}>{money(p.amount)}</td>
                    </tr>
                  ))}
                  {account.payments.length === 0 && (
                    <tr><td colSpan={4} style={{ textAlign: 'center', padding: 18, color: 'var(--text-muted)' }}>
                      لا توجد دفعات
                    </td></tr>
                  )}
                </tbody>
              </table>
            </div>

            <button className="btn btn-secondary" style={{ marginTop: 16 }} onClick={() => setAccount(null)}>
              إغلاق
            </button>
          </div>
        </div>
      )}

      {toast && (
        <div className={`toast toast-${toast.type} animate-slide`}>
          <span>{toast.type === 'success' ? '✓' : '⚠️'}</span>
          <span>{toast.msg}</span>
        </div>
      )}
    </div>
  )
}

/** The list row carries only a summary; editing wants the supplier's own fields. */
function summaryToSupplier(row: SupplierSummary): Partial<Supplier> {
  return { supplier_id: row.supplierId, name: row.name, phone: row.phone ?? '', notes: '' }
}
