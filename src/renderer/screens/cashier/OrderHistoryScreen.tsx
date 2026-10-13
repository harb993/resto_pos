import React, { useState, useEffect } from 'react'
import type { DeliveryStatus, Order, ReturnedStockLine } from '../../../shared/types'
import { useAuthStore } from '../../state/stores'
import { WorkShiftSelect, useWorkShifts, chosenShift, type ShiftChoice } from '../../components/WorkShift'

const DELIVERY_STATUS_LABELS: Record<DeliveryStatus, string> = {
  preparing: '👨‍🍳 قيد التحضير',
  pending: '⏳ جاهز — بانتظار سائق',
  out: '🛵 مع السائق',
  delivered: '✅ تم التسليم',
  returned: '↩️ لم يُسلَّم',
}

export default function OrderHistoryScreen() {
  const [orders, setOrders] = useState<Order[]>([])
  const [loading, setLoading] = useState(true)
  const [statusFilter, setStatusFilter] = useState<'all' | 'completed' | 'voided' | 'deleted'>('all')
  /**
   * Deleted invoices, kept in their own list rather than mixed into `orders`.
   *
   * They are excluded from every normal query on purpose — that is what deleting one
   * does — so they have to be fetched separately, and keeping them apart means no
   * count or total on this screen can accidentally start including them.
   */
  const [deletedOrders, setDeletedOrders] = useState<Order[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  // Which shift's invoices to show. Numbers restart every shift, so «0007» only means
  // one invoice once the shift is known.
  const workShifts = useWorkShifts()
  const [shiftChoice, setShiftChoice] = useState<ShiftChoice>('current')
  const shiftScope = chosenShift(shiftChoice, workShifts)
  const [selectedOrder, setSelectedOrder] = useState<any | null>(null)
  const [showVoidModal, setShowVoidModal] = useState(false)
  const [showDeleteModal, setShowDeleteModal] = useState(false)
  const [voidReason, setVoidReason] = useState('')
  const [ownerPassword, setOwnerPassword] = useState('')
  const [toast, setToast] = useState<{ msg: string; type: string } | null>(null)
  const [reprintingId, setReprintingId] = useState<number | null>(null)

  const user = useAuthStore((s: any) => s.user)
  const isOwner = user?.role === 'owner'
  const canSeeDeleted = user?.role === 'owner' || user?.role === 'accountant'

  useEffect(() => {
    loadOrders()
  }, [])

  // An order rung up on the OTHER till must appear here without anyone navigating
  // away and back — that is the whole point of linking the two machines.
  useEffect(() => {
    if (!window.api?.onOrdersChanged) return
    return window.api.onOrdersChanged(() => { loadOrders() })
  }, [])

  const loadOrders = async () => {
    setLoading(true)
    const res = await window.api.listOrders()
    if (res.success) setOrders(res.data)

    // A cashier is refused this list in the main process, which is correct — only the
    // owner can delete an invoice. Their tab simply stays empty rather than erroring.
    const del = await window.api.listDeletedOrders()
    setDeletedOrders(del.success ? del.data : [])
    setLoading(false)
  }

  const showToast = (msg: string, type = 'success') => {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3000)
  }

  const filteredOrders = (statusFilter === 'deleted' ? deletedOrders : orders).filter((o) => {
    const matchStatus = statusFilter === 'all' || statusFilter === 'deleted' || o.status === statusFilter
    const matchSearch = searchQuery === '' ||
      o.order_id.toString().includes(searchQuery) ||
      (o.invoice_number && o.invoice_number.toLowerCase().includes(searchQuery.toLowerCase())) ||
      (o.cashier_name && o.cashier_name.toLowerCase().includes(searchQuery.toLowerCase())) ||
      (o.customer_phone && o.customer_phone.includes(searchQuery)) ||
      (o.customer_name && o.customer_name.includes(searchQuery))
    const matchShift = !shiftScope ||
      (String(o.created_at) >= shiftScope.from && String(o.created_at) < shiftScope.to)
    return matchStatus && matchSearch && matchShift
  })

  const viewOrderDetails = async (orderId: number) => {
    const res = await window.api.getOrder(orderId)
    if (res.success) {
      setSelectedOrder(res.data)
    }
  }

  /** Turn the returned-stock lines into something readable in a toast. */
  const describeReturnedStock = (lines?: ReturnedStockLine[]): string => {
    if (!lines || lines.length === 0) return 'لم يكن هناك مخزون مخصوم لإرجاعه'
    const shown = lines.slice(0, 3)
      .map(l => `${l.name} +${l.quantity} ${l.unit}`)
      .join('، ')
    const rest = lines.length > 3 ? ` و${lines.length - 3} مادة أخرى` : ''
    return `رجع للمخزون: ${shown}${rest}`
  }

  const handleVoidOrder = async () => {
    if (!selectedOrder || !voidReason) return
    const res = await window.api.voidOrder(selectedOrder.order_id, voidReason, ownerPassword)
    if (res.success) {
      const label = selectedOrder.invoice_number || `#${selectedOrder.order_id}`
      showToast(`تم إلغاء الفاتورة ${label} — ${describeReturnedStock(res.data?.returnedStock)}`, 'success')
      setShowVoidModal(false)
      setSelectedOrder(null)
      setVoidReason('')
      setOwnerPassword('')
      loadOrders()
    } else {
      showToast(res.error || 'فشل إلغاء الفاتورة', 'error')
    }
  }

  const handleDeleteOrder = async () => {
    if (!selectedOrder) return
    const res = await window.api.deleteOrder(selectedOrder.order_id)
    if (res.success) {
      const label = selectedOrder.invoice_number || `#${selectedOrder.order_id}`
      showToast(`تم حذف الفاتورة ${label} — ${describeReturnedStock(res.data?.returnedStock)}`, 'success')
      setShowDeleteModal(false)
      setSelectedOrder(null)
      loadOrders()
    } else {
      showToast(res.error || 'فشل حذف الفاتورة', 'error')
    }
  }

  /**
   * Send an old invoice to the printers again. It goes to every active printer that
   * has something to print for it — including the kitchen, which is deliberate: a
   * lost kitchen ticket is the usual reason anyone reaches for this.
   */
  const reprintInvoice = async (orderId: number) => {
    setReprintingId(orderId)
    try {
      const res = await window.api.printOrder(orderId, { reprint: true })
      if (!res.success) {
        showToast(res.error || 'تعذر إرسال الفاتورة للطابعة', 'error')
      } else if (res.data.length === 0) {
        showToast('لا توجد طابعات معرّفة — أضفها من الإعدادات', 'warning')
      } else {
        const failed = res.data.filter((r: any) => !r.ok)
        if (failed.length > 0) {
          showToast(`تعذرت الطباعة على: ${failed.map((r: any) => r.printerName).join('، ')}`, 'error')
        } else {
          showToast('تم إرسال الفاتورة إلى الطابعة')
        }
      }
    } catch (err: any) {
      showToast(err?.message || 'تعذر إرسال الفاتورة للطابعة', 'error')
    }
    setReprintingId(null)
  }

  const getOrderTypeLabel = (type: string) => {
    if (type === 'delivery') return '🛵 دليفري'
    if (type === 'takeaway') return '🛍️ تيك أواي'
    return '🍽️ صالة'
  }

  return (
    <div className="animate-fade" dir="rtl">
      {/* Page Header */}
      <div className="page-header">
        <div>
          <h1 className="page-title">سجل الفواتير والطلبات</h1>
          <p className="page-subtitle">إجمالي {orders.length} فاتورة مسجلة في النظام</p>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="btn btn-secondary" onClick={loadOrders}>
            🔄 تحديث القائمة
          </button>
        </div>
      </div>

      {/* Filter Tabs & Search */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, gap: 16 }}>
        <div style={{ display: 'flex', gap: 6, background: 'var(--bg-card)', padding: 4, borderRadius: 'var(--radius-sm)' }}>
          <button
            className={`btn btn-sm ${statusFilter === 'all' ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => setStatusFilter('all')}
          >
            جميع الفواتير ({orders.length})
          </button>
          <button
            className={`btn btn-sm ${statusFilter === 'completed' ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => setStatusFilter('completed')}
          >
            ✓ المكتملة ({orders.filter(o => o.status === 'completed').length})
          </button>
          <button
            className={`btn btn-sm ${statusFilter === 'voided' ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => setStatusFilter('voided')}
          >
            ✕ الملغاة ({orders.filter(o => o.status === 'voided').length})
          </button>
          {/* Hidden from the cashier, whose list comes back empty by design — the
              main process refuses it, and this matches that rule rather than
              offering a tab that could only ever be blank. */}
          {canSeeDeleted && (
            <button
              className={`btn btn-sm ${statusFilter === 'deleted' ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => setStatusFilter('deleted')}
            >
              🗑️ المحذوفة ({deletedOrders.length})
            </button>
          )}
        </div>

        <WorkShiftSelect value={shiftChoice} onChange={setShiftChoice} shifts={workShifts} allowAll allLabel="كل الورديات" />

        <div style={{ width: 320 }}>
          <input
            className="input"
            style={{ padding: '8px 14px', fontSize: 13 }}
            type="text"
            placeholder="بحث برقم الفاتورة، الكاشير، العميل..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
      </div>

      {statusFilter === 'deleted' && (
        <div style={{
          padding: 12, marginBottom: 12, fontSize: 12, lineHeight: 1.9,
          background: 'var(--danger-bg)', borderRadius: 'var(--radius-sm)',
        }}>
          🗑️ <b>الفواتير المحذوفة</b> — محفوظة في قاعدة البيانات للمراجعة، لكنها
          <b> خارج كل التقارير</b>: لا مبيعات، ولا أرباح، ولا حساب سائق. المواد الخام
          التي خُصمت منها رجعت للمخزون لحظة الحذف. اضغط «تفاصيل» لترى من حذفها ومتى
          وكل ما كان بداخلها.
        </div>
      )}

      {/* Orders Table */}
      <div className="table-container">
        <table>
          <thead>
            <tr>
              <th>رقم الفاتورة</th>
              <th>النوع</th>
              <th>الكاشير</th>
              <th>المجموع الفرعي</th>
              <th>الضريبة</th>
              <th>الخصم</th>
              <th>التوصيل</th>
              <th>الإجمالي الصافي</th>
              <th>طريقة الدفع</th>
              <th>الحالة</th>
              <th>التاريخ والوقت</th>
              <th>الإجراءات</th>
            </tr>
          </thead>
          <tbody>
            {filteredOrders.map((o) => (
              <tr key={o.order_id}>
                <td style={{ fontWeight: 800, color: 'var(--accent)' }}>{o.invoice_number || `#${o.order_id}`}</td>
                <td>
                  <span className="badge badge-info">{getOrderTypeLabel(o.order_type)}</span>
                </td>
                <td style={{ fontWeight: 700 }}>{o.cashier_name}</td>
                <td>{o.subtotal.toFixed(2)} ج.م</td>
                <td>{o.order_type === 'dine_in' ? `${o.tax.toFixed(2)} ج.م` : '-'}</td>
                <td style={{ color: o.discount > 0 ? 'var(--success)' : 'inherit' }}>
                  {o.discount > 0 ? `-${o.discount.toFixed(2)} ج.م` : '0'}
                </td>
                <td>{o.delivery_fee > 0 ? `${o.delivery_fee.toFixed(2)} ج.م` : '-'}</td>
                <td style={{ fontWeight: 800, fontSize: 15, color: 'var(--text-primary)' }}>
                  {o.total_amount.toFixed(2)} ج.م
                </td>
                <td>
                  <span className={`badge ${o.payment_type === 'cash' ? 'badge-success' : 'badge-info'}`}>
                    {o.payment_type === 'cash' ? '💵 نقدي' : '💳 فيزا'}
                  </span>
                </td>
                <td>
                  {o.deleted_at ? (
                    <>
                      <span className="badge badge-danger">🗑️ محذوفة</span>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                        {o.deleted_by_name || '—'}
                        <div>{new Date(o.deleted_at.replace(' ', 'T')).toLocaleString('ar-EG')}</div>
                      </div>
                    </>
                  ) : (
                    <span className={`badge ${o.status === 'completed' ? 'badge-success' : 'badge-danger'}`}>
                      {o.status === 'completed' ? 'مكتملة' : 'ملغاة'}
                    </span>
                  )}
                </td>
                <td style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                  {new Date(o.created_at).toLocaleString('ar-EG')}
                </td>
                <td>
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => viewOrderDetails(o.order_id)}
                  >
                    📄 تفاصيل
                  </button>
                </td>
              </tr>
            ))}
            {filteredOrders.length === 0 && !loading && (
              <tr>
                <td colSpan={12} style={{ textAlign: 'center', padding: 48, color: 'var(--text-muted)' }}>
                  <div className="empty-state">
                    <div className="empty-state-icon">📋</div>
                    <div className="empty-state-text">لا توجد فواتير مطابقة</div>
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Order Details & Receipt Modal */}
      {selectedOrder && (
        <div className="modal-overlay" onClick={() => setSelectedOrder(null)}>
          <div className="modal" style={{ maxWidth: 460 }} onClick={(e) => e.stopPropagation()}>
            <h2 className="modal-title">تفاصيل الفاتورة {selectedOrder.invoice_number || `#${selectedOrder.order_id}`}</h2>

            {selectedOrder.deleted_at && (
              <div style={{
                padding: 12, marginBottom: 14, borderRadius: 'var(--radius-sm)',
                background: 'var(--danger-bg)', border: '1px solid rgba(217,45,32,0.28)',
                fontSize: 13, lineHeight: 1.9,
              }}>
                🗑️ <b>فاتورة محذوفة</b> — خارج كل التقارير والحسابات، ومواردها الخام
                رجعت إلى المخزون وقت الحذف.
                <div style={{ marginTop: 6 }}>
                  حذفها: <b>{selectedOrder.deleted_by_name || '—'}</b> ·{' '}
                  {new Date(selectedOrder.deleted_at.replace(' ', 'T')).toLocaleString('ar-EG')}
                </div>
              </div>
            )}

            <div style={{ background: 'var(--bg-card)', padding: 14, borderRadius: 'var(--radius-sm)', marginBottom: 16, fontSize: 13 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                <span style={{ color: 'var(--text-muted)' }}>الكاشير المسؤول:</span>
                <span style={{ fontWeight: 700 }}>{selectedOrder.cashier_name}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                <span style={{ color: 'var(--text-muted)' }}>النوع:</span>
                <span style={{ fontWeight: 700 }}>{getOrderTypeLabel(selectedOrder.order_type)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                <span style={{ color: 'var(--text-muted)' }}>التاريخ:</span>
                <span>{new Date(selectedOrder.created_at).toLocaleString('ar-EG')}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                <span style={{ color: 'var(--text-muted)' }}>طريقة الدفع:</span>
                <span style={{ fontWeight: 700 }}>{selectedOrder.payment_type === 'cash' ? 'نقدي (كاش)' : 'بطاقة (فيزا)'}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: 'var(--text-muted)' }}>حالة الفاتورة:</span>
                <span className={`badge ${selectedOrder.status === 'completed' ? 'badge-success' : 'badge-danger'}`}>
                  {selectedOrder.status === 'completed' ? 'مكتملة' : `ملغاة (${selectedOrder.void_reason || 'بدون سبب'})`}
                </span>
              </div>
            </div>

            {selectedOrder.order_type === 'delivery' && (
              <div style={{ background: 'var(--bg-card-hover)', padding: 10, borderRadius: 'var(--radius-sm)', marginBottom: 16, fontSize: 13, border: '1px solid var(--border)' }}>
                <h4 style={{ margin: '0 0 8px 0', fontSize: 12, color: 'var(--text-secondary)' }}>بيانات التوصيل:</h4>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  <div><strong>العميل:</strong> {selectedOrder.customer_name}</div>
                  <div><strong>الهاتف:</strong> {selectedOrder.customer_phone}</div>
                  <div style={{ gridColumn: '1 / -1' }}><strong>العنوان:</strong> {selectedOrder.customer_address}</div>
                  {selectedOrder.area_name && <div><strong>المنطقة:</strong> {selectedOrder.area_name}</div>}
                  {selectedOrder.driver_name && <div><strong>السائق:</strong> {selectedOrder.driver_name}</div>}
                  {/* Where it got to, and whether its cash has come back in. Both are
                      managed from مركز الدليفري; here they are read-only facts. */}
                  {selectedOrder.delivery_status && (
                    <div>
                      <strong>الحالة:</strong> {DELIVERY_STATUS_LABELS[selectedOrder.delivery_status as DeliveryStatus]}
                    </div>
                  )}
                  {selectedOrder.payment_type === 'cash' && selectedOrder.delivery_status === 'delivered' && (
                    <div>
                      <strong>نقدية السائق:</strong>{' '}
                      {selectedOrder.settlement_id
                        ? <span style={{ color: 'var(--success)' }}>تم استلامها</span>
                        : <span style={{ color: 'var(--danger)' }}>لم تُستلم بعد</span>}
                    </div>
                  )}
                </div>
              </div>
            )}

            <h3 style={{ fontSize: 14, fontWeight: 800, marginBottom: 8 }}>الأصناف المطلوبة:</h3>
            <div style={{ maxHeight: 180, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', marginBottom: 16 }}>
              <table style={{ fontSize: 12 }}>
                <thead>
                  <tr>
                    <th>الصنف</th>
                    <th style={{ textAlign: 'center' }}>الكمية</th>
                    <th style={{ textAlign: 'left' }}>السعر</th>
                  </tr>
                </thead>
                <tbody>
                  {selectedOrder.items?.map((it: any) => (
                    <tr key={it.order_item_id || it.menu_item_id}>
                      <td style={{ fontWeight: 700 }}>
                        {it.name || it.item_name}
                        {it.variant_label && <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{it.variant_label}</div>}
                      </td>
                      <td style={{ textAlign: 'center' }}>x{it.quantity}</td>
                      <td style={{ textAlign: 'left' }}>{(it.unit_price * it.quantity).toFixed(2)} ج.م</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13, borderTop: '1px solid var(--border)', paddingTop: 10, marginBottom: 18 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>المجموع الفرعي:</span>
                <span>{selectedOrder.subtotal.toFixed(2)} ج.م</span>
              </div>
              {selectedOrder.order_type === 'dine_in' && (
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span>الضريبة:</span>
                  <span>{selectedOrder.tax.toFixed(2)} ج.م</span>
                </div>
              )}
              {selectedOrder.delivery_fee > 0 && (
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span>رسوم التوصيل:</span>
                  <span>{selectedOrder.delivery_fee.toFixed(2)} ج.م</span>
                </div>
              )}
              {selectedOrder.discount > 0 && (
                <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--success)' }}>
                  <span>الخصم:</span>
                  <span>-{selectedOrder.discount.toFixed(2)} ج.م</span>
                </div>
              )}
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 16, fontWeight: 900, color: 'var(--accent)', marginTop: 4 }}>
                <span>الإجمالي النهائي:</span>
                <span>{selectedOrder.total_amount.toFixed(2)} ج.م</span>
              </div>
            </div>

            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              {/* A cancelled invoice is deliberately still reprintable: the copy the
                  customer or the accountant is asking for is often precisely the one
                  that was voided, and it prints stamped as a reprint. */}
              <button
                className="btn btn-primary"
                disabled={reprintingId === selectedOrder.order_id}
                onClick={() => reprintInvoice(selectedOrder.order_id)}
              >
                {reprintingId === selectedOrder.order_id ? '⏳ جاري الإرسال...' : '🖨️ إعادة طباعة'}
              </button>
              {/* A deleted invoice is already out of the books — there is nothing left
                  to void or delete, and offering either would only fail in the main
                  process. It stays reprintable, which is usually why it is open. */}
              {selectedOrder.status === 'completed' && !selectedOrder.deleted_at && (
                <button
                  className="btn btn-danger"
                  onClick={() => setShowVoidModal(true)}
                >
                  ✕ إلغاء الفاتورة (Void)
                </button>
              )}
              {isOwner && !selectedOrder.deleted_at && (
                <button
                  className="btn"
                  style={{ backgroundColor: 'var(--danger)', color: 'white' }}
                  onClick={() => setShowDeleteModal(true)}
                >
                  🗑️ حذف الفاتورة
                </button>
              )}
              <button className="btn btn-secondary" onClick={() => setSelectedOrder(null)}>
                إغلاق
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Void Confirmation Modal */}
      {showVoidModal && selectedOrder && (
        <div className="modal-overlay" onClick={() => setShowVoidModal(false)}>
          <div className="modal" style={{ maxWidth: 400 }} onClick={(e) => e.stopPropagation()}>
            <h2 className="modal-title" style={{ color: 'var(--danger)' }}>تأكيد إلغاء الفاتورة {selectedOrder.invoice_number || `#${selectedOrder.order_id}`}</h2>
            <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 14 }}>
              سيتم إرجاع كميات الأصناف إلى المخزون تلقائياً وتسجيل حركة الإلغاء في سجل التدقيق.
            </p>

            <div className="form-group">
              <label className="form-label">سبب الإلغاء (مطلوب)</label>
              <input
                className="input"
                type="text"
                placeholder="مثال: خطأ في الطلب، طلب العميل الإلغاء..."
                value={voidReason}
                onChange={(e) => setVoidReason(e.target.value)}
              />
            </div>

            {!isOwner && (
              <div className="form-group">
                <label className="form-label">كلمة مرور المدير (مطلوبة)</label>
                <input
                  className="input"
                  type="password"
                  placeholder="يعتمد المدير الإلغاء بكلمة مروره"
                  value={ownerPassword}
                  onChange={(e) => setOwnerPassword(e.target.value)}
                  autoComplete="off"
                />
              </div>
            )}

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 20 }}>
              <button className="btn btn-secondary" onClick={() => setShowVoidModal(false)}>
                تراجع
              </button>
              <button
                className="btn btn-danger"
                onClick={handleVoidOrder}
                disabled={!voidReason.trim() || (!isOwner && !ownerPassword)}
              >
                تأكيد الإلغاء
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {showDeleteModal && selectedOrder && isOwner && (
        <div className="modal-overlay" onClick={() => setShowDeleteModal(false)}>
          <div className="modal" style={{ maxWidth: 400 }} onClick={(e) => e.stopPropagation()}>
            <h2 className="modal-title" style={{ color: 'var(--danger)' }}>تأكيد حذف الفاتورة {selectedOrder.invoice_number || `#${selectedOrder.order_id}`}</h2>
            <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 10 }}>
              الحذف سيخفي الفاتورة من كافة التقارير وسجل المبيعات، لكن ستظل موجودة في قاعدة البيانات (Soft Delete).
            </p>
            <div style={{
              background: 'var(--success-bg)', border: '1px solid rgba(21,128,61,0.28)',
              borderRadius: 'var(--radius-sm)', padding: '10px 12px', fontSize: 13, marginBottom: 14,
            }}>
              ✅ <b>سيتم إرجاع كل المواد الخام المخصومة</b> من هذه الفاتورة إلى المخزون تلقائياً،
              وسيظهر لك ما تم إرجاعه بعد الحذف.
            </div>

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 20 }}>
              <button className="btn btn-secondary" onClick={() => setShowDeleteModal(false)}>
                تراجع
              </button>
              <button
                className="btn btn-danger"
                onClick={handleDeleteOrder}
              >
                تأكيد الحذف نهائياً
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && <div className={`toast toast-${toast.type}`}>{toast.msg}</div>}
    </div>
  )
}
