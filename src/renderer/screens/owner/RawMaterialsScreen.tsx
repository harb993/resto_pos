import React, { useState, useEffect, useCallback } from 'react'
import type {
  RawMaterial, PrepConversion, RawMaterialManualReason, RawMaterialTransaction,
} from '../../../shared/types'
import { useAuthStore } from '../../state/stores'
import NumberInput from '../../components/NumberInput'
import DeleteEntityModal from '../../components/DeleteEntityModal'

const UNIT_OPTIONS = ['قطعة', 'دجاجة', 'كجم', 'جرام', 'لتر', 'رغيف', 'كانز', 'علبة']

/** How each stock movement reads in the history log. */
const RM_REASON_LABEL: Record<string, string> = {
  sale: 'بيع',
  restock: 'توريد',
  waste: 'هالك',
  adjustment: 'تسوية جرد',
  prep_out: 'مستهلك في التجهيز',
  prep_in: 'ناتج تجهيز',
  void: 'إرجاع (إلغاء/حذف فاتورة)',
}
const RM_REASON_BADGE: Record<string, string> = {
  sale: 'badge-info',
  restock: 'badge-success',
  waste: 'badge-danger',
  adjustment: 'badge-warning',
  prep_out: 'badge-warning',
  prep_in: 'badge-success',
  void: 'badge-success',
}

const emptyForm = {
  rawMaterialId: undefined as number | undefined,
  name: '',
  unit: 'قطعة',
  costPerUnit: 0,
  lowStockThreshold: 5,
  openingStock: 0,
  isActive: 1,
}

export default function RawMaterialsScreen() {
  // Accountants can see the stock and its value, but every write is owner-gated in
  // the main process — so hide the controls rather than show buttons that will fail.
  const user = useAuthStore((s: any) => s.user)
  const canEdit = user?.role === 'owner'

  const [materials, setMaterials] = useState<RawMaterial[]>([])
  const [preps, setPreps] = useState<PrepConversion[]>([])
  const [loading, setLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')
  const [toast, setToast] = useState<{ msg: string; type: string } | null>(null)

  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState(emptyForm)

  const [adjusting, setAdjusting] = useState<RawMaterial | null>(null)
  const [adjustQty, setAdjustQty] = useState('')
  /**
   * `count` is not a movement the database knows about — it is how a stocktake is
   * actually done. The other three ask for a DIFFERENCE, which means the person
   * holding the clipboard has to work out that 42 counted against 37.5 on screen is
   * "+4.5" and type that. They are counting sacks of rice at midnight; the arithmetic
   * is where the mistakes come from.
   *
   * So this one takes the number they counted and works the difference out itself,
   * then records it as an ordinary `adjustment` — the movement log still shows what
   * changed and by how much, which is the thing that has to stay true.
   */
  const [adjustReason, setAdjustReason] = useState<RawMaterialManualReason | 'count'>('restock')

  const [runningPrep, setRunningPrep] = useState<PrepConversion | null>(null)
  const [prepBatches, setPrepBatches] = useState('')

  // Creating / editing a prep rule (e.g. 1 كجم بطاطس → 4 أطباق)
  const [editingPrep, setEditingPrep] = useState<Partial<PrepConversion> | null>(null)
  const [savingPrep, setSavingPrep] = useState(false)

  // Deleting a material — the modal checks what depends on it before offering anything.
  const [deletingMaterialId, setDeletingMaterialId] = useState<number | null>(null)

  // Movement history for one material
  const [historyFor, setHistoryFor] = useState<RawMaterial | null>(null)
  const [history, setHistory] = useState<RawMaterialTransaction[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)

  const showToast = (msg: string, type = 'success') => {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3500)
  }

  const loadData = useCallback(async () => {
    setLoading(true)
    const [matRes, prepRes] = await Promise.all([
      window.api.listRawMaterials(true),
      window.api.listPrepConversions(),
    ])
    if (matRes.success) setMaterials(matRes.data)
    if (prepRes.success) setPreps(prepRes.data)
    setLoading(false)
  }, [])

  useEffect(() => { loadData() }, [loadData])

  // Balances change from elsewhere too — a sale at the till, a deleted invoice
  // returning its ingredients. Without this the screen kept showing the figure it
  // read on mount, which looked like the stock had not moved at all.
  useEffect(() => {
    if (!window.api?.onStockChanged) return
    return window.api.onStockChanged(() => { loadData() })
  }, [loadData])

  const openCreate = () => { setForm(emptyForm); setShowForm(true) }

  const openEdit = (m: RawMaterial) => {
    setForm({
      rawMaterialId: m.raw_material_id,
      name: m.name,
      unit: m.unit,
      costPerUnit: m.cost_per_unit,
      lowStockThreshold: m.low_stock_threshold,
      openingStock: 0,
      isActive: m.is_active,
    })
    setShowForm(true)
  }

  const saveMaterial = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.name.trim()) return
    const res = await window.api.upsertRawMaterial(form)
    if (res.success) {
      showToast(form.rawMaterialId ? 'تم تحديث المادة الخام' : 'تم إضافة المادة الخام')
      setShowForm(false)
      loadData()
    } else {
      showToast(res.error || 'فشل الحفظ', 'error')
    }
  }

  /** For a stocktake: what the counted figure means as a movement. */
  const countDelta = (): number => {
    if (!adjusting || adjustQty === '') return 0
    return Math.round((Number(adjustQty) - adjusting.stock_quantity) * 1000) / 1000
  }

  const submitAdjust = async () => {
    if (!adjusting || adjustQty === '') return

    const counting = adjustReason === 'count'
    const change = counting ? countDelta() : Number(adjustQty)
    if (!counting && change === 0) return

    if (counting && change === 0) {
      // Counted exactly what the system already said. Nothing to record — writing a
      // zero movement would put a line in the history that says nothing happened.
      showToast(`الرصيد مطابق للجرد — لا حاجة لأي تعديل`)
      setAdjusting(null); setAdjustQty('')
      return
    }

    const res = await window.api.adjustRawMaterialStock(
      adjusting.raw_material_id, change, counting ? 'adjustment' : adjustReason
    )
    if (res.success) {
      showToast(counting
        ? `تم ضبط رصيد (${adjusting.name}) على ${adjustQty} ${adjusting.unit}`
        : `تم تحديث رصيد (${adjusting.name})`)
      setAdjusting(null); setAdjustQty(''); loadData()
    } else {
      showToast(res.error || 'فشل تحديث الرصيد', 'error')
    }
  }

  // ---- prep conversion rules ----

  const openNewPrep = () => {
    const first = materials.find(m => m.is_active)
    const second = materials.find(m => m.is_active && m.raw_material_id !== first?.raw_material_id)
    setEditingPrep({
      source_material_id: first?.raw_material_id,
      output_material_id: second?.raw_material_id,
      yield_quantity: 1,
    })
  }

  const savePrep = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!editingPrep) return
    setSavingPrep(true)
    const res = await window.api.upsertPrepConversion({
      prepConversionId: editingPrep.prep_conversion_id,
      sourceMaterialId: editingPrep.source_material_id,
      outputMaterialId: editingPrep.output_material_id,
      yieldQuantity: editingPrep.yield_quantity,
    })
    setSavingPrep(false)
    if (res.success) {
      showToast(editingPrep.prep_conversion_id ? 'تم تعديل عملية التجهيز' : 'تم إضافة عملية التجهيز')
      setEditingPrep(null)
      loadData()
    } else {
      showToast(res.error || 'تعذر حفظ عملية التجهيز', 'error')
    }
  }

  const removePrep = async (p: PrepConversion) => {
    const res = await window.api.deletePrepConversion(p.prep_conversion_id)
    if (res.success) {
      showToast('تم حذف عملية التجهيز')
      loadData()
    } else {
      showToast(res.error || 'تعذر الحذف', 'error')
    }
  }

  // ---- movement history ----

  const HISTORY_LIMIT = 300

  const openHistory = async (m: RawMaterial) => {
    setHistoryFor(m)
    setHistoryLoading(true)
    setHistory([])
    const res = await window.api.getRawMaterialHistory(m.raw_material_id, HISTORY_LIMIT)
    if (res.success) setHistory(res.data)
    setHistoryLoading(false)
  }

  /**
   * Balance after each movement, walked backwards from today's stock.
   *
   * The history only holds movements; the quantity a material was created with was never
   * a movement, so the rows on their own never add up to the balance on screen. Showing
   * the running balance — and the leftover as an opening row — makes the ledger tie out.
   */
  const historyRunning = React.useMemo(() => {
    if (!historyFor) return { rows: [] as { balance: number }[], opening: 0 }
    let balance = historyFor.stock_quantity
    const rows = history.map(h => {
      const after = balance
      balance = Math.round((balance - h.change_amount) * 1000) / 1000
      return { balance: Math.round(after * 1000) / 1000 }
    })
    return { rows, opening: Math.round(balance * 1000) / 1000 }
  }, [history, historyFor])

  const submitPrep = async () => {
    if (!runningPrep || !prepBatches) return
    const res = await window.api.runPrep(runningPrep.prep_conversion_id, Number(prepBatches))
    if (res.success) {
      const d = res.data
      showToast(`تم تجهيز ${d.sourceUsed} × ${d.sourceName} ← ${d.outputProduced} ${d.outputUnit} ${d.outputName}`)
      setRunningPrep(null); setPrepBatches(''); loadData()
    } else {
      showToast(res.error || 'فشل التجهيز', 'error')
    }
  }

  const filtered = materials.filter(m =>
    searchQuery === '' || m.name.toLowerCase().includes(searchQuery.toLowerCase())
  )

  const activeMaterials = materials.filter(m => m.is_active)
  const lowCount = activeMaterials.filter(m => m.stock_quantity <= m.low_stock_threshold).length
  const outCount = activeMaterials.filter(m => m.stock_quantity <= 0).length
  const stockValue = activeMaterials.reduce(
    (sum, m) => sum + Math.max(0, m.stock_quantity) * m.cost_per_unit, 0
  )

  const stockBadge = (m: RawMaterial) => {
    if (m.stock_quantity <= 0) return 'badge-danger'
    if (m.stock_quantity <= m.low_stock_threshold) return 'badge-warning'
    return 'badge-success'
  }

  return (
    <div className="animate-fade" dir="rtl">
      <div className="page-header">
        <div>
          <h1 className="page-title">المواد الخام والمخزون</h1>
          <p className="page-subtitle">
            {activeMaterials.length} مادة نشطة · قيمة المخزون: {stockValue.toFixed(2)} ج.م
            {lowCount > 0 && (
              <span style={{ color: 'var(--danger)', fontWeight: 800 }}> · ⚠️ {lowCount} مادة قاربت على النفاد</span>
            )}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="btn btn-secondary" onClick={loadData}>🔄 تحديث</button>
          {canEdit && (
            <button className="btn btn-primary" onClick={openCreate}>+ إضافة مادة خام</button>
          )}
        </div>
      </div>

      {/* Prep conversions — the daily "we butchered N chickens" step */}
      {canEdit && (
        <div className="card" style={{ marginBottom: 18 }}>
          <div className="card-header">
            <span className="card-title">🔪 التجهيز اليومي (تقطيع وتحضير)</span>
            <button className="btn btn-primary btn-sm" onClick={openNewPrep}>
              + إضافة عملية تجهيز
            </button>
          </div>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
            عرّف أي تحويل بين مادتين (دجاجة ← قطع، كيس بطاطس ← أطباق)، ثم سجّل ما تم تجهيزه —
            يُخصم من المادة الأصلية ويُضاف للمادة الجاهزة تلقائياً.
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {preps.length === 0 && (
              <p style={{ fontSize: 13, color: 'var(--text-muted)', padding: '10px 0' }}>
                لا توجد عمليات تجهيز — أضف واحدة لتحويل مادة خام إلى مادة جاهزة.
              </p>
            )}
            {preps.map(p => (
              <div
                key={p.prep_conversion_id}
                style={{
                  display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
                  background: 'var(--bg-card)', padding: '10px 14px', borderRadius: 'var(--radius-sm)',
                }}
              >
                <span style={{ fontWeight: 800 }}>
                  1 {p.source_unit} {p.source_name} ← {p.yield_quantity} {p.output_unit} {p.output_name}
                </span>
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  (متاح: {p.source_stock} {p.source_unit} · جاهز: {p.output_stock} {p.output_unit})
                </span>
                <div style={{ display: 'flex', gap: 6, marginRight: 'auto' }}>
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={() => { setRunningPrep(p); setPrepBatches('') }}
                  >
                    🔪 تسجيل تجهيز
                  </button>
                  <button className="btn btn-secondary btn-sm" onClick={() => setEditingPrep(p)}>
                    تعديل
                  </button>
                  <button className="btn btn-danger btn-sm" onClick={() => removePrep(p)}>
                    حذف
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Search + counters */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, gap: 16 }}>
        <div style={{ width: 320 }}>
          <input
            className="input"
            style={{ padding: '9px 14px', fontSize: 13 }}
            type="text"
            placeholder="بحث عن مادة خام..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <div className="badge badge-success" style={{ padding: '6px 14px', fontSize: 13 }}>
            متوفر: {activeMaterials.length - lowCount}
          </div>
          <div className="badge badge-warning" style={{ padding: '6px 14px', fontSize: 13 }}>
            منخفض: {lowCount - outCount}
          </div>
          <div className="badge badge-danger" style={{ padding: '6px 14px', fontSize: 13 }}>
            نفذ: {outCount}
          </div>
        </div>
      </div>

      <div className="table-container">
        <table>
          <thead>
            <tr>
              <th>المادة الخام</th>
              <th>الوحدة</th>
              <th>الرصيد الحالي</th>
              <th>حد التنبيه</th>
              <th>تكلفة الوحدة</th>
              <th>قيمة الرصيد</th>
              <th>الحالة</th>
              <th>الإجراءات</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(m => (
              <tr key={m.raw_material_id} style={{ opacity: m.is_active ? 1 : 0.55 }}>
                <td style={{ fontWeight: 800 }}>{m.name}</td>
                <td style={{ color: 'var(--text-muted)' }}>{m.unit}</td>
                <td>
                  <span className={`badge ${stockBadge(m)}`} style={{ fontSize: 13, padding: '4px 12px' }}>
                    {m.stock_quantity} {m.unit}
                  </span>
                </td>
                <td style={{ color: 'var(--text-muted)' }}>{m.low_stock_threshold}</td>
                <td>{m.cost_per_unit.toFixed(2)} ج.م</td>
                <td style={{ fontWeight: 700 }}>
                  {(Math.max(0, m.stock_quantity) * m.cost_per_unit).toFixed(2)} ج.م
                </td>
                <td>
                  <span className={`badge ${m.is_active ? 'badge-success' : 'badge-danger'}`}>
                    {m.is_active ? 'نشط' : 'موقوف'}
                  </span>
                </td>
                <td>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {canEdit && (
                      <>
                        <button
                          className="btn btn-primary btn-sm"
                          onClick={() => { setAdjusting(m); setAdjustQty(''); setAdjustReason('restock') }}
                        >
                          📦 حركة رصيد
                        </button>
                        <button className="btn btn-secondary btn-sm" onClick={() => openEdit(m)}>تعديل</button>
                        <button
                          className="btn btn-ghost btn-sm"
                          style={{ color: 'var(--danger)' }}
                          onClick={() => setDeletingMaterialId(m.raw_material_id)}
                        >
                          🗑️ حذف
                        </button>
                      </>
                    )}
                    {/* Answers "why did this balance change" — available to the accountant too. */}
                    <button className="btn btn-ghost btn-sm" onClick={() => openHistory(m)}>
                      📋 السجل
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && !loading && (
              <tr>
                <td colSpan={8} style={{ textAlign: 'center', padding: 40 }}>
                  <div className="empty-state">
                    <div className="empty-state-icon">📦</div>
                    <div className="empty-state-text">لا توجد مواد خام مطابقة</div>
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Add / edit material */}
      {showForm && (
        <div className="modal-overlay" onClick={() => setShowForm(false)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 460 }}>
            <h2 className="modal-title">{form.rawMaterialId ? 'تعديل مادة خام' : 'إضافة مادة خام جديدة'}</h2>
            <form onSubmit={saveMaterial}>
              <div className="form-group">
                <label className="form-label">اسم المادة *</label>
                <input
                  className="input"
                  required
                  autoFocus
                  value={form.name}
                  onChange={e => setForm({ ...form, name: e.target.value })}
                  placeholder="مثال: دجاج كامل، أرز، خبز برجر"
                />
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <div className="form-group">
                  <label className="form-label">وحدة القياس *</label>
                  <input
                    className="input"
                    required
                    list="unit-options"
                    value={form.unit}
                    onChange={e => setForm({ ...form, unit: e.target.value })}
                  />
                  <datalist id="unit-options">
                    {UNIT_OPTIONS.map(u => <option key={u} value={u} />)}
                  </datalist>
                </div>
                <div className="form-group">
                  <label className="form-label">تكلفة الوحدة (ج.م) *</label>
                  <NumberInput
                    value={form.costPerUnit}
                    onValueChange={v => setForm({ ...form, costPerUnit: v })}
                    placeholder="0.00"
                  />
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <div className="form-group">
                  <label className="form-label">حد التنبيه (رصيد منخفض)</label>
                  <NumberInput
                    value={form.lowStockThreshold}
                    onValueChange={v => setForm({ ...form, lowStockThreshold: v })}
                    decimals={3}
                    placeholder="0"
                  />
                </div>
                {!form.rawMaterialId && (
                  <div className="form-group">
                    <label className="form-label">الرصيد الافتتاحي</label>
                    <NumberInput
                      value={form.openingStock}
                      onValueChange={v => setForm({ ...form, openingStock: v })}
                      decimals={3}
                      placeholder="0"
                    />
                  </div>
                )}
              </div>

              {form.rawMaterialId && (
                <>
                  <div className="form-group" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <input
                      type="checkbox"
                      checked={form.isActive === 1}
                      onChange={e => setForm({ ...form, isActive: e.target.checked ? 1 : 0 })}
                    />
                    <label className="form-label" style={{ marginBottom: 0 }}>مادة نشطة</label>
                  </div>
                  <p style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 12 }}>
                    الرصيد لا يُعدَّل من هنا — استخدم زر «حركة رصيد» ليُسجَّل في سجل الحركات.
                  </p>
                </>
              )}

              <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
                <button type="submit" className="btn btn-primary" style={{ flex: 1 }}>حفظ</button>
                <button type="button" className="btn btn-secondary" onClick={() => setShowForm(false)}>إلغاء</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Stock movement */}
      {adjusting && (
        <div className="modal-overlay" onClick={() => setAdjusting(null)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 420 }}>
            <h2 className="modal-title">حركة رصيد: {adjusting.name}</h2>

            <div style={{ background: 'var(--bg-card)', padding: 14, borderRadius: 'var(--radius-sm)', marginBottom: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14 }}>
                <span style={{ color: 'var(--text-muted)' }}>الرصيد الحالي:</span>
                <span style={{ fontWeight: 900, color: 'var(--accent)', fontSize: 16 }}>
                  {adjusting.stock_quantity} {adjusting.unit}
                </span>
              </div>
            </div>

            <div className="form-group">
              <label className="form-label">نوع الحركة</label>
              <select
                className="input"
                value={adjustReason}
                onChange={e => { setAdjustReason(e.target.value as any); setAdjustQty('') }}
              >
                <option value="count">📋 جرد — اكتب الكمية الموجودة فعلاً</option>
                <option value="restock">📥 توريد جديد (إضافة)</option>
                <option value="waste">🗑️ هالك / تالف (خصم)</option>
                <option value="adjustment">⚙️ تسوية يدوية (موجب أو سالب)</option>
              </select>
            </div>

            <div className="form-group">
              <label className="form-label">
                {adjustReason === 'count'
                  ? `الكمية الموجودة فعلاً (${adjusting.unit})`
                  : `الكمية (${adjusting.unit})`}
              </label>
              <NumberInput
                value={adjustQty === '' ? null : Number(adjustQty)}
                onValueChange={v => setAdjustQty(String(v))}
                decimals={3}
                // Stocktakes go both ways; a delivery or a write-off does not.
                allowNegative={adjustReason === 'adjustment'}
                placeholder={
                  adjustReason === 'count' ? `عدّ وسجّل الرقم — مثال: ${adjusting.stock_quantity}`
                    : adjustReason === 'adjustment' ? 'مثال: 5 أو 5-'
                    : 'أدخل الكمية'
                }
                autoFocus
              />
              {adjustReason === 'adjustment' && (
                <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                  استخدم رقماً سالباً للخصم من الرصيد.
                </p>
              )}
              {/* Say what is about to be written, before it is written. */}
              {adjustReason === 'count' && adjustQty !== '' && (
                <div style={{
                  marginTop: 8, padding: '8px 11px', fontSize: 12.5, lineHeight: 1.9,
                  borderRadius: 'var(--radius-sm)',
                  background: countDelta() === 0 ? 'var(--success-bg)' : 'var(--warning-bg)',
                  borderRight: `3px solid var(--${countDelta() === 0 ? 'success' : 'warning'})`,
                }}>
                  {countDelta() === 0 ? (
                    <>✅ مطابق للرصيد المسجّل — لن يُسجَّل أي تعديل.</>
                  ) : (
                    <>
                      سيُسجَّل فرق جرد قدره{' '}
                      <b style={{ color: countDelta() > 0 ? 'var(--success)' : 'var(--danger)' }}>
                        {countDelta() > 0 ? '+' : ''}{countDelta()} {adjusting.unit}
                      </b>
                      <br />
                      {adjusting.stock_quantity} ← <b>{adjustQty}</b> {adjusting.unit}
                    </>
                  )}
                </div>
              )}
            </div>

            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 20 }}>
              <button className="btn btn-secondary" onClick={() => setAdjusting(null)}>إلغاء</button>
              <button
                className="btn btn-primary"
                onClick={submitAdjust}
                disabled={adjustQty === '' || (adjustReason !== 'count' && Number(adjustQty) === 0)}
              >
                {adjustReason === 'count' ? 'حفظ الجرد' : 'تأكيد الحركة'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Run a prep batch */}
      {runningPrep && (
        <div className="modal-overlay" onClick={() => setRunningPrep(null)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 430 }}>
            <h2 className="modal-title">تسجيل تجهيز</h2>

            <div style={{ background: 'var(--bg-card)', padding: 14, borderRadius: 'var(--radius-sm)', marginBottom: 16, fontSize: 13 }}>
              <div style={{ fontWeight: 800, marginBottom: 6 }}>
                1 {runningPrep.source_unit} {runningPrep.source_name} ← {runningPrep.yield_quantity} {runningPrep.output_unit} {runningPrep.output_name}
              </div>
              <div style={{ color: 'var(--text-muted)' }}>
                المتاح للتجهيز: {runningPrep.source_stock} {runningPrep.source_unit}
              </div>
            </div>

            <div className="form-group">
              <label className="form-label">
                الكمية المُجهَّزة ({runningPrep.source_unit})
              </label>
              <NumberInput
                value={prepBatches === '' ? null : Number(prepBatches)}
                onValueChange={v => setPrepBatches(v === 0 ? '' : String(v))}
                decimals={0}
                placeholder="مثال: 10"
                autoFocus
              />
            </div>

            {Number(prepBatches) > 0 && (
              <div className="badge badge-info" style={{ padding: '8px 14px', fontSize: 13, marginBottom: 12, display: 'block' }}>
                الناتج: {(Number(prepBatches) * runningPrep.yield_quantity).toFixed(2)} {runningPrep.output_unit} من {runningPrep.output_name}
              </div>
            )}

            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 16 }}>
              <button className="btn btn-secondary" onClick={() => setRunningPrep(null)}>إلغاء</button>
              <button
                className="btn btn-primary"
                onClick={submitPrep}
                disabled={!prepBatches || Number(prepBatches) <= 0}
              >
                تأكيد التجهيز
              </button>
            </div>
          </div>
        </div>
      )}

      {deletingMaterialId !== null && (
        <DeleteEntityModal
          kind="rawMaterial"
          id={deletingMaterialId}
          onClose={() => setDeletingMaterialId(null)}
          onDone={(msg) => { setDeletingMaterialId(null); showToast(msg); loadData() }}
        />
      )}

      {/* Define / edit a prep rule */}
      {editingPrep && (
        <div className="modal-overlay" onClick={() => setEditingPrep(null)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 520 }}>
            <h2 className="modal-title">
              {editingPrep.prep_conversion_id ? 'تعديل عملية تجهيز' : 'إضافة عملية تجهيز'}
            </h2>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 16 }}>
              حدد المادة الأصلية والمادة الناتجة وكم وحدة تنتج من وحدة واحدة.
              مثال: 1 كجم بطاطس ← 4 أطباق بطاطس.
            </p>

            <form onSubmit={savePrep}>
              <div className="form-group">
                <label className="form-label">المادة الأصلية (المستهلكة) *</label>
                <select
                  className="input"
                  required
                  value={editingPrep.source_material_id ?? ''}
                  onChange={e => setEditingPrep({ ...editingPrep, source_material_id: Number(e.target.value) })}
                >
                  <option value="" disabled>اختر المادة...</option>
                  {materials.filter(m => m.is_active).map(m => (
                    <option key={m.raw_material_id} value={m.raw_material_id}>
                      {m.name} ({m.unit})
                    </option>
                  ))}
                </select>
              </div>

              <div className="form-group">
                <label className="form-label">المادة الناتجة (الجاهزة) *</label>
                <select
                  className="input"
                  required
                  value={editingPrep.output_material_id ?? ''}
                  onChange={e => setEditingPrep({ ...editingPrep, output_material_id: Number(e.target.value) })}
                >
                  <option value="" disabled>اختر المادة...</option>
                  {materials.filter(m => m.is_active).map(m => (
                    <option key={m.raw_material_id} value={m.raw_material_id}>
                      {m.name} ({m.unit})
                    </option>
                  ))}
                </select>
              </div>

              <div className="form-group">
                <label className="form-label">الناتج من وحدة واحدة *</label>
                <NumberInput
                  value={editingPrep.yield_quantity ?? null}
                  onValueChange={v => setEditingPrep({ ...editingPrep, yield_quantity: v })}
                  decimals={3}
                  placeholder="مثال: 8"
                />
              </div>

              {editingPrep.source_material_id === editingPrep.output_material_id && (
                <div className="badge badge-danger" style={{ padding: '8px 12px', display: 'block', marginBottom: 12 }}>
                  ⚠️ لا يمكن أن تكون المادة الأصلية هي نفسها المادة الناتجة
                </div>
              )}

              <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 16 }}>
                <button type="button" className="btn btn-secondary" onClick={() => setEditingPrep(null)}>
                  إلغاء
                </button>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={savingPrep ||
                    !editingPrep.source_material_id || !editingPrep.output_material_id ||
                    editingPrep.source_material_id === editingPrep.output_material_id ||
                    !editingPrep.yield_quantity}
                >
                  {savingPrep ? 'جاري الحفظ...' : 'حفظ'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Movement history for one material */}
      {historyFor && (
        <div className="modal-overlay" onClick={() => setHistoryFor(null)}>
          <div
            className="modal"
            onClick={e => e.stopPropagation()}
            style={{ maxWidth: 780, maxHeight: '86vh', overflowY: 'auto' }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <h2 className="modal-title" style={{ marginBottom: 4 }}>سجل حركة: {historyFor.name}</h2>
                <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                  الرصيد الحالي:{' '}
                  <b style={{ color: 'var(--accent)' }}>
                    {historyFor.stock_quantity} {historyFor.unit}
                  </b>
                </div>
              </div>
              <button className="btn btn-secondary" onClick={() => setHistoryFor(null)}>إغلاق</button>
            </div>

            {historyLoading ? (
              <div className="empty-state" style={{ padding: 30 }}>
                <div className="empty-state-text">جاري التحميل...</div>
              </div>
            ) : (
              <div className="table-container" style={{ marginTop: 16, maxHeight: '58vh', overflowY: 'auto' }}>
                <table>
                  <thead>
                    <tr>
                      <th>التاريخ</th><th>الحركة</th><th>الكمية</th>
                      <th>الرصيد بعدها</th><th>الفاتورة</th><th>بواسطة</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((h, i) => (
                      <tr key={h.rm_txn_id}>
                        <td style={{ whiteSpace: 'nowrap' }}>{String(h.created_at).slice(0, 16)}</td>
                        <td>
                          <span className={`badge ${RM_REASON_BADGE[h.reason] || 'badge-info'}`}>
                            {RM_REASON_LABEL[h.reason] || h.reason}
                          </span>
                        </td>
                        <td style={{
                          fontWeight: 800,
                          color: h.change_amount < 0 ? 'var(--danger)' : 'var(--success)',
                        }}>
                          {h.change_amount > 0 ? '+' : ''}{h.change_amount} {h.unit || historyFor.unit}
                        </td>
                        <td style={{ fontWeight: 700, whiteSpace: 'nowrap' }}>
                          {historyRunning.rows[i]?.balance} {historyFor.unit}
                        </td>
                        <td style={{ color: 'var(--text-muted)' }}>
                          {h.related_order_id ? `#${h.related_order_id}` : '—'}
                        </td>
                        <td style={{ color: 'var(--text-muted)' }}>{h.created_by_name || '—'}</td>
                      </tr>
                    ))}
                    {history.length > 0 && (
                      <tr style={{ background: 'var(--bg-subtle)' }}>
                        <td style={{ color: 'var(--text-muted)' }}>—</td>
                        <td colSpan={2} style={{ color: 'var(--text-secondary)', fontWeight: 700 }}>
                          {history.length >= HISTORY_LIMIT
                            ? 'الرصيد قبل هذه الحركات'
                            : 'الرصيد الافتتاحي عند إضافة المادة'}
                        </td>
                        <td style={{ fontWeight: 800, whiteSpace: 'nowrap' }}>
                          {historyRunning.opening} {historyFor.unit}
                        </td>
                        <td colSpan={2} style={{ color: 'var(--text-muted)' }}>—</td>
                      </tr>
                    )}
                    {history.length === 0 && (
                      <tr>
                        <td colSpan={6} style={{ textAlign: 'center', padding: 26, color: 'var(--text-muted)' }}>
                          لا توجد حركات مسجلة على هذه المادة
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {toast && <div className={`toast toast-${toast.type}`}>{toast.msg}</div>}
    </div>
  )
}
