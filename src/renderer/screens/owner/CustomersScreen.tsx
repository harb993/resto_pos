import React, { useState, useEffect, useCallback } from 'react'
import type { Customer, CustomerOrder } from '../../../shared/types'
import { useSettingsStore } from '../../state/stores'

/** The delivery client book — every customer who has ever ordered for delivery. */
export default function CustomersScreen() {
  const currency = useSettingsStore((s) => s.settings.currency_symbol)
  const [customers, setCustomers] = useState<Customer[]>([])
  const [stats, setStats] = useState<{ totalCustomers: number; repeatCustomers: number; totalRevenue: number } | null>(null)
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)

  const [openPhone, setOpenPhone] = useState<string | null>(null)
  const [history, setHistory] = useState<CustomerOrder[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    const [list, st] = await Promise.all([
      window.api.listCustomers({ search }),
      window.api.getCustomerStats(),
    ])
    if (list.success) setCustomers(list.data)
    if (st.success) setStats(st.data)
    setLoading(false)
  }, [search])

  // Debounced so typing in the search box does not fire a query per keystroke.
  useEffect(() => {
    const t = setTimeout(load, 250)
    return () => clearTimeout(t)
  }, [load])

  const openHistory = async (phone: string) => {
    setOpenPhone(phone)
    setHistoryLoading(true)
    const res = await window.api.getCustomerOrders(phone)
    if (res.success) setHistory(res.data)
    setHistoryLoading(false)
  }

  const money = (n: number) =>
    n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

  const since = (iso: string) => {
    const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000)
    if (days <= 0) return 'اليوم'
    if (days === 1) return 'أمس'
    if (days < 30) return `منذ ${days} يوم`
    const months = Math.floor(days / 30)
    return `منذ ${months} شهر`
  }

  const openCustomer = customers.find(c => c.phone === openPhone)

  return (
    <div className="animate-fade" dir="rtl">
      <div className="page-header">
        <div>
          <h1 className="page-title">قاعدة بيانات العملاء</h1>
          <p className="page-subtitle">
            كل عميل طلب دليفري — بياناته وعدد طلباته وإجمالي ما أنفقه. تُبنى تلقائياً من الفواتير.
          </p>
        </div>
        <button className="btn btn-secondary" onClick={load}>🔄 تحديث</button>
      </div>

      {stats && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 16, marginBottom: 20 }}>
          <Tile label="إجمالي العملاء" value={String(stats.totalCustomers)} color="var(--accent)" />
          <Tile
            label="عملاء متكررون"
            value={String(stats.repeatCustomers)}
            color="var(--success)"
            hint={stats.totalCustomers > 0
              ? `${Math.round((stats.repeatCustomers / stats.totalCustomers) * 100)}% من العملاء`
              : undefined}
          />
          <Tile label="إجمالي مبيعات الدليفري" value={`${money(stats.totalRevenue)} ${currency}`} color="var(--warning)" />
        </div>
      )}

      <div style={{ marginBottom: 16, maxWidth: 420 }}>
        <input
          className="input"
          placeholder="بحث برقم الهاتف أو الاسم أو العنوان..."
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
      </div>

      <div className="table-container">
        <table>
          <thead>
            <tr>
              <th>رقم الهاتف</th>
              <th>الاسم</th>
              <th>العنوان</th>
              <th>المنطقة</th>
              <th>الطلبات</th>
              <th>إجمالي الإنفاق</th>
              <th>آخر طلب</th>
              <th>السجل</th>
            </tr>
          </thead>
          <tbody>
            {customers.map(c => (
              <tr key={c.phone}>
                <td style={{ fontWeight: 800, fontFamily: 'monospace', color: 'var(--accent)' }}>{c.phone}</td>
                <td style={{ fontWeight: 700 }}>{c.name || '—'}</td>
                <td style={{ fontSize: 12, color: 'var(--text-secondary)', maxWidth: 260 }}>{c.address || '—'}</td>
                <td>{c.area_name ? <span className="badge badge-info">{c.area_name}</span> : '—'}</td>
                <td>
                  <span className={`badge ${c.order_count > 1 ? 'badge-success' : 'badge-warning'}`}>
                    {c.order_count} طلب
                  </span>
                </td>
                <td style={{ fontWeight: 800 }}>
                  {money(c.total_spent)}
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600 }}>
                    متوسط {money(c.average_order)}
                  </div>
                </td>
                <td style={{ fontSize: 12 }}>
                  {since(c.last_order_at)}
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{c.last_order_at.slice(0, 10)}</div>
                </td>
                <td>
                  <button className="btn btn-secondary btn-sm" onClick={() => openHistory(c.phone)}>
                    📋 الطلبات
                  </button>
                </td>
              </tr>
            ))}
            {customers.length === 0 && !loading && (
              <tr>
                <td colSpan={8} style={{ textAlign: 'center', padding: 40 }}>
                  <div className="empty-state">
                    <div className="empty-state-icon">👥</div>
                    <div className="empty-state-text">
                      {search ? 'لا يوجد عميل مطابق للبحث' : 'لا يوجد عملاء دليفري بعد'}
                    </div>
                    {!search && (
                      <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6 }}>
                        يُضاف العميل تلقائياً بمجرد تسجيل أول طلب توصيل باسمه.
                      </p>
                    )}
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {openPhone && (
        <div className="modal-overlay" onClick={() => setOpenPhone(null)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 760, maxHeight: '88vh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <h2 className="modal-title" style={{ marginBottom: 4 }}>
                  {openCustomer?.name || 'عميل'}
                </h2>
                <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                  <span style={{ fontFamily: 'monospace', fontWeight: 700 }}>{openPhone}</span>
                  {openCustomer?.address && <> · {openCustomer.address}</>}
                </div>
              </div>
              <button className="btn btn-secondary" onClick={() => setOpenPhone(null)}>إغلاق</button>
            </div>

            {openCustomer && (
              <div style={{ display: 'flex', gap: 12, margin: '16px 0' }}>
                <Tile label="عدد الطلبات" value={String(openCustomer.order_count)} color="var(--accent)" small />
                <Tile label="إجمالي الإنفاق" value={money(openCustomer.total_spent)} color="var(--success)" small />
                <Tile label="متوسط الطلب" value={money(openCustomer.average_order)} color="var(--warning)" small />
                <Tile label="عميل منذ" value={openCustomer.first_order_at.slice(0, 10)} color="var(--info)" small />
              </div>
            )}

            {historyLoading ? (
              <div className="empty-state" style={{ padding: 30 }}>
                <div className="empty-state-text">جاري التحميل...</div>
              </div>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>التاريخ</th><th>رقم الفاتورة</th><th>الأصناف</th>
                    <th>الدفع</th><th style={{ textAlign: 'left' }}>الإجمالي</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map(o => (
                    <tr key={o.order_id} style={o.status === 'voided'
                      ? { opacity: 0.5, textDecoration: 'line-through' } : undefined}>
                      <td style={{ whiteSpace: 'nowrap' }}>{o.created_at.slice(0, 16)}</td>
                      <td style={{ fontWeight: 800, color: 'var(--accent)' }}>
                        {o.invoice_number || `#${o.order_id}`}
                      </td>
                      <td style={{ fontSize: 12, color: 'var(--text-secondary)', maxWidth: 280 }}>
                        {o.items_summary || `${o.item_count} صنف`}
                      </td>
                      <td>{o.payment_type === 'cash' ? 'نقدي' : 'بطاقة'}</td>
                      <td style={{ textAlign: 'left', fontWeight: 800 }}>{money(o.total_amount)}</td>
                    </tr>
                  ))}
                  {history.length === 0 && (
                    <tr><td colSpan={5} style={{ textAlign: 'center', padding: 24, color: 'var(--text-muted)' }}>
                      لا توجد طلبات
                    </td></tr>
                  )}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function Tile({ label, value, color, hint, small }: {
  label: string; value: string; color: string; hint?: string; small?: boolean
}) {
  return (
    <div
      className={small ? undefined : 'card'}
      style={small
        ? { flex: 1, background: 'var(--bg-card-hover)', borderTop: `3px solid ${color}`, borderRadius: 8, padding: '10px 13px' }
        : { padding: 20, borderTop: `3px solid ${color}` }}
    >
      <div style={{ fontSize: small ? 11 : 13, color: 'var(--text-muted)', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: small ? 17 : 24, fontWeight: 900, color }}>{value}</div>
      {hint && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 5 }}>{hint}</div>}
    </div>
  )
}
