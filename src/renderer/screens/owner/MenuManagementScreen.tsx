import React, { useState, useEffect } from 'react'
import type { MenuItem, Category, MenuItemInput, RawMaterial, Printer, PrinterRole } from '../../../shared/types'
import NumberInput from '../../components/NumberInput'
import DeleteEntityModal from '../../components/DeleteEntityModal'
import VariantEditor from './VariantEditor'
import { useSettingsStore } from '../../state/stores'
import type { DeletableKind } from '../../../shared/types'

/** The printers that print a prep ticket — the only ones a category can be sent to. */
const PREP_ROLES: PrinterRole[] = ['kitchen', 'bar', 'counter']

/** The add / edit category form. `printerId`: null automatic, 0 no prep ticket. */
interface CategoryDraft {
  categoryId?: number
  name: string
  displayOrder: number
  printerId: number | null
}

/** One editable ingredient row in the recipe modal. */
interface RecipeDraftLine {
  rawMaterialId: number
  quantity: number
}

export default function MenuManagementScreen() {
  const [categories, setCategories] = useState<Category[]>([])
  const [items, setItems] = useState<MenuItem[]>([])
  const [materials, setMaterials] = useState<RawMaterial[]>([])
  const [showModal, setShowModal] = useState(false)
  const [catDraft, setCatDraft] = useState<CategoryDraft | null>(null)
  const [printers, setPrinters] = useState<Printer[]>([])
  const [editItem, setEditItem] = useState<MenuItem | null>(null)
  const [form, setForm] = useState<Partial<MenuItemInput>>({})
  const [toast, setToast] = useState<{ msg: string; type: string } | null>(null)

  // Deleting a category or an item — the modal works out what depends on it first.
  const [deleteTarget, setDeleteTarget] = useState<{ kind: DeletableKind; id: number } | null>(null)

  // Recipe editor
  const [recipeItem, setRecipeItem] = useState<MenuItem | null>(null)
  const [recipeLines, setRecipeLines] = useState<RecipeDraftLine[]>([])
  const [savingRecipe, setSavingRecipe] = useState(false)

  // Variant editors — the questions asked when something is rung up. Set on the
  // CATEGORY normally; the per-item one is for exceptions.
  const [variantItem, setVariantItem] = useState<MenuItem | null>(null)
  const [variantCategory, setVariantCategory] = useState<
    { categoryId: number; name: string; samplePrice: number } | null
  >(null)
  const currency = useSettingsStore(s => s.settings.currency_symbol) || 'ج.م'

  useEffect(() => { loadData() }, [])

  const loadData = async () => {
    const [c, m, rm, p] = await Promise.all([
      window.api.listCategories(),
      window.api.getMenu(true),
      window.api.listRawMaterials(),
      window.api.listPrinters(),
    ])
    if (c.success) setCategories(c.data)
    if (m.success) setItems(m.data)
    if (rm.success) setMaterials(rm.data)
    if (p.success) setPrinters(p.data)
  }

  const prepPrinters = printers.filter(p => PREP_ROLES.includes(p.role))

  /** Where a category's items are printed, in the words on the chip. */
  const printerLabel = (c: Category): { text: string; warn?: boolean } => {
    if (c.printer_id === 0) return { text: '🧾 الكاشير فقط — بدون تذكرة تحضير' }
    if (c.printer_id != null) {
      const p = printers.find(x => x.printer_id === c.printer_id)
      if (!p) return { text: '🖨️ طابعة غير موجودة', warn: true }
      return p.is_active
        ? { text: `🖨️ يطبع في: ${p.name}` }
        : { text: `🖨️ ${p.name} (موقوفة — لن تخرج تذكرة)`, warn: true }
    }
    return { text: '🖨️ تلقائي — حسب إعدادات الطابعات' }
  }

  const openRecipe = async (item: MenuItem) => {
    const res = await window.api.getRecipe(item.item_id)
    setRecipeLines(res.success
      ? res.data.map((r: any) => ({ rawMaterialId: r.raw_material_id, quantity: r.quantity }))
      : [])
    setRecipeItem(item)
  }

  const materialById = (id: number) => materials.find(m => m.raw_material_id === id)

  // Cost of one unit of the item, from the ingredients currently in the editor.
  const recipeCost = recipeLines.reduce((sum, l) => {
    const m = materialById(l.rawMaterialId)
    return sum + (m ? m.cost_per_unit * (l.quantity || 0) : 0)
  }, 0)

  const saveRecipe = async () => {
    if (!recipeItem) return
    const clean = recipeLines.filter(l => l.rawMaterialId && l.quantity > 0)

    const ids = clean.map(l => l.rawMaterialId)
    if (new Set(ids).size !== ids.length) {
      showToastMsg('لا يمكن تكرار نفس المادة الخام — اجمع الكميات في سطر واحد', 'error')
      return
    }

    setSavingRecipe(true)
    const res = await window.api.setRecipe(recipeItem.item_id, clean)
    setSavingRecipe(false)

    if (res.success) {
      showToastMsg(clean.length === 0
        ? 'تم مسح المكونات — لن يُخصم مخزون عند بيع هذا الصنف'
        : `تم حفظ ${clean.length} مكوّن — التكلفة ${recipeCost.toFixed(2)} ج.م`)
      setRecipeItem(null)
      loadData()
    } else {
      showToastMsg(res.error || 'فشل حفظ المكونات', 'error')
    }
  }

  const showToastMsg = (msg: string, type = 'success') => {
    setToast({ msg, type }); setTimeout(() => setToast(null), 3000)
  }

  const openAddItem = () => {
    setEditItem(null)
    setForm({ category_id: categories[0]?.category_id, price: 0, cost_price: 0, is_active: 1 })
    setShowModal(true)
  }

  const openEditItem = (item: MenuItem) => {
    setEditItem(item)
    setForm({
      item_id: item.item_id, category_id: item.category_id, name: item.name,
      price: item.price, cost_price: item.cost_price,
      baseline_cost: item.baseline_cost,
      description: item.description || '', is_active: item.is_active,
    })
    setShowModal(true)
  }

  const saveItem = async () => {
    // A price of 0 is a real price — «دقة + شطة» is free — so only a missing or
    // negative one stops the save.
    if (!form.name?.trim() || form.price == null || form.price < 0) return
    const res = await window.api.upsertMenuItem(form)
    if (res.success) {
      showToastMsg(editItem ? 'تم تحديث بيانات الوجبة' : 'تم إضافة الوجبة بنجاح')
      setShowModal(false)
      loadData()
    } else {
      showToastMsg(res.error || 'فشل حفظ الصنف', 'error')
    }
  }

  const toggleActive = async (item: MenuItem) => {
    const res = await window.api.setMenuItemActive(item.item_id, !item.is_active)
    if (res.success) {
      showToastMsg(item.is_active ? 'تم إيقاف الصنف مؤقتاً (86)' : 'تمت إعادة تفعيل الصنف')
      loadData()
    }
  }

  const openAddCategory = () =>
    setCatDraft({ name: '', displayOrder: categories.length + 1, printerId: null })

  const openEditCategory = (c: Category) =>
    setCatDraft({
      categoryId: c.category_id, name: c.name, displayOrder: c.display_order,
      printerId: c.printer_id ?? null,
    })

  const saveCategory = async () => {
    if (!catDraft || !catDraft.name.trim()) return
    const res = await window.api.upsertCategory({
      categoryId: catDraft.categoryId,
      name: catDraft.name.trim(),
      displayOrder: catDraft.displayOrder,
      printerId: catDraft.printerId,
    })
    if (res.success) {
      showToastMsg(catDraft.categoryId ? 'تم تحديث القسم' : 'تمت إضافة القسم الجديد')
      setCatDraft(null); loadData()
    } else {
      showToastMsg(res.error || 'تعذر حفظ القسم', 'error')
    }
  }

  return (
    <div className="animate-fade" dir="rtl">
      {/* Header */}
      <div className="page-header">
        <div>
          <h1 className="page-title">إدارة قائمة الطعام والوجبات</h1>
          <p className="page-subtitle">إجمالي {items.length} صنف مسجل عبر {categories.length} أقسام رئيسية</p>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="btn btn-secondary" onClick={openAddCategory}>
            + إضافة قسم جديد 📂
          </button>
          <button className="btn btn-primary" onClick={openAddItem}>
            + إضافة وجبة جديدة 🍽️
          </button>
        </div>
      </div>

      {/* Items Table */}
      {/* Categories — with a way to remove one, which the screen never offered before */}
      <div className="card" style={{ marginBottom: 18 }}>
        <div className="card-header">
          <span className="card-title">📂 الأقسام ({categories.length})</span>
        </div>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 12, lineHeight: 1.9 }}>
          اضبط <b>اختيارات القسم</b> مرة واحدة وتنطبق على كل أصنافه — الحالية والتي
          تضيفها لاحقاً. قسم الشاورما مثلاً قد يسأل "عادي / حار"، وقسم المشروبات بلا
          اختيارات فتُضاف المياه والكانز بضغطة واحدة.
          {' '}ومن <b>✏️ تعديل</b> تختار <b>الطابعة</b> التي تخرج عليها تذكرة تحضير أصناف
          القسم — فاتورة العميل تخرج على طابعة الكاشير مع كل طلب في كل الأحوال.
        </p>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {categories.map(c => {
            const inCat = items.filter(i => i.category_id === c.category_id)
            // Every item in a category inherits the same groups, so the first one is
            // a fair sample for showing what a price difference actually comes to.
            const sample = inCat.find(i => i.variants && i.variants.length > 0) ?? inCat[0]
            const groupNames = (sample?.variants ?? [])
              .filter(g => g.category_id === c.category_id)
              .map(g => g.group_name)

            return (
              <div
                key={c.category_id}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 10,
                  background: 'var(--bg-card-hover)', border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-sm)', padding: '8px 10px 8px 14px', fontSize: 13,
                }}
              >
                <span>
                  <b>{c.name}</b>
                  <span style={{ color: 'var(--text-muted)', fontSize: 12, marginRight: 6 }}>
                    {inCat.length} صنف
                  </span>
                  <div style={{ fontSize: 11, color: groupNames.length ? 'var(--accent)' : 'var(--text-muted)', marginTop: 2 }}>
                    {groupNames.length ? `يسأل: ${groupNames.join(' + ')}` : 'بدون اختيارات — إضافة بضغطة واحدة'}
                  </div>
                  {(() => {
                    const where = printerLabel(c)
                    return (
                      <div style={{ fontSize: 11, marginTop: 2, color: where.warn ? 'var(--danger)' : 'var(--text-muted)' }}>
                        {where.text}
                      </div>
                    )
                  })()}
                </span>
                <button className="btn btn-secondary btn-sm" onClick={() => openEditCategory(c)}>
                  ✏️ تعديل
                </button>
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => setVariantCategory({
                    categoryId: c.category_id,
                    name: c.name,
                    samplePrice: sample?.price ?? 100,
                  })}
                >
                  ⚙️ الاختيارات
                </button>
                <button
                  onClick={() => setDeleteTarget({ kind: 'category', id: c.category_id })}
                  title="حذف القسم"
                  style={{
                    background: 'none', border: 'none', cursor: 'pointer',
                    color: 'var(--danger)', fontWeight: 900, fontSize: 14, padding: '0 2px',
                  }}
                >
                  ✕
                </button>
              </div>
            )
          })}
          {categories.length === 0 && (
            <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>لا توجد أقسام بعد</span>
          )}
        </div>
      </div>

      <div className="table-container">
        <table>
          <thead>
            <tr>
              <th>اسم الوجبة / الصنف</th>
              <th>القسم</th>
              <th>سعر البيع</th>
              <th>سعر التكلفة</th>
              <th>المكونات / المتاح</th>
              <th>حالة التوفر</th>
              <th>الإجراءات</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.item_id} style={{ opacity: item.is_active ? 1 : 0.5 }}>
                <td style={{ fontWeight: 800 }}>{item.name}</td>
                <td><span className="badge badge-info">{item.category_name}</span></td>
                <td style={{ fontWeight: 800, color: 'var(--accent)' }}>{item.price.toFixed(2)} ج.م</td>
                <td style={{ color: 'var(--text-muted)' }}>
                  {item.cost_price.toFixed(2)} ج.م
                  {/*
                    What the recipe sheet costed this dish at — the figure its selling
                    price was set against. Shown beside the working cost because the
                    two drift apart as supplier prices move, and the gap is the whole
                    point of the costing tab in the finance screen.
                  */}
                  {!!item.baseline_cost && item.baseline_cost !== item.cost_price && (
                    <span style={{ fontSize: 10, display: 'block', color: 'var(--text-muted)' }}>
                      المبدئية (خامات وتغليف): {item.baseline_cost.toFixed(2)}
                    </span>
                  )}
                  {!!item.recipe_count && (
                    <span style={{ fontSize: 10, display: 'block', color: 'var(--accent)' }}>محسوبة من المكونات</span>
                  )}
                </td>
                <td>
                  {item.recipe_count ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                      <span className="badge badge-info" title="يُخصم من المواد الخام عند البيع">
                        🧾 {item.recipe_count} مكوّن
                      </span>
                      {/* How many can still be made — decided by the ingredient that runs out first. */}
                      <span
                        style={{
                          fontSize: 11,
                          color: (item.available_portions ?? 0) <= 0 ? 'var(--danger)' : 'var(--text-muted)',
                          fontWeight: (item.available_portions ?? 0) <= 0 ? 800 : 400,
                        }}
                      >
                        {(item.available_portions ?? 0) <= 0
                          ? '⚠️ المكونات ناقصة'
                          : `يكفي لـ ${item.available_portions} وجبة`}
                      </span>
                    </div>
                  ) : (
                    <span className="badge badge-warning" title="أضف المكونات ليُخصم المخزون تلقائياً عند البيع">
                      ⚠️ لم تُحدد المكونات
                    </span>
                  )}
                </td>
                <td>
                  <span className={`badge ${item.is_active ? 'badge-success' : 'badge-danger'}`}>
                    {item.is_active ? 'متاح للبيع' : 'موقوف مؤقتاً (86)'}
                  </span>
                </td>
                <td>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button className="btn btn-secondary btn-sm" onClick={() => openEditItem(item)}>
                      ✏️ تعديل
                    </button>
                    <button className="btn btn-secondary btn-sm" onClick={() => openRecipe(item)}>
                      🧾 المكونات
                    </button>
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={() => setVariantItem(item)}
                      title={(item.variants ?? []).map(g => g.group_name).join(' + ') || 'بدون اختيارات'}
                    >
                      ⚙️ اختيارات الصنف
                      {/* Only the item's OWN groups are counted — what this button
                          edits. The inherited ones belong to the category button. */}
                      {(() => {
                        const own = (item.variants ?? []).filter(g => g.menu_item_id != null).length
                        return own > 0 ? <span style={{ marginRight: 4, opacity: 0.8 }}>({own})</span> : null
                      })()}
                    </button>
                    <button
                      className={`btn btn-sm ${item.is_active ? 'btn-danger' : 'btn-success'}`}
                      onClick={() => toggleActive(item)}
                    >
                      {item.is_active ? '⛔ إيقاف' : '✓ تفعيل'}
                    </button>
                    <button
                      className="btn btn-ghost btn-sm"
                      style={{ color: 'var(--danger)' }}
                      onClick={() => setDeleteTarget({ kind: 'menuItem', id: item.item_id })}
                    >
                      🗑️ حذف
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Add / Edit Item Modal */}
      {showModal && (
        <div className="modal-overlay" onClick={() => setShowModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2 className="modal-title">{editItem ? 'تعديل بيانات الوجبة' : 'إضافة وجبة جديدة للمنيو'}</h2>
            
            <div className="form-group">
              <label className="form-label">اسم الوجبة</label>
              <input className="input" placeholder="مثال: كشري كبير / فتة شاورما فراخ" value={form.name || ''} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus />
            </div>

            <div className="form-group">
              <label className="form-label">القسم التابع له</label>
              <select className="input" value={form.category_id} onChange={(e) => setForm({ ...form, category_id: Number(e.target.value) })}>
                {categories.map((c) => <option key={c.category_id} value={c.category_id}>{c.name}</option>)}
              </select>
            </div>

            <div className="grid-2">
              <div className="form-group">
                <label className="form-label">سعر البيع (ج.م)</label>
                <NumberInput
                  value={form.price}
                  onValueChange={(v) => setForm({ ...form, price: v })}
                  placeholder="0.00"
                />
              </div>
              <div className="form-group">
                <label className="form-label">سعر التكلفة (ج.م)</label>
                <NumberInput
                  value={form.cost_price}
                  onValueChange={(v) => setForm({ ...form, cost_price: v })}
                  placeholder="0.00"
                />
              </div>
            </div>

            {/*
              «التكلفة المبدئية», the sheet's «تكلفة الخامات والتغليف» — what this dish's
              selling price was set against. Its own field rather than folded into the
              cost above, because the two answer different questions: the cost moves
              with the shelf, this one stays put so «هل ما زلنا نربح كما خططنا؟» has
              something to be measured from. Editing it moves the baseline the finance
              screen compares against, so it says so underneath.
            */}
            <div className="form-group">
              <label className="form-label">التكلفة المبدئية — خامات وتغليف (ج.م)</label>
              <NumberInput
                value={form.baseline_cost}
                onValueChange={(v) => setForm({ ...form, baseline_cost: v })}
                placeholder="0.00"
              />
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                تكلفة الخامات والتغليف كما في «ملخص الريسبى» — تُقارَن بالتكلفة الفعلية
                في المركز المالي. اتركها فارغة في صنف جديد لتأخذ سعر التكلفة.
              </span>
            </div>

            {/* No stock field: the restaurant stocks raw materials, never finished
                meals. What a meal consumes is set in «المكونات». */}
            <div className="form-group">
              <label className="form-label">الوصف (يظهر للكاشير)</label>
              <input className="input" placeholder="مثال: شاورما + بطاطس + طحينة + مخلل" value={form.description || ''} onChange={(e) => setForm({ ...form, description: e.target.value })} />
            </div>

            {editItem && (
              <div
                style={{
                  background: 'var(--bg-card)', padding: 12, borderRadius: 'var(--radius-sm)',
                  fontSize: 12, color: 'var(--text-muted)', marginBottom: 4,
                }}
              >
                {editItem.recipe_count
                  ? `🧾 هذا الصنف يخصم ${editItem.recipe_count} مادة خام عند البيع — عدّلها من زر «المكونات».`
                  : '⚠️ لم تُحدد مكونات هذا الصنف — لن يُخصم أي مخزون عند بيعه. استخدم زر «المكونات».'}
              </div>
            )}

            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 22 }}>
              <button className="btn btn-secondary" onClick={() => setShowModal(false)}>إلغاء</button>
              <button className="btn btn-primary" onClick={saveItem}>حفظ الوجبة</button>
            </div>
          </div>
        </div>
      )}

      {/* Recipe (ingredients) Modal */}
      {recipeItem && (
        <div className="modal-overlay" onClick={() => setRecipeItem(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 620 }}>
            <h2 className="modal-title">مكونات: {recipeItem.name}</h2>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 16 }}>
              حدد كمية كل مادة خام تدخل في <strong>قطعة/وجبة واحدة</strong>. عند بيع الصنف سيتم خصم هذه
              الكميات تلقائياً من المواد الخام.
            </p>

            {materials.length === 0 ? (
              <div className="empty-state" style={{ padding: 24 }}>
                <div className="empty-state-icon">🥩</div>
                <div className="empty-state-text">لا توجد مواد خام مسجلة</div>
                <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6 }}>
                  أضف المواد الخام أولاً من صفحة «المواد الخام».
                </p>
              </div>
            ) : (
              <>
                <div style={{ maxHeight: 300, overflowY: 'auto', marginBottom: 12 }}>
                  {recipeLines.map((line, idx) => {
                    const m = materialById(line.rawMaterialId)
                    return (
                      <div
                        key={idx}
                        style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}
                      >
                        <select
                          className="input"
                          style={{ flex: 2 }}
                          value={line.rawMaterialId || ''}
                          onChange={(e) => {
                            const next = [...recipeLines]
                            next[idx] = { ...next[idx], rawMaterialId: Number(e.target.value) }
                            setRecipeLines(next)
                          }}
                        >
                          <option value="" disabled>اختر المادة الخام...</option>
                          {materials.map(mat => (
                            <option key={mat.raw_material_id} value={mat.raw_material_id}>
                              {mat.name} ({mat.unit})
                            </option>
                          ))}
                        </select>

                        <NumberInput
                          style={{ flex: 1 }}
                          value={line.quantity}
                          decimals={3}
                          placeholder="الكمية"
                          onValueChange={(v) => {
                            const next = [...recipeLines]
                            next[idx] = { ...next[idx], quantity: v }
                            setRecipeLines(next)
                          }}
                        />

                        <span style={{ fontSize: 12, color: 'var(--text-muted)', minWidth: 96 }}>
                          {m ? `${m.unit} · ${(m.cost_per_unit * (line.quantity || 0)).toFixed(2)} ج.م` : ''}
                        </span>

                        <button
                          className="btn btn-danger btn-sm"
                          onClick={() => setRecipeLines(recipeLines.filter((_, i) => i !== idx))}
                          title="حذف المكوّن"
                        >
                          ✕
                        </button>
                      </div>
                    )
                  })}

                  {recipeLines.length === 0 && (
                    <p style={{ fontSize: 13, color: 'var(--text-muted)', padding: '12px 0' }}>
                      لا توجد مكونات — لن يُخصم أي مخزون عند بيع هذا الصنف.
                    </p>
                  )}
                </div>

                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => setRecipeLines([...recipeLines, { rawMaterialId: 0, quantity: 0 }])}
                >
                  + إضافة مكوّن
                </button>

                <div
                  style={{
                    display: 'flex', justifyContent: 'space-between', marginTop: 16, paddingTop: 12,
                    borderTop: '1px solid var(--border)', fontSize: 14, fontWeight: 800,
                  }}
                >
                  <span>تكلفة الوجبة من المكونات:</span>
                  <span style={{ color: 'var(--accent)' }}>{recipeCost.toFixed(2)} ج.م</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--text-muted)' }}>
                  <span>سعر البيع: {recipeItem.price.toFixed(2)} ج.م</span>
                  <span>
                    هامش الربح: {(recipeItem.price - recipeCost).toFixed(2)} ج.م
                    {recipeItem.price > 0 && ` (${(((recipeItem.price - recipeCost) / recipeItem.price) * 100).toFixed(0)}%)`}
                  </span>
                </div>
              </>
            )}

            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 22 }}>
              <button className="btn btn-secondary" onClick={() => setRecipeItem(null)}>إلغاء</button>
              <button className="btn btn-primary" onClick={saveRecipe} disabled={savingRecipe || materials.length === 0}>
                {savingRecipe ? 'جاري الحفظ...' : 'حفظ المكونات'}
              </button>
            </div>
          </div>
        </div>
      )}

      {variantCategory && (
        <VariantEditor
          target={{ kind: 'category', ...variantCategory }}
          currency={currency}
          onClose={() => setVariantCategory(null)}
          onSaved={loadData}
          showToast={showToastMsg}
        />
      )}

      {variantItem && (
        <VariantEditor
          target={{ kind: 'item', item: variantItem }}
          currency={currency}
          onClose={() => setVariantItem(null)}
          onSaved={loadData}
          showToast={showToastMsg}
        />
      )}

      {/* Add / edit category — its name and the printer its prep tickets come out of */}
      {catDraft && (
        <div className="modal-overlay" onClick={() => setCatDraft(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 460 }}>
            <h2 className="modal-title">{catDraft.categoryId ? 'تعديل القسم' : 'إضافة قسم جديد للقائمة'}</h2>
            <div className="form-group">
              <label className="form-label">اسم القسم</label>
              <input
                className="input" value={catDraft.name} autoFocus
                onChange={(e) => setCatDraft({ ...catDraft, name: e.target.value })}
                placeholder="مثال: العروض الخاصة، الحلويات، الإضافات..."
              />
            </div>

            <div className="form-group">
              <label className="form-label">🖨️ تطبع أصناف هذا القسم على</label>
              <select
                className="input"
                value={catDraft.printerId === null ? '' : String(catDraft.printerId)}
                onChange={(e) => setCatDraft({
                  ...catDraft,
                  printerId: e.target.value === '' ? null : Number(e.target.value),
                })}
              >
                <option value="">تلقائي — حسب إعدادات الطابعات</option>
                {prepPrinters.map(p => (
                  <option key={p.printer_id} value={p.printer_id}>
                    {p.name}{p.is_active ? '' : ' (موقوفة)'}
                  </option>
                ))}
                {/* A printer since deleted must not make the form lie about what is saved. */}
                {catDraft.printerId != null && catDraft.printerId !== 0 &&
                  !prepPrinters.some(p => p.printer_id === catDraft.printerId) && (
                  <option value={catDraft.printerId}>طابعة غير موجودة</option>
                )}
                <option value="0">بدون تذكرة تحضير (الكاشير فقط)</option>
              </select>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6, lineHeight: 1.8 }}>
                كل صنف من هذا القسم يُطلب تخرج تذكرته على هذه الطابعة وحدها، بدون أسعار.
                فاتورة العميل بالأسعار تخرج على طابعة الكاشير مع كل طلب في كل الأحوال.
                {' '}اختر «بدون تذكرة تحضير» لما يسلّمه الكاشير بنفسه مثل المشروبات.
                {prepPrinters.length === 0 && (
                  <b style={{ display: 'block', color: 'var(--warning, #b45309)' }}>
                    لا توجد طابعات مطبخ بعد — أضفها من الإعدادات ← الطابعات بوظيفة «المطبخ».
                  </b>
                )}
              </div>
            </div>

            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 20 }}>
              <button className="btn btn-secondary" onClick={() => setCatDraft(null)}>إلغاء</button>
              <button className="btn btn-primary" onClick={saveCategory} disabled={!catDraft.name.trim()}>
                {catDraft.categoryId ? 'حفظ القسم' : 'إضافة القسم'}
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteTarget && (
        <DeleteEntityModal
          kind={deleteTarget.kind}
          id={deleteTarget.id}
          onClose={() => setDeleteTarget(null)}
          onDone={(msg) => { setDeleteTarget(null); showToastMsg(msg); loadData() }}
        />
      )}

      {toast && <div className={`toast toast-${toast.type}`}>{toast.msg}</div>}
    </div>
  )
}
