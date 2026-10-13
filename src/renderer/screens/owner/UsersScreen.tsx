import React, { useState, useEffect } from 'react'
import type { User, UserSlot } from '../../../shared/types'

/**
 * The four fixed posts. The system is built around exactly these operators:
 * two cashiers (one per shift), the owner and the accountant. Nobody else logs in —
 * daily kitchen and cleaning staff live in «إدارة العمال» and are paid per day.
 *
 * A post is never created or deleted here, only handed to a different person by
 * changing the name and login on it.
 */
const SLOTS: { slot: UserSlot; label: string; icon: string; note: string }[] = [
  { slot: 'owner', label: 'المدير (صاحب المطعم)', icon: '👑', note: 'صلاحيات كاملة على النظام' },
  { slot: 'cashier1', label: 'كاشير الوردية الأولى', icon: '💼', note: 'نقطة البيع — الوردية الصباحية' },
  { slot: 'cashier2', label: 'كاشير الوردية الثانية', icon: '💼', note: 'نقطة البيع — الوردية المسائية' },
  { slot: 'accountant', label: 'المحاسب', icon: '📊', note: 'التقارير المالية والمخزون — بدون بيع' },
]

const emptyForm = { fullName: '', username: '', password: '' }

export default function UsersScreen() {
  const [users, setUsers] = useState<User[]>([])
  const [editing, setEditing] = useState<User | null>(null)
  const [form, setForm] = useState(emptyForm)
  const [saving, setSaving] = useState(false)
  const [toast, setToast] = useState<{ msg: string; type: string } | null>(null)

  useEffect(() => { loadUsers() }, [])

  const loadUsers = async () => {
    const res = await window.api.listUsers()
    if (res.success) setUsers(res.data)
  }

  const showToast = (msg: string, type = 'success') => {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3500)
  }

  const userForSlot = (slot: UserSlot) => users.find(u => u.slot === slot)

  const openEdit = (user: User) => {
    // Password starts blank: it is write-only, and leaving it empty means "keep the
    // current one" rather than clearing it.
    setForm({ fullName: user.full_name, username: user.username, password: '' })
    setEditing(user)
  }

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!editing) return
    if (!form.fullName.trim() || !form.username.trim()) return
    if (form.password && form.password.length < 6) {
      showToast('كلمة المرور يجب أن تكون 6 أحرف على الأقل', 'error')
      return
    }

    setSaving(true)
    const res = await window.api.updateUserAccount({
      userId: editing.user_id,
      fullName: form.fullName,
      username: form.username,
      // Only send what was actually filled in.
      password: form.password || undefined,
    })
    setSaving(false)

    if (res.success) {
      showToast('تم حفظ بيانات الحساب بنجاح')
      setEditing(null)
      loadUsers()
    } else {
      showToast(res.error || 'فشل حفظ البيانات', 'error')
    }
  }

  // Anything without a slot is left over from before the four-post structure.
  const extras = users.filter(u => !u.slot)

  return (
    <div className="animate-fade" dir="rtl">
      <div className="page-header">
        <div>
          <h1 className="page-title">مستخدمو النظام</h1>
          <p className="page-subtitle">
            أربعة حسابات ثابتة تُشغّل النظام — كاشير لكل وردية، المدير، والمحاسب.
            العمال اليوميون لا يدخلون النظام ويُسجَّلون في «إدارة العمال».
          </p>
        </div>
        <button className="btn btn-secondary" onClick={loadUsers}>🔄 تحديث</button>
      </div>

      <div className="grid-2">
        {SLOTS.map(({ slot, label, icon, note }) => {
          const user = userForSlot(slot)
          return (
            <div className="card" key={slot}>
              <div className="card-header">
                <span className="card-title">{icon} {label}</span>
                {user && (
                  <span className={`badge ${user.is_active ? 'badge-success' : 'badge-danger'}`}>
                    {user.is_active ? 'مفعل' : 'معطل'}
                  </span>
                )}
              </div>

              <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 14 }}>{note}</p>

              {user ? (
                <>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
                    <Row label="الاسم" value={user.full_name} />
                    <Row label="اسم المستخدم" value={user.username} mono />
                  </div>
                  <button className="btn btn-primary" style={{ width: '100%' }} onClick={() => openEdit(user)}>
                    ✏️ تعديل البيانات وكلمة المرور
                  </button>
                </>
              ) : (
                <p style={{ fontSize: 13, color: 'var(--danger)', fontWeight: 700 }}>
                  ⚠️ الحساب غير موجود — أعد تشغيل البرنامج لإنشائه تلقائياً.
                </p>
              )}
            </div>
          )
        })}
      </div>

      {extras.length > 0 && (
        <div className="card" style={{ marginTop: 20 }}>
          <div className="card-header">
            <span className="card-title">حسابات إضافية قديمة</span>
          </div>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
            حسابات أُنشئت قبل اعتماد نظام الحسابات الأربعة الثابتة. يمكنك تعطيلها إن لم تعد مستخدمة.
          </p>
          <table className="receipt-table">
            <tbody>
              {extras.map(u => (
                <tr key={u.user_id} style={{ opacity: u.is_active ? 1 : 0.5 }}>
                  <td style={{ fontWeight: 700 }}>{u.full_name}</td>
                  <td>{u.username}</td>
                  <td>{u.role}</td>
                  <td style={{ textAlign: 'left' }}>
                    <button
                      className={`btn btn-sm ${u.is_active ? 'btn-danger' : 'btn-success'}`}
                      onClick={async () => {
                        await window.api.toggleUserActive(u.user_id, !u.is_active)
                        loadUsers()
                      }}
                    >
                      {u.is_active ? 'تعطيل' : 'تفعيل'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <div className="modal-overlay" onClick={() => setEditing(null)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 460 }}>
            <h2 className="modal-title">
              {SLOTS.find(s => s.slot === editing.slot)?.label ?? editing.full_name}
            </h2>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 16 }}>
              لتسليم الوردية لشخص آخر، غيّر الاسم وبيانات الدخول هنا — لا حاجة لإنشاء حساب جديد.
            </p>

            <form onSubmit={save}>
              <div className="form-group">
                <label className="form-label">اسم الموظف *</label>
                <input
                  className="input"
                  required
                  autoFocus
                  value={form.fullName}
                  onChange={e => setForm({ ...form, fullName: e.target.value })}
                  placeholder="مثال: أحمد محمود"
                />
              </div>

              <div className="form-group">
                <label className="form-label">اسم المستخدم (للدخول) *</label>
                <input
                  className="input"
                  required
                  value={form.username}
                  onChange={e => setForm({ ...form, username: e.target.value })}
                  placeholder="مثال: cashier1"
                />
              </div>

              <div className="form-group">
                <label className="form-label">كلمة مرور جديدة</label>
                <input
                  className="input"
                  type="password"
                  value={form.password}
                  onChange={e => setForm({ ...form, password: e.target.value })}
                  placeholder="اتركها فارغة للإبقاء على الحالية"
                />
              </div>

              <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 20 }}>
                <button type="button" className="btn btn-secondary" onClick={() => setEditing(null)}>إلغاء</button>
                <button type="submit" className="btn btn-primary" disabled={saving}>
                  {saving ? 'جاري الحفظ...' : 'حفظ'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {toast && <div className={`toast toast-${toast.type}`}>{toast.msg}</div>}
    </div>
  )
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
      <span style={{ color: 'var(--text-muted)' }}>{label}</span>
      <span
        style={{
          fontWeight: 700,
          ...(mono ? { fontFamily: 'monospace', color: 'var(--accent)' } : {}),
        }}
      >
        {value}
      </span>
    </div>
  )
}
