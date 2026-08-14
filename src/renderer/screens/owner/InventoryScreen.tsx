import React, { useState, useEffect } from 'react'
import type { MenuItem } from '../../shared/types'

export default function InventoryScreen() {
  const [items, setItems] = useState<MenuItem[]>([])
  const [showRestock, setShowRestock] = useState<MenuItem | null>(null)
  const [qty, setQty] = useState('')
  const [reason, setReason] = useState<'restock' | 'waste' | 'adjustment'>('restock')
  const [toast, setToast] = useState<{ msg: string; type: string } | null>(null)

  useEffect(() => { loadItems() }, [])

  const loadItems = async () => {
    const res = await window.api.getMenu(true)
    if (res.success) setItems(res.data)
  }

  const handleRestock = async () => {
    if (!showRestock || !qty) return
    const res = await window.api.restockItem(showRestock.item_id, Number(qty), reason)
    if (res.success) {
      setToast({ msg: `Stock updated for ${showRestock.name}`, type: 'success' })
      setTimeout(() => setToast(null), 3000)
      setShowRestock(null); setQty(''); loadItems()
    } else {
      setToast({ msg: res.error || 'Failed', type: 'error' })
      setTimeout(() => setToast(null), 3000)
    }
  }

  const lowStockCount = items.filter(i => i.is_active && i.stock_quantity <= 5).length

  return (
    <div className="animate-fade">
      <div className="page-header">
        <div>
          <h1 className="page-title">Inventory</h1>
          <p className="page-subtitle">
            {items.length} items · {lowStockCount > 0 && <span style={{ color: 'var(--danger)' }}>{lowStockCount} low stock</span>}
          </p>
        </div>
        <button className="btn btn-secondary" onClick={loadItems}>↻ Refresh</button>
      </div>

      <div className="table-container">
        <table>
          <thead><tr><th>Item</th><th>Category</th><th>Stock</th><th>Status</th><th>Action</th></tr></thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.item_id}>
                <td style={{ fontWeight: 600 }}>{item.name}</td>
                <td>{item.category_name}</td>
                <td>
                  <span className={`badge ${item.stock_quantity <= 0 ? 'badge-danger' : item.stock_quantity <= 5 ? 'badge-warning' : 'badge-success'}`}>
                    {item.stock_quantity}
                  </span>
                </td>
                <td><span className={`badge ${item.is_active ? 'badge-success' : 'badge-danger'}`}>{item.is_active ? 'Active' : 'Inactive'}</span></td>
                <td><button className="btn btn-secondary btn-sm" onClick={() => { setShowRestock(item); setQty(''); setReason('restock') }}>Adjust Stock</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showRestock && (
        <div className="modal-overlay" onClick={() => setShowRestock(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 380 }}>
            <h2 className="modal-title">Adjust Stock: {showRestock.name}</h2>
            <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 16 }}>Current stock: <strong>{showRestock.stock_quantity}</strong></p>
            <div className="form-group">
              <label className="form-label">Reason</label>
              <select className="input" value={reason} onChange={(e) => setReason(e.target.value as any)}>
                <option value="restock">Restock (add)</option>
                <option value="waste">Waste (remove)</option>
                <option value="adjustment">Adjustment (add)</option>
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">Quantity</label>
              <input className="input" type="number" min="1" value={qty} onChange={(e) => setQty(e.target.value)} placeholder="Enter quantity" autoFocus />
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn btn-secondary" onClick={() => setShowRestock(null)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleRestock}>Update Stock</button>
            </div>
          </div>
        </div>
      )}

      {toast && <div className={`toast toast-${toast.type}`}>{toast.msg}</div>}
    </div>
  )
}
