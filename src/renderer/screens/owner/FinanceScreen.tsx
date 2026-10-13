import React, { useState, useEffect, useCallback } from 'react'
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip,
  ResponsiveContainer, BarChart, Bar, Legend,
} from 'recharts'
import type { FinanceReport } from '../../../shared/types'
import { useSettingsStore } from '../../state/stores'
import { dateStr, now } from '../../lib/clock'
import { WorkShiftSelect, useWorkShifts, type ShiftChoice } from '../../components/WorkShift'

const GRID = 'rgba(28, 22, 20, 0.10)'
const TOOLTIP = {
  background: 'var(--bg-card)', border: '1px solid var(--border-light)', borderRadius: 10,
  color: 'var(--text-primary)', boxShadow: 'var(--shadow-md)', fontWeight: 700,
} as const

/**
 * `toISOString()` is UTC, and this shop is not. At 01:00 in Cairo it is still
 * yesterday in UTC, so "today" resolved to the previous day for the first three
 * hours of every night — precisely the hours a late-closing restaurant is still
 * trading and someone is pulling a report. `dateStr` reads the local calendar date,
 * and on a node till it reads it off the MASTER's clock so both machines agree.
 */
const iso = (d: Date) => dateStr(d)

/** Which of the two questions this screen is answering — see the tab strip. */
type FinanceView = 'report' | 'costing'

/** The quick ranges an accountant actually asks for. */
function presetRange(key: string): { start: string; end: string } {
  const today = now()
  const start = now()
  switch (key) {
    case 'today':
      return { start: iso(today), end: iso(today) }
    case 'week':
      start.setDate(today.getDate() - 6)
      return { start: iso(start), end: iso(today) }
    case 'month':
      return { start: iso(new Date(today.getFullYear(), today.getMonth(), 1)), end: iso(today) }
    case 'lastMonth': {
      const first = new Date(today.getFullYear(), today.getMonth() - 1, 1)
      const last = new Date(today.getFullYear(), today.getMonth(), 0)
      return { start: iso(first), end: iso(last) }
    }
    case 'year':
      return { start: iso(new Date(today.getFullYear(), 0, 1)), end: iso(today) }
    default:
      start.setDate(today.getDate() - 29)
      return { start: iso(start), end: iso(today) }
  }
}

const PRESETS = [
  { key: 'today', label: 'اليوم' },
  { key: 'week', label: 'آخر 7 أيام' },
  { key: 'month', label: 'هذا الشهر' },
  { key: 'lastMonth', label: 'الشهر الماضي' },
  { key: 'year', label: 'هذه السنة' },
]

export default function FinanceScreen() {
  const currency = useSettingsStore((s) => s.settings.currency_symbol)
  const shifts = useWorkShifts()
  // 'all' is whole days; 'current' is the shift running now; a number is one earlier
  // shift from the list.
  // Opens on the shift running now: the shop runs by the shift, so that is the first
  // thing anybody wants. Whole days are one choice away.
  const [shift, setShift] = useState<ShiftChoice>('current')
  const shiftArg = shift === 'all' ? undefined : shift
  const [range, setRange] = useState(() => presetRange('month'))
  const [activePreset, setActivePreset] = useState('month')
  const [report, setReport] = useState<FinanceReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [view, setView] = useState<FinanceView>('report')
  const [busy, setBusy] = useState<null | 'pdf' | 'excel'>(null)
  const [toast, setToast] = useState<{ msg: string; type: string; path?: string } | null>(null)

  const showToast = (msg: string, type = 'success', path?: string) => {
    setToast({ msg, type, path })
    setTimeout(() => setToast(null), path ? 8000 : 4000)
  }

  const load = useCallback(async () => {
    setLoading(true)
    const res = await window.api.getFinanceReport(range.start, range.end, shiftArg)
    if (res.success) setReport(res.data)
    else showToast(res.error || 'تعذر تحميل التقرير', 'error')
    setLoading(false)
  }, [range.start, range.end, shiftArg])

  useEffect(() => { load() }, [load])

  const applyPreset = (key: string) => {
    setActivePreset(key)
    setRange(presetRange(key))
  }

  const doExport = async (kind: 'pdf' | 'excel') => {
    setBusy(kind)
    const res = kind === 'pdf'
      ? await window.api.exportFinancePdf(range.start, range.end, shiftArg)
      : await window.api.exportFinanceExcel(range.start, range.end, shiftArg)
    setBusy(null)

    if (!res.success) {
      showToast(res.error || 'فشل التصدير', 'error')
      return
    }
    // A cancelled save dialog is not a failure — say nothing rather than claim success.
    if (!res.data?.filePath) return
    showToast(`تم حفظ الملف بنجاح`, 'success', res.data.filePath)
  }

  const money = (n: number) =>
    n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

  if (loading && !report) {
    return (
      <div className="empty-state" dir="rtl">
        <div className="empty-state-icon" style={{ animation: 'pulse 1.5s infinite' }}>📊</div>
        <div className="empty-state-text">جاري تجهيز التقرير المالي...</div>
      </div>
    )
  }

  if (!report) return null

  const r = report
  const profitColor = r.netProfit >= 0 ? 'var(--success)' : 'var(--danger)'

  const dailyChart = r.daily.map(d => ({
    ...d,
    label: d.date.slice(5),
    'الإيرادات': d.revenue,
    'المصروف': d.expenses + d.salaries + d.cogs,
  }))

  const spendChart = r.expensesByCategory.map(c => ({ name: c.label, 'المصروف': c.total }))

  return (
    <div className="animate-fade" dir="rtl" style={{ paddingBottom: 40 }}>
      <div className="page-header">
        <div>
          <h1 className="page-title">المركز المالي</h1>
          <p className="page-subtitle">
            {r.shift
              ? <>الإيرادات، الأرباح، وكل جنيه صُرف — وردية {r.shift.name} يوم {r.shift.date}</>
              : <>الإيرادات، الأرباح، وكل جنيه صُرف — من {r.period.start} إلى {r.period.end}</>}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="btn btn-secondary" onClick={load} disabled={loading}>🔄 تحديث</button>
          <button className="btn btn-secondary" onClick={() => doExport('excel')} disabled={busy !== null}>
            {busy === 'excel' ? '⏳ جاري...' : '📗 تصدير Excel'}
          </button>
          <button className="btn btn-primary" onClick={() => doExport('pdf')} disabled={busy !== null}>
            {busy === 'pdf' ? '⏳ جاري...' : '📄 تصدير PDF'}
          </button>
        </div>
      </div>

      {/*
        Two different questions, so two tabs rather than one longer scroll.

        The report answers "what did we take and what did we spend, over this period".
        The costing tab answers "is each dish still earning what we priced it to earn"
        — which has no period at all: it is today's ingredient prices against the sheet
        the menu was built from.
      */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 18 }}>
        <button
          className={`cat-pill-btn ${view === 'report' ? 'active' : ''}`}
          onClick={() => setView('report')}
        >
          📊 التقرير المالي
        </button>
        <button
          className={`cat-pill-btn ${view === 'costing' ? 'active' : ''}`}
          onClick={() => setView('costing')}
        >
          🧮 التكلفة المبدئية مقابل الفعلية
        </button>
      </div>

      {view === 'costing' ? <CostingPanel /> : (
      <>
      {/* Range picker */}
      <div className="card" style={{ marginBottom: 20, display: 'flex', gap: 14, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <WorkShiftSelect value={shift} onChange={setShift} shifts={shifts} allowAll allLabel="بالتاريخ (أيام كاملة)" />
        <div style={{ display: shift === 'all' ? 'flex' : 'none', gap: 6, flexWrap: 'wrap' }}>
          {PRESETS.map(p => (
            <button
              key={p.key}
              className={`cat-pill-btn ${shift === 'all' && activePreset === p.key ? 'active' : ''}`}
              onClick={() => { setShift('all'); applyPreset(p.key) }}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 10, marginRight: 'auto', alignItems: 'flex-end', flexWrap: 'wrap' }}>
          {/* Dates only make sense for whole days; a shift carries its own times. */}
          {shift === 'all' && (
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label">من</label>
              <input
                type="date" className="input" value={range.start}
                onChange={e => { setActivePreset(''); setRange({ ...range, start: e.target.value }) }}
              />
            </div>
          )}
          {shift === 'all' && (
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label">إلى</label>
              <input
                type="date" className="input" value={range.end}
                onChange={e => { setActivePreset(''); setRange({ ...range, end: e.target.value }) }}
              />
            </div>
          )}
        </div>
        {r.shift && (
          <div style={{
            flexBasis: '100%', fontSize: 13, padding: '9px 13px', borderRadius: 6,
            background: r.shift.isOpen ? 'var(--warning-bg)' : 'var(--success-bg)',
            borderRight: `3px solid ${r.shift.isOpen ? 'var(--warning)' : 'var(--success)'}`,
          }}>
            🕒 وردية <b>{r.shift.name}</b> — بدأت{' '}
            <b style={{ direction: 'ltr', display: 'inline-block' }}>{r.shift.startedAt}</b>
            {r.shift.isOpen
              ? <> — <b>جارية الآن</b> (تنتهي <span style={{ direction: 'ltr', display: 'inline-block' }}>{r.shift.endsAt}</span>)، والأرقام محسوبة حتى هذه اللحظة</>
              : <> — انتهت <b style={{ direction: 'ltr', display: 'inline-block' }}>{r.shift.endsAt}</b></>}
          </div>
        )}
      </div>

      {/* Headline figures */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(185px, 1fr))', gap: 16, marginBottom: 22 }}>
        <Kpi label="المبيعات" value={`${money(r.revenue)} ${currency}`} color="var(--accent)"
             hint={`${r.orderCount} فاتورة · متوسط ${money(r.averageOrder)}`} />
        <Kpi label="مجمل الربح" value={`${money(r.grossProfit)} ${currency}`} color="var(--warning)"
             hint={`بعد الضريبة ${money(r.tax)} وتكلفة البضاعة ${money(r.cogs)}`} />
        <Kpi label="المصروفات والمرتبات" value={`${money(r.totalSpent)} ${currency}`} color="var(--danger)"
             hint={`مصروفات ${money(r.expensesTotal)} · مرتبات ${money(r.salariesTotal)}`} />
        <Kpi label="صافي الربح" value={`${money(r.netProfit)} ${currency}`} color={r.netProfit >= 0 ? 'var(--success)' : 'var(--danger)'}
             hint={`هامش ${r.netMarginPct}%`} big />
        {r.drawer && (
          <Kpi label="النقدية المتوقعة في الدرج" value={`${money(r.drawer.expectedCash)} ${currency}`} color="var(--info)"
               hint={r.drawer.driverCashPending > 0 ? `مع السائقين ${money(r.drawer.driverCashPending)} لم تُورَّد` : `مبيعات نقدية ${money(r.drawer.cashSales)}`} />
        )}
      </div>

      {/* P&L */}
      <div className="card" style={{ marginBottom: 22 }}>
        <div className="card-header"><span className="card-title">🧾 قائمة الأرباح والخسائر</span></div>
        <table>
          <tbody>
            <PlRow label="المبيعات (ما دفعه العملاء)" value={money(r.revenue)} currency={currency} bold />
            <PlRow label="ضريبة القيمة المضافة — تُورَّد للضرائب وليست ربحاً" value={`− ${money(r.tax)}`} currency={currency} color="var(--danger)" />
            <PlRow label="صافي المبيعات" value={money(r.netSales)} currency={currency} bold />
            <PlRow label="منها: رسوم التوصيل" value={money(r.deliveryFees)} currency={currency} indent muted />
            <PlRow label="بعد خصومات للعملاء بقيمة" value={money(r.discount)} currency={currency} indent muted />
            <PlRow label="تكلفة البضاعة المباعة" value={`− ${money(r.cogs)}`} currency={currency} color="var(--danger)" />
            <PlRow label={`مجمل الربح (هامش ${r.grossMarginPct}%)`} value={money(r.grossProfit)} currency={currency} bold color="var(--success)" />
            <PlRow label="المصروفات التشغيلية" value={`− ${money(r.operatingExpenses)}`} currency={currency} color="var(--danger)" />
            <PlRow label="المرتبات المصروفة" value={`− ${money(r.salariesTotal)}`} currency={currency} color="var(--danger)" />
            {r.wasteValue > 0 && (
              <PlRow label="الهالك" value={`− ${money(r.wasteValue)}`} currency={currency} color="var(--danger)" />
            )}
            <tr style={{ borderTop: '2px solid var(--text-primary)' }}>
              <td style={{ padding: '14px 10px', fontWeight: 900, fontSize: 16 }}>
                صافي الربح <span style={{ color: 'var(--text-muted)', fontWeight: 600, fontSize: 13 }}>(هامش {r.netMarginPct}%)</span>
              </td>
              <td style={{ padding: '14px 10px', textAlign: 'left', fontWeight: 900, fontSize: 20, color: profitColor }}>
                {money(r.netProfit)} {currency}
              </td>
            </tr>
          </tbody>
        </table>

        <div style={{ marginTop: 14, background: 'var(--bg-card-hover)', borderRight: '3px solid var(--amber)', padding: '10px 14px', borderRadius: 6, fontSize: 12, color: 'var(--text-secondary)' }}>
          <b>شراء الخامات لا يُخصم من الربح مرة ثانية</b> — تكلفة كل وجبة مباعة محسوبة بالفعل ضمن
          «تكلفة البضاعة المباعة». مشتريات خامات مسجلة كمصروف: <b>{money(r.ingredientPurchases)} {currency}</b>،
          وتوريدات مخزن: <b>{money(r.stockPurchaseValue)} {currency}</b> (تظهر في الدرج وحساب الموردين فقط).
          {r.voidedCount > 0 && <> · فواتير ملغاة: <b>{r.voidedCount}</b> بقيمة <b>{money(r.voidedValue)} {currency}</b>.</>}
        </div>
      </div>

      {/* Suppliers — beside the P&L, deliberately not inside it. What was BOUGHT is
          not what was CONSUMED; the ingredients actually sold are already in COGS. */}
      {r.suppliers && (
        <div className="card" style={{ marginBottom: 22 }}>
          <div className="card-header">
            <span className="card-title">🚚 الموردون والمشتريات</span>
            {r.suppliers.totalOwed > 0 && (
              <span className="badge badge-danger">
                مستحق عليك {money(r.suppliers.totalOwed)} {currency}
              </span>
            )}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 14, marginBottom: 16 }}>
            <div style={{ padding: 12, background: 'var(--bg-card-hover)', borderRadius: 6 }}>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                مشتريات الفترة ({r.suppliers.deliveriesInRange} توريد)
              </div>
              <div style={{ fontSize: 21, fontWeight: 900 }}>
                {money(r.suppliers.purchasedInRange)} {currency}
              </div>
            </div>
            <div style={{ padding: 12, background: 'var(--bg-card-hover)', borderRadius: 6 }}>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                المدفوع للموردين ({r.suppliers.paymentsInRange} دفعة)
              </div>
              <div style={{ fontSize: 21, fontWeight: 900, color: 'var(--success)' }}>
                {money(r.suppliers.paidInRange)} {currency}
              </div>
            </div>
            <div style={{ padding: 12, background: 'var(--bg-card-hover)', borderRadius: 6 }}>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>إجمالي المستحق حالياً</div>
              <div style={{
                fontSize: 21, fontWeight: 900,
                color: r.suppliers.totalOwed > 0 ? 'var(--danger)' : 'var(--success)',
              }}>
                {money(r.suppliers.totalOwed)} {currency}
              </div>
            </div>
          </div>

          {r.suppliers.bySupplier.length > 0 && (
            <div className="table-container" style={{ maxHeight: 260 }}>
              <table>
                <thead>
                  <tr><th>المورد</th><th>الموردة</th><th>المدفوع</th><th>المستحق</th><th>آخر توريد</th></tr>
                </thead>
                <tbody>
                  {r.suppliers.bySupplier.map(s => (
                    <tr key={s.supplierId}>
                      <td style={{ fontWeight: 800 }}>{s.name}</td>
                      <td>{money(s.supplied)} {currency}</td>
                      <td style={{ color: 'var(--success)' }}>{money(s.paid)} {currency}</td>
                      <td style={{ fontWeight: 900, color: s.owed > 0 ? 'var(--danger)' : 'var(--success)' }}>
                        {money(s.owed)} {currency}
                      </td>
                      <td style={{ color: 'var(--text-muted)' }}>{s.lastDelivery || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div style={{ marginTop: 12, background: 'var(--bg-card-hover)', borderRight: '3px solid var(--amber)', padding: '10px 14px', borderRadius: 6, fontSize: 12, color: 'var(--text-secondary)' }}>
            هذه الأرقام <b>خارج حساب الربح</b> عن قصد: ما اشتريته ليس ما استهلكته. تكلفة
            ما بِيع فعلاً محسوبة في «تكلفة البضاعة المباعة»، وإضافة المشتريات فوقها
            تحسب الجنيه مرتين. «المستحق» رصيد وليس مصروفاً، فلا مكان له في هامش الربح.
          </div>
        </div>
      )}

      {/* Charts */}
      <div className="card" style={{ marginBottom: 22, minHeight: 340 }}>
        <div className="card-header"><span className="card-title">📈 الداخل مقابل الخارج يومياً</span></div>
        <div style={{ width: '100%', height: 280 }} dir="ltr">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={dailyChart} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="finRev" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="var(--accent)" stopOpacity={0.32} />
                  <stop offset="95%" stopColor="var(--accent)" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="finSpend" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="var(--amber)" stopOpacity={0.28} />
                  <stop offset="95%" stopColor="var(--amber)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke={GRID} vertical={false} />
              <XAxis dataKey="label" stroke="var(--text-muted)" fontSize={11} tickMargin={8} />
              <YAxis stroke="var(--text-muted)" fontSize={11} />
              <RechartsTooltip contentStyle={TOOLTIP} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Area type="monotone" dataKey="الإيرادات" stroke="var(--accent)" strokeWidth={2.5} fill="url(#finRev)" />
              <Area type="monotone" dataKey="المصروف" stroke="var(--amber)" strokeWidth={2.5} fill="url(#finSpend)" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="grid-2" style={{ marginBottom: 22, alignItems: 'stretch' }}>
        <div className="card" style={{ display: 'flex', flexDirection: 'column' }}>
          <div className="card-header"><span className="card-title">💸 المصروف حسب النوع</span></div>
          <div style={{ flex: 1, minHeight: 260 }} dir="ltr">
            {spendChart.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={spendChart} layout="vertical" margin={{ top: 5, right: 24, left: 20, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={GRID} horizontal={false} />
                  <XAxis type="number" stroke="var(--text-muted)" fontSize={11} />
                  <YAxis dataKey="name" type="category" stroke="var(--text-muted)" fontSize={11} width={110} tick={{ fill: 'var(--text-primary)' }} />
                  <RechartsTooltip cursor={{ fill: 'rgba(28,22,20,0.05)' }} contentStyle={TOOLTIP} />
                  <Bar dataKey="المصروف" fill="var(--amber)" radius={[0, 4, 4, 0]} barSize={18} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <Empty text="لا توجد مصروفات في هذه الفترة" />
            )}
          </div>
        </div>

        <div className="card" style={{ display: 'flex', flexDirection: 'column' }}>
          <div className="card-header"><span className="card-title">🏆 الأصناف الأعلى ربحاً</span></div>
          <div style={{ flex: 1, overflowY: 'auto', maxHeight: 300 }}>
            <table>
              <thead>
                <tr><th>الصنف</th><th>الكمية</th><th style={{ textAlign: 'left' }}>الربح</th></tr>
              </thead>
              <tbody>
                {r.topItemsByProfit.map((i, idx) => (
                  <tr key={idx}>
                    <td style={{ fontWeight: 700 }}>{i.name}</td>
                    <td>{i.units}</td>
                    <td style={{ textAlign: 'left', fontWeight: 800, color: 'var(--success)' }}>
                      {money(i.profit)}
                      <span style={{ color: 'var(--text-muted)', fontWeight: 600, fontSize: 11 }}> ({i.marginPct}%)</span>
                    </td>
                  </tr>
                ))}
                {r.topItemsByProfit.length === 0 && (
                  <tr><td colSpan={3} style={{ textAlign: 'center', padding: 24, color: 'var(--text-muted)' }}>لا توجد مبيعات</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/*
        Two questions the profit table above cannot answer, because it is ranked by
        profit and cut at twelve: "how many did we sell of everything", and "what did
        that eat off the shelf". The second is the one that drives the next order to
        the supplier — a meal is one line on an invoice but eight things out of the
        store.
      */}
      <div className="grid-2">
        <div className="card" style={{ display: 'flex', flexDirection: 'column' }}>
          <div className="card-header">
            <span className="card-title">📦 كل الأصناف المباعة</span>
            <span className="badge badge-info" style={{ fontSize: 12, padding: '5px 12px' }}>
              {r.itemsSold.reduce((t, i) => t + i.units, 0)} قطعة · {r.itemsSold.length} صنف
            </span>
          </div>
          <div style={{ flex: 1, overflowY: 'auto', maxHeight: 380 }}>
            <table>
              <thead>
                <tr>
                  <th>الصنف</th><th>القسم</th>
                  <th>الكمية</th>
                  <th style={{ textAlign: 'left' }}>المبيعات</th>
                </tr>
              </thead>
              <tbody>
                {r.itemsSold.map((i, idx) => (
                  <tr key={idx}>
                    <td style={{ fontWeight: 700 }}>{i.name}</td>
                    <td style={{ color: 'var(--text-muted)', fontSize: 12 }}>{i.category}</td>
                    <td style={{ fontWeight: 800 }}>{i.units}</td>
                    <td style={{ textAlign: 'left' }}>{money(i.revenue)}</td>
                  </tr>
                ))}
                {r.itemsSold.length === 0 && (
                  <tr><td colSpan={4} style={{ textAlign: 'center', padding: 24, color: 'var(--text-muted)' }}>لا توجد مبيعات</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card" style={{ display: 'flex', flexDirection: 'column' }}>
          <div className="card-header">
            <span className="card-title">🥖 الخامات المستهلكة</span>
            <span className="badge badge-warning" style={{ fontSize: 12, padding: '5px 12px' }}>
              {r.materialsUsed.length} مادة
            </span>
          </div>
          <div style={{ flex: 1, overflowY: 'auto', maxHeight: 380 }}>
            <table>
              <thead>
                <tr>
                  <th>المادة</th>
                  <th>الكمية</th>
                  <th style={{ textAlign: 'left' }}>التكلفة</th>
                </tr>
              </thead>
              <tbody>
                {r.materialsUsed.map((m, idx) => (
                  <tr key={idx}>
                    <td style={{ fontWeight: 700 }}>{m.name}</td>
                    <td style={{ fontWeight: 800 }}>
                      {m.quantity} <span style={{ color: 'var(--text-muted)', fontWeight: 600, fontSize: 11 }}>{m.unit}</span>
                    </td>
                    <td style={{ textAlign: 'left' }}>{money(m.cost)}</td>
                  </tr>
                ))}
                {r.materialsUsed.length === 0 && (
                  <tr>
                    <td colSpan={3} style={{ textAlign: 'center', padding: 20, color: 'var(--text-muted)', fontSize: 12, lineHeight: 1.9 }}>
                      لا توجد خامات مستهلكة.
                      <br />
                      تظهر هنا الأصناف التي لها <b>مكونات</b> في «إدارة المخزون» فقط.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Every pound */}
      <div className="card">
        <div className="card-header">
          <span className="card-title">📒 كل جنيه صُرف</span>
          <span className="badge badge-danger" style={{ fontSize: 13, padding: '6px 14px' }}>
            {money(r.totalSpent)} {currency}
          </span>
        </div>
        <div className="table-container" style={{ maxHeight: 420, overflowY: 'auto' }}>
          <table>
            <thead>
              <tr>
                <th>التاريخ</th><th>النوع</th><th>البيان</th><th>سجّلها</th>
                <th style={{ textAlign: 'left' }}>المبلغ</th>
              </tr>
            </thead>
            <tbody>
              {r.ledger.map((e, idx) => (
                <tr key={idx}>
                  <td style={{ whiteSpace: 'nowrap' }}>{e.date}</td>
                  <td>
                    <span className={`badge ${e.kind === 'salary' ? 'badge-info' : 'badge-warning'}`}>
                      {e.kind === 'salary' ? 'مرتب' : 'مصروف'}
                    </span>
                  </td>
                  <td>
                    <div style={{ fontWeight: 700 }}>{e.label}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{e.category}</div>
                  </td>
                  <td style={{ color: 'var(--text-muted)' }}>{e.by || '—'}</td>
                  <td style={{ textAlign: 'left', fontWeight: 800 }}>{money(e.amount)}</td>
                </tr>
              ))}
              {r.ledger.length === 0 && (
                <tr><td colSpan={5} style={{ textAlign: 'center', padding: 30, color: 'var(--text-muted)' }}>
                  لا توجد مصروفات أو مرتبات في هذه الفترة
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      </>
      )}

      {toast && (
        <div className={`toast toast-${toast.type}`} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span>{toast.msg}</span>
          {toast.path && (
            <button
              className="btn btn-sm"
              style={{ background: 'rgba(255,255,255,0.22)', color: '#fff', border: 'none' }}
              onClick={() => window.api.openExportedFile(toast.path!)}
            >
              فتح الملف
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function Kpi({ label, value, color, hint, big }: {
  label: string; value: string; color: string; hint?: string; big?: boolean
}) {
  return (
    <div className="card" style={{ padding: 20, borderTop: `3px solid ${color}` }}>
      <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: big ? 30 : 24, fontWeight: 900, color }}>{value}</div>
      {hint && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>{hint}</div>}
    </div>
  )
}

function PlRow({ label, value, currency, bold, indent, muted, color }: {
  label: string; value: string; currency: string
  bold?: boolean; indent?: boolean; muted?: boolean; color?: string
}) {
  return (
    <tr>
      <td style={{
        padding: '10px', paddingRight: indent ? 30 : 10,
        fontWeight: bold ? 800 : 600,
        color: muted ? 'var(--text-muted)' : 'var(--text-primary)',
        fontSize: muted ? 13 : 14,
      }}>
        {label}
      </td>
      <td style={{
        padding: '10px', textAlign: 'left',
        fontWeight: bold ? 900 : 700,
        color: color || (muted ? 'var(--text-muted)' : 'var(--text-primary)'),
        fontSize: muted ? 13 : 15,
      }}>
        {value} {currency}
      </td>
    </tr>
  )
}

/**
 * «التكلفة المبدئية مقابل الفعلية» — the plan against the shelf.
 *
 * Every dish was costed once in «ملخص الريسبى» — its ingredients plus its packaging,
 * with the sheet's safety margin — and its selling price was set against that figure.
 * Then chicken went up. This is the only screen that says so: what the sheet said a
 * dish would cost, what its ingredients cost today, and the gap.
 *
 * The baseline is editable per dish in «قائمة الطعام», so a re-costed sheet can be
 * entered without an import.
 *
 * No date range, deliberately. This is not about a period — it is today's supplier
 * prices against the plan the menu was built on.
 */
function CostingPanel() {
  const [report, setReport] = React.useState<any>(null)
  const [loading, setLoading] = React.useState(true)
  const [onlyDrift, setOnlyDrift] = React.useState(false)

  const load = React.useCallback(async () => {
    setLoading(true)
    const res = await window.api.getCostingReport()
    setLoading(false)
    if (res.success) setReport(res.data)
  }, [])

  React.useEffect(() => { load() }, [load])

  if (loading) return <div className="card" style={{ padding: 28 }}><Empty text="جاري الحساب..." /></div>
  if (!report) return <div className="card" style={{ padding: 28 }}><Empty text="تعذر حساب التكلفة" /></div>

  const cur = report.currency
  const n = (v: number | null) => (v === null ? '—' : v.toFixed(2))
  const rows = onlyDrift ? report.items.filter((i: any) => i.drift !== null) : report.items

  return (
    <>
      <div className="grid-2" style={{ marginBottom: 18 }}>
        <div className="card" style={{ padding: 20 }}>
          <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 6 }}>
            أصناف يمكن مقارنتها
          </div>
          <div style={{ fontSize: 28, fontWeight: 900 }}>
            {report.comparedItems}
            <span style={{ fontSize: 15, color: 'var(--text-muted)', fontWeight: 700 }}>
              {' '}من {report.totalItems}
            </span>
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6, lineHeight: 1.8 }}>
            {report.notCostedItems > 0
              ? <>{report.notCostedItems} صنف بلا مكونات مُسعَّرة — سعّر المواد الخام ليظهر فرقها.</>
              : 'كل الأصناف لها مكونات مُسعَّرة.'}
          </div>
        </div>

        <div className="card" style={{ padding: 20 }}>
          <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 6 }}>
            متوسط انحراف التكلفة عن الخطة
          </div>
          <div style={{
            fontSize: 28, fontWeight: 900,
            color: report.averageDriftPct > 0 ? 'var(--danger)' : 'var(--success)',
          }}>
            {report.averageDriftPct > 0 ? '+' : ''}{report.averageDriftPct}%
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6, lineHeight: 1.8 }}>
            {report.overPlanCount > 0
              ? <><b style={{ color: 'var(--danger)' }}>{report.overPlanCount}</b> صنف تكلفته الآن أعلى مما سُعِّر عليه.</>
              : 'لا يوجد صنف تجاوز تكلفته المخططة.'}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <span className="card-title">🧮 التكلفة المبدئية مقابل الفعلية</span>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12.5, cursor: 'pointer' }}>
              <input type="checkbox" checked={onlyDrift} onChange={e => setOnlyDrift(e.target.checked)} />
              الأصناف المُسعَّرة فقط
            </label>
            <button className="btn btn-secondary btn-sm" onClick={load}>🔄 تحديث</button>
          </div>
        </div>

        <p style={{ fontSize: 12.5, color: 'var(--text-muted)', lineHeight: 1.9, marginBottom: 10 }}>
          <b>التكلفة المبدئية</b> = <b>تكلفة الخامات والتغليف</b> كما في «ملخص الريسبى»،
          وهي الأساس الذي بُني عليه سعر البيع، وتُعدَّل لكل صنف من شاشة «قائمة الطعام».
          <b> التكلفة الفعلية</b> = تكلفة مكوناته بأسعار الموردين اليوم.
          الفرق بينهما يقول إن كان الصنف ما زال يربح ما خُطِّط له.
        </p>

        <div className="table-container" style={{ maxHeight: 520, overflowY: 'auto' }}>
          <table>
            <thead>
              <tr>
                <th>الصنف</th>
                <th>القسم</th>
                <th>سعر البيع</th>
                <th>التكلفة المبدئية<br />
                  <span style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-muted)' }}>
                    خامات وتغليف
                  </span>
                </th>
                <th>التكلفة الفعلية</th>
                <th>الفرق</th>
                <th style={{ textAlign: 'left' }}>الربح الآن</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((i: any) => (
                <tr key={i.itemId} style={{ opacity: i.isActive ? 1 : 0.55 }}>
                  <td style={{ fontWeight: 700 }}>{i.name}</td>
                  <td style={{ color: 'var(--text-muted)', fontSize: 12 }}>{i.category}</td>
                  <td>{n(i.price)}</td>
                  <td style={{ fontWeight: 700 }}>
                    {i.baselineCost > 0 ? n(i.baselineCost) : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                  </td>
                  <td style={{ fontWeight: 700 }}>
                    {i.actualCost === null ? (
                      <span
                        style={{ color: 'var(--text-muted)', fontSize: 11.5 }}
                        title={i.recipeLines === 0
                          ? 'لا توجد مكونات لهذا الصنف'
                          : `${i.pricedLines} من ${i.recipeLines} مكوّن مُسعَّر`}
                      >
                        {i.recipeLines === 0 ? 'بلا مكونات' : `${i.pricedLines}/${i.recipeLines} مُسعَّر`}
                      </span>
                    ) : n(i.actualCost)}
                  </td>
                  <td style={{
                    fontWeight: 800,
                    color: i.drift === null ? 'var(--text-muted)'
                      : i.drift > 0 ? 'var(--danger)' : 'var(--success)',
                  }}>
                    {i.drift === null ? '—' : <>{i.drift > 0 ? '+' : ''}{n(i.drift)}
                      <span style={{ fontSize: 11, fontWeight: 700 }}> ({i.driftPct > 0 ? '+' : ''}{i.driftPct}%)</span>
                    </>}
                  </td>
                  <td style={{ textAlign: 'left', fontWeight: 800 }}>
                    {i.actualProfit === null ? (
                      <span style={{ color: 'var(--text-muted)', fontWeight: 600 }}>
                        {i.plannedProfit === null ? '—' : `مخطط ${n(i.plannedProfit)}`}
                      </span>
                    ) : (
                      <span style={{ color: i.actualProfit > 0 ? 'var(--success)' : 'var(--danger)' }}>
                        {n(i.actualProfit)} {cur}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr><td colSpan={7} style={{ textAlign: 'center', padding: 30, color: 'var(--text-muted)', lineHeight: 1.9 }}>
                  لا توجد أصناف.
                  <br />
                  استورد «القائمة الجاهزة» ثم «مكونات الوجبات»، وسعّر المواد الخام.
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  )
}

function Empty({ text }: { text: string }) {
  return (
    <div style={{ display: 'flex', height: '100%', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)' }}>
      {text}
    </div>
  )
}
