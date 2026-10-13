import React, { useState, useEffect } from 'react'
import type { Salary, Worker } from '../../../shared/types'
import NumberInput from '../../components/NumberInput'
import { useAuthStore } from '../../state/stores'
import { todayStr } from '../../lib/clock'

export default function SalariesScreen() {
  const [salaries, setSalaries] = useState<Salary[]>([])
  const [workers, setWorkers] = useState<Worker[]>([])
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [toast, setToast] = useState<{ msg: string; type: string } | null>(null)

  const [formData, setFormData] = useState<Partial<Salary>>({
    worker_id: 0,
    amount: 0,
    pay_period_start: todayStr(),
    pay_period_end: todayStr(),
    paid_on: todayStr()
  })
  // What the attendance log says this worker is owed for the selected period.
  const [due, setDue] = useState<{ days: number; dailyWage: number; total: number } | null>(null)

  // Removing a payment changes the wage bill in every report, so it is confirmed
  // and owner-only (the main process enforces the role as well).
  const [deleting, setDeleting] = useState<Salary | null>(null)
  const isOwner = useAuthStore((s: any) => s.user?.role === 'owner')

  const confirmDelete = async () => {
    if (!deleting) return
    const res = await window.api.deleteSalary(deleting.salary_id)
    if (res.success) {
      showToast(`تم حذف مرتب ${deleting.worker_name} بمبلغ ${deleting.amount.toFixed(2)} ج.م`)
      setDeleting(null)
      loadData()
    } else {
      showToast(res.error || 'تعذر حذف المرتب', 'error')
    }
  }

  useEffect(() => {
    loadData()
  }, [])

  useEffect(() => {
    if (!showModal || !formData.worker_id || !formData.pay_period_start || !formData.pay_period_end) {
      setDue(null)
      return
    }
    // Ignore a response that arrives after the selection has already moved on,
    // otherwise a slow reply can overwrite the figure for a newer period.
    let current = true
    window.api
      .getWorkerPayForPeriod(formData.worker_id, formData.pay_period_start, formData.pay_period_end)
      .then((res: any) => {
        if (!current) return
        setDue(res.success ? res.data : null)
      })
    return () => { current = false }
  }, [showModal, formData.worker_id, formData.pay_period_start, formData.pay_period_end])

  /** Copy the calculated figure into the amount field. */
  const useCalculated = () => {
    if (due) setFormData(f => ({ ...f, amount: due.total }))
  }

  const loadData = async () => {
    setLoading(true)
    const [salRes, workRes] = await Promise.all([
      window.api.listSalaries(),
      window.api.listWorkers()
    ])
    if (salRes.success) setSalaries(salRes.data)
    if (workRes.success) setWorkers(workRes.data.filter((w: any) => w.is_active === 1))
    setLoading(false)
  }

  const showToast = (msg: string, type = 'success') => {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3000)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!formData.worker_id || !formData.amount) return

    const res = await window.api.upsertSalary({
      salaryId: formData.salary_id,
      workerId: formData.worker_id,
      amount: Number(formData.amount),
      periodStart: formData.pay_period_start,
      periodEnd: formData.pay_period_end,
      paidOn: formData.paid_on
    })

    if (res.success) {
      showToast('تم حفظ المرتب بنجاح')
      setShowModal(false)
      loadData()
    } else {
      showToast(res.error || 'حدث خطأ', 'error')
    }
  }

  const openEdit = (salary: Salary) => {
    setFormData(salary)
    setShowModal(true)
  }

  return (
    <div className="animate-fade" dir="rtl">
      <div className="page-header">
        <div>
          <h1 className="page-title">مرتبات العمال اليوميين</h1>
          <p className="page-subtitle">
            يُحسب المستحق تلقائياً من أيام الحضور × الأجر اليومي، ويمكنك تعديل المبلغ قبل الصرف.
          </p>
        </div>
        <button className="btn btn-primary" onClick={() => { 
          setFormData({ 
            worker_id: workers[0]?.worker_id || 0, 
            amount: 0, 
            pay_period_start: todayStr(),
            pay_period_end: todayStr(),
            paid_on: todayStr()
          }); 
          setShowModal(true); 
        }}>
          + تسجيل مرتب جديد
        </button>
      </div>

      <div className="table-container">
        <table>
          <thead>
            <tr>
              <th>الموظف</th>
              <th>بداية الفترة</th>
              <th>نهاية الفترة</th>
              <th>المبلغ (ج.م)</th>
              <th>تاريخ الصرف</th>
              <th>الإجراءات</th>
            </tr>
          </thead>
          <tbody>
            {salaries.map((s) => (
              <tr key={s.salary_id}>
                <td style={{ fontWeight: 700 }}>{s.worker_name}</td>
                <td>{s.pay_period_start}</td>
                <td>{s.pay_period_end}</td>
                <td style={{ fontWeight: 800, color: 'var(--text-primary)' }}>{s.amount.toFixed(2)}</td>
                <td>{s.paid_on || '-'}</td>
                <td>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button className="btn btn-secondary btn-sm" onClick={() => openEdit(s)}>تعديل</button>
                    {isOwner && (
                      <button className="btn btn-danger btn-sm" onClick={() => setDeleting(s)}>حذف</button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {salaries.length === 0 && !loading && (
              <tr>
                <td colSpan={6} style={{ textAlign: 'center', padding: 30 }}>لا توجد سجلات رواتب</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {showModal && (
        <div className="modal-overlay" onClick={() => setShowModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h2 className="modal-title">{formData.salary_id ? 'تعديل سجل المرتب' : 'تسجيل مرتب جديد'}</h2>
            <form onSubmit={handleSubmit}>
              <div className="form-group">
                <label className="form-label">الموظف *</label>
                <select
                  className="input"
                  required
                  value={formData.worker_id}
                  onChange={e => setFormData({ ...formData, worker_id: Number(e.target.value) })}
                >
                  <option value={0} disabled>اختر موظف...</option>
                  {workers.map(w => <option key={w.worker_id} value={w.worker_id}>{w.full_name} ({w.role_title})</option>)}
                </select>
              </div>
              {due && (
                <div
                  style={{
                    marginBottom: 12, background: 'var(--bg-card)', padding: 12,
                    borderRadius: 'var(--radius-sm)', fontSize: 13,
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                    <span style={{ color: 'var(--text-muted)' }}>📅 أيام الحضور المسجلة</span>
                    <strong>{due.days} يوم</strong>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                    <span style={{ color: 'var(--text-muted)' }}>💵 الأجر اليومي</span>
                    <strong>{due.dailyWage.toFixed(2)} ج.م</strong>
                  </div>
                  <div
                    style={{
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                      borderTop: '1px solid var(--border)', paddingTop: 6, marginTop: 6,
                    }}
                  >
                    <span style={{ fontWeight: 800 }}>المستحق</span>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <strong style={{ color: 'var(--accent)', fontSize: 15 }}>
                        {due.total.toFixed(2)} ج.م
                      </strong>
                      <button type="button" className="btn btn-secondary btn-sm" onClick={useCalculated}>
                        استخدام هذا المبلغ
                      </button>
                    </span>
                  </div>
                  {due.dailyWage === 0 && (
                    <p style={{ fontSize: 11, color: 'var(--danger)', marginTop: 6 }}>
                      ⚠️ لم يُحدَّد أجر يومي لهذا العامل — عدّله من «إدارة العمال اليوميين».
                    </p>
                  )}
                </div>
              )}
              <div className="form-group">
                <label className="form-label">المبلغ المصروف (ج.م) *</label>
                <NumberInput
                  value={formData.amount}
                  onValueChange={v => setFormData({ ...formData, amount: v })}
                  placeholder="0.00"
                />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <div className="form-group">
                  <label className="form-label">بداية الفترة *</label>
                  <input
                    type="date"
                    className="input"
                    required
                    value={formData.pay_period_start}
                    onChange={e => setFormData({ ...formData, pay_period_start: e.target.value })}
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">نهاية الفترة *</label>
                  <input
                    type="date"
                    className="input"
                    required
                    value={formData.pay_period_end}
                    onChange={e => setFormData({ ...formData, pay_period_end: e.target.value })}
                  />
                </div>
              </div>
              <div className="form-group">
                <label className="form-label">تاريخ الصرف</label>
                <input
                  type="date"
                  className="input"
                  value={formData.paid_on || ''}
                  onChange={e => setFormData({ ...formData, paid_on: e.target.value })}
                />
              </div>
              <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
                <button type="submit" className="btn btn-primary" style={{ flex: 1 }}>حفظ السجل</button>
                <button type="button" className="btn btn-secondary" onClick={() => setShowModal(false)}>إلغاء</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {deleting && (
        <div className="modal-overlay" onClick={() => setDeleting(null)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 440 }}>
            <h2 className="modal-title" style={{ color: 'var(--danger)' }}>حذف سجل مرتب</h2>

            <div style={{
              background: 'var(--bg-card-hover)', padding: 14,
              borderRadius: 'var(--radius-sm)', marginBottom: 14, fontSize: 14,
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                <span style={{ color: 'var(--text-muted)' }}>العامل</span>
                <b>{deleting.worker_name}</b>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                <span style={{ color: 'var(--text-muted)' }}>الفترة</span>
                <b>{deleting.pay_period_start} → {deleting.pay_period_end}</b>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: 'var(--text-muted)' }}>المبلغ</span>
                <b style={{ color: 'var(--accent)', fontSize: 16 }}>{deleting.amount.toFixed(2)} ج.م</b>
              </div>
            </div>

            <p style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 16 }}>
              سيُحذف هذا السجل نهائياً، وسينقص إجمالي المرتبات في التقارير المالية بنفس المبلغ.
            </p>

            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button className="btn btn-secondary" onClick={() => setDeleting(null)}>إلغاء</button>
              <button className="btn btn-danger" onClick={confirmDelete}>تأكيد الحذف</button>
            </div>
          </div>
        </div>
      )}

      {toast && <div className={`toast toast-${toast.type}`}>{toast.msg}</div>}
    </div>
  )
}
