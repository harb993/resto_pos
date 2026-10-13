import React, { useState, useEffect, useCallback } from 'react'
import type { Shift } from '../../../shared/types'
import ShiftReportModal from './ShiftReportModal'
import { todayStr, daysAgoStr } from '../../lib/clock'
import { useWorkShifts, useWorkShiftStatus } from '../../components/WorkShift'
import { useAuthStore } from '../../state/stores'

/**
 * Two lists that used to be one, and were confusing as one.
 *
 *   ورديات المحل    the shop's shifts — each is the whole till for that period: every
 *                   invoice, expense and wage, whoever was signed in. This is the one
 *                   the reports, the numbering and the close-out are built on.
 *   ساعات الموظفين  who was signed in and for how long, for hours and wages. Clocked
 *                   by the system from sign-in and sign-out; nothing here is typed in.
 */
export default function ShiftsScreen() {
  const [tab, setTab] = useState<'shop' | 'staff'>('shop')

  return (
    <div className="animate-fade" dir="rtl">
      <div className="page-header">
        <div>
          <h1 className="page-title">الورديات</h1>
          <p className="page-subtitle">
            كل الفواتير والمصروفات والمرتبات تتبع الوردية التي حدثت فيها
          </p>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 18 }}>
        <button className={`cat-pill-btn ${tab === 'shop' ? 'active' : ''}`} onClick={() => setTab('shop')}>
          🕒 ورديات المحل
        </button>
        <button className={`cat-pill-btn ${tab === 'staff' ? 'active' : ''}`} onClick={() => setTab('staff')}>
          ⏱️ ساعات الموظفين
        </button>
      </div>

      {tab === 'shop' ? <ShopShifts /> : <StaffHours />}
    </div>
  )
}

function ShopShifts() {
  const workShifts = useWorkShifts()
  const { status, refresh } = useWorkShiftStatus()
  const isOwner = useAuthStore((s) => s.user?.role === 'owner')
  const [reportId, setReportId] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const start = async () => {
    setBusy(true)
    const res = await window.api.startWorkShift()
    setBusy(false)
    if (res.success) { setError(''); refresh() }
    else setError(res.error || 'تعذر بدء الوردية')
  }

  const ltr: React.CSSProperties = { direction: 'ltr', display: 'inline-block' }

  return (
    <>
      {/* Where things stand right now, and the one thing that can be done about it. */}
      {status && (
        <div className="card" style={{
          marginBottom: 18, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 14, flexWrap: 'wrap',
          borderRight: `4px solid ${status.open ? 'var(--success)' : 'var(--warning)'}`,
        }}>
          {status.open ? (
            <div style={{ fontSize: 14, lineHeight: 1.9 }}>
              🟢 وردية <b>{status.open.name}</b> جارية — بدأت <b style={ltr}>{status.open.openedAt}</b> وتنتهي
              تلقائياً <b style={ltr}>{status.open.endsAt}</b>
            </div>
          ) : (
            <div style={{ fontSize: 14, lineHeight: 1.9 }}>
              🔴 <b>لا توجد وردية مفتوحة</b> — لا يمكن تسجيل فواتير.
              {status.next && (
                <> الوردية التالية (<b>{status.next.name}</b>) تبدأ تلقائياً <b style={ltr}>{status.next.startsAt}</b>.</>
              )}
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {error && <span className="badge badge-danger">⚠️ {error}</span>}
            {status.open ? (
              <button className="btn btn-primary" onClick={() => setReportId(status.open!.workShiftId)}>
                🧾 تقرير الوردية الحالية
              </button>
            ) : isOwner ? (
              <button className="btn btn-primary" onClick={start} disabled={busy}>
                {busy ? '⏳ جاري...' : '▶ ابدأ وردية جديدة الآن'}
              </button>
            ) : null}
          </div>
        </div>
      )}

      <div className="table-container">
        <table>
          <thead>
            <tr><th>التاريخ</th><th>الوردية</th><th>البداية</th><th>النهاية</th><th></th></tr>
          </thead>
          <tbody>
            {workShifts.map(w => (
              <tr key={w.workShiftId}>
                <td style={{ fontWeight: 700 }}>{w.date}</td>
                <td>
                  <span className={`badge ${w.manual ? 'badge-warning' : 'badge-info'}`}>{w.name}</span>
                </td>
                <td><span style={ltr}>{w.openedAt.slice(11)}</span></td>
                <td>
                  {w.isOpen
                    ? <span className="badge badge-success">🟢 جارية الآن</span>
                    : <span style={ltr}>{w.endsAt.slice(11)}</span>}
                </td>
                <td style={{ textAlign: 'left' }}>
                  <button className="btn btn-primary btn-sm" onClick={() => setReportId(w.workShiftId)}>
                    🧾 تقرير الوردية
                  </button>
                </td>
              </tr>
            ))}
            {workShifts.length === 0 && (
              <tr><td colSpan={5} style={{ textAlign: 'center', padding: 30, color: 'var(--text-muted)' }}>لا توجد ورديات مسجلة بعد</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {reportId !== null && <ShiftReportModal shiftId={reportId} work onClose={() => setReportId(null)} />}
    </>
  )
}

function StaffHours() {
  const [shifts, setShifts] = useState<Shift[]>([])
  const [loading, setLoading] = useState(true)
  const [reportShiftId, setReportShiftId] = useState<number | null>(null)
  const [dateFrom, setDateFrom] = useState(() => daysAgoStr(30))
  const [dateTo, setDateTo] = useState(() => todayStr())

  const loadData = useCallback(async () => {
    setLoading(true)
    const res = await window.api.listShifts({ dateFrom, dateTo })
    if (res.success) setShifts(res.data)
    setLoading(false)
  }, [dateFrom, dateTo])

  useEffect(() => { loadData() }, [loadData])

  // An open session keeps accumulating, so refresh while one is running.
  useEffect(() => {
    if (!shifts.some(s => s.is_open)) return
    const timer = setInterval(loadData, 60_000)
    return () => clearInterval(timer)
  }, [shifts, loadData])

  const fmtHours = (h?: number) => {
    if (h === undefined || h === null || Number.isNaN(h)) return '—'
    const safe = Math.max(0, h)
    const hours = Math.floor(safe)
    const minutes = Math.round((safe - hours) * 60)
    return `${hours} س ${String(minutes).padStart(2, '0')} د`
  }

  // Hours per person over the selected range.
  const byPerson = Object.values(
    shifts.reduce((acc: Record<number, { name: string; hours: number; sessions: number }>, s) => {
      const key = s.cashier_id
      if (!acc[key]) acc[key] = { name: s.cashier_name || '—', hours: 0, sessions: 0 }
      acc[key].hours += Math.max(0, s.hours_worked ?? 0)
      acc[key].sessions++
      return acc
    }, {})
  ).sort((a, b) => b.hours - a.hours)

  return (
    <>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 16 }}>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label className="form-label">من تاريخ</label>
          <input type="date" className="input" value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
        </div>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label className="form-label">إلى تاريخ</label>
          <input type="date" className="input" value={dateTo} onChange={e => setDateTo(e.target.value)} />
        </div>
        <button className="btn btn-secondary" onClick={loadData}>🔄 تحديث</button>
      </div>

      {byPerson.length > 0 && (
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 18 }}>
          {byPerson.map(p => (
            <div key={p.name} className="card" style={{ padding: '10px 16px', minWidth: 180 }}>
              <div style={{ fontWeight: 800, marginBottom: 4 }}>{p.name}</div>
              <div style={{ color: 'var(--accent)', fontWeight: 800, fontSize: 16 }}>{fmtHours(p.hours)}</div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{p.sessions} مرة دخول</div>
            </div>
          ))}
        </div>
      )}

      <div className="table-container">
        <table>
          <thead>
            <tr><th>التاريخ</th><th>الموظف</th><th>الدخول</th><th>الخروج</th><th>ساعات العمل</th><th></th></tr>
          </thead>
          <tbody>
            {shifts.map((s) => (
              <tr key={s.shift_id}>
                <td style={{ fontWeight: 700 }}>{s.shift_date}</td>
                <td>{s.cashier_name}</td>
                <td>{s.start_time || '—'}</td>
                <td>
                  {s.is_open
                    ? <span className="badge badge-success">🟢 موجود الآن</span>
                    : (s.end_time || '—')}
                </td>
                <td style={{ fontWeight: 800, color: 'var(--accent)' }}>{fmtHours(s.hours_worked)}</td>
                <td style={{ textAlign: 'left' }}>
                  <button className="btn btn-secondary btn-sm" onClick={() => setReportShiftId(s.shift_id)}>
                    مبيعات الموظف
                  </button>
                </td>
              </tr>
            ))}
            {shifts.length === 0 && !loading && (
              <tr>
                <td colSpan={6} style={{ textAlign: 'center', padding: 30, color: 'var(--text-muted)' }}>
                  لا توجد سجلات دخول في هذه الفترة
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {reportShiftId !== null && (
        <ShiftReportModal shiftId={reportShiftId} onClose={() => setReportShiftId(null)} />
      )}
    </>
  )
}
