import React, { useState, useEffect, useMemo } from 'react'
import type { Worker, WorkerAttendance } from '../../../shared/types'
import { resolveShift } from '../../../shared/shifts'
import NumberInput from '../../components/NumberInput'
import { useSettingsStore } from '../../state/stores'
import { todayStr } from '../../lib/clock'

const money = (n: number): string => `${(n ?? 0).toFixed(2)} ج.م`

export default function WorkersScreen() {
  const [workers, setWorkers] = useState<Worker[]>([])
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [toast, setToast] = useState<{ msg: string; type: string } | null>(null)

  const [formData, setFormData] = useState<Partial<Worker>>({
    full_name: '',
    role_title: '',
    is_active: 1
  })

  const settings = useSettingsStore((s) => s.settings)
  // One shift a day means there is no second window to offer or to name — see
  // shared/shifts.ts. Without this a shop that had switched still saw «مسائية» here.
  const singleShift = Number(settings.shifts_per_day ?? 2) === 1
  const shift1Name = settings.shift1_name || 'صباحية'
  const shift2Name = settings.shift2_name || 'مسائية'
  const shiftLabel = (n?: number | null) => {
    if (n !== 1 && n !== 2) return '—'
    const w = resolveShift(n, settings)
    return `${w.icon} ${w.name}`
  }

  const [expandedWorkerId, setExpandedWorkerId] = useState<number | null>(null)
  const [attendance, setAttendance] = useState<WorkerAttendance[]>([])
  const [newAttendanceDate, setNewAttendanceDate] = useState(todayStr())
  // Which shift the day being recorded belongs to; null follows the worker's usual one.
  const [newAttendanceShift, setNewAttendanceShift] = useState<number | null>(null)

  useEffect(() => { loadWorkers() }, [])

  const toggleAttendance = async (workerId: number) => {
    if (expandedWorkerId === workerId) {
      setExpandedWorkerId(null)
      setAttendance([])
      return
    }
    setExpandedWorkerId(workerId)
    const res = await window.api.listAttendance(workerId)
    if (res.success) setAttendance(res.data)
  }

  const reloadAttendance = async (workerId: number) => {
    const res = await window.api.listAttendance(workerId)
    if (res.success) setAttendance(res.data)
  }

  const handleMarkAttendance = async (workerId: number) => {
    const res = await window.api.markAttendance(workerId, newAttendanceDate, newAttendanceShift)
    if (res.success) {
      showToast('تم تسجيل يوم الحضور')
      reloadAttendance(workerId)
      // A day recorded is a day owed — the balance on the row above must move with it,
      // or the owner is looking at a figure that was true a moment ago.
      loadWorkers()
    } else {
      showToast(res.error || 'حدث خطأ', 'error')
    }
  }

  const handleUnmarkAttendance = async (workerId: number, workDate: string) => {
    const res = await window.api.unmarkAttendance(workerId, workDate)
    if (res.success) { reloadAttendance(workerId); loadWorkers() }
  }

  const loadWorkers = async () => {
    setLoading(true)
    const res = await window.api.listWorkers()
    if (res.success) setWorkers(res.data)
    setLoading(false)
  }

  const showToast = (msg: string, type = 'success') => {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3000)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!formData.full_name?.trim()) return

    const res = await window.api.upsertWorker({
      workerId: formData.worker_id,
      fullName: formData.full_name,
      roleTitle: formData.role_title,
      dailyWage: formData.daily_wage ?? 0,
      defaultShift: formData.default_shift ?? null,
      isActive: formData.is_active,
      linkedUserId: formData.linked_user_id
    })

    if (res.success) {
      showToast('تم الحفظ بنجاح')
      setShowModal(false)
      loadWorkers()
    } else {
      showToast(res.error || 'حدث خطأ', 'error')
    }
  }

  const openEdit = (worker: Worker) => {
    setFormData(worker)
    setShowModal(true)
  }

  /**
   * The shop-wide position. Split rather than netted: one worker owed 500 and
   * another overpaid 500 is NOT "all square" — the first has to be paid tonight and
   * the second's advance comes back over his next few days.
   */
  const totals = useMemo(() => {
    let owedToWorkers = 0   // the restaurant's debt
    let owedByWorkers = 0   // advances still to be worked off
    let earned = 0
    let paid = 0
    for (const w of workers) {
      earned += w.earned ?? 0
      paid += w.paid ?? 0
      const bal = w.balance ?? 0
      if (bal > 0) owedToWorkers += bal
      else owedByWorkers += -bal
    }
    return { owedToWorkers, owedByWorkers, earned, paid }
  }, [workers])

  return (
    <div className="animate-fade" dir="rtl">
      <div className="page-header">
        <div>
          <h1 className="page-title">إدارة العمال اليوميين</h1>
          <p className="page-subtitle">
            العمال الذين يتغيرون يومياً (مطبخ، نظافة، مساعدة) — لا يدخلون النظام،
            ويُحاسَبون بأجر يومي حسب أيام الحضور المسجّلة.
          </p>
        </div>
        <button className="btn btn-primary" onClick={() => { setFormData({ full_name: '', role_title: '', daily_wage: 0, is_active: 1 }); setShowModal(true) }}>
          + إضافة عامل جديد
        </button>
      </div>

      {/* ---- Where the wage bill stands ---- */}
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
        gap: 14, marginBottom: 20,
      }}>
        <div className="stat-card">
          <div className="stat-label">💸 مستحق للعمال</div>
          <div className="stat-value" style={{ color: totals.owedToWorkers > 0 ? 'var(--danger)' : 'var(--success)' }}>
            {money(totals.owedToWorkers)}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>أيام اشتغلوها ولم تُدفع بعد</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">🧾 سُلف على العمال</div>
          <div className="stat-value" style={{ color: totals.owedByWorkers > 0 ? 'var(--warning)' : undefined }}>
            {money(totals.owedByWorkers)}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>مدفوع زيادة عن أيام العمل</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">📅 إجمالي الأجور المستحقة</div>
          <div className="stat-value">{money(totals.earned)}</div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>كل أيام الحضور × الأجر اليومي</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">✅ إجمالي المدفوع</div>
          <div className="stat-value" style={{ color: 'var(--success)' }}>{money(totals.paid)}</div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>كل المرتبات المسجلة</div>
        </div>
      </div>

      <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 14, lineHeight: 1.9 }}>
        الحساب لكل عامل = <b>(أيام الحضور × الأجر اليومي) − ما تم صرفه له</b>، من أول يوم
        وحتى الآن. الرقم بالأحمر معناه أن المطعم <b>مدين له</b>، والأخضر معناه أنه أخذ
        <b> زيادة</b> عن أيام عمله (سلفة تُخصم من أيامه القادمة). المرتبات تُسجَّل من شاشة
        «مرتبات العمال».
        <br />
        ملاحظة: تغيير الأجر اليومي يعيد حساب <b>كل</b> أيامه السابقة بالأجر الجديد — النظام
        يحفظ أجراً واحداً لكل عامل وليس تاريخاً للأجور.
      </p>

      <div className="table-container">
        <table>
          <thead>
            <tr>
              <th>الاسم</th>
              <th>نوع العمل</th>
              <th>الأجر اليومي</th>
              <th>أيام الحضور</th>
              <th>المستحق</th>
              <th>المدفوع</th>
              <th>الحساب</th>
              <th>الوردية المعتادة</th>
              <th>الحالة</th>
              <th>الإجراءات</th>
            </tr>
          </thead>
          <tbody>
            {workers.map((w) => (
              <React.Fragment key={w.worker_id}>
                <tr style={{ opacity: w.is_active ? 1 : 0.6 }}>
                  <td style={{ fontWeight: 700 }}>{w.full_name}</td>
                  <td>{w.role_title || '-'}</td>
                  <td style={{ fontWeight: 700, color: 'var(--accent)' }}>
                    {(w.daily_wage ?? 0).toFixed(2)} ج.م / يوم
                  </td>
                  <td style={{ fontWeight: 700 }}>{w.daysWorked ?? 0}</td>
                  <td>{money(w.earned ?? 0)}</td>
                  <td>
                    {money(w.paid ?? 0)}
                    {w.lastPaidOn && (
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600 }}>
                        آخر صرف {w.lastPaidOn}
                      </div>
                    )}
                  </td>
                  <td>
                    {/* The one number the owner is actually looking for. */}
                    {(w.balance ?? 0) > 0.004 ? (
                      <>
                        <div style={{ fontWeight: 900, fontSize: 15, color: 'var(--danger)' }}>
                          {money(w.balance ?? 0)}
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>مستحق له</div>
                      </>
                    ) : (w.balance ?? 0) < -0.004 ? (
                      <>
                        <div style={{ fontWeight: 900, fontSize: 15, color: 'var(--success)' }}>
                          {money(-(w.balance ?? 0))}
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>سلفة عليه</div>
                      </>
                    ) : (
                      <span className="badge badge-success">مسدَّد</span>
                    )}
                  </td>
                  <td>
                    {w.default_shift
                      ? <span className={`badge ${w.default_shift === 1 ? 'badge-info' : 'badge-warning'}`}>
                          {shiftLabel(w.default_shift)}
                        </span>
                      : <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>بدون وردية ثابتة</span>}
                  </td>
                  <td>
                    <span className={`badge ${w.is_active ? 'badge-success' : 'badge-danger'}`}>
                      {w.is_active ? 'نشط' : 'موقوف'}
                    </span>
                  </td>
                  <td>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button className="btn btn-secondary btn-sm" onClick={() => openEdit(w)}>تعديل</button>
                      <button className="btn btn-ghost btn-sm" onClick={() => toggleAttendance(w.worker_id)}>
                        📅 {expandedWorkerId === w.worker_id ? 'إخفاء الحضور' : 'أيام الحضور'}
                      </button>
                    </div>
                  </td>
                </tr>
                {expandedWorkerId === w.worker_id && (
                  <tr>
                    <td colSpan={10} style={{ background: 'var(--bg-card)', padding: 16 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
                        <strong style={{ fontSize: 13 }}>تسجيل يوم حضور لـ {w.full_name}:</strong>
                        <input
                          type="date"
                          className="input"
                          style={{ width: 160 }}
                          value={newAttendanceDate}
                          onChange={e => setNewAttendanceDate(e.target.value)}
                        />
                        {/* Defaults to this worker's usual shift, but any day can differ. */}
                        <select
                          className="input"
                          style={{ width: 170 }}
                          value={newAttendanceShift ?? ''}
                          onChange={e => setNewAttendanceShift(e.target.value ? Number(e.target.value) : null)}
                        >
                          <option value="">
                            الوردية المعتادة{w.default_shift ? ` (${shiftLabel(w.default_shift)})` : ''}
                          </option>
                          <option value={1}>☀️ {shift1Name}</option>
                          {!singleShift && <option value={2}>🌙 {shift2Name}</option>}
                        </select>
                        <button className="btn btn-primary btn-sm" onClick={() => handleMarkAttendance(w.worker_id)}>
                          + تسجيل
                        </button>
                        <span style={{ marginRight: 'auto', fontSize: 12, color: 'var(--text-muted)' }}>
                          إجمالي الأيام المسجلة: <strong>{attendance.length}</strong>
                        </span>
                      </div>
                      {attendance.length === 0 ? (
                        <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>لا توجد أيام حضور مسجلة بعد</p>
                      ) : (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                          {attendance.map(a => (
                            <span
                              key={a.attendance_id}
                              className={`badge ${resolveShift(a.shift_number, settings).number === 2 ? 'badge-warning' : 'badge-info'}`}
                              style={{ display: 'flex', alignItems: 'center', gap: 6 }}
                            >
                              {a.work_date}
                              <span style={{ opacity: 0.75 }}>
                                {a.shift_number ? resolveShift(a.shift_number, settings).icon : ''}
                              </span>
                              <button
                                onClick={() => handleUnmarkAttendance(w.worker_id, a.work_date)}
                                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', fontWeight: 800 }}
                                title="حذف"
                              >
                                ✕
                              </button>
                            </span>
                          ))}
                        </div>
                      )}
                    </td>
                  </tr>
                )}
              </React.Fragment>
            ))}
            {workers.length === 0 && !loading && (
              <tr>
                <td colSpan={10} style={{ textAlign: 'center', padding: 30 }}>لا يوجد موظفين مسجلين</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {showModal && (
        <div className="modal-overlay" onClick={() => setShowModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h2 className="modal-title">{formData.worker_id ? 'تعديل موظف' : 'إضافة موظف جديد'}</h2>
            <form onSubmit={handleSubmit}>
              <div className="form-group">
                <label className="form-label">الاسم بالكامل *</label>
                <input
                  type="text"
                  className="input"
                  required
                  value={formData.full_name}
                  onChange={e => setFormData({ ...formData, full_name: e.target.value })}
                />
              </div>
              <div className="form-group">
                <label className="form-label">نوع العمل (طباخ، عامل نظافة، مساعد...)</label>
                <input
                  type="text"
                  className="input"
                  value={formData.role_title || ''}
                  onChange={e => setFormData({ ...formData, role_title: e.target.value })}
                />
              </div>
              <div className="form-group">
                <label className="form-label">الأجر اليومي (ج.م) *</label>
                <NumberInput
                  value={formData.daily_wage}
                  onValueChange={v => setFormData({ ...formData, daily_wage: v })}
                  placeholder="مثال: 250"
                />
                <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                  يُحسب المرتب تلقائياً = عدد أيام الحضور × الأجر اليومي.
                </p>
              </div>

              <div className="form-group">
                <label className="form-label">الوردية المعتادة</label>
                <select
                  className="input"
                  value={formData.default_shift ?? ''}
                  onChange={e => setFormData({
                    ...formData,
                    default_shift: e.target.value ? (Number(e.target.value) as 1 | 2) : null,
                  })}
                >
                  <option value="">— بدون وردية ثابتة —</option>
                  <option value={1}>☀️ {shift1Name}</option>
                  {!singleShift && <option value={2}>🌙 {shift2Name}</option>}
                </select>
                <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                  الوردية الافتراضية عند تسجيل الحضور — ويمكن تغييرها في أي يوم.
                </p>
              </div>
              <div className="form-group" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input
                  type="checkbox"
                  checked={formData.is_active === 1}
                  onChange={e => setFormData({ ...formData, is_active: e.target.checked ? 1 : 0 })}
                />
                <label className="form-label" style={{ marginBottom: 0 }}>عامل نشط (على رأس العمل)</label>
              </div>
              <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
                <button type="submit" className="btn btn-primary" style={{ flex: 1 }}>حفظ التغييرات</button>
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
