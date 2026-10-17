import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { useCartStore, useAuthStore, useSettingsStore, type OrderType } from '../../state/stores'
import type {
  MenuItem, Category, DeliveryArea, DeliveryDriver, Customer, VariantOption,
} from '../../../shared/types'
import logoUrl from '../../assets/logo.png'
import NumberInput from '../../components/NumberInput'
// On a node till this follows the MASTER's clock, so the time on the two screens —
// and the day a sale is counted in — is the same on both machines.
import { now } from '../../lib/clock'

/** What each order type is called on an invoice, in the words the counter uses. */
const ORDER_TYPE_AR = {
  dine_in: 'صالة',
  takeaway: 'تيك أواي',
  delivery: 'دليفري',
} as const

export default function POSScreen() {
  const [categories, setCategories] = useState<Category[]>([])
  const [items, setItems] = useState<MenuItem[]>([])
  const [deliveryAreas, setDeliveryAreas] = useState<DeliveryArea[]>([])
  const [drivers, setDrivers] = useState<DeliveryDriver[]>([])
  const [activeCategory, setActiveCategory] = useState<number | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  // Read from the shared store, not a local copy — the main process pushes every
  // settings save into it, so a VAT/currency/discount change applies here instantly.
  const settings = useSettingsStore((s) => s.settings)
  const [toast, setToast] = useState<{ msg: string; type: string } | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [lastCompletedOrder, setLastCompletedOrder] = useState<any | null>(null)
  const [showReceiptModal, setShowReceiptModal] = useState(false)
  const [currentTime, setCurrentTime] = useState(now().toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' }))
  const [isDeliveryInfoOpen, setIsDeliveryInfoOpen] = useState(true)
  const [selectedItemForVariant, setSelectedItemForVariant] = useState<MenuItem | null>(null)
  /** The option picked so far in each of that item's groups, keyed by group id. */
  const [variantChoice, setVariantChoice] = useState<Record<number, number>>({})
  // A returning delivery customer matched on the phone being typed.
  const [knownCustomer, setKnownCustomer] = useState<Customer | null>(null)
  // Whether any thermal printer is configured at all. Until the owner adds one the
  // receipt is a screen-only document, and the button has to fall back to the
  // browser print dialog rather than silently doing nothing.
  const [hasPrinters, setHasPrinters] = useState(false)
  const [printing, setPrinting] = useState(false)

  const cart = useCartStore()
  const user = useAuthStore((s: any) => s.user)

  // Live clock
  useEffect(() => {
    const timer = setInterval(() => {
      setCurrentTime(now().toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' }))
    }, 1000)
    return () => clearInterval(timer)
  }, [])

  const loadData = useCallback(async () => {
    const [catRes, menuRes, areasRes, driversRes] = await Promise.all([
      window.api.listCategories(),
      window.api.getMenu(),
      window.api.listDeliveryAreas(),
      window.api.listDeliveryDrivers()
    ])
    if (catRes.success) setCategories(catRes.data)
    if (menuRes.success) setItems(menuRes.data)
    if (areasRes.success) setDeliveryAreas(areasRes.data)
    if (driversRes.success) setDrivers(driversRes.data)
  }, [])

  useEffect(() => { loadData() }, [loadData])

  /**
   * Arranging the grid, on the screen it is actually used on.
   *
   * The owner taps ✏️, drags the tiles into the order the shop works in, and taps ✓.
   * Pointer events rather than HTML5 drag-and-drop: the latter does not fire on a
   * touchscreen, which is the only input a till has.
   *
   * While arranging, a tile does not ring anything up — the same tap that would add a
   * burger is the one that picks it up to move it.
   */
  const [arranging, setArranging] = useState(false)
  const [order, setOrder] = useState<number[] | null>(null)
  const [dragId, setDragId] = useState<number | null>(null)
  const [savingOrder, setSavingOrder] = useState(false)
  const canArrange = user?.role === 'owner'

  // Leaving arrange mode, whichever way, always drops the working copy.
  const stopArranging = () => { setArranging(false); setOrder(null); setDragId(null) }

  /**
   * Enter arrange mode, picking a section if the grid is showing all of them.
   *
   * A position on «جميع الأصناف» spans categories and means nothing to save, so this
   * used to be a disabled button — which from the counter is indistinguishable from a
   * broken one: you press ✏️ and nothing happens, with no reason given. Selecting the
   * first section instead does what the press obviously meant.
   *
   * A search is cleared for the same reason: arranging a filtered grid would save an
   * order derived from three of a section's twenty items.
   */
  const startArranging = () => {
    let list = filteredItems
    if (activeCategory === null || searchQuery.trim() !== '') {
      const first = activeCategory ?? categories[0]?.category_id ?? null
      if (first === null) return
      setActiveCategory(first)
      setSearchQuery('')
      list = items.filter(i => i.category_id === first)
    }
    if (list.length < 2) return
    setOrder(list.map(i => i.item_id))
    setArranging(true)
  }

  const saveArrangement = async () => {
    // `null` is the "all items" view — a position there spans categories and means
    // nothing to save. The button is disabled for it; this is the belt and braces.
    if (!order || activeCategory === null) { stopArranging(); return }
    setSavingOrder(true)
    const res = await window.api.reorderMenuItems(activeCategory, order)
    setSavingOrder(false)
    if (res.success) {
      showToast('تم حفظ ترتيب الشاشة')
      stopArranging()
      loadData()
    } else {
      showToast(res.error || 'تعذر حفظ الترتيب', 'error')
    }
  }

  /** Picking a tile up. */
  const grabTile = (itemId: number, e: React.PointerEvent) => {
    if (!arranging) return
    // Keep receiving moves even when the pointer leaves the tile it started on —
    // without this the drag dies the instant you cross into the next tile, and on a
    // touchscreen it never starts at all.
    ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
    setDragId(itemId)
  }

  const releaseTile = (e: React.PointerEvent) => {
    ;(e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId)
    setDragId(null)
  }

  /**
   * Dragging over another tile swaps them as you go, so the grid rearranges under the
   * finger rather than only on release — which is the part that makes it feel like
   * moving something rather than filling in a form.
   *
   * The tile underneath is found by HIT-TESTING the pointer's position, not by letting
   * the other tiles report that the pointer entered them. They cannot: capturing the
   * pointer above redirects every move, enter and leave event to the tile being held,
   * so the neighbours are never told anything and nothing ever moved. Capture is not
   * optional — dropping it to get those events back breaks the drag the other way, and
   * touch captures implicitly whether we ask for it or not.
   */
  const dragMove = (e: React.PointerEvent) => {
    if (!arranging || dragId === null || !order) return
    // A pointer that is no longer pressed is a button released off-grid.
    if (e.pointerType === 'mouse' && e.buttons === 0) { setDragId(null); return }

    const under = document.elementFromPoint(e.clientX, e.clientY)
    const tile = under?.closest('[data-arrange-id]') as HTMLElement | null
    if (!tile) return

    const overId = Number(tile.dataset.arrangeId)
    if (!Number.isFinite(overId) || overId === dragId) return

    const from = order.indexOf(dragId)
    const to = order.indexOf(overId)
    if (from < 0 || to < 0) return

    const next = [...order]
    next.splice(to, 0, ...next.splice(from, 1))
    setOrder(next)
  }

  // Stock moves for reasons other than this till: a delivery arriving, waste being
  // recorded, an invoice deleted, prep run in the kitchen. The main process announces
  // every one of them, so the portions shown on the cards follow along instead of
  // going stale until the next sale.
  useEffect(() => {
    if (!window.api?.onStockChanged) return
    return window.api.onStockChanged(() => { loadData() })
  }, [loadData])

  useEffect(() => {
    window.api.listPrinters().then(res => {
      if (res.success) setHasPrinters(res.data.some((p: any) => p.is_active))
    })
  }, [])

  // Automatic printing runs in the background after the sale is recorded, so a
  // printer that is out of paper or switched off cannot report itself through the
  // checkout call — it arrives here instead. The sale is fine; the paper is not, and
  // the cashier is the only one who can do anything about it.
  useEffect(() => {
    if (!window.api?.onPrintResult) return
    return window.api.onPrintResult(({ results }: any) => {
      const failed = (results || []).filter((r: any) => !r.ok)
      if (failed.length === 0) return
      const names = failed.map((r: any) => r.printerName).join('، ')
      showToast(`⚠️ تعذرت الطباعة على: ${names} — الطلب مسجّل، راجع الطابعة`, 'warning')
    })
  }, [])

  // Look the phone up once it is long enough to be a real number. Debounced, and it
  // only OFFERS the match — see the banner; filling the form is the cashier's choice.
  useEffect(() => {
    const phone = cart.customerPhone.trim()
    if (cart.orderType !== 'delivery' || phone.length < 8) {
      setKnownCustomer(null)
      return
    }
    let live = true
    const t = setTimeout(async () => {
      const res = await window.api.getCustomerByPhone(phone)
      if (live) setKnownCustomer(res.success ? res.data : null)
    }, 350)
    return () => { live = false; clearTimeout(t) }
  }, [cart.customerPhone, cart.orderType])

  /**
   * Suggestions while the number is still being typed.
   *
   * The exact-match banner above only fires on a complete number, which is no help
   * at all with a phone pressed to your ear: three or four digits in, the customer
   * you want is usually already the only one on the list. Picking one fills the whole
   * form from their last order — name, address and area, which sets the fee.
   */
  const [suggestions, setSuggestions] = useState<Customer[]>([])
  const [suggestOpen, setSuggestOpen] = useState(false)

  useEffect(() => {
    const term = cart.customerPhone.trim()
    if (cart.orderType !== 'delivery' || term.length < 3) {
      setSuggestions([])
      return
    }
    let live = true
    const t = setTimeout(async () => {
      const res = await window.api.listCustomers({ search: term, limit: 6 })
      if (!live) return
      // An exact hit is already announced by the banner; showing the same customer
      // twice, once as a list and once as a banner, just adds a decision.
      const rows: Customer[] = res.success ? res.data : []
      setSuggestions(rows.filter(r => r.phone !== term))
    }, 250)
    return () => { live = false; clearTimeout(t) }
  }, [cart.customerPhone, cart.orderType])

  /** Put a customer's saved details into the form. */
  const fillFrom = (c: Customer) => {
    if (c.phone) cart.setCustomerPhone(c.phone)
    if (c.name) cart.setCustomerName(c.name)
    if (c.address) cart.setCustomerAddress(c.address)
    if (c.delivery_area_id) {
      cart.setDeliveryAreaId(c.delivery_area_id)
      const area = deliveryAreas.find(a => a.delivery_area_id === c.delivery_area_id)
      // The fee comes from the area, and the main process prices it again anyway —
      // this is only so the total on screen is right before the order is sent.
      if (area) cart.setDeliveryFee(area.delivery_fee)
    }
    setSuggestOpen(false)
    showToast(`تم تحميل بيانات ${c.name || 'العميل'}`)
  }

  const applyKnownCustomer = () => {
    if (knownCustomer) fillFrom(knownCustomer)
  }

  // Filtered menu items
  const filteredItems = useMemo(() => {
    const visible = items.filter((item) => {
      const matchCat = activeCategory === null || item.category_id === activeCategory
      const matchSearch = searchQuery.trim() === '' ||
        item.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        (item.description && item.description.toLowerCase().includes(searchQuery.toLowerCase()))
      return matchCat && matchSearch
    })

    // While arranging, the grid follows the working copy so tiles move under the
    // finger. `order` is dropped the moment arrange mode ends, and everything goes
    // back to the saved order the server sends.
    if (!arranging || !order) return visible
    const byId = new Map(visible.map(i => [i.item_id, i]))
    return order.map(id => byId.get(id)).filter(Boolean) as typeof visible
  }, [items, activeCategory, searchQuery, arranging, order])

  // Zero is a REAL rate, not a missing one. `settings.tax_rate || 0.14` treated it as
  // missing — so a shop that set VAT to 0 had the till go on charging 14% on screen
  // while the receipt, computed in the main process, correctly charged none. The
  // customer was quoted one total and handed another, and nothing the owner typed in
  // settings made any difference. Fall back only when the value is genuinely not a
  // number.
  const taxRate = Number.isFinite(settings.tax_rate) ? settings.tax_rate : 0.14
  const currency = settings.currency_symbol || 'ج.م'
  // The cap the owner configured. Cashiers cannot exceed it; the main process
  // enforces the same limit, so this only keeps the UI honest.
  const maxDiscount = Number.isFinite(settings.max_cashier_discount)
    ? settings.max_cashier_discount
    : 10
  const discountLimit = user?.role === 'cashier' ? maxDiscount : 100

  const subtotal = cart.getSubtotal()
  const tax = cart.getTax(taxRate)
  const discountAmount = cart.getDiscount()
  const total = cart.getTotal(taxRate)
  const changeDue = cart.getChange(taxRate)

  // Offer only the preset percentages the current user is actually allowed to apply.
  // 30% is the owner's alone — a cashier never sees it, whatever their cap.
  const discountOptions = [0, 5, 10, 15, 20, ...(user?.role === 'owner' ? [30] : [])]
    .filter((p) => p <= discountLimit)

  const showToast = (msg: string, type = 'success') => {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3000)
  }

  const handleDiscountPercent = (pct: number) => {
    const clamped = Math.max(0, Math.min(pct, discountLimit))
    if (clamped !== pct) {
      showToast(`أقصى خصم مسموح به ${discountLimit}%`, 'warning')
    }
    cart.setDiscountPercent(clamped)
  }

  const handleQuickCash = (amount: number | 'exact') => {
    if (amount === 'exact') {
      cart.setTenderedAmount(total)
    } else {
      cart.setTenderedAmount(amount)
    }
  }

  const handleCheckout = async () => {
    if (cart.items.length === 0) return

    // Delivery validation
    if (cart.orderType === 'delivery') {
      if (!cart.customerName.trim() || !cart.customerPhone.trim() || !cart.customerAddress.trim()) {
        showToast('يرجى إكمال بيانات العميل لطلب التوصيل', 'error')
        return
      }
      if (!cart.deliveryAreaId) {
        showToast('يرجى اختيار منطقة التوصيل', 'error')
        return
      }
    }

    setConfirming(true)
    try {
      // Only WHAT was ordered goes over the wire. Prices, tax, the delivery fee and
      // the final total are computed in the main process from the database.
      const res = await window.api.createOrder({
        items: cart.items,
        paymentType: cart.paymentType,
        discountPercent: cart.discountPercent,
        orderType: cart.orderType,
        customerName: cart.customerName || undefined,
        customerPhone: cart.customerPhone || undefined,
        customerAddress: cart.customerAddress || undefined,
        deliveryAreaId: cart.deliveryAreaId || undefined,
        driverId: cart.driverId || undefined,
        // Display only — it is what the customer handed over, which nothing but this
        // screen knows, and it decides nothing about the totals. The main process
        // uses it for the "change due" line when it prints the receipt.
        tenderedAmount: cart.tenderedAmount || undefined,
        notes: cart.orderNote || undefined,
      })

      if (res.success) {
        const t = res.data // authoritative totals from the main process
        const tendered = cart.tenderedAmount
        const orderSummary = {
          orderId: t.orderId,
          invoiceNumber: t.invoiceNumber,
          items: [...cart.items],
          // The receipt prints what was actually recorded, never the local preview.
          subtotal: t.subtotal,
          tax: t.tax,
          discount: t.discount,
          discountPercent: t.discountPercent,
          deliveryFee: t.deliveryFee,
          totalAmount: t.totalAmount,
          paymentType: cart.paymentType,
          orderType: cart.orderType,
          customerName: cart.customerName,
          customerPhone: cart.customerPhone,
          customerAddress: cart.customerAddress,
          tenderedAmount: tendered,
          changeDue: tendered > 0 ? Math.max(0, tendered - t.totalAmount) : 0,
          createdAt: now().toLocaleString('ar-EG'),
          cashierName: user?.fullName || 'الكاشير',
        }
        setLastCompletedOrder(orderSummary)
        setShowReceiptModal(true)

        // Raw materials that hit zero are reported, never blocked — the sale is already
        // recorded. The warning is the cue to correct the count, not to redo the order.
        if (t.stockWarnings?.length) {
          showToast(`⚠️ نفدت مواد خام: ${t.stockWarnings.join(' · ')} — يرجى مراجعة المخزون`, 'warning')
        } else if (t.discountCapped) {
          showToast(`تم تطبيق الحد الأقصى للخصم (${t.discountPercent}%)`, 'warning')
        } else {
          showToast(`تم إتمام الفاتورة رقم ${t.invoiceNumber} بنجاح!`, 'success')
        }
        cart.clear()
        loadData() // refresh stock
      } else {
        showToast(res.error || 'تعذر إتمام الطلب', 'error')
      }
    } catch (err: any) {
      showToast(err.message || 'حدث خطأ أثناء معالجة الطلب', 'error')
    }
    setConfirming(false)
  }

  /**
   * The print button on the receipt. With printers set up it sends the ticket to
   * them; with none it falls back to the browser dialog, which is what this screen
   * did before there was any printer support and is still better than a dead button.
   */
  const handleReprint = async () => {
    if (!lastCompletedOrder) return

    if (!hasPrinters) {
      window.print()
      setShowReceiptModal(false)
      return
    }

    setPrinting(true)
    try {
      const res = await window.api.printOrder(lastCompletedOrder.orderId, {
        tenderedAmount: lastCompletedOrder.tenderedAmount || undefined,
        reprint: true,
      })
      if (!res.success) {
        showToast(res.error || 'تعذر إرسال الفاتورة للطابعة', 'error')
      } else {
        const failed = (res.data || []).filter((r: any) => !r.ok)
        if (failed.length > 0) {
          showToast(`تعذرت الطباعة على: ${failed.map((r: any) => r.printerName).join('، ')}`, 'error')
        } else {
          showToast('تم إرسال الفاتورة إلى الطابعة')
          setShowReceiptModal(false)
        }
      }
    } catch (err: any) {
      showToast(err?.message || 'تعذر إرسال الفاتورة للطابعة', 'error')
    }
    setPrinting(false)
  }

  // ---- The variant chooser ----
  //
  // A group with a single option is answered for the cashier rather than asked: an
  // item that offers only one size is not a question, and making someone tap it every
  // time is exactly the kind of friction that gets a POS abandoned at the counter.
  useEffect(() => {
    if (!selectedItemForVariant) { setVariantChoice({}); return }
    const preset: Record<number, number> = {}
    for (const g of selectedItemForVariant.variants ?? []) {
      if (g.options.length === 1) preset[g.variant_group_id] = g.options[0].variant_option_id
    }
    setVariantChoice(preset)
  }, [selectedItemForVariant])

  /** The options chosen so far, in the owner's group order. */
  const chosenVariantOptions = useMemo(() => {
    if (!selectedItemForVariant) return []
    const picked: VariantOption[] = []
    for (const g of selectedItemForVariant.variants ?? []) {
      const optionId = variantChoice[g.variant_group_id]
      const option = g.options.find(o => o.variant_option_id === optionId)
      if (option) picked.push(option)
    }
    return picked
  }, [selectedItemForVariant, variantChoice])

  const allVariantsChosen = !!selectedItemForVariant &&
    chosenVariantOptions.length === (selectedItemForVariant.variants ?? []).length

  /** Live price preview. The main process recomputes this from the same option ids. */
  const variantPrice = useMemo(() => {
    if (!selectedItemForVariant) return 0
    const deltas = chosenVariantOptions.reduce((sum, o) => sum + (Number(o.price_delta) || 0), 0)
    return Math.max(0, selectedItemForVariant.price + deltas)
  }, [selectedItemForVariant, chosenVariantOptions])

  const closeVariantPicker = () => { setSelectedItemForVariant(null); setVariantChoice({}) }

  const confirmVariantPicker = () => {
    if (!selectedItemForVariant || !allVariantsChosen) return
    cart.addItem(selectedItemForVariant, chosenVariantOptions)
    closeVariantPicker()
  }

  const getCategoryIcon = (name: string) => {
    if (name.includes('وجب') || name.includes('دجاج') || name.includes('Meal') || name.includes('Chicken')) return '🍗'
    if (name.includes('برجر') || name.includes('سندوتش') || name.includes('Burger')) return '🍔'
    if (name.includes('مقبل') || name.includes('بطاطس') || name.includes('Fries') || name.includes('Side')) return '🍟'
    if (name.includes('مشروب') || name.includes('عصير') || name.includes('Drink')) return '🥤'
    if (name.includes('حلو') || name.includes('كيك') || name.includes('Dessert')) return '🍰'
    return '🍽️'
  }

  return (
    <div className="pos-container" dir="rtl">
      {/* Right/Center: Fast-Food Touch Menu Area */}
      <div className="pos-main-panel">
        <div className="pos-top-bar">
          <div className="order-type-selector">
            <button
              className={`order-type-btn ${cart.orderType === 'dine_in' ? 'active' : ''}`}
              onClick={() => cart.setOrderType('dine_in')}
            >
              🍽️ صالة (داخلي)
            </button>
            <button
              className={`order-type-btn ${cart.orderType === 'takeaway' ? 'active' : ''}`}
              onClick={() => cart.setOrderType('takeaway')}
            >
              🛍️ سفري (تيك أواي)
            </button>
            <button
              className={`order-type-btn ${cart.orderType === 'delivery' ? 'active' : ''}`}
              onClick={() => {
                cart.setOrderType('delivery')
                setIsDeliveryInfoOpen(true)
              }}
            >
              🛵 توصيل (دليفري)
            </button>
          </div>

          <div className="search-input-wrapper">
            <span className="search-icon-pos">🔍</span>
            <input
              className="search-input"
              type="text"
              placeholder="بحث سريع عن وجبة أو صنف..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>

          {/*
            Arranging the grid, from the grid. Owner only, and only inside a single
            section — "all items" is a view across categories, and dropping a burger
            between two drinks there would mean nothing to save.
          */}
          {canArrange && (
            arranging ? (
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                {/* Said out loud, because a grid that is waiting to be dragged looks
                    exactly like a grid that is broken. */}
                <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--accent)' }}>
                  اضغط على الصنف واسحبه لمكانه
                </span>
                <button className="btn btn-secondary btn-sm" onClick={stopArranging} disabled={savingOrder}>
                  إلغاء
                </button>
                <button className="btn btn-primary btn-sm" onClick={saveArrangement} disabled={savingOrder}>
                  {savingOrder ? '...' : '✓ حفظ الترتيب'}
                </button>
              </div>
            ) : (
              <button
                className="btn btn-ghost btn-sm"
                title="ترتيب الأصناف — اسحب المربعات بالإصبع أو الماوس"
                disabled={items.length < 2}
                onClick={startArranging}
              >
                ✏️ ترتيب
              </button>
            )
          )}

          <div style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 13, fontWeight: 700, color: 'var(--text-muted)' }}>
            <span>🕒 {currentTime}</span>
            <span style={{ color: 'var(--accent)' }}>•</span>
            <span style={{ color: 'var(--text-primary)' }}>👤 {user?.fullName}</span>
          </div>
        </div>

        <div className="pos-categories-bar">
          <button
            className={`cat-pill-btn ${activeCategory === null ? 'active' : ''}`}
            onClick={() => setActiveCategory(null)}
          >
            <span>🌟</span>
            <span>جميع الأصناف ({items.length})</span>
          </button>
          {categories.map((c) => (
            <button
              key={c.category_id}
              className={`cat-pill-btn ${activeCategory === c.category_id ? 'active' : ''}`}
              onClick={() => setActiveCategory(c.category_id)}
            >
              <span>{getCategoryIcon(c.name)}</span>
              <span>{c.name}</span>
            </button>
          ))}
        </div>

        <div className="pos-items-scroll">
          <div className="pos-items-grid">
            {filteredItems.map((item) => {
              // Availability comes from the ingredients on hand, not from a per-meal
              // count — the restaurant stocks chicken and buns, not "meals". A shortage
              // is shown but never blocks the sale: a miscount must not stop service.
              const tracked = !!item.recipe_count
              const portions = item.available_portions ?? 0
              const short = tracked && portions <= 0
              // Sum across variant rows so the badge shows the true count on the card.
              const inCartQty = cart.getItemQuantity(item.item_id)

              return (
                <div
                  key={item.item_id}
                  className={`food-card ${inCartQty > 0 && !arranging ? 'in-cart' : ''}`}
                  // How the tile under the pointer is identified mid-drag. An attribute
                  // rather than a lookup by index: the grid reorders while the finger
                  // is still down, so a position is stale the moment it is read.
                  data-arrange-id={arranging ? item.item_id : undefined}
                  style={arranging ? {
                    cursor: dragId === item.item_id ? 'grabbing' : 'grab',
                    touchAction: 'none',          // or the browser scrolls instead of dragging
                    userSelect: 'none',
                    opacity: dragId === item.item_id ? 0.45 : 1,
                    outline: dragId === item.item_id
                      ? '2px dashed var(--accent)'
                      : '1px dashed var(--border)',
                    transform: dragId === item.item_id ? 'scale(0.97)' : undefined,
                    transition: 'transform 120ms ease, opacity 120ms ease',
                  } : undefined}
                  onPointerDown={(e) => grabTile(item.item_id, e)}
                  onPointerMove={dragMove}
                  onPointerUp={releaseTile}
                  onPointerCancel={releaseTile}
                  // What an item asks is now its own data, not a guess from its
                  // category name. No groups — water, cola — rings up in one tap;
                  // anything with groups opens the chooser.
                  //
                  // While arranging, the same tap picks the tile up instead: a screen
                  // being rearranged must not be ringing things up at the same time.
                  onClick={() => {
                    if (arranging) return
                    if (item.variants && item.variants.length > 0) {
                      setSelectedItemForVariant(item)
                    } else {
                      cart.addItem(item)
                    }
                  }}
                >
                  {arranging && (
                    <div style={{
                      position: 'absolute', top: 6, insetInlineStart: 6, zIndex: 2,
                      fontSize: 11, fontWeight: 900, lineHeight: 1,
                      background: 'var(--accent)', color: '#fff',
                      borderRadius: 999, padding: '4px 7px',
                    }}>
                      ⇕ {(order ?? []).indexOf(item.item_id) + 1}
                    </div>
                  )}
                  {inCartQty > 0 && (
                    <div className="food-card-cart-qty">
                      {inCartQty}
                    </div>
                  )}

                  <div className="food-card-header">
                    <div className="food-card-title">{item.name}</div>
                  </div>

                  {item.description && (
                    <div className="food-card-desc">{item.description}</div>
                  )}

                  <div className="food-card-footer">
                    <div className="food-price">{item.price.toFixed(0)} <span style={{ fontSize: 11, fontWeight: 700 }}>{currency}</span></div>
                    {!tracked ? null : short ? (
                      <span className="food-stock-badge badge badge-danger" title="نقص في المواد الخام — البيع مسموح">
                        ⚠️ المكونات ناقصة
                      </span>
                    ) : portions <= 5 ? (
                      <span className="food-stock-badge badge badge-warning">يكفي {portions}</span>
                    ) : (
                      <span className="food-stock-badge badge badge-success">متوفر ({portions})</span>
                    )}
                  </div>
                </div>
              )
            })}

            {filteredItems.length === 0 && (
              <div className="empty-state" style={{ gridColumn: '1/-1' }}>
                <div className="empty-state-icon">🍗</div>
                {/* A brand-new system has no menu yet. Saying "nothing matches your
                    search" there reads as a fault; say what to do instead. */}
                {items.length === 0 ? (
                  <>
                    <div className="empty-state-text">لا توجد أصناف في القائمة بعد</div>
                    <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 6 }}>
                      {user?.role === 'owner'
                        ? 'ابدأ بإضافة الأقسام والأصناف من شاشة «قائمة الطعام».'
                        : 'اطلب من المدير إضافة الأصناف من شاشة «قائمة الطعام».'}
                    </p>
                  </>
                ) : (
                  <div className="empty-state-text">لا توجد أصناف مطابقة للبحث</div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Left (in RTL): KFC-Style Cart & Checkout Panel */}
      <aside className="pos-cart-panel" style={{ display: 'flex', flexDirection: 'column' }}>
        <div className="cart-header-bar">
          <div className="cart-header-title">
            <span>🛒 سلة الطلب الحالي</span>
            {cart.items.length > 0 && (
              <span className="cart-items-count-badge">
                {cart.items.reduce((s, i) => s + i.quantity, 0)} قطع
              </span>
            )}
          </div>
          {cart.items.length > 0 && (
            <button className="btn btn-ghost btn-sm" style={{ color: 'var(--danger)' }} onClick={() => cart.clear()}>
              مسح الكل 🗑️
            </button>
          )}
        </div>

        {/* Delivery Info Strip — a single slim bar. Click to open the form popup. */}
        {cart.orderType === 'delivery' && (() => {
          const hasInfo = cart.customerName || cart.customerPhone
          const isComplete = cart.customerPhone && cart.customerName && cart.customerAddress && cart.deliveryAreaId
          return (
            <button
              onClick={() => setIsDeliveryInfoOpen(true)}
              style={{
                width: '100%', display: 'flex', alignItems: 'center', gap: 10,
                padding: '8px 14px', border: 'none', borderBottom: '2px solid var(--border)',
                background: isComplete ? 'var(--success-bg)' : 'var(--accent-subtle)',
                cursor: 'pointer', textAlign: 'right', direction: 'rtl',
              }}
            >
              <span style={{ fontSize: 18 }}>🛵</span>
              <div style={{ flex: 1, overflow: 'hidden' }}>
                {hasInfo ? (
                  <>
                    <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {cart.customerName || '—'} · {cart.customerPhone || '—'}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {cart.customerAddress || 'بدون عنوان'}{cart.deliveryAreaId ? ` · ${deliveryAreas.find(a => a.delivery_area_id === cart.deliveryAreaId)?.area_name || ''}` : ''}
                    </div>
                  </>
                ) : (
                  <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--accent)' }}>
                    ⚠️ اضغط هنا لإدخال بيانات التوصيل
                  </div>
                )}
              </div>
              <span style={{ fontSize: 11, color: isComplete ? 'var(--success)' : 'var(--accent)', fontWeight: 700, whiteSpace: 'nowrap' }}>
                {isComplete ? '✓ مكتمل' : 'تعديل ✏️'}
              </span>
            </button>
          )
        })()}


        <div className="cart-items-list">
          {cart.items.length === 0 ? (
            <div className="empty-state" style={{ padding: '60px 20px' }}>
              <div className="empty-state-icon">🍽️</div>
              <div className="empty-state-text">السلة فارغة</div>
              <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>اضغط على أي وجبة لإضافتها للطلب</p>
            </div>
          ) : (
            cart.items.map((item) => (
              // Keyed and mutated by lineId, so عادي and حار of the same meal are
              // genuinely independent rows.
              <div key={item.lineId} className="cart-item-row animate-fade">
                <div className="cart-item-info">
                  <div className="cart-item-name">
                    {item.name}
                    {item.variantLabel && <span style={{ fontSize: 11, color: 'var(--accent)', marginRight: 4 }}>({item.variantLabel})</span>}
                  </div>
                  <div className="cart-item-unit-price">{item.unitPrice.toFixed(0)} {currency} للقطعة</div>
                </div>

                <div className="cart-qty-control">
                  <button className="qty-btn" onClick={() => cart.updateQuantity(item.lineId, item.quantity - 1)}>−</button>
                  <span className="qty-number">{item.quantity}</span>
                  <button className="qty-btn" onClick={() => cart.updateQuantity(item.lineId, item.quantity + 1)}>+</button>
                </div>

                <div className="cart-item-total-price">
                  {(item.unitPrice * item.quantity).toFixed(0)} <span style={{ fontSize: 10 }}>{currency}</span>
                </div>

                <button
                  className="cart-item-delete-btn"
                  title="حذف الصنف"
                  onClick={() => cart.removeItem(item.lineId)}
                >
                  ✕
                </button>
              </div>
            ))
          )}
        </div>

        {cart.items.length > 0 && (
          <>
          {/* Everything in here may scroll away when space is tight. The total and the
              pay button below are a separate block that never shrinks, so the delivery
              form can no longer bury the price. */}
          <div className="cart-calculation-footer">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)' }}>نسبة الخصم:</span>
              <div className="discount-pills-row">
                {discountOptions.map((pct) => (
                  <button
                    key={pct}
                    type="button"
                    className={`discount-pill ${cart.discountPercent === pct ? 'active' : ''}`}
                    onClick={() => handleDiscountPercent(pct)}
                  >
                    {pct === 0 ? 'بدون خصم' : `${pct}%`}
                  </button>
                ))}
              </div>
            </div>

            <div className="cart-row">
              <span>المجموع الفرعي ({cart.items.reduce((s, i) => s + i.quantity, 0)} عناصر)</span>
              <span>{subtotal.toFixed(2)} {currency}</span>
            </div>

            {cart.orderType === 'dine_in' && (
              <div className="cart-row">
                <span>ضريبة القيمة المضافة ({(taxRate * 100).toFixed(0)}%)</span>
                <span>{tax.toFixed(2)} {currency}</span>
              </div>
            )}

            {cart.orderType === 'delivery' && (
              <div className="cart-row" style={{ color: 'var(--accent)' }}>
                <span>رسوم التوصيل</span>
                <span>{cart.deliveryFee.toFixed(2)} {currency}</span>
              </div>
            )}

            {discountAmount > 0 && (
              <div className="cart-row discount">
                <span>قيمة الخصم ({cart.discountPercent}%)</span>
                <span>-{discountAmount.toFixed(2)} {currency}</span>
              </div>
            )}

            <div className="payment-type-grid">
              <button
                type="button"
                className={`payment-type-card ${cart.paymentType === 'cash' ? 'active' : ''}`}
                onClick={() => cart.setPaymentType('cash')}
              >
                <span>💵</span>
                <span>دفع نقدي (كاش)</span>
              </button>
              <button
                type="button"
                className={`payment-type-card ${cart.paymentType === 'card' ? 'active' : ''}`}
                onClick={() => cart.setPaymentType('card')}
              >
                <span>💳</span>
                <span>بطاقة بنكية (فيزا)</span>
              </button>
            </div>

            {cart.paymentType === 'cash' && (
              <div className="cash-tender-box">
                <div className="quick-cash-row">
                  <button type="button" className="quick-cash-btn" onClick={() => handleQuickCash('exact')}>
                    مبلغ مضبوط
                  </button>
                  {[50, 100, 200, 500].map((amt) => (
                    <button key={amt} type="button" className="quick-cash-btn" onClick={() => handleQuickCash(amt)}>
                      {amt} ج
                    </button>
                  ))}
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>المدفوع:</span>
                  <NumberInput
                    style={{ padding: '6px 10px', fontSize: 13, height: 34 }}
                    value={cart.tenderedAmount}
                    onValueChange={(v) => cart.setTenderedAmount(v)}
                    placeholder="أدخل المبلغ المستلم..."
                  />
                </div>

                {cart.tenderedAmount > 0 && (
                  <div className="change-due-banner">
                    <span>الباقي للعميل:</span>
                    <span style={{ fontSize: 16 }}>{changeDue.toFixed(2)} {currency}</span>
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="cart-calc-pinned">
            {/* A note for the kitchen or the counter. Left empty it prints nothing at
                all — no empty heading on the ticket, no paper spent saying nothing. */}
            <input
              className="input"
              style={{ marginBottom: 8, fontSize: 13 }}
              value={cart.orderNote}
              onChange={e => cart.setOrderNote(e.target.value)}
              placeholder="📝 ملاحظة للمطبخ أو الكاونتر (اختياري)"
              maxLength={200}
            />

            <div className="cart-row total">
              <span>الإجمالي النهائي</span>
              <span className="total-amount">{total.toFixed(2)} {currency}</span>
            </div>

            <button
              className="btn-checkout"
              onClick={handleCheckout}
              disabled={confirming}
            >
              {confirming ? (
                <span>⏳ جاري حفظ وطباعة الطلب...</span>
              ) : (
                <>
                  <span>✓ تأكيد ودفع الطلب</span>
                  <span style={{ opacity: 0.8, fontSize: 14 }}>({total.toFixed(2)} {currency})</span>
                </>
              )}
            </button>
          </div>
          </>
        )}
      </aside>

      {showReceiptModal && lastCompletedOrder && (
        <div className="modal-overlay" onClick={() => setShowReceiptModal(false)}>
          <div className="modal" style={{ maxWidth: 420 }} onClick={(e) => e.stopPropagation()}>
            <div className="receipt-paper">
              <div className="receipt-header">
                <img
                  src={logoUrl}
                  alt=""
                  style={{ width: 68, height: 68, objectFit: 'contain', margin: '0 auto 6px', display: 'block' }}
                />
                <h2>{settings.business_name || 'Crispo Fried Chicken'}</h2>
                <p style={{ fontSize: 11, color: '#4b5563' }}>{settings.business_address || 'القاهرة — مصر'}</p>
                <p style={{ fontSize: 11, color: '#4b5563' }}>هاتف: {settings.business_phone || '+20 100 123 4567'}</p>
                <div className="receipt-divider" />
                <p style={{ fontSize: 13, fontWeight: 800 }}>فاتورة ضريبية مبسطة {lastCompletedOrder.invoiceNumber}</p>
                <p style={{ fontSize: 11, color: '#6b7280' }}>التاريخ: {lastCompletedOrder.createdAt}</p>
                {/* The order type decides what the customer is looking at, so it is
                    read at a glance rather than buried in the small print. */}
                <p style={{
                  fontSize: 16, fontWeight: 900, letterSpacing: 0.5,
                  margin: '6px 0 4px', color: '#111827',
                }}>
                  {ORDER_TYPE_AR[lastCompletedOrder.orderType as keyof typeof ORDER_TYPE_AR]}
                </p>
                <p style={{ fontSize: 11, color: '#6b7280' }}>
                  الكاشير: {lastCompletedOrder.cashierName}
                </p>
                {lastCompletedOrder.orderType === 'delivery' && (
                  <div style={{ textAlign: 'right', marginTop: 8, fontSize: 12, backgroundColor: '#f3f4f6', padding: 8, borderRadius: 4 }}>
                    <div style={{ fontWeight: 700 }}>العميل: {lastCompletedOrder.customerName}</div>
                    <div>الهاتف: {lastCompletedOrder.customerPhone}</div>
                    <div>العنوان: {lastCompletedOrder.customerAddress}</div>
                  </div>
                )}
              </div>

              <div className="receipt-divider" />

              <table className="receipt-table">
                <thead>
                  <tr>
                    <th>الصنف</th>
                    <th style={{ textAlign: 'center' }}>الكمية</th>
                    <th style={{ textAlign: 'left' }}>الإجمالي</th>
                  </tr>
                </thead>
                <tbody>
                  {lastCompletedOrder.items.map((it: any, idx: number) => (
                    <tr key={idx}>
                      <td style={{ fontWeight: 700 }}>
                        {it.name}
                        {it.variantLabel && <div style={{ fontSize: 10, color: '#6b7280', marginTop: 2 }}>{it.variantLabel}</div>}
                      </td>
                      <td style={{ textAlign: 'center' }}>x{it.quantity}</td>
                      <td style={{ textAlign: 'left' }}>{(it.unitPrice * it.quantity).toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <div className="receipt-divider" />

              <div className="receipt-totals">
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span>المجموع الفرعي:</span>
                  <span>{lastCompletedOrder.subtotal.toFixed(2)} {currency}</span>
                </div>
                {lastCompletedOrder.orderType === 'dine_in' && (
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span>ضريبة القيمة المضافة:</span>
                    <span>{lastCompletedOrder.tax.toFixed(2)} {currency}</span>
                  </div>
                )}
                {lastCompletedOrder.orderType === 'delivery' && (
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span>رسوم التوصيل:</span>
                    <span>{lastCompletedOrder.deliveryFee.toFixed(2)} {currency}</span>
                  </div>
                )}
                {lastCompletedOrder.discount > 0 && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', color: '#059669' }}>
                    <span>الخصم ({lastCompletedOrder.discountPercent}%):</span>
                    <span>-{lastCompletedOrder.discount.toFixed(2)} {currency}</span>
                  </div>
                )}
                <div className="receipt-total-big" style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span>الإجمالي:</span>
                  <span>{lastCompletedOrder.totalAmount.toFixed(2)} {currency}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginTop: 4 }}>
                  <span>طريقة الدفع:</span>
                  <span>{lastCompletedOrder.paymentType === 'cash' ? 'نقدي (كاش)' : 'بطاقة (فيزا)'}</span>
                </div>
                {lastCompletedOrder.paymentType === 'cash' && lastCompletedOrder.tenderedAmount > 0 && (
                  <>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
                      <span>المستلم:</span>
                      <span>{lastCompletedOrder.tenderedAmount.toFixed(2)} {currency}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, fontWeight: 800, color: '#059669' }}>
                      <span>المتبقي للعميل:</span>
                      <span>{lastCompletedOrder.changeDue.toFixed(2)} {currency}</span>
                    </div>
                  </>
                )}
              </div>

              <div className="receipt-divider" />
              <p style={{ fontSize: 12, fontWeight: 700, margin: '8px 0', textAlign: 'center' }}>
                {settings.receipt_footer || 'شكراً لزيارتكم! بالهناء والشفاء ❤️'}
              </p>
              <p style={{ fontSize: 9, color: '#9ca3b0', letterSpacing: 2, textAlign: 'center' }}>||| | |||| | |||||| || | |||</p>
            </div>

            <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
              <button
                className="btn btn-primary"
                style={{ flex: 1 }}
                disabled={printing}
                onClick={handleReprint}
              >
                {printing
                  ? '⏳ جاري الإرسال للطابعة...'
                  : hasPrinters
                    ? (settings.print_auto ? '🖨️ إعادة طباعة الفاتورة' : '🖨️ طباعة الفاتورة')
                    : '🖨️ طباعة الفاتورة'}
              </button>
              <button
                className="btn btn-secondary"
                onClick={() => setShowReceiptModal(false)}
              >
                إغلاق
              </button>
            </div>
            {hasPrinters && !!settings.print_auto && (
              <p style={{ fontSize: 11, color: '#6b7280', textAlign: 'center', marginTop: 8 }}>
                طُبعت الفاتورة تلقائياً — استخدم الزر فقط إذا احتجت نسخة أخرى
              </p>
            )}
          </div>
        </div>
      )}

      {/* Variant chooser — one question per group, entirely from the item's own data */}
      {selectedItemForVariant && (
        <div className="modal-overlay" onClick={closeVariantPicker} style={{ zIndex: 9999 }}>
          <div
            className="modal"
            style={{ maxWidth: 440, maxHeight: '88vh', overflowY: 'auto' }}
            onClick={e => e.stopPropagation()}
          >
            <h3 style={{ marginBottom: 4, color: 'var(--text-primary)', fontSize: 19, fontWeight: 800, textAlign: 'center' }}>
              {selectedItemForVariant.name}
            </h3>
            <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 13, marginBottom: 18 }}>
              السعر الأساسي {selectedItemForVariant.price.toFixed(2)} {currency}
            </div>

            {(selectedItemForVariant.variants ?? []).map(group => (
              <div key={group.variant_group_id} style={{ marginBottom: 18 }}>
                <div style={{ fontWeight: 800, fontSize: 14, marginBottom: 8 }}>
                  {group.group_name}
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 10 }}>
                  {group.options.map(option => {
                    const chosen = variantChoice[group.variant_group_id] === option.variant_option_id
                    return (
                      <button
                        key={option.variant_option_id}
                        type="button"
                        className={chosen ? 'btn btn-primary' : 'btn btn-secondary'}
                        style={{
                          padding: '16px 10px', height: 'auto', fontSize: 16,
                          display: 'flex', flexDirection: 'column', gap: 4,
                        }}
                        onClick={() => setVariantChoice(c => ({
                          ...c, [group.variant_group_id]: option.variant_option_id,
                        }))}
                      >
                        <span style={{ fontWeight: 800 }}>{option.option_name}</span>
                        {/* Only ever shown when it changes the price — a زero delta
                            printed as "+0.00" reads like a charge that is not there. */}
                        {option.price_delta !== 0 && (
                          <span style={{ fontSize: 12, fontWeight: 700, opacity: 0.9 }}>
                            {option.price_delta > 0 ? '+' : '−'}
                            {Math.abs(option.price_delta).toFixed(2)} {currency}
                          </span>
                        )}
                      </button>
                    )
                  })}
                </div>
              </div>
            ))}

            <div style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '12px 14px', marginBottom: 14, borderRadius: 'var(--radius-sm)',
              background: 'var(--bg-card-hover)', fontWeight: 800, fontSize: 17,
            }}>
              <span>الإجمالي للقطعة</span>
              <span style={{ color: 'var(--accent)' }}>
                {variantPrice.toFixed(2)} {currency}
              </span>
            </div>

            <div style={{ display: 'flex', gap: 10 }}>
              <button
                className="btn btn-primary"
                style={{ flex: 1, fontSize: 17, padding: '14px' }}
                disabled={!allVariantsChosen}
                onClick={confirmVariantPicker}
              >
                {allVariantsChosen ? '✓ إضافة للطلب' : 'اختر من كل مجموعة'}
              </button>
              <button className="btn btn-secondary" onClick={closeVariantPicker}>
                إلغاء
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div className={`toast toast-${toast.type} animate-slide`}>
          <span>{toast.type === 'success' ? '✓' : '⚠️'}</span>
          <span>{toast.msg}</span>
        </div>
      )}

      {/* ── Delivery Info Modal ── portal to escape pos-container grid clipping ── */}
      {cart.orderType === 'delivery' && isDeliveryInfoOpen && createPortal(
        <div className="modal-overlay" onClick={() => setIsDeliveryInfoOpen(false)} style={{ zIndex: 9000 }}>
          <div
            className="modal"
            onClick={e => e.stopPropagation()}
            style={{ maxWidth: 480, width: '95%' }}
            dir="rtl"
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
              <h2 className="modal-title" style={{ margin: 0 }}>🛵 بيانات التوصيل</h2>
              <button className="btn btn-secondary btn-sm" onClick={() => setIsDeliveryInfoOpen(false)}>✕ إغلاق</button>
            </div>

            {/* Known customer auto-fill banner */}
            {knownCustomer && (
              <div style={{
                background: 'var(--success-bg)', border: '1px solid rgba(21,128,61,0.28)',
                borderRadius: 'var(--radius-md)', padding: '10px 14px', fontSize: 13,
                display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16,
              }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 800 }}>⭐ عميل سابق: {knownCustomer.name || '—'}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>
                    {knownCustomer.order_count} طلب سابق{knownCustomer.address ? ` · ${knownCustomer.address}` : ''}
                  </div>
                </div>
                <button
                  className="btn btn-sm"
                  style={{ background: 'var(--success)', color: '#fff', border: 'none', whiteSpace: 'nowrap' }}
                  onClick={applyKnownCustomer}
                >
                  استخدام بياناته ✓
                </button>
              </div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {/* Phone + Name */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div style={{ position: 'relative' }}>
                  <label style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>📱 رقم الموبايل *</label>
                  <input
                    type="text"
                    className="input"
                    value={cart.customerPhone}
                    onChange={e => { cart.setCustomerPhone(e.target.value); setSuggestOpen(true) }}
                    onFocus={() => setSuggestOpen(true)}
                    // A click on a suggestion blurs the field first, so the list has to
                    // outlive the blur by a moment or the click never lands.
                    onBlur={() => setTimeout(() => setSuggestOpen(false), 150)}
                    placeholder="01xxxxxxxxx"
                    autoFocus
                    autoComplete="off"
                  />

                  {suggestOpen && suggestions.length > 0 && (
                    <div style={{
                      position: 'absolute', top: '100%', right: 0, left: 0, zIndex: 50,
                      marginTop: 4, background: 'var(--bg-card)',
                      border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
                      boxShadow: 'var(--shadow-lg, 0 8px 24px rgba(0,0,0,0.18))',
                      maxHeight: 240, overflowY: 'auto',
                    }}>
                      {suggestions.map(c => (
                        <button
                          key={c.phone}
                          type="button"
                          // onMouseDown, not onClick: mousedown fires before the input's
                          // blur, so the choice registers even as the field loses focus.
                          onMouseDown={e => { e.preventDefault(); fillFrom(c) }}
                          style={{
                            display: 'block', width: '100%', textAlign: 'right',
                            padding: '9px 12px', background: 'none', border: 'none',
                            borderBottom: '1px solid var(--border)', cursor: 'pointer',
                            color: 'inherit', font: 'inherit',
                          }}
                        >
                          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                            <span style={{ fontWeight: 800 }}>{c.name || 'بدون اسم'}</span>
                            <span dir="ltr" style={{ fontFamily: 'monospace', color: 'var(--accent)', fontWeight: 700 }}>
                              {c.phone}
                            </span>
                          </div>
                          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                            {c.address || 'بدون عنوان'}
                            {c.area_name ? ` · ${c.area_name}` : ''} · {c.order_count} طلب سابق
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <div>
                  <label style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>👤 اسم العميل *</label>
                  <input
                    type="text"
                    className="input"
                    value={cart.customerName}
                    onChange={e => cart.setCustomerName(e.target.value)}
                    placeholder="الاسم الكامل"
                  />
                </div>
              </div>

              {/* Address */}
              <div>
                <label style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>📍 العنوان بالتفصيل *</label>
                <input
                  type="text"
                  className="input"
                  value={cart.customerAddress}
                  onChange={e => cart.setCustomerAddress(e.target.value)}
                  placeholder="الشارع، رقم المبنى، الدور..."
                />
              </div>

              {/* Area + Driver */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div>
                  <label style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>🗺️ منطقة التوصيل *</label>
                  <select
                    className="input"
                    value={cart.deliveryAreaId || ''}
                    onChange={e => {
                      const id = Number(e.target.value)
                      cart.setDeliveryAreaId(id)
                      const area = deliveryAreas.find(a => a.delivery_area_id === id)
                      if (area) cart.setDeliveryFee(area.delivery_fee)
                    }}
                  >
                    <option value="" disabled>اختر المنطقة...</option>
                    {deliveryAreas.map(a => (
                      <option key={a.delivery_area_id} value={a.delivery_area_id}>
                        {a.area_name} — {a.delivery_fee} {currency}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>🛵 السائق (اختياري)</label>
                  <select
                    className="input"
                    value={cart.driverId || ''}
                    onChange={e => cart.setDriverId(Number(e.target.value))}
                  >
                    <option value="">بدون سائق محدد</option>
                    {drivers.map(d => (
                      <option key={d.driver_id} value={d.driver_id}>{d.full_name}</option>
                    ))}
                  </select>
                </div>
              </div>
            </div>

            {/* Actions */}
            <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
              <button
                className="btn btn-primary"
                style={{ flex: 1, background: 'var(--success)', border: 'none', fontSize: 15, fontWeight: 800 }}
                onClick={() => {
                  if (!cart.customerPhone || !cart.customerName || !cart.customerAddress || !cart.deliveryAreaId) {
                    showToast('يرجى إكمال الحقول المطلوبة (*)', 'warning')
                  } else {
                    setIsDeliveryInfoOpen(false)
                    showToast('تم حفظ بيانات التوصيل ✓')
                  }
                }}
              >
                ✓ حفظ وإغلاق
              </button>
              <button className="btn btn-secondary" onClick={() => setIsDeliveryInfoOpen(false)}>
                إلغاء
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}
