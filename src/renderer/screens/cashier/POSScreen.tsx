import React, { useState, useEffect, useCallback } from 'react'
import { useCartStore, useAuthStore } from '../state/stores'
import type { MenuItem, Category } from '../../shared/types'

export default function POSScreen() {
  const [categories, setCategories] = useState<Category[]>([])
  const [items, setItems] = useState<MenuItem[]>([])
  const [activeCategory, setActiveCategory] = useState<number | null>(null)
  const [settings, setSettings] = useState<any>({})
  const [toast, setToast] = useState<{ msg: string; type: string } | null>(null)
  const [confirming, setConfirming] = useState(false)

  const cart = useCartStore()
  const user = useAuthStore((s) => s.user)

  const loadData = useCallback(async () => {
    const [catRes, menuRes, settRes] = await Promise.all([
      window.api.listCategories(),
      window.api.getMenu(),
      window.api.getSettings(),
    ])
    if (catRes.success) {
      setCategories(catRes.data)
      if (!activeCategory && catRes.data.length > 0) setActiveCategory(catRes.data[0].category_id)
    }
    if (menuRes.success) setItems(menuRes.data)
    if (settRes.success) setSettings(settRes.data)
  }, [])

  useEffect(() => { loadData() }, [loadData])

  const filteredItems = activeCategory
    ? items.filter((i) => i.category_id === activeCategory)
    : items

  const taxRate = settings.tax_rate || 0.14
  const currency = settings.currency_symbol || 'EGP'
  const subtotal = cart.getSubtotal()
  const tax = cart.getTax(taxRate)
  const total = cart.getTotal(taxRate)

  const showToast = (msg: string, type = 'success') => {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3000)
  }

  const handleCheckout = async () => {
    if (cart.items.length === 0) return
    setConfirming(true)
    try {
      const res = await window.api.createOrder({
        items: cart.items,
        paymentType: cart.paymentType,
        subtotal,
        tax,
        discount: cart.discount,
        totalAmount: total,
      })
      if (res.success) {
        showToast(`Order #${res.data.orderId} created!`, 'success')
        cart.clear()
        loadData() // refresh stock
      } else {
        showToast(res.error || 'Order failed', 'error')
      }
    } catch (err: any) {
      showToast(err.message || 'Order failed', 'error')
    }
    setConfirming(false)
  }

  return (
    <div className="pos-layout">
      {/* Left: Menu Grid */}
      <div style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div className="category-tabs">
          {categories.map((c) => (
            <button
              key={c.category_id}
              className={`category-tab ${activeCategory === c.category_id ? 'active' : ''}`}
              onClick={() => setActiveCategory(c.category_id)}
            >
              {c.name}
            </button>
          ))}
        </div>

        <div className="items-grid">
          {filteredItems.map((item) => {
            const soldOut = item.stock_quantity <= 0
            return (
              <div
                key={item.item_id}
                className={`item-card ${soldOut ? 'sold-out' : ''}`}
                onClick={() => { if (!soldOut) cart.addItem(item) }}
              >
                {soldOut && <span className="stock-badge badge badge-danger">Sold Out</span>}
                {!soldOut && item.stock_quantity <= 5 && (
                  <span className="stock-badge badge badge-warning">{item.stock_quantity}</span>
                )}
                <div className="item-name">{item.name}</div>
                <div className="item-price">{currency} {item.price.toFixed(2)}</div>
              </div>
            )
          })}
          {filteredItems.length === 0 && (
            <div className="empty-state" style={{ gridColumn: '1/-1' }}>
              <div className="empty-state-icon">📋</div>
              <div className="empty-state-text">No items in this category</div>
            </div>
          )}
        </div>
      </div>

      {/* Right: Cart */}
      <div className="cart-panel">
        <div className="cart-header">
          <span>🛒 Current Order</span>
          {cart.items.length > 0 && (
            <button className="btn btn-ghost btn-sm" onClick={() => cart.clear()}>Clear</button>
          )}
        </div>

        <div className="cart-items">
          {cart.items.length === 0 ? (
            <div className="empty-state">
              <div className="empty-state-icon">🍽️</div>
              <div className="empty-state-text">Tap items to add to order</div>
            </div>
          ) : (
            cart.items.map((item) => (
              <div key={item.menuItemId} className="cart-item">
                <div className="cart-item-name">{item.name}</div>
                <div className="cart-item-qty">
                  <button className="qty-btn" onClick={() => cart.updateQuantity(item.menuItemId, item.quantity - 1)}>−</button>
                  <span style={{ fontSize: 14, fontWeight: 600, minWidth: 20, textAlign: 'center' }}>{item.quantity}</span>
                  <button className="qty-btn" onClick={() => cart.updateQuantity(item.menuItemId, item.quantity + 1)}>+</button>
                </div>
                <div className="cart-item-total">{currency} {(item.unitPrice * item.quantity).toFixed(2)}</div>
              </div>
            ))
          )}
        </div>

        {cart.items.length > 0 && (
          <div className="cart-footer">
            <div className="cart-summary-row">
              <span>Subtotal</span>
              <span>{currency} {subtotal.toFixed(2)}</span>
            </div>
            <div className="cart-summary-row">
              <span>Tax ({(taxRate * 100).toFixed(0)}%)</span>
              <span>{currency} {tax.toFixed(2)}</span>
            </div>
            {cart.discount > 0 && (
              <div className="cart-summary-row" style={{ color: 'var(--success)' }}>
                <span>Discount</span>
                <span>-{currency} {cart.discount.toFixed(2)}</span>
              </div>
            )}
            <div className="cart-total-row">
              <span>Total</span>
              <span>{currency} {total.toFixed(2)}</span>
            </div>

            <div className="payment-toggle">
              <button className={`payment-btn ${cart.paymentType === 'cash' ? 'active' : ''}`} onClick={() => cart.setPaymentType('cash')}>
                💵 Cash
              </button>
              <button className={`payment-btn ${cart.paymentType === 'card' ? 'active' : ''}`} onClick={() => cart.setPaymentType('card')}>
                💳 Card
              </button>
            </div>

            <button className="btn btn-primary btn-lg" style={{ width: '100%' }} onClick={handleCheckout} disabled={confirming}>
              {confirming ? 'Processing...' : `Checkout — ${currency} ${total.toFixed(2)}`}
            </button>
          </div>
        )}
      </div>

      {/* Toast */}
      {toast && (
        <div className={`toast toast-${toast.type}`}>{toast.msg}</div>
      )}
    </div>
  )
}
