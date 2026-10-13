import React, { useState, useEffect, useCallback } from 'react'
import { useSettingsStore } from '../../state/stores'
import type { FinanceReport } from '../../../shared/types'
import { WorkShiftSelect, ShiftTimes, useWorkShifts, type ShiftChoice } from '../../components/WorkShift'

/**
 * One screen, one question: how is the shift going?
 *
 * The shop runs by the shift, so that is what leads — what was sold, what it earned,
 * what went out and what should be in the drawer, for the shift running now or any
 * earlier one. Every figure is the same one the shift report and the finance screen
 * show, because all three ask the main process the same thing.
 *
 * Below it, three small figures for the calendar — today, this week, this month — for
 * the comparison a shift on its own cannot give.
 */
export default function DashboardScreen() {
  const settings = useSettingsStore((s) => s.settings)
  const currency = settings.currency_symbol || 'ج.م'
  const shifts = useWorkShifts()

  const [shift, setShift] = useState<ShiftChoice>('current')
  const [report, setReport] = useState<FinanceReport | null>(null)
  const [calendar, setCalendar] = useState<any>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    const [shiftRes, todayRes, weekRes, monthRes] = await Promise.all([
      window.api.getFinanceReport('', '', shift === 'all' ? 'current' : shift),
      window.api.getAnalyticsSummary('today'),
      window.api.getAnalyticsSummary('week'),
      window.api.getAnalyticsSummary('month'),
    ])
    if (shiftRes.success) { setReport(shiftRes.data); setError('') }
    else { setReport(null); setError(shiftRes.error || 'تعذر تحميل بيانات الوردية') }
    setCalendar({
      today: todayRes.success ? todayRes.data : null,
      week: weekRes.success ? weekRes.data : null,
      month: monthRes.success ? monthRes.data : null,
    })
    setLoading(false)
  }, [shift])

  useEffect(() => { void load() }, [load])

  // A sale or a new shift changes every figure here; do not make anybody press refresh.
  useEffect(() => {
    const offOrders = window.api.onOrdersChanged?.(() => { void load() })
    const offShift = window.api.onWorkShiftChanged?.(() => { void load() })
    return () => { offOrders?.(); offShift?.() }
  }, [load])

  const money = (n: number) =>
    `${(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`

  const r = report
  const s = r?.shift

  const periods = [
    { label: 'اليوم', data: calendar?.today },
    { label: 'هذا الأسبوع', data: calendar?.week },
    { label: 'هذا الشهر', data: calendar?.month },
  ]

  return (
    <div className="animate-fade" dir="rtl">
      <div className="page-header">
        <div>
          <h1 className="page-title">لوحة التحكم</h1>
          <p className="page-subtitle">كل الأرقام محسوبة على الوردية — اختر وردية لترى نتيجتها</p>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end' }}>
          <WorkShiftSelect value={shift} onChange={setShift} shifts={shifts} />
          <button className="btn btn-secondary" onClick={load} disabled={loading}>🔄 تحديث</button>
        </div>
      </div>

      {error && (
        <div className="badge badge-danger" style={{ padding: '10px 14px', marginBottom: 16, display: 'block' }}>⚠️ {error}</div>
      )}

      {r && s && (
        <>
          <div style={{ marginBottom: 16 }}>
            <ShiftTimes name={s.name} startedAt={s.startedAt} endsAt={s.endsAt} isOpen={s.isOpen} />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 16, marginBottom: 16 }}>
            <Figure icon="🧾" label="المبيعات" value={money(r.revenue)} hint={`${r.orderCount} فاتورة`} color="var(--accent)" />
            <Figure
              icon="📈" label="صافي الربح" value={money(r.netProfit)}
              hint={`هامش ${r.netMarginPct}%`} color={r.netProfit >= 0 ? 'var(--success)' : 'var(--danger)'}
            />
            <Figure
              icon="💸" label="المصروفات والمرتبات" value={money(r.totalSpent)}
              hint={`مصروفات ${money(r.expensesTotal)} · مرتبات ${money(r.salariesTotal)}`} color="var(--warning)"
            />
            {r.drawer && (
              <Figure
                icon="🏦" label="النقدية المتوقعة في الدرج" value={money(r.drawer.expectedCash)}
                hint={r.drawer.driverCashPending > 0
                  ? `مع السائقين ${money(r.drawer.driverCashPending)} لم تُورَّد`
                  : `مبيعات نقدية ${money(r.drawer.cashSales)}`}
                color="var(--info)"
              />
            )}
          </div>

          {/* How the profit is arrived at, in the order it is worked out. */}
          <div className="card" style={{ marginBottom: 24 }}>
            <div className="card-header"><span className="card-title">كيف حُسب ربح الوردية</span></div>
            <table>
              <tbody>
                <Step label="المبيعات (ما دفعه العملاء)" value={money(r.revenue)} />
                <Step label="− ضريبة القيمة المضافة (تُورَّد للضرائب)" value={money(r.tax)} minus />
                <Step label="− تكلفة البضاعة المباعة" value={money(r.cogs)} minus />
                <Step label="− المصروفات التشغيلية" value={money(r.operatingExpenses)} minus />
                <Step label="− المرتبات" value={money(r.salariesTotal)} minus />
                {r.wasteValue > 0 && <Step label="− الهالك" value={money(r.wasteValue)} minus />}
                <Step label="= صافي الربح" value={money(r.netProfit)} total good={r.netProfit >= 0} />
              </tbody>
            </table>
          </div>
        </>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 16 }}>
        {periods.map(p => (
          <div key={p.label} className="stat-card">
            <div className="stat-label">مبيعات {p.label}</div>
            <div className="stat-value" style={{ fontSize: 22 }}>{money(p.data?.current?.revenue || 0)}</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6 }}>
              🧾 {p.data?.current?.order_count || 0} فاتورة
              {p.data?.previous?.revenue > 0 && <> · الفترة السابقة {money(p.data.previous.revenue)}</>}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function Figure({ icon, label, value, hint, color }: {
  icon: string; label: string; value: string; hint: string; color: string
}) {
  return (
    <div className="stat-card" style={{ borderTop: `3px solid ${color}` }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div className="stat-label">{label}</div>
        <span style={{ fontSize: 20 }}>{icon}</span>
      </div>
      <div className="stat-value" style={{ color }}>{value}</div>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8 }}>{hint}</div>
    </div>
  )
}

function Step({ label, value, minus, total, good }: {
  label: string; value: string; minus?: boolean; total?: boolean; good?: boolean
}) {
  return (
    <tr style={total ? { borderTop: '2px solid var(--text-primary)' } : undefined}>
      <td style={{ padding: '9px 10px', fontWeight: total ? 900 : 600, fontSize: total ? 15 : 14 }}>{label}</td>
      <td style={{
        padding: '9px 10px', textAlign: 'left', fontWeight: total ? 900 : 700, fontSize: total ? 17 : 14,
        color: total ? (good ? 'var(--success)' : 'var(--danger)') : (minus ? 'var(--danger)' : 'var(--text-primary)'),
      }}>
        {value}
      </td>
    </tr>
  )
}
