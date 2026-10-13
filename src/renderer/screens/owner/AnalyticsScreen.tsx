import React, { useState, useEffect } from 'react'
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, ResponsiveContainer,
  PieChart, Pie, Cell,
  BarChart, Bar, Legend
} from 'recharts'
import type { TopItem } from '../../../shared/types'
import { todayStr, dateStr, now } from '../../lib/clock'

export default function AnalyticsScreen() {
  const [topItems, setTopItems] = useState<TopItem[]>([])
  const [worstItems, setWorstItems] = useState<TopItem[]>([])
  const [trend, setTrend] = useState<any[]>([])
  const [catBreakdown, setCatBreakdown] = useState<any[]>([])
  const [summary, setSummary] = useState<any>(null)
  
  const [loading, setLoading] = useState(true)
  const [exporting, setExporting] = useState(false)
  
  const [exportStart, setExportStart] = useState(() => {
    const d = now()
    d.setDate(1)
    return dateStr(d)
  })
  const [exportEnd, setExportEnd] = useState(() => todayStr())
  const [toast, setToast] = useState<{ msg: string; type: string } | null>(null)

  // The counting report. Held separately from the charts because it is computed on
  // demand for whatever range is in the bar above, not on every visit to the screen.
  const [salesProducts, setSalesProducts] = useState<any>(null)
  const [spBusy, setSpBusy] = useState<false | 'load' | 'export' | 'print'>(false)

  useEffect(() => { loadAnalytics() }, [])

  const loadAnalytics = async () => {
    setLoading(true)
    const [t, best, worst, cats, sum] = await Promise.all([
      window.api.getAnalyticsTrend('day'),
      window.api.getTopItems(10, 'DESC'),
      window.api.getTopItems(10, 'ASC'),
      window.api.getCategoryBreakdown(),
      window.api.getAnalyticsSummary('month')
    ])
    if (t.success) setTrend(t.data)
    if (best.success) setTopItems(best.data)
    if (worst.success) setWorstItems(worst.data)
    if (cats.success) setCatBreakdown(cats.data)
    if (sum.success) setSummary(sum.data)
    setLoading(false)
  }

  const showToast = (msg: string, type = 'success') => {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3000)
  }

  const handleExport = async () => {
    setExporting(true)
    const res = await window.api.exportReport(exportStart, exportEnd)
    if (res.success) {
      if (res.data.filePath) {
        showToast(`تم التصدير بنجاح: ${res.data.filePath}`)
      }
    } else {
      showToast(res.error || 'فشل التصدير', 'error')
    }
    setExporting(false)
  }

  const loadSalesProducts = async () => {
    setSpBusy('load')
    const res = await window.api.getSalesProductsReport(exportStart, exportEnd)
    setSpBusy(false)
    if (res.success) setSalesProducts(res.data)
    else showToast(res.error || 'تعذر حساب التقرير', 'error')
  }

  const exportSalesProducts = async () => {
    setSpBusy('export')
    const res = await window.api.exportSalesProducts(exportStart, exportEnd)
    setSpBusy(false)
    if (res.success) showToast('تم حفظ التقرير — PDF و Excel في مجلد تقارير المبيعات')
    else showToast(res.error || 'فشل التصدير', 'error')
  }

  const printSalesProducts = async () => {
    setSpBusy('print')
    const res = await window.api.printSalesProducts(exportStart, exportEnd)
    setSpBusy(false)
    if (res.success) showToast(`تم إرسال التقرير إلى "${res.data.printerName}"`)
    else showToast(res.error || 'تعذرت الطباعة', 'error')
  }

  if (loading) {
    return (
      <div className="empty-state" dir="rtl">
        <div className="empty-state-icon" style={{ animation: 'pulse 1.5s infinite' }}>📊</div>
        <div className="empty-state-text">جاري تحميل وتحليل البيانات...</div>
      </div>
    )
  }

  // Chart palette on the light theme: brand crimson and amber first, then hues that
  // stay distinguishable side by side and dark enough to read on white.
  const COLORS = ['var(--accent)', 'var(--amber)', 'var(--success)', 'var(--info)', '#7C3AED', '#0E7490']

  // Shared chart chrome, so every chart reads the same way.
  const GRID_STROKE = 'rgba(28, 22, 20, 0.10)'
  const TOOLTIP_STYLE = {
    background: 'var(--bg-card)',
    border: '1px solid var(--border-light)',
    borderRadius: 10,
    color: 'var(--text-primary)',
    boxShadow: '0 4px 12px rgba(28,22,20,0.10)',
    fontWeight: 700,
  } as const

  // Format trend data for chart
  const formattedTrend = trend.map(d => ({
    ...d,
    dateLabel: d.date ? d.date.split('-').slice(1).join('/') : '',
    الإيرادات: d.revenue
  }))

  const topItemsChart = topItems.map(item => ({
    name: item.name,
    'المبيعات': item.unitsSold
  }))

  return (
    <div className="animate-fade" dir="rtl" style={{ paddingBottom: 40 }}>
      {/* Page Header */}
      <div className="page-header" style={{ marginBottom: 24 }}>
        <div>
          <h1 className="page-title" style={{ fontSize: 28 }}>لوحة المؤشرات والتحليلات 📈</h1>
          <p className="page-subtitle">نظرة عامة على أداء المطعم (آخر 30 يوماً)</p>
        </div>
        <div style={{ display: 'flex', gap: 12 }}>
          <button className="btn btn-secondary" onClick={loadAnalytics}>
            🔄 تحديث
          </button>
          <button className="btn btn-primary" onClick={handleExport} disabled={exporting}>
            {exporting ? '⏳ جاري التصدير...' : '📊 تصدير تقرير مالي كامل'}
          </button>
        </div>
      </div>

      {/* Date Range for Export (Hidden in card, made compact) */}
      <div className="card" style={{ marginBottom: 24, padding: '12px 20px', display: 'flex', alignItems: 'center', gap: 20, background: 'var(--bg-card-hover)', border: '1px solid var(--border)' }}>
        <span style={{ fontWeight: 600, color: 'var(--text-muted)' }}>نطاق التصدير:</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <label style={{ fontSize: 12 }}>من</label>
          <input className="input" type="date" value={exportStart} onChange={e => setExportStart(e.target.value)} style={{ padding: '4px 10px', height: 32 }} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <label style={{ fontSize: 12 }}>إلى</label>
          <input className="input" type="date" value={exportEnd} onChange={e => setExportEnd(e.target.value)} style={{ padding: '4px 10px', height: 32 }} />
        </div>
      </div>

      {/*
        «Sales Products» — the counting report. Everything sold in the range above,
        section by section, and what it took out of the store. Uses the same date
        range as the export bar, so one set of dates drives the whole screen.
      */}
      <div className="card" style={{ marginBottom: 24 }}>
        <div className="card-header">
          <span className="card-title">🧾 تقرير المبيعات بالأصناف</span>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn btn-sm btn-secondary" onClick={loadSalesProducts} disabled={spBusy !== false}>
              🔄 عرض
            </button>
            <button className="btn btn-sm btn-secondary" onClick={exportSalesProducts} disabled={spBusy !== false}>
              {spBusy === 'export' ? '⏳ جاري التصدير...' : '📦 PDF + Excel'}
            </button>
            <button className="btn btn-sm btn-primary" onClick={printSalesProducts} disabled={spBusy !== false}>
              {spBusy === 'print' ? '⏳ جاري الطباعة...' : '🖨️ طباعة على الكاشير'}
            </button>
            <button className="btn btn-sm btn-ghost" onClick={() => window.api.openSalesReportFolder()}>
              📂 المجلد
            </button>
          </div>
        </div>

        {!salesProducts ? (
          <div style={{ padding: 22, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13, lineHeight: 1.9 }}>
            اضغط <b>عرض</b> لحساب كميات كل صنف بيع في الفترة المحددة أعلاه —
            {' '}ومعها الخامات التي خرجت من المخزن مقابلها.
          </div>
        ) : (
          <>
            <div style={{
              display: 'flex', gap: 22, flexWrap: 'wrap', padding: '4px 4px 14px',
              fontSize: 13, color: 'var(--text-muted)',
            }}>
              <span>الفواتير: <b style={{ color: 'var(--text-primary)' }}>{salesProducts.orderCount}</b></span>
              <span>إجمالي الكمية: <b style={{ color: 'var(--text-primary)' }}>{salesProducts.totalQuantity}</b></span>
              <span>الإجمالي: <b style={{ color: 'var(--success)' }}>
                {salesProducts.grandTotal.toFixed(2)} {salesProducts.currency}
              </b></span>
            </div>

            <div className="grid-2">
              <div style={{ maxHeight: 420, overflowY: 'auto' }}>
                {salesProducts.groups.map((g: any, gi: number) => (
                  <div key={gi} style={{ marginBottom: 14 }}>
                    <div style={{
                      fontWeight: 800, fontSize: 13.5, padding: '5px 8px',
                      background: 'var(--bg-card-hover)', borderRadius: 'var(--radius-sm)',
                      display: 'flex', justifyContent: 'space-between',
                    }}>
                      <span>{g.category}</span>
                      <span>{g.quantity} · {g.total.toFixed(2)}</span>
                    </div>
                    <table>
                      <tbody>
                        {g.items.map((i: any, ii: number) => (
                          <tr key={ii}>
                            <td>{i.name}</td>
                            <td style={{ width: 60, fontWeight: 800 }}>{i.quantity}</td>
                            <td style={{ width: 50, color: 'var(--text-muted)', fontSize: 11 }}>{i.unit}</td>
                            <td style={{ width: 90, textAlign: 'left' }}>{i.total.toFixed(2)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ))}
                {salesProducts.groups.length === 0 && (
                  <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)' }}>
                    لا توجد مبيعات في هذه الفترة
                  </div>
                )}
              </div>

              <div style={{ maxHeight: 420, overflowY: 'auto' }}>
                <div style={{
                  fontWeight: 800, fontSize: 13.5, padding: '5px 8px', marginBottom: 4,
                  background: 'var(--warning-bg)', borderRadius: 'var(--radius-sm)',
                }}>
                  🥖 الخامات المستهلكة
                </div>
                <table>
                  <tbody>
                    {salesProducts.materials.map((m: any, i: number) => (
                      <tr key={i}>
                        <td>{m.name}</td>
                        <td style={{ width: 110, fontWeight: 800 }}>
                          {m.quantity} <span style={{ fontWeight: 600, fontSize: 11, color: 'var(--text-muted)' }}>{m.unit}</span>
                        </td>
                        <td style={{ width: 90, textAlign: 'left' }}>{m.cost.toFixed(2)}</td>
                      </tr>
                    ))}
                    {salesProducts.materials.length === 0 && (
                      <tr><td style={{ padding: 18, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12, lineHeight: 1.9 }}>
                        لا توجد خامات مستهلكة.
                        <br />
                        استورد «مكونات الوجبات» من شاشة المخزون أولاً.
                      </td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </div>

      {/* KPI Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 20, marginBottom: 24 }}>
        <div className="card" style={{ padding: 24, background: 'linear-gradient(135deg, var(--accent-subtle) 0%, var(--bg-card) 100%)', borderTop: '3px solid var(--accent)' }}>
          <div style={{ fontSize: 14, color: 'var(--text-muted)', marginBottom: 8 }}>إجمالي الإيرادات (هذا الشهر)</div>
          <div style={{ fontSize: 32, fontWeight: 900, color: 'var(--accent)' }}>
            {summary?.current?.revenue?.toLocaleString() || 0} <span style={{ fontSize: 16 }}>ج.م</span>
          </div>
        </div>
        <div className="card" style={{ padding: 24, background: 'linear-gradient(135deg, var(--success-bg) 0%, var(--bg-card) 100%)', borderTop: '3px solid var(--success)' }}>
          <div style={{ fontSize: 14, color: 'var(--text-muted)', marginBottom: 8 }}>عدد الطلبات (هذا الشهر)</div>
          <div style={{ fontSize: 32, fontWeight: 900, color: 'var(--success)' }}>
            {summary?.current?.order_count?.toLocaleString() || 0}
          </div>
        </div>
        <div className="card" style={{ padding: 24, background: 'linear-gradient(135deg, var(--amber-bg) 0%, var(--bg-card) 100%)', borderTop: '3px solid var(--amber)' }}>
          <div style={{ fontSize: 14, color: 'var(--text-muted)', marginBottom: 8 }}>متوسط قيمة الطلب</div>
          <div style={{ fontSize: 32, fontWeight: 900, color: 'var(--warning)' }}>
            {summary?.current?.order_count > 0 
              ? (summary.current.revenue / summary.current.order_count).toFixed(2) 
              : 0} <span style={{ fontSize: 16 }}>ج.م</span>
          </div>
        </div>
      </div>

      {/* Main Trend Chart */}
      <div className="card" style={{ marginBottom: 24, padding: 24, minHeight: 350 }}>
        <h3 style={{ margin: '0 0 20px 0', fontSize: 18, color: 'var(--text-primary)' }}>مؤشر المبيعات اليومية 📉</h3>
        <div style={{ width: '100%', height: 300 }} dir="ltr">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={formattedTrend} margin={{ top: 10, right: 30, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="colorRevenue" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="var(--accent)" stopOpacity={0.35}/>
                  <stop offset="95%" stopColor="var(--accent)" stopOpacity={0}/>
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} vertical={false} />
              <XAxis dataKey="dateLabel" stroke="var(--text-muted)" fontSize={12} tickMargin={10} />
              <YAxis stroke="var(--text-muted)" fontSize={12} tickFormatter={(val) => `${val}`} />
              <RechartsTooltip
                contentStyle={TOOLTIP_STYLE}
                itemStyle={{ color: 'var(--accent)', fontWeight: 700 }}
              />
              <Area type="monotone" dataKey="الإيرادات" stroke="var(--accent)" strokeWidth={3} fillOpacity={1} fill="url(#colorRevenue)" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="grid-2" style={{ marginBottom: 24, alignItems: 'stretch' }}>
        {/* Category Breakdown Donut */}
        <div className="card" style={{ padding: 24, display: 'flex', flexDirection: 'column' }}>
          <h3 style={{ margin: '0 0 20px 0', fontSize: 18, color: 'var(--text-primary)' }}>نسبة المبيعات حسب القسم 🍕</h3>
          <div style={{ flex: 1, minHeight: 300, display: 'flex', alignItems: 'center', justifyContent: 'center' }} dir="ltr">
            {catBreakdown.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={catBreakdown}
                    cx="50%"
                    cy="50%"
                    innerRadius={70}
                    outerRadius={100}
                    paddingAngle={5}
                    dataKey="revenue"
                    stroke="none"
                  >
                    {catBreakdown.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                    ))}
                  </Pie>
                  <RechartsTooltip
                    formatter={(value: number) => [`${value.toFixed(0)} ج.م`, 'الإيراد']}
                    contentStyle={TOOLTIP_STYLE}
                  />
                  <Legend verticalAlign="bottom" height={36} wrapperStyle={{ fontSize: 12, color: 'var(--text-secondary)' }} />
                </PieChart>
              </ResponsiveContainer>
            ) : (
              <div style={{ color: 'var(--text-muted)' }}>لا توجد بيانات</div>
            )}
          </div>
        </div>

        {/* Best Sellers Bar Chart */}
        <div className="card" style={{ padding: 24, display: 'flex', flexDirection: 'column' }}>
          <h3 style={{ margin: '0 0 20px 0', fontSize: 18, color: 'var(--text-primary)' }}>أفضل الأصناف مبيعاً 🏆</h3>
          <div style={{ flex: 1, minHeight: 300 }} dir="ltr">
            {topItemsChart.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={topItemsChart.slice(0,7)} layout="vertical" margin={{ top: 5, right: 30, left: 20, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} horizontal={false} />
                  <XAxis type="number" stroke="var(--text-muted)" fontSize={12} />
                  <YAxis dataKey="name" type="category" stroke="var(--text-muted)" fontSize={12} width={100} tick={{fill: 'var(--text-primary)'}} />
                  <RechartsTooltip
                    cursor={{fill: 'rgba(28,22,20,0.05)'}}
                    contentStyle={TOOLTIP_STYLE}
                  />
                  <Bar dataKey="المبيعات" fill="var(--success)" radius={[0, 4, 4, 0]} barSize={20} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div style={{ display: 'flex', height: '100%', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)' }}>لا توجد بيانات</div>
            )}
          </div>
        </div>
      </div>

      {/* Slowest Sellers - Keeps list format but styled better */}
      <div className="card" style={{ padding: 24 }}>
        <h3 style={{ margin: '0 0 20px 0', fontSize: 18, color: 'var(--text-primary)' }}>الأصناف الأقل مبيعاً (للمراجعة) ⚠️</h3>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          {worstItems.slice(0, 8).map((item, i) => (
            <div key={i} style={{
              background: 'var(--danger-bg)', border: '1px solid rgba(217,45,32,0.22)',
              borderRadius: 8, padding: '12px 20px', display: 'flex', alignItems: 'center', gap: 12,
            }}>
              <span style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{item.name}</span>
              <span className="badge badge-danger" style={{ fontSize: 12, padding: '4px 8px' }}>{item.unitsSold} مبيعات فقط</span>
            </div>
          ))}
          {worstItems.length === 0 && <div style={{ color: 'var(--text-muted)' }}>جميع الأصناف تباع بشكل جيد!</div>}
        </div>
      </div>

      {toast && <div className={`toast toast-${toast.type}`}>{toast.msg}</div>}
    </div>
  )
}
