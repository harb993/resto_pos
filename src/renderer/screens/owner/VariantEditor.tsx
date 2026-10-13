import React, { useState, useEffect } from 'react'
import type { MenuItem, VariantGroup } from '../../../shared/types'
import NumberInput from '../../components/NumberInput'

/**
 * Defines what an item asks the cashier when it is rung up.
 *
 * Three shapes cover almost everything a fried-chicken counter sells:
 *   nothing        water, cola — no groups, so it goes in with one tap
 *   a size         fries, meals — صغير / وسط / كبير, each priced differently
 *   a count        burgers — سنجل / دبل / تريبل
 * and a fourth that changes nothing about the price: عادي / حار.
 *
 * An item can carry several groups at once — a burger that comes in both a size and
 * a number of patties asks two questions and adds both differences to the price.
 */

interface DraftOption { optionName: string; priceDelta: number }
interface DraftGroup { groupName: string; options: DraftOption[] }

/** The setups a counter actually uses, so a new item is one click rather than typing. */
const PRESETS: { label: string; icon: string; group: DraftGroup }[] = [
  {
    label: 'الحجم',
    icon: '🍟',
    group: {
      groupName: 'الحجم',
      options: [
        { optionName: 'صغير', priceDelta: -10 },
        { optionName: 'وسط', priceDelta: 0 },
        { optionName: 'كبير', priceDelta: 15 },
      ],
    },
  },
  {
    label: 'عدد الطبقات',
    icon: '🍔',
    group: {
      groupName: 'عدد الطبقات',
      options: [
        { optionName: 'سنجل', priceDelta: 0 },
        { optionName: 'دبل', priceDelta: 25 },
        { optionName: 'تريبل', priceDelta: 45 },
      ],
    },
  },
  {
    label: 'النوع (عادي / حار)',
    icon: '🌶️',
    group: {
      groupName: 'النوع',
      options: [
        { optionName: 'عادي', priceDelta: 0 },
        { optionName: 'حار', priceDelta: 0 },
      ],
    },
  },
]

function toDraft(groups: VariantGroup[]): DraftGroup[] {
  return groups.map(g => ({
    groupName: g.group_name,
    options: g.options.map(o => ({ optionName: o.option_name, priceDelta: o.price_delta })),
  }))
}

interface Props {
  /** Editing a whole CATEGORY's questions, or one item's own extras. */
  target:
    | { kind: 'category'; categoryId: number; name: string; samplePrice: number }
    | { kind: 'item'; item: MenuItem }
  currency: string
  onClose: () => void
  onSaved: () => void
  showToast: (msg: string, type?: string) => void
}

export default function VariantEditor({ target, currency, onClose, onSaved, showToast }: Props) {
  const [groups, setGroups] = useState<DraftGroup[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const isCategory = target.kind === 'category'
  const title = target.kind === 'category' ? target.name : target.item.name
  const targetId = target.kind === 'category' ? target.categoryId : target.item.item_id
  // What the price previews are worked out against. A category has no single price of
  // its own, so it borrows one of its items' — purely to show what a +15 comes to.
  const basePrice = target.kind === 'category' ? target.samplePrice : target.item.price

  useEffect(() => {
    let live = true
    const request = isCategory
      ? window.api.getCategoryVariants(targetId)
      : window.api.getItemVariants(targetId)
    request.then(res => {
      if (!live) return
      setGroups(res.success ? toDraft(res.data) : [])
      setLoading(false)
    })
    return () => { live = false }
  }, [targetId, isCategory])

  const addPreset = (preset: DraftGroup) => {
    if (groups.some(g => g.groupName === preset.groupName)) {
      showToast(`المجموعة "${preset.groupName}" مضافة بالفعل`, 'warning')
      return
    }
    setGroups(gs => [...gs, { groupName: preset.groupName, options: preset.options.map(o => ({ ...o })) }])
  }

  const patchGroup = (gi: number, patch: Partial<DraftGroup>) =>
    setGroups(gs => gs.map((g, i) => (i === gi ? { ...g, ...patch } : g)))

  const patchOption = (gi: number, oi: number, patch: Partial<DraftOption>) =>
    setGroups(gs => gs.map((g, i) => i !== gi ? g : {
      ...g,
      options: g.options.map((o, j) => (j === oi ? { ...o, ...patch } : o)),
    }))

  const save = async () => {
    // Caught here as well as in the main process so the owner is told which group is
    // wrong, rather than watching the save fail with a database error.
    for (const g of groups) {
      if (!g.groupName.trim()) { showToast('اسم المجموعة مطلوب', 'error'); return }
      if (g.options.length === 0) {
        showToast(`أضف اختياراً واحداً على الأقل في "${g.groupName}"`, 'error'); return
      }
      if (g.options.some(o => !o.optionName.trim())) {
        showToast(`اسم الاختيار مطلوب في "${g.groupName}"`, 'error'); return
      }
    }

    setSaving(true)
    const res = isCategory
      ? await window.api.setCategoryVariants(targetId, groups)
      : await window.api.setItemVariants(targetId, groups)
    setSaving(false)

    if (res.success) {
      showToast(groups.length === 0
        ? `"${title}" أصبح يُضاف بضغطة واحدة بدون اختيارات`
        : `تم حفظ اختيارات "${title}"`)
      onSaved()
      onClose()
    } else {
      showToast(res.error || 'تعذر حفظ الاختيارات', 'error')
    }
  }

  return (
    <div className="modal-overlay" onClick={() => !saving && onClose()}>
      <div
        className="modal"
        onClick={e => e.stopPropagation()}
        style={{ maxWidth: 680, maxHeight: '90vh', overflowY: 'auto' }}
      >
        <h2 className="modal-title">
          {isCategory ? `اختيارات القسم: ${title}` : `اختيارات إضافية: ${title}`}
        </h2>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 16, lineHeight: 1.9 }}>
          {isCategory ? (
            <>
              هذه الأسئلة يسألها الكاشير عن <b>كل صنف في هذا القسم</b> — بما في ذلك
              الأصناف التي تضيفها لاحقاً. اضبط "حار / عادي" على قسم الدجاج مرة واحدة،
              و"سنجل / دبل / تريبل" على قسم البرجر، واترك قسم المشروبات <b>بلا أي
              مجموعة</b> فتُضاف المياه والكولا بضغطة واحدة.
            </>
          ) : (
            <>
              أسئلة تخص <b>هذا الصنف وحده</b>، تُسأل بعد أسئلة القسم. استخدمها للاستثناء
              فقط — مثل برجر بعينه يأتي بأحجام مختلفة عن باقي القسم.
            </>
          )}
          <br />
          فرق السعر يُضاف إلى سعر الصنف
          {isCategory ? ' (المعاينة بالأسفل محسوبة على ' : ' ('}
          {basePrice.toFixed(2)} {currency}) — ويمكن أن يكون بالسالب لحجم أرخص، أو
          صفراً إذا كان الاختيار لا يغيّر السعر (مثل حار وعادي).
        </p>

        {loading ? (
          <div style={{ padding: 30, textAlign: 'center', color: 'var(--text-muted)' }}>
            جاري التحميل...
          </div>
        ) : (
          <>
            <div style={{ marginBottom: 18 }}>
              <div style={{ fontWeight: 800, fontSize: 13, marginBottom: 8 }}>إضافة مجموعة جاهزة</div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {PRESETS.map(p => (
                  <button
                    key={p.label}
                    className="btn btn-secondary btn-sm"
                    onClick={() => addPreset(p.group)}
                  >
                    {p.icon} {p.label}
                  </button>
                ))}
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => setGroups(gs => [...gs, { groupName: '', options: [{ optionName: '', priceDelta: 0 }] }])}
                >
                  ➕ مجموعة مخصصة
                </button>
              </div>
            </div>

            {groups.length === 0 && (
              <div style={{
                padding: 22, textAlign: 'center', borderRadius: 'var(--radius-sm)',
                background: 'var(--bg-card-hover)', color: 'var(--text-muted)', marginBottom: 16,
              }}>
                {isCategory ? 'لا توجد اختيارات — كل أصناف هذا القسم تُضاف للطلب مباشرة بضغطة واحدة.' : 'لا توجد اختيارات خاصة — يكتفي هذا الصنف بأسئلة قسمه.'}
                {isCategory && <div style={{ fontSize: 12, marginTop: 6 }}>وهو المطلوب لقسم المشروبات: المياه والكولا والعصائر.</div>}
              </div>
            )}

            {groups.map((group, gi) => (
              <div
                key={gi}
                style={{
                  border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
                  padding: 14, marginBottom: 14,
                }}
              >
                <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                  <input
                    className="input"
                    style={{ flex: 1, fontWeight: 800 }}
                    value={group.groupName}
                    placeholder="اسم المجموعة (مثال: الحجم)"
                    onChange={e => patchGroup(gi, { groupName: e.target.value })}
                  />
                  <button
                    className="btn btn-ghost btn-sm"
                    style={{ color: 'var(--danger)' }}
                    onClick={() => setGroups(gs => gs.filter((_, i) => i !== gi))}
                  >
                    🗑️ حذف المجموعة
                  </button>
                </div>

                <table className="receipt-table" style={{ marginBottom: 10 }}>
                  <thead>
                    <tr>
                      <th>الاختيار</th>
                      <th style={{ width: 150 }}>فرق السعر</th>
                      <th style={{ width: 130 }}>السعر النهائي</th>
                      <th style={{ width: 50 }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {group.options.map((option, oi) => (
                      <tr key={oi}>
                        <td>
                          <input
                            className="input"
                            style={{ padding: '6px 10px' }}
                            value={option.optionName}
                            placeholder="مثال: كبير"
                            onChange={e => patchOption(gi, oi, { optionName: e.target.value })}
                          />
                        </td>
                        <td>
                          <NumberInput
                            style={{ padding: '6px 10px' }}
                            value={option.priceDelta}
                            allowNegative
                            onValueChange={v => patchOption(gi, oi, { priceDelta: v })}
                          />
                        </td>
                        <td style={{ fontWeight: 800, color: 'var(--accent)' }}>
                          {Math.max(0, basePrice + (Number(option.priceDelta) || 0)).toFixed(2)} {currency}
                        </td>
                        <td>
                          <button
                            className="btn btn-ghost btn-sm"
                            style={{ color: 'var(--danger)' }}
                            onClick={() => patchGroup(gi, {
                              options: group.options.filter((_, j) => j !== oi),
                            })}
                          >
                            ✕
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => patchGroup(gi, {
                    options: [...group.options, { optionName: '', priceDelta: 0 }],
                  })}
                >
                  ➕ إضافة اختيار
                </button>
              </div>
            ))}

            <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
              <button className="btn btn-primary" style={{ flex: 1 }} disabled={saving} onClick={save}>
                {saving ? 'جاري الحفظ...' : '💾 حفظ الاختيارات'}
              </button>
              <button className="btn btn-secondary" disabled={saving} onClick={onClose}>إلغاء</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
