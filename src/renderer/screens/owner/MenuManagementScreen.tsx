import React, { useState, useEffect } from 'react'
import type { MenuItem, Category, MenuItemInput } from '../../shared/types'

export default function MenuManagementScreen() {
  const [categories, setCategories] = useState<Category[]>([])
  const [items, setItems] = useState<MenuItem[]>([])
  const [showModal, setShowModal] = useState(false)
  const [showCatModal, setShowCatModal] = useState(false)
  const [editItem, setEditItem] = useState<MenuItem | null>(null)
  const [form, setForm] = useState<Partial<MenuItemInput>>({})
  const [catName, setCatName] = useState('')
  const [toast, setToast] = useState<{ msg: string; type: string } | null>(null)

  useEffect(() => { loadData() }, [])

  const loadData = async () => {
    const [c, m] = await Promise.all([
      window.api.listCategories(),
      window.api.getMenu(true),
    ])
    if (c.success) setCategories(c.data)
    if (m.success) setItems(m.data)
  }

  const showToastMsg = (msg: string, type = 'success') => {
    setToast({ msg, type }); setTimeout(() => setToast(null), 3000)
  }

  const openAddItem = () => {
    setEditItem(null)
    setForm({ category_id: categories[0]?.category_id, price: 0, cost_price: 0, stock_quantity: 0, is_active: 1 })
    setShowModal(true)
  }

  const openEditItem = (item: MenuItem) => {
    setEditItem(item)
    setForm({ item_id: item.item_id, category_id: item.category_id, name: item.name, price: item.price, cost_price: item.cost_price, description: item.description || '', stock_quantity: item.stock_quantity, is_active: item.is_active })
    setShowModal(true)
  }

  const saveItem = async () => {
    if (!form.name || !form.price) return
    const res = await window.api.upsertMenuItem(form)
    if (res.success) {
      showToastMsg(editItem ? 'Item updated' : 'Item created')
      setShowModal(false)
      loadData()
    } else {
      showToastMsg(res.error || 'Failed', 'error')
    }
  }

  const toggleActive = async (item: MenuItem) => {
    const res = await window.api.setMenuItemActive(item.item_id, !item.is_active)
    if (res.success) loadData()
  }

  const addCategory = async () => {
    if (!catName.trim()) return
    const res = await window.api.upsertCategory({ name: catName.trim(), displayOrder: categories.length })
    if (res.success) {
      setCatName(''); setShowCatModal(false); loadData()
      showToastMsg('Category added')
    }
  }

  return (
    <div className="animate-fade">
      <div className="page-header">
        <div><h1 className="page-title">Menu Management</h1><p className="page-subtitle">{items.length} items across {categories.length} categories</p></div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-secondary" onClick={() => setShowCatModal(true)}>+ Category</button>
          <button className="btn btn-primary" onClick={openAddItem}>+ Add Item</button>
        </div>
      </div>

      <div className="table-container">
        <table>
          <thead><tr><th>Name</th><th>Category</th><th>Price</th><th>Cost</th><th>Stock</th><th>Status</th><th>Actions</th></tr></thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.item_id} style={{ opacity: item.is_active ? 1 : 0.5 }}>
                <td style={{ fontWeight: 600 }}>{item.name}</td>
                <td>{item.category_name}</td>
                <td>{item.price.toFixed(2)}</td>
                <td style={{ color: 'var(--text-muted)' }}>{item.cost_price.toFixed(2)}</td>
                <td>
                  <span className={`badge ${item.stock_quantity <= 0 ? 'badge-danger' : item.stock_quantity <= 5 ? 'badge-warning' : 'badge-success'}`}>
                    {item.stock_quantity}
                  </span>
                </td>
                <td>
                  <span className={`badge ${item.is_active ? 'badge-success' : 'badge-danger'}`}>
                    {item.is_active ? 'Active' : '86\'d'}
                  </span>
                </td>
                <td>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button className="btn btn-ghost btn-sm" onClick={() => openEditItem(item)}>Edit</button>
                    <button className="btn btn-ghost btn-sm" onClick={() => toggleActive(item)}>
                      {item.is_active ? '86' : 'Restore'}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Item Modal */}
      {showModal && (
        <div className="modal-overlay" onClick={() => setShowModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2 className="modal-title">{editItem ? 'Edit Item' : 'Add Item'}</h2>
            <div className="form-group">
              <label className="form-label">Name</label>
              <input className="input" value={form.name || ''} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
            <div className="form-group">
              <label className="form-label">Category</label>
              <select className="input" value={form.category_id} onChange={(e) => setForm({ ...form, category_id: Number(e.target.value) })}>
                {categories.map((c) => <option key={c.category_id} value={c.category_id}>{c.name}</option>)}
              </select>
            </div>
            <div className="grid-2">
              <div className="form-group">
                <label className="form-label">Price</label>
                <input className="input" type="number" step="0.01" value={form.price || ''} onChange={(e) => setForm({ ...form, price: Number(e.target.value) })} />
              </div>
              <div className="form-group">
                <label className="form-label">Cost Price</label>
                <input className="input" type="number" step="0.01" value={form.cost_price || ''} onChange={(e) => setForm({ ...form, cost_price: Number(e.target.value) })} />
              </div>
            </div>
            <div className="form-group">
              <label className="form-label">Stock Quantity</label>
              <input className="input" type="number" value={form.stock_quantity || ''} onChange={(e) => setForm({ ...form, stock_quantity: Number(e.target.value) })} />
            </div>
            <div className="form-group">
              <label className="form-label">Description</label>
              <input className="input" value={form.description || ''} onChange={(e) => setForm({ ...form, description: e.target.value })} />
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 20 }}>
              <button className="btn btn-secondary" onClick={() => setShowModal(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={saveItem}>Save</button>
            </div>
          </div>
        </div>
      )}

      {/* Category Modal */}
      {showCatModal && (
        <div className="modal-overlay" onClick={() => setShowCatModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 380 }}>
            <h2 className="modal-title">Add Category</h2>
            <div className="form-group">
              <label className="form-label">Category Name</label>
              <input className="input" value={catName} onChange={(e) => setCatName(e.target.value)} placeholder="e.g. Buckets, Sides, Drinks" autoFocus />
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn btn-secondary" onClick={() => setShowCatModal(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={addCategory}>Add</button>
            </div>
          </div>
        </div>
      )}

      {toast && <div className={`toast toast-${toast.type}`}>{toast.msg}</div>}
    </div>
  )
}
