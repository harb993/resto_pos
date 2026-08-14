import React, { useState, useEffect } from 'react'

export default function DashboardScreen() {
  const [summary, setSummary] = useState<any>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    loadDashboard()
  }, [])

  const loadDashboard = async () => {
    setLoading(true)
    const [todayRes, weekRes, monthRes] = await Promise.all([
      window.api.getAnalyticsSummary('today'),
      window.api.getAnalyticsSummary('week'),
      window.api.getAnalyticsSummary('month'),
    ])
    setSummary({
      today: todayRes.success ? todayRes.data : null,
      week: weekRes.success ? weekRes.data : null,
      month: monthRes.success ? monthRes.data : null,
    })
    setLoading(false)
  }

  const fmtCurrency = (v: number) => `EGP ${(v || 0).toFixed(2)}`

  const getDelta = (current: number, previous: number) => {
    if (!previous) return null
    const pct = ((current - previous) / previous * 100).toFixed(1)
    const isUp = current >= previous
    return { pct, isUp }
  }

  if (loading) {
    return <div className="empty-state"><div className="empty-state-text">Loading dashboard...</div></div>
  }

  const cards = [
    { label: "Today's Revenue", value: summary?.today?.current?.revenue, prev: summary?.today?.previous?.revenue, orders: summary?.today?.current?.order_count },
    { label: "This Week", value: summary?.week?.current?.revenue, prev: summary?.week?.previous?.revenue, orders: summary?.week?.current?.order_count },
    { label: "This Month", value: summary?.month?.current?.revenue, prev: summary?.month?.previous?.revenue, orders: summary?.month?.current?.order_count },
  ]

  return (
    <div className="animate-fade">
      <div className="page-header">
        <div>
          <h1 className="page-title">Dashboard</h1>
          <p className="page-subtitle">Business overview at a glance</p>
        </div>
        <button className="btn btn-secondary" onClick={loadDashboard}>↻ Refresh</button>
      </div>

      <div className="grid-3" style={{ marginBottom: 24 }}>
        {cards.map((c, i) => {
          const delta = getDelta(c.value || 0, c.prev || 0)
          return (
            <div key={i} className="stat-card">
              <div className="stat-label">{c.label}</div>
              <div className="stat-value">{fmtCurrency(c.value || 0)}</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 8 }}>
                {delta && (
                  <span className={`stat-delta ${delta.isUp ? 'up' : 'down'}`}>
                    {delta.isUp ? '↑' : '↓'} {delta.pct}%
                  </span>
                )}
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  {c.orders || 0} orders
                </span>
              </div>
            </div>
          )
        })}
      </div>

      <div className="card">
        <div className="card-header">
          <span className="card-title">Quick Actions</span>
        </div>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ background: 'var(--accent-subtle)', border: '1px solid rgba(245,158,11,0.2)', borderRadius: 'var(--radius-md)', padding: '16px 24px', flex: 1, minWidth: 200 }}>
            <div style={{ fontSize: 24, marginBottom: 8 }}>📊</div>
            <div style={{ fontWeight: 600, fontSize: 14 }}>Full Analytics</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>Charts, trends, menu engineering</div>
          </div>
          <div style={{ background: 'var(--info-bg)', border: '1px solid rgba(59,130,246,0.2)', borderRadius: 'var(--radius-md)', padding: '16px 24px', flex: 1, minWidth: 200 }}>
            <div style={{ fontSize: 24, marginBottom: 8 }}>🍗</div>
            <div style={{ fontWeight: 600, fontSize: 14 }}>Menu Management</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>Items, categories, pricing</div>
          </div>
          <div style={{ background: 'var(--success-bg)', border: '1px solid rgba(34,197,94,0.2)', borderRadius: 'var(--radius-md)', padding: '16px 24px', flex: 1, minWidth: 200 }}>
            <div style={{ fontSize: 24, marginBottom: 8 }}>📦</div>
            <div style={{ fontWeight: 600, fontSize: 14 }}>Inventory</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>Stock levels, restocking</div>
          </div>
        </div>
      </div>
    </div>
  )
}
