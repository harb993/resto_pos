import React, { useState, useEffect } from 'react'
import type { TopItem } from '../../shared/types'

export default function AnalyticsScreen() {
  const [topItems, setTopItems] = useState<TopItem[]>([])
  const [worstItems, setWorstItems] = useState<TopItem[]>([])
  const [trend, setTrend] = useState<any[]>([])
  const [catBreakdown, setCatBreakdown] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => { loadAnalytics() }, [])

  const loadAnalytics = async () => {
    setLoading(true)
    const [t, best, worst, cats] = await Promise.all([
      window.api.getAnalyticsTrend('day'),
      window.api.getTopItems(10, 'DESC'),
      window.api.getTopItems(10, 'ASC'),
      window.api.getCategoryBreakdown(),
    ])
    if (t.success) setTrend(t.data)
    if (best.success) setTopItems(best.data)
    if (worst.success) setWorstItems(worst.data)
    if (cats.success) setCatBreakdown(cats.data)
    setLoading(false)
  }

  if (loading) return <div className="empty-state"><div className="empty-state-text">Loading analytics...</div></div>

  const totalCatRevenue = catBreakdown.reduce((s: number, c: any) => s + c.revenue, 0)

  return (
    <div className="animate-fade">
      <div className="page-header">
        <div><h1 className="page-title">Analytics</h1><p className="page-subtitle">Last 30 days performance</p></div>
        <button className="btn btn-secondary" onClick={loadAnalytics}>↻ Refresh</button>
      </div>

      {/* Revenue Trend */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div className="card-header"><span className="card-title">📈 Revenue Trend (30 Days)</span></div>
        {trend.length > 0 ? (
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 180, padding: '0 4px' }}>
            {trend.map((d: any, i: number) => {
              const max = Math.max(...trend.map((t: any) => t.revenue))
              const height = max > 0 ? (d.revenue / max) * 160 : 0
              return (
                <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                  <div style={{ fontSize: 9, color: 'var(--text-muted)', transform: 'rotate(-45deg)', whiteSpace: 'nowrap' }}>
                    {d.revenue > 0 ? d.revenue.toFixed(0) : ''}
                  </div>
                  <div style={{
                    width: '100%', height, minHeight: 2,
                    background: 'linear-gradient(to top, var(--accent), rgba(245,158,11,0.3))',
                    borderRadius: '4px 4px 0 0',
                    transition: 'height 0.5s ease',
                  }} title={`${d.date}: EGP ${d.revenue.toFixed(2)}`} />
                </div>
              )
            })}
          </div>
        ) : (
          <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-muted)' }}>No data yet</div>
        )}
      </div>

      <div className="grid-2" style={{ marginBottom: 20 }}>
        {/* Best Sellers */}
        <div className="card">
          <div className="card-header"><span className="card-title">🏆 Best Sellers</span></div>
          {topItems.length > 0 ? topItems.map((item, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ width: 24, height: 24, borderRadius: '50%', background: 'var(--accent-subtle)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, color: 'var(--accent)' }}>{i + 1}</span>
                <span style={{ fontSize: 14, fontWeight: 500 }}>{item.name}</span>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{item.unitsSold} sold</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>EGP {item.revenue.toFixed(2)}</div>
              </div>
            </div>
          )) : <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)' }}>No sales data</div>}
        </div>

        {/* Category Breakdown */}
        <div className="card">
          <div className="card-header"><span className="card-title">🍕 Category Breakdown</span></div>
          {catBreakdown.length > 0 ? catBreakdown.map((cat: any, i: number) => {
            const pct = totalCatRevenue > 0 ? (cat.revenue / totalCatRevenue * 100) : 0
            const colors = ['var(--accent)', 'var(--info)', 'var(--success)', 'var(--danger)', '#8b5cf6', '#06b6d4']
            return (
              <div key={i} style={{ marginBottom: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 4 }}>
                  <span style={{ fontWeight: 500 }}>{cat.name}</span>
                  <span style={{ color: 'var(--text-muted)' }}>{pct.toFixed(1)}% · EGP {cat.revenue.toFixed(0)}</span>
                </div>
                <div style={{ height: 6, background: 'var(--bg-input)', borderRadius: 3 }}>
                  <div style={{ height: '100%', width: `${pct}%`, background: colors[i % colors.length], borderRadius: 3, transition: 'width 0.5s' }} />
                </div>
              </div>
            )
          }) : <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)' }}>No data</div>}
        </div>
      </div>

      {/* Worst Sellers */}
      <div className="card">
        <div className="card-header"><span className="card-title">📉 Slowest Sellers</span></div>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          {worstItems.slice(0, 5).map((item, i) => (
            <div key={i} style={{ background: 'var(--bg-input)', borderRadius: 'var(--radius-sm)', padding: '10px 16px', fontSize: 13 }}>
              <span style={{ fontWeight: 600 }}>{item.name}</span>
              <span style={{ color: 'var(--text-muted)', marginLeft: 8 }}>{item.unitsSold} sold</span>
            </div>
          ))}
          {worstItems.length === 0 && <div style={{ color: 'var(--text-muted)' }}>No data</div>}
        </div>
      </div>
    </div>
  )
}
