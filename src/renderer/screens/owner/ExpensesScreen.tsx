import React, { useState, useEffect } from 'react'
import type { Expense, ExpenseCategory } from '../../../shared/types'
import { useAuthStore } from '../../state/stores'
import NumberInput from '../../components/NumberInput'
import { todayStr } from '../../lib/clock'
import { WorkShiftSelect, useWorkShifts, chosenShift, type ShiftChoice } from '../../components/WorkShift'

export default function ExpensesScreen() {
  const [expenses, setExpenses] = useState<Expense[]>([])
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [toast, setToast] = useState<{ msg: string; type: string } | null>(null)

  const [formData, setFormData] = useState({
    category: 'other' as ExpenseCategory,
    description: '',
    amount: '',
    expenseDate: todayStr()
  })

  const [filterCategory, setFilterCategory] = useState<string>('all')

  const user = useAuthStore((s: any) => s.user)
  const isOwner = user?.role === 'owner'

  const categories: { id: ExpenseCategory; label: string }[] = [
    { id: 'ingredients', label: 'مكونات ومشتريات' },
    { id: 'utilities', label: 'كهرباء ومياه' },
    { id: 'maintenance', label: 'صيانة' },
    { id: 'delivery', label: 'توصيل' },
    { id: 'other', label: 'أخرى' },
  ]

  useEffect(() => { loadExpenses() }, [])

  const loadExpenses = async () => {
    setLoading(true)
    const res = await window.api.listExpenses()
    if (res.success) setExpenses(res.data)
    setLoading(false)
  }

  const showToast = (msg: string, type = 'success') => {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3000)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!formData.amount || isNaN(Number(formData.amount))) {
      showToast('يرجى إدخال مبلغ صحيح', 'error')
      return
    }

    const res = await window.api.addExpense({
      ...formData,
      amount: Number(formData.amount)
    })

    if (res.success) {
      showToast('تمت إضافة المصروف بنجاح')
      setShowModal(false)
      setFormData({ ...formData, description: '', amount: '' })
      loadExpenses()
    } else {
      showToast(res.error || 'حدث خطأ', 'error')
    }
  }

  const handleDelete = async (id: number) => {
    if (!confirm('هل أنت متأكد من حذف هذا المصروف؟')) return
    const res = await window.api.deleteExpense(id)
    if (res.success) {
      showToast('تم الحذف بنجاح')
      loadExpenses()
    } else {
      showToast(res.error || 'حدث خطأ', 'error')
    }
  }

  // An expense belongs to the shift it was recorded in — that is the drawer it came out of.
  const workShifts = useWorkShifts()
  const [shiftChoice, setShiftChoice] = useState<ShiftChoice>('current')
  const shiftScope = chosenShift(shiftChoice, workShifts)

  const filteredExpenses = expenses.filter(e =>
    (filterCategory === 'all' || e.category === filterCategory) &&
    (!shiftScope || (String(e.created_at) >= shiftScope.from && String(e.created_at) < shiftScope.to)))

  return (
    <div className="animate-fade" dir="rtl">
      <div className="page-header">
        <div>
          <h1 className="page-title">إدارة المصروفات</h1>
          <p className="page-subtitle">تسجيل المصروفات التشغيلية اليومية</p>
        </div>
        <button className="btn btn-primary" onClick={() => setShowModal(true)}>
          + إضافة مصروف
        </button>
      </div>

      <div style={{ display: 'flex', gap: 6, marginBottom: 16, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <WorkShiftSelect value={shiftChoice} onChange={setShiftChoice} shifts={workShifts} allowAll allLabel="كل الورديات" />
        <button
          className={`btn btn-sm ${filterCategory === 'all' ? 'btn-primary' : 'btn-ghost'}`}
          onClick={() => setFilterCategory('all')}
        >
          الكل
        </button>
        {categories.map(c => (
          <button
            key={c.id}
            className={`btn btn-sm ${filterCategory === c.id ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => setFilterCategory(c.id)}
          >
            {c.label}
          </button>
        ))}
      </div>

      <div className="table-container">
        <table>
          <thead>
            <tr>
              <th>التاريخ</th>
              <th>التصنيف</th>
              <th>الوصف</th>
              <th>المبلغ</th>
              <th>سُجل بواسطة</th>
              {isOwner && <th>الإجراءات</th>}
            </tr>
          </thead>
          <tbody>
            {filteredExpenses.map((exp) => (
              <tr key={exp.expense_id}>
                <td>{exp.expense_date}</td>
                <td>
                  <span className="badge badge-info">
                    {categories.find(c => c.id === exp.category)?.label}
                  </span>
                </td>
                <td>{exp.description || '-'}</td>
                <td style={{ fontWeight: 700 }}>{exp.amount.toFixed(2)} ج.م</td>
                <td style={{ color: 'var(--text-muted)' }}>{exp.recorded_by_name}</td>
                {isOwner && (
                  <td>
                    <button className="btn btn-danger btn-sm" onClick={() => handleDelete(exp.expense_id)}>حذف</button>
                  </td>
                )}
              </tr>
            ))}
            {filteredExpenses.length === 0 && !loading && (
              <tr>
                <td colSpan={6} style={{ textAlign: 'center', padding: 30 }}>لا توجد مصروفات مسجلة</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {showModal && (
        <div className="modal-overlay" onClick={() => setShowModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h2 className="modal-title">إضافة مصروف جديد</h2>
            <form onSubmit={handleSubmit}>
              <div className="form-group">
                <label className="form-label">تاريخ المصروف</label>
                <input
                  type="date"
                  className="input"
                  required
                  value={formData.expenseDate}
                  onChange={e => setFormData({ ...formData, expenseDate: e.target.value })}
                />
              </div>
              <div className="form-group">
                <label className="form-label">التصنيف</label>
                <select
                  className="input"
                  value={formData.category}
                  onChange={e => setFormData({ ...formData, category: e.target.value as ExpenseCategory })}
                >
                  {categories.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
                </select>
              </div>
              <div className="form-group">
                <label className="form-label">المبلغ (ج.م)</label>
                <NumberInput
                  value={formData.amount === '' ? null : Number(formData.amount)}
                  onValueChange={v => setFormData({ ...formData, amount: v === 0 ? '' : String(v) })}
                  placeholder="0.00"
                />
              </div>
              <div className="form-group">
                <label className="form-label">الوصف التفصيلي (اختياري)</label>
                <textarea
                  className="input"
                  rows={3}
                  value={formData.description}
                  onChange={e => setFormData({ ...formData, description: e.target.value })}
                ></textarea>
              </div>
              <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
                <button type="submit" className="btn btn-primary" style={{ flex: 1 }}>حفظ المصروف</button>
                <button type="button" className="btn btn-secondary" onClick={() => setShowModal(false)}>إلغاء</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {toast && <div className={`toast toast-${toast.type}`}>{toast.msg}</div>}
    </div>
  )
}
