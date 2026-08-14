import React, { useState, useEffect } from 'react'
import type { Order } from '../../shared/types'

export default function OrderHistoryScreen() {
  const [orders, setOrders] = useState<Order[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    loadOrders()
  }, [])

  const loadOrders = async () => {
    setLoading(true)
    const res = await window.api.listOrders()
    if (res.success) setOrders(res.data)
    setLoading(false)
  }

  return (
    <div className="animate-fade">
      <div className="page-header">
        <div>
          <h1 className="page-title">Order History</h1>
          <p className="page-subtitle">{orders.length} orders</p>
        </div>
        <button className="btn btn-secondary" onClick={loadOrders}>↻ Refresh</button>
      </div>

      <div className="table-container">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Cashier</th>
              <th>Total</th>
              <th>Payment</th>
              <th>Status</th>
              <th>Date</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((o) => (
              <tr key={o.order_id}>
                <td style={{ fontWeight: 600 }}>#{o.order_id}</td>
                <td>{o.cashier_name}</td>
                <td style={{ fontWeight: 600 }}>{o.total_amount.toFixed(2)}</td>
                <td><span className="badge badge-info">{o.payment_type}</span></td>
                <td>
                  <span className={`badge ${o.status === 'completed' ? 'badge-success' : 'badge-danger'}`}>
                    {o.status}
                  </span>
                </td>
                <td style={{ color: 'var(--text-muted)', fontSize: 13 }}>
                  {new Date(o.created_at).toLocaleString()}
                </td>
              </tr>
            ))}
            {orders.length === 0 && !loading && (
              <tr><td colSpan={6} style={{ textAlign: 'center', padding: 48, color: 'var(--text-muted)' }}>No orders yet</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
