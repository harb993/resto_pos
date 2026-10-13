import React, { useState, useEffect, useCallback, useMemo } from 'react'
import type {
  DeliveryDriver, DeliveryStatus, DeliverySummary, DriverBalance, DriverSettlement, Order,
} from '../../../shared/types'
import { useAuthStore } from '../../state/stores'
import { todayStr, daysAgoStr, timeOf, elapsedSince as elapsed } from '../../lib/clock'

/**
 * The delivery centre — where every order is, and who is holding the money.
 *
 * It answers two questions that people keep asking the till and getting no answer to:
 *
 *   "Where is order 42?"        — waiting, with Ahmed, delivered, or came back.
 *   "Has Ahmed paid in yet?"    — how many orders, how much cash, since when.
 *
 * They are separate on purpose. A delivered order is finished as far as the customer
 * is concerned and still outstanding as far as the books are concerned, and that gap
 * — the hour or the evening while the cash is in someone's pocket — is the whole
 * reason this screen exists.
 *
 * Card orders never become a debt: the customer paid the machine, so there is
 * nothing for the driver to hand over. Only cash does.
 */

type Tab = 'live' | 'preparing' | 'pending' | 'out' | 'delivered' | 'returned' | 'all' | 'deleted'

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'live', label: 'الجاري الآن', icon: '🔴' },
  { id: 'preparing', label: 'قيد التحضير', icon: '👨‍🍳' },
  { id: 'pending', label: 'جاهز — بانتظار سائق', icon: '⏳' },
  { id: 'out', label: 'مع السائق', icon: '🛵' },
  { id: 'delivered', label: 'تم التسليم', icon: '✅' },
  { id: 'returned', label: 'لم يُسلَّم', icon: '↩️' },
  { id: 'all', label: 'الكل', icon: '📋' },
  { id: 'deleted', label: 'المحذوفة', icon: '🗑️' },
]

const STATUS_BADGE: Record<DeliveryStatus, { label: string; cls: string; icon: string }> = {
  preparing: { label: 'قيد التحضير', cls: 'badge-warning', icon: '👨‍🍳' },
  pending: { label: 'جاهز — بانتظار سائق', cls: 'badge-warning', icon: '⏳' },
  out: { label: 'مع السائق', cls: 'badge-info', icon: '🛵' },
  delivered: { label: 'تم التسليم', cls: 'badge-success', icon: '✅' },
  returned: { label: 'لم يُسلَّم', cls: 'badge-danger', icon: '↩️' },
}

/** The states an order can still be moved out of — everything before it arrives. */
const BEFORE_ARRIVAL: (DeliveryStatus | null)[] = ['preparing', 'pending', 'out', null]

const money = (n: number): string => `${(n ?? 0).toFixed(2)} ج.م`

// Dates and elapsed times come from lib/clock, which follows the MASTER's clock on a
// node till. Two shop PCs drift apart by minutes over a few months and nobody ever
// sets them — so "today", and how long an order has been out, have to be reckoned on
// one machine's clock or the two screens quietly disagree about the same evening.
const daysAgo = daysAgoStr

/** A touch target, not a mouse target. These get pressed with a thumb, at speed. */
const TOUCH: React.CSSProperties = {
  padding: '10px 14px', fontSize: 14, fontWeight: 700, minHeight: 42, minWidth: 104,
}

export default function DeliveryCenterScreen() {
  const user = useAuthStore((s: any) => s.user)
  // Taking cash from a driver is the cashier's job. They are the person at the
  // counter at 1am when he walks back in, and the owner is not there. What keeps it
  // honest is the record — every settlement stores who took it and which orders it
  // covered — not a permission that only ever meant the screen went un-updated.
  const canSettle = !!user

  const [dateFrom, setDateFrom] = useState(todayStr())
  const [dateTo, setDateTo] = useState(todayStr())
  const [tab, setTab] = useState<Tab>('live')
  /** What is typed, and what has actually been sent — they differ while typing. */
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')

  const [summary, setSummary] = useState<DeliverySummary | null>(null)
  const [drivers, setDrivers] = useState<DriverBalance[]>([])
  const [orders, setOrders] = useState<Order[]>([])
  const [allDrivers, setAllDrivers] = useState<DeliveryDriver[]>([])
  const [settlements, setSettlements] = useState<DriverSettlement[]>([])
  const [loading, setLoading] = useState(true)
  const [busyOrderId, setBusyOrderId] = useState<number | null>(null)
  const [toast, setToast] = useState<{ msg: string; type: string } | null>(null)

  // The settle-up dialog: which driver, and which of his orders are being counted in.
  const [settling, setSettling] = useState<DriverBalance | null>(null)
  const [settleOrders, setSettleOrders] = useState<Order[]>([])
  const [settleChecked, setSettleChecked] = useState<Set<number>>(new Set())
  const [settleNote, setSettleNote] = useState('')
  const [settleBusy, setSettleBusy] = useState(false)

  /** The order being examined in full — including deleted ones, which is the point. */
  const [details, setDetails] = useState<Order | null>(null)

  const showToast = (msg: string, type = 'success') => {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3500)
  }

  const load = useCallback(async () => {
    const [board, driverList, history] = await Promise.all([
      // `search` reaches the order list only. The counters and the driver balances
      // still describe the shop right now, which is what they are for — a search for
      // one phone number must not make "نقدية مع السائقين" read as that customer's.
      //
      // The deleted tab is the one view the server has to fetch differently: those
      // rows are excluded from every normal query by design, so they cannot be
      // filtered out of the same list on the client.
      window.api.getDeliveryBoard({
        dateFrom, dateTo, search,
        status: tab === 'deleted' ? 'deleted' : 'all',
      }),
      window.api.listDeliveryDrivers(),
      window.api.listDriverSettlements({ limit: 20 }),
    ])
    if (board.success) {
      setSummary(board.data.summary)
      setDrivers(board.data.drivers)
      setOrders(board.data.orders)
    } else {
      showToast(board.error || 'تعذر تحميل بيانات الدليفري', 'error')
    }
    if (driverList.success) setAllDrivers(driverList.data.filter((d: DeliveryDriver) => d.is_active))
    if (history.success) setSettlements(history.data)
    setLoading(false)
  }, [dateFrom, dateTo, search, tab])

  useEffect(() => { load() }, [load])

  // Search as you type, but one query per pause rather than one per keystroke — a
  // phone number is eleven of them and every one would sweep the whole history.
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 300)
    return () => clearTimeout(t)
  }, [searchInput])

  // An order marked delivered on the OTHER till has to show here without anyone
  // pressing refresh — two people working one delivery board is the normal case.
  useEffect(() => {
    if (!window.api?.onOrdersChanged) return
    return window.api.onOrdersChanged(() => { load() })
  }, [load])

  // Orders sit in a state for a length of time that matters ("out for 50 minutes"),
  // and nothing pushes an event when a minute passes. Re-render on the minute so the
  // waiting times on screen are the real ones.
  const [, setTick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setTick(n => n + 1), 60000)
    return () => clearInterval(t)
  }, [])

  const shown = useMemo(() => {
    // A search answers "where are this number's orders?", and the answer must not be
    // silently narrowed by whichever tab happened to be open — most of what you find
    // when looking someone up was delivered weeks ago.
    if (search) return orders
    // 'deleted' arrives already filtered by the server — those rows are not in the
    // normal list at all — so there is nothing left to narrow.
    if (tab === 'all' || tab === 'deleted') return orders
    if (tab === 'live') {
      return orders.filter(o => o.delivery_status === 'preparing'
        || o.delivery_status === 'pending' || o.delivery_status === 'out')
    }
    return orders.filter(o => o.delivery_status === tab)
  }, [orders, tab, search])

  /**
   * Who the search found. Grouped by phone, because that is what identifies a
   * delivery customer here — the name is typed fresh with each order and comes back
   * spelled three different ways.
   */
  const matched = useMemo(() => {
    if (!search) return []
    const byPhone = new Map<string, {
      phone: string; name: string; address: string; area: string
      orders: number; spent: number; last: string
    }>()
    for (const o of orders) {
      const phone = o.customer_phone || '—'
      const found = byPhone.get(phone)
      if (found) {
        found.orders += 1
        found.spent += o.total_amount
        // The list arrives newest-first, so the first row seen is the latest one.
        found.name = found.name || o.customer_name || ''
      } else {
        byPhone.set(phone, {
          phone,
          name: o.customer_name || 'بدون اسم',
          address: o.customer_address || '',
          area: o.area_name || '',
          orders: 1,
          spent: o.total_amount,
          last: o.created_at,
        })
      }
    }
    return [...byPhone.values()].sort((a, b) => b.orders - a.orders)
  }, [orders, search])

  /**
   * Tab counts come from the summary, not from the loaded rows.
   *
   * The two disagree on purpose: the live states are counted across the whole book
   * (a forgotten order from last night is still waiting) and the deleted ones are
   * not in the loaded list at all. Counting what happens to be on screen produced a
   * badge that contradicted the table it was labelling.
   */
  const countFor = (t: Tab): number => {
    if (!summary) return 0
    const live = summary.preparingCount + summary.pendingCount + summary.outCount
    switch (t) {
      case 'live': return live
      case 'preparing': return summary.preparingCount
      case 'pending': return summary.pendingCount
      case 'out': return summary.outCount
      case 'delivered': return summary.deliveredCount
      case 'returned': return summary.returnedCount
      case 'deleted': return summary.deletedCount
      case 'all': return live + summary.deliveredCount + summary.returnedCount
    }
  }

  const assign = async (orderId: number, driverId: number) => {
    if (!driverId) return
    setBusyOrderId(orderId)
    const res = await window.api.assignDeliveryDriver(orderId, driverId)
    setBusyOrderId(null)
    if (res.success) { showToast('تم تسليم الطلب للسائق'); load() }
    else showToast(res.error || 'تعذر تعيين السائق', 'error')
  }

  const setStatus = async (orderId: number, status: DeliveryStatus) => {
    setBusyOrderId(orderId)
    const res = await window.api.setDeliveryStatus(orderId, status)
    setBusyOrderId(null)
    if (res.success) { showToast(`الطلب: ${STATUS_BADGE[status].label}`); load() }
    else showToast(res.error || 'تعذر تحديث الحالة', 'error')
  }

  const openDetails = async (orderId: number) => {
    // order:get looks an invoice up by id with no "not deleted" condition, so a
    // deleted one opens exactly like any other — which is the only way to answer
    // "what was actually on that order?" after it has been removed.
    const res = await window.api.getOrder(orderId)
    if (res.success && res.data) setDetails(res.data)
    else showToast(res.error || 'تعذر قراءة تفاصيل الطلب', 'error')
  }

  const openSettle = async (driver: DriverBalance) => {
    const res = await window.api.listUnsettledDeliveries(driver.driver_id)
    if (!res.success) return showToast(res.error || 'تعذر قراءة المستحقات', 'error')
    if (res.data.length === 0) return showToast(`لا توجد مبالغ مستحقة على ${driver.full_name}`, 'warning')
    setSettling(driver)
    setSettleOrders(res.data)
    // Everything ticked: handing in the whole round is the normal case, and
    // un-ticking is how a partial hand-over gets recorded.
    setSettleChecked(new Set(res.data.map((o: Order) => o.order_id)))
    setSettleNote('')
  }

  const settleTotal = useMemo(
    () => settleOrders.filter(o => settleChecked.has(o.order_id)).reduce((s, o) => s + o.total_amount, 0),
    [settleOrders, settleChecked],
  )

  const confirmSettle = async () => {
    if (!settling || settleChecked.size === 0) return
    setSettleBusy(true)
    const all = settleChecked.size === settleOrders.length
    const res = await window.api.settleDriver(settling.driver_id, {
      // Sending no ids means "everything outstanding", which is also what the server
      // would compute — but a driver who delivered one more order while this dialog
      // was open would then be settled for it too, without it ever being on screen.
      orderIds: all ? settleOrders.map(o => o.order_id) : [...settleChecked],
      note: settleNote,
    })
    setSettleBusy(false)
    if (res.success) {
      showToast(`تم استلام ${money(res.data.total_amount)} من ${settling.full_name} عن ${res.data.order_count} طلب`)
      setSettling(null)
      load()
    } else {
      showToast(res.error || 'تعذر تسجيل الاستلام', 'error')
    }
  }

  const totalOwed = drivers.reduce((s, d) => s + d.cashOwed, 0)

  return (
    <div className="animate-fade" dir="rtl" style={{ paddingBottom: 40 }}>
      <div className="page-header">
        <div>
          <h1 className="page-title">مركز الدليفري</h1>
          <p className="page-subtitle">
            حالة كل طلب توصيل، ومن معه فلوس المطعم ولم يسلّمها بعد
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div>
            <label className="form-label" style={{ fontSize: 11 }}>من</label>
            <input className="input" type="date" value={dateFrom} dir="ltr"
              style={{ padding: '8px 12px' }}
              onChange={e => setDateFrom(e.target.value)} />
          </div>
          <div>
            <label className="form-label" style={{ fontSize: 11 }}>إلى</label>
            <input className="input" type="date" value={dateTo} dir="ltr"
              style={{ padding: '8px 12px' }}
              onChange={e => setDateTo(e.target.value)} />
          </div>
          <button className="btn btn-secondary btn-sm"
            onClick={() => { setDateFrom(todayStr()); setDateTo(todayStr()) }}>اليوم</button>
          <button className="btn btn-secondary btn-sm"
            onClick={() => { setDateFrom(daysAgo(6)); setDateTo(todayStr()) }}>آخر ٧ أيام</button>
          <button className="btn btn-secondary btn-sm" onClick={load}>🔄 تحديث</button>
        </div>
      </div>

      {/* ---- The counters ---- */}
      {summary && (
        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))',
          gap: 14, marginBottom: 22,
        }}>
          <div className="stat-card">
            <div className="stat-label">👨‍🍳 قيد التحضير</div>
            <div className="stat-value" style={{ color: summary.preparingCount > 0 ? 'var(--warning)' : undefined }}>
              {summary.preparingCount}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>في المطبخ — لم تجهز بعد</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">⏳ جاهز بانتظار سائق</div>
            <div className="stat-value" style={{ color: summary.pendingCount > 0 ? 'var(--warning)' : undefined }}>
              {summary.pendingCount}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>اتجهّز ومحتاج حد ياخده</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">🛵 مع السائقين الآن</div>
            <div className="stat-value">{summary.outCount}</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>طلبات في الطريق</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">✅ تم تسليمها</div>
            <div className="stat-value" style={{ color: 'var(--success)' }}>{summary.deliveredCount}</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              بقيمة {money(summary.deliveredValue)}
            </div>
          </div>
          <div className="stat-card">
            <div className="stat-label">💰 نقدية مع السائقين</div>
            <div className="stat-value" style={{ color: summary.cashOwed > 0 ? 'var(--danger)' : 'var(--success)' }}>
              {money(summary.cashOwed)}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              {summary.unsettledCount} طلب لم تُستلم فلوسه
            </div>
          </div>
          <div className="stat-card">
            <div className="stat-label">↩️ لم تُسلَّم</div>
            <div className="stat-value" style={{ color: summary.returnedCount > 0 ? 'var(--danger)' : undefined }}>
              {summary.returnedCount}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>رجعت للمطعم</div>
          </div>
        </div>
      )}

      {/* ---- Drivers and what they are holding ---- */}
      <div className="card" style={{ marginBottom: 22 }}>
        <div className="card-header">
          <span className="card-title">🧍 السائقون والحساب</span>
          {totalOwed > 0 && (
            <span className="badge badge-danger">إجمالي غير مُستلم: {money(totalOwed)}</span>
          )}
        </div>

        <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 14, lineHeight: 1.9 }}>
          «النقدية المستحقة» هي فلوس الطلبات <b>التي سلّمها السائق ودفعها العميل كاش</b> ولم
          يسلّمها للمطعم بعد. طلبات الفيزا لا تدخل هنا إطلاقاً — العميل دفع للماكينة ولم
          تمر الفلوس على السائق. والمبلغ لا يختفي بتغيير التاريخ أعلى الشاشة: فلوس أمس
          التي ما زالت في جيب السائق تظل ظاهرة حتى تُستلم.
        </p>

        <div className="table-container">
          <table>
            <thead>
              <tr>
                <th>السائق</th>
                <th>معه الآن</th>
                <th>سلّم في الفترة</th>
                <th>رسوم التوصيل</th>
                <th>نقدية مستحقة</th>
                <th>آخر استلام</th>
                <th>إجراء</th>
              </tr>
            </thead>
            <tbody>
              {drivers.map(d => (
                <tr key={d.driver_id} style={{ opacity: d.is_active ? 1 : 0.55 }}>
                  <td style={{ fontWeight: 800 }}>
                    {d.full_name}
                    {d.phone && (
                      <div dir="ltr" style={{ fontSize: 11, color: 'var(--text-muted)', textAlign: 'right' }}>
                        {d.phone}
                      </div>
                    )}
                    {!d.is_active && <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>(موقوف)</div>}
                  </td>
                  <td>
                    {d.outCount > 0
                      ? <>
                          <span className="badge badge-info">{d.outCount} طلب</span>
                          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                            {money(d.outValue)}
                          </div>
                        </>
                      : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                  </td>
                  <td>
                    <b>{d.deliveredCount}</b>
                    {d.returnedCount > 0 && (
                      <span style={{ color: 'var(--danger)', fontSize: 11 }}> · {d.returnedCount} مرتجع</span>
                    )}
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{money(d.deliveredValue)}</div>
                  </td>
                  <td>{money(d.feesCollected)}</td>
                  <td style={{
                    fontWeight: 900, fontSize: 15,
                    color: d.cashOwed > 0 ? 'var(--danger)' : 'var(--text-muted)',
                  }}>
                    {d.cashOwed > 0 ? money(d.cashOwed) : '—'}
                    {d.unsettledCount > 0 && (
                      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)' }}>
                        {d.unsettledCount} طلب
                      </div>
                    )}
                  </td>
                  <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                    {d.lastSettledAt
                      ? new Date(d.lastSettledAt.replace(' ', 'T')).toLocaleString('ar-EG')
                      : 'لم يسلّم من قبل'}
                  </td>
                  <td>
                    <button
                      className="btn btn-success"
                      style={TOUCH}
                      disabled={!canSettle || d.cashOwed <= 0}
                      title={d.cashOwed > 0 ? `استلام ${money(d.cashOwed)} من ${d.full_name}` : 'لا توجد مبالغ مستحقة'}
                      onClick={() => openSettle(d)}
                    >
                      💵 استلام النقدية
                    </button>
                  </td>
                </tr>
              ))}
              {drivers.length === 0 && (
                <tr>
                  <td colSpan={7} style={{ textAlign: 'center', padding: 28, color: 'var(--text-muted)' }}>
                    لا يوجد سائقون — أضفهم من إعدادات النظام أولاً.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ---- The orders themselves ---- */}
      <div style={{
        display: 'flex', gap: 12, alignItems: 'center', marginBottom: 14,
        flexWrap: 'wrap', justifyContent: 'space-between',
      }}>
        <div style={{ display: 'flex', gap: 6, background: 'var(--bg-card)', padding: 4, borderRadius: 'var(--radius-sm)', flexWrap: 'wrap' }}>
          {TABS.map(t => (
            <button
              key={t.id}
              className={`btn btn-sm ${!search && tab === t.id ? 'btn-primary' : 'btn-ghost'}`}
              style={search ? { opacity: 0.5 } : undefined}
              onClick={() => { setSearch(''); setSearchInput(''); setTab(t.id) }}
            >
              {t.icon} {t.label} ({countFor(t.id)})
            </button>
          ))}
        </div>

        <div style={{ display: 'flex', gap: 6, alignItems: 'center', minWidth: 300, flex: '0 1 380px' }}>
          <input
            className="input"
            style={{ flex: 1, padding: '9px 14px', fontSize: 13 }}
            placeholder="🔍 ابحث برقم الموبايل، اسم العميل، أو رقم الفاتورة"
            value={searchInput}
            onChange={e => setSearchInput(e.target.value)}
          />
          {searchInput && (
            <button className="btn btn-secondary btn-sm" onClick={() => { setSearchInput(''); setSearch('') }}>
              ✕
            </button>
          )}
        </div>
      </div>

      {/* Who the number belongs to — the first thing anyone wants when a phone rings. */}
      {search && (
        <div style={{ marginBottom: 14 }}>
          {matched.length === 0 ? (
            <div style={{
              padding: 16, textAlign: 'center', background: 'var(--bg-card)',
              border: '1px solid var(--border)', borderRadius: 'var(--radius-md)',
              color: 'var(--text-muted)', fontSize: 13,
            }}>
              لا توجد طلبات توصيل مطابقة لـ «<b>{search}</b>» — عميل جديد على الأرجح.
            </div>
          ) : (
            <>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>
                نتائج البحث عن «<b>{search}</b>» في <b>كل التاريخ</b> — بغض النظر عن الفترة
                المختارة أعلى الشاشة. البطاقات في الأعلى ما زالت تعرض حالة المطعم الآن.
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12 }}>
                {matched.map(c => (
                  <div key={c.phone} className="card" style={{ padding: 16 }}>
                    <div style={{ fontSize: 19, fontWeight: 900, marginBottom: 4 }}>👤 {c.name}</div>
                    <div dir="ltr" style={{
                      textAlign: 'right', fontFamily: 'monospace', fontWeight: 800,
                      fontSize: 15, color: 'var(--accent)', marginBottom: 8,
                    }}>
                      {c.phone}
                    </div>
                    {c.address && (
                      <div style={{ fontSize: 13, marginBottom: 4 }}>
                        📍 {c.address}{c.area ? ` — ${c.area}` : ''}
                      </div>
                    )}
                    <div style={{
                      display: 'flex', gap: 16, marginTop: 10, paddingTop: 10,
                      borderTop: '1px solid var(--border)', fontSize: 13,
                    }}>
                      <span><b>{c.orders}</b> طلب</span>
                      <span>إجمالي <b>{money(c.spent)}</b></span>
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>
                      آخر طلب: {new Date(c.last.replace(' ', 'T')).toLocaleString('ar-EG')}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {tab === 'deleted' && !search && (
        <div style={{
          padding: 12, marginBottom: 12, fontSize: 12, lineHeight: 1.9,
          background: 'var(--danger-bg)', borderRadius: 'var(--radius-sm)',
        }}>
          🗑️ <b>طلبات التوصيل المحذوفة</b> — كل ما حُذف، من أول يوم، بغض النظر عن الفترة
          المختارة أعلى الشاشة. هذه الفواتير <b>لا تدخل</b> في المبيعات ولا في حساب أي
          سائق، وقد رجعت موادها الخام إلى المخزون وقت الحذف. اضغط «تفاصيل» لرؤية من حذفها
          ومتى وماذا كان بداخلها بالضبط.
        </div>
      )}

      <div className="table-container">
        <table>
          <thead>
            <tr>
              <th>الفاتورة</th>
              <th>العميل</th>
              <th>المنطقة</th>
              <th>الإجمالي</th>
              <th>الدفع</th>
              <th>السائق</th>
              <th>الحالة</th>
              <th>الوقت</th>
              <th>إجراءات</th>
            </tr>
          </thead>
          <tbody>
            {shown.map(o => {
              const st = o.delivery_status ? STATUS_BADGE[o.delivery_status] : null
              const busy = busyOrderId === o.order_id
              const settled = !!o.settlement_id
              const deletedRow = !!o.deleted_at
              return (
                <tr key={o.order_id} style={deletedRow ? { opacity: 0.75 } : undefined}>
                  <td style={{ fontWeight: 800, color: 'var(--accent)' }}>
                    {o.invoice_number || `#${o.order_id}`}
                  </td>
                  <td>
                    <div style={{ fontWeight: 700 }}>{o.customer_name || '—'}</div>
                    <div dir="ltr" style={{ fontSize: 11, color: 'var(--text-muted)', textAlign: 'right' }}>
                      {o.customer_phone}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{o.customer_address}</div>
                  </td>
                  <td style={{ fontSize: 12 }}>{o.area_name || '—'}</td>
                  <td style={{ fontWeight: 800 }}>
                    {money(o.total_amount)}
                    {o.delivery_fee > 0 && (
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600 }}>
                        منها توصيل {money(o.delivery_fee)}
                      </div>
                    )}
                  </td>
                  <td>
                    <span className={`badge ${o.payment_type === 'cash' ? 'badge-success' : 'badge-info'}`}>
                      {o.payment_type === 'cash' ? '💵 كاش' : '💳 فيزا'}
                    </span>
                    {o.payment_type === 'cash' && o.delivery_status === 'delivered' && (
                      <div style={{ fontSize: 11, marginTop: 4, fontWeight: 700, color: settled ? 'var(--success)' : 'var(--danger)' }}>
                        {settled ? '✓ استُلمت' : '⏱ مع السائق'}
                      </div>
                    )}
                  </td>
                  <td>
                    {/* Changing the driver on a delivered order would move its money to
                        someone else's account, so the list closes once it arrives. */}
                    {deletedRow || o.delivery_status === 'delivered' || o.delivery_status === 'returned' ? (
                      <span style={{ fontWeight: 700 }}>{o.driver_name || '—'}</span>
                    ) : (
                      <select
                        className="input"
                        style={{ padding: '6px 10px', fontSize: 12, minWidth: 130 }}
                        value={o.driver_id || ''}
                        disabled={busy}
                        onChange={e => assign(o.order_id, Number(e.target.value))}
                      >
                        <option value="">— اختر سائقاً —</option>
                        {allDrivers.map(d => (
                          <option key={d.driver_id} value={d.driver_id}>{d.full_name}</option>
                        ))}
                        {/* A driver since deactivated must still show on his own order,
                            or the row would look unassigned and get handed to someone else. */}
                        {o.driver_id && !allDrivers.some(d => d.driver_id === o.driver_id) && (
                          <option value={o.driver_id}>{o.driver_name} (موقوف)</option>
                        )}
                      </select>
                    )}
                  </td>
                  <td>
                    {deletedRow ? (
                      <>
                        <span className="badge badge-danger">🗑️ محذوفة</span>
                        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                          بواسطة {o.deleted_by_name || '—'}
                          <div>{new Date(o.deleted_at!.replace(' ', 'T')).toLocaleString('ar-EG')}</div>
                        </div>
                        {/* What it WAS before it was removed still matters: an order
                            deleted after it had gone out is a different story from
                            one deleted before anybody touched it. */}
                        {st && (
                          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                            كانت: {st.label}
                          </div>
                        )}
                      </>
                    ) : st
                      ? <span className={`badge ${st.cls}`}>{st.icon} {st.label}</span>
                      : <span className="badge badge-warning" title="طلب قديم سابق لتشغيل مركز الدليفري">
                          غير متتبَّع
                        </span>}
                    {o.status === 'voided' && (
                      <div style={{ fontSize: 11, color: 'var(--danger)', marginTop: 4, fontWeight: 700 }}>
                        ملغاة: {o.void_reason || 'بدون سبب'}
                      </div>
                    )}
                  </td>
                  <td style={{ fontSize: 12, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                    {/* Search results and stale live orders span days, so anything not
                        from today says which day it was. */}
                    {!o.created_at.startsWith(todayStr()) && (
                      <div style={{ fontWeight: 700 }}>
                        {new Date(o.created_at.replace(' ', 'T')).toLocaleDateString('ar-EG')}
                      </div>
                    )}
                    {timeOf(o.created_at)}
                    {o.delivery_status === 'out' && o.dispatched_at && (
                      <div style={{ color: 'var(--warning)', fontWeight: 700 }}>
                        خرج منذ {elapsed(o.dispatched_at)}
                      </div>
                    )}
                    {o.delivery_status === 'pending' && (
                      <div style={{ color: 'var(--warning)', fontWeight: 700 }}>
                        منتظر منذ {elapsed(o.created_at)}
                      </div>
                    )}
                    {o.delivered_at && (
                      <div style={{ color: 'var(--success)' }}>سُلّم {timeOf(o.delivered_at)}</div>
                    )}
                  </td>
                  {/* The journey, one press per step. Sized for a thumb on a
                      touchscreen at the counter, because that is what these are
                      pressed with — and wrapped rather than squeezed onto one line,
                      so a narrow screen never hides the action somebody needs. */}
                  <td>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', minWidth: 230 }}>
                      <button className="btn btn-secondary" style={TOUCH}
                        onClick={() => openDetails(o.order_id)}>
                        📄 تفاصيل
                      </button>
                      {!deletedRow && (
                        <>
                          {/* The kitchen finishing it is its own event: until someone
                              presses this, the order is not ready for anybody to take. */}
                          {o.delivery_status === 'preparing' && (
                            <button
                              className="btn btn-primary" style={TOUCH}
                              disabled={busy}
                              onClick={() => setStatus(o.order_id, 'pending')}
                            >
                              ✅ جاهز
                            </button>
                          )}

                          {/* Handing it over, as its own explicit act.
                              This step used to have no button at all — an order only
                              became "with the driver" as a side effect of choosing one
                              from the dropdown. That works when the driver is standing
                              there, and not at all when the order was assigned earlier
                              and he is only now leaving with it, which is most of them.
                              So the step you actually perform now has a button. */}
                          {o.delivery_status !== 'out' && o.delivery_status !== 'delivered'
                            && o.delivery_status !== 'returned' && (
                            <button
                              className="btn btn-warning" style={TOUCH}
                              disabled={busy || !o.driver_id}
                              title={o.driver_id ? 'الطلب خرج مع السائق الآن' : 'اختر السائق أولاً'}
                              onClick={() => setStatus(o.order_id, 'out')}
                            >
                              🛵 مع السائق
                            </button>
                          )}

                          {o.delivery_status !== 'delivered' && (
                            <button
                              className="btn btn-success" style={TOUCH}
                              disabled={busy || !o.driver_id}
                              title={o.driver_id ? '' : 'اختر السائق أولاً'}
                              onClick={() => setStatus(o.order_id, 'delivered')}
                            >
                              ✅ تم التسليم
                            </button>
                          )}
                          {o.delivery_status !== 'returned' && !settled && (
                            <button
                              className="btn btn-ghost" style={TOUCH}
                              disabled={busy}
                              onClick={() => setStatus(o.order_id, 'returned')}
                            >
                              ↩️ لم يُسلَّم
                            </button>
                          )}
                          {(o.delivery_status === 'delivered' || o.delivery_status === 'returned') && !settled && (
                            <button
                              className="btn btn-ghost" style={TOUCH}
                              disabled={busy || !o.driver_id}
                              onClick={() => setStatus(o.order_id, 'out')}
                              title="إرجاع الطلب إلى حالة «مع السائق»"
                            >
                              ↺ تراجع
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              )
            })}
            {shown.length === 0 && !loading && (
              <tr>
                <td colSpan={9} style={{ textAlign: 'center', padding: 44 }}>
                  <div className="empty-state">
                    <div className="empty-state-icon">🛵</div>
                    <div className="empty-state-text">
                      {search ? `لا توجد نتائج لـ «${search}»`
                        : tab === 'live' ? 'لا توجد طلبات جارية الآن'
                          : 'لا توجد طلبات في هذا التبويب'}
                    </div>
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {summary && summary.untrackedCount > 0 && (
        <div style={{
          marginTop: 12, padding: 12, fontSize: 12, lineHeight: 1.8,
          background: 'var(--warning-bg)', borderRadius: 'var(--radius-sm)',
        }}>
          {summary.untrackedCount} طلب توصيل في هذه الفترة سابق لتشغيل مركز الدليفري، فليست له
          حالة مسجّلة. لم يفترض النظام أنها سُلّمت — لا أحد يعلم — ولذلك لا تدخل في أي مبلغ
          مستحق. الطلبات الجديدة كلها متتبَّعة من لحظة إصدار الفاتورة.
        </div>
      )}

      {/* ---- Hand-over history ---- */}
      <div className="card" style={{ marginTop: 22 }}>
        <div className="card-header">
          <span className="card-title">🧾 سجل استلام النقدية من السائقين</span>
        </div>
        <div className="table-container">
          <table>
            <thead>
              <tr><th>التاريخ</th><th>السائق</th><th>عدد الطلبات</th><th>المبلغ</th><th>استلمها</th><th>ملاحظة</th></tr>
            </thead>
            <tbody>
              {settlements.map(s => (
                <tr key={s.settlement_id}>
                  <td style={{ fontSize: 12 }}>
                    {new Date(s.settled_at.replace(' ', 'T')).toLocaleString('ar-EG')}
                  </td>
                  <td style={{ fontWeight: 800 }}>{s.driver_name}</td>
                  <td>{s.order_count}</td>
                  <td style={{ fontWeight: 800, color: 'var(--success)' }}>{money(s.total_amount)}</td>
                  <td style={{ fontSize: 12 }}>{s.settled_by_name || '—'}</td>
                  <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{s.note || '—'}</td>
                </tr>
              ))}
              {settlements.length === 0 && (
                <tr>
                  <td colSpan={6} style={{ textAlign: 'center', padding: 24, color: 'var(--text-muted)' }}>
                    لم يتم استلام أي نقدية من سائق حتى الآن.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ---- Settle-up ---- */}
      {settling && (
        <div className="modal-overlay" onClick={() => !settleBusy && setSettling(null)}>
          <div className="modal" style={{ maxWidth: 560, maxHeight: '88vh', overflowY: 'auto' }} onClick={e => e.stopPropagation()}>
            <h2 className="modal-title">استلام النقدية من {settling.full_name}</h2>
            <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 14, lineHeight: 1.9 }}>
              راجع الطلبات التي يسلّم فلوسها الآن. لو سلّم جزءاً فقط، أزل علامة الطلبات التي
              لم يسلّم فلوسها وستظل مستحقة عليه.
            </p>

            <div className="table-container" style={{ marginBottom: 14, maxHeight: 300 }}>
              <table>
                <thead>
                  <tr>
                    <th style={{ width: 40 }}>
                      <input
                        type="checkbox"
                        checked={settleChecked.size === settleOrders.length}
                        onChange={e => setSettleChecked(
                          e.target.checked ? new Set(settleOrders.map(o => o.order_id)) : new Set()
                        )}
                      />
                    </th>
                    <th>الفاتورة</th>
                    <th>العميل</th>
                    <th>الوقت</th>
                    <th>المبلغ</th>
                  </tr>
                </thead>
                <tbody>
                  {settleOrders.map(o => (
                    <tr key={o.order_id}>
                      <td>
                        <input
                          type="checkbox"
                          checked={settleChecked.has(o.order_id)}
                          onChange={e => setSettleChecked(prev => {
                            const next = new Set(prev)
                            e.target.checked ? next.add(o.order_id) : next.delete(o.order_id)
                            return next
                          })}
                        />
                      </td>
                      <td style={{ fontWeight: 800 }}>{o.invoice_number || `#${o.order_id}`}</td>
                      <td style={{ fontSize: 12 }}>{o.customer_name}</td>
                      <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                        {new Date(o.created_at.replace(' ', 'T')).toLocaleDateString('ar-EG')} {timeOf(o.created_at)}
                      </td>
                      <td style={{ fontWeight: 800 }}>{money(o.total_amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '12px 14px', marginBottom: 14, borderRadius: 'var(--radius-sm)',
              background: 'var(--bg-card-hover)',
            }}>
              <span style={{ fontWeight: 800 }}>
                المبلغ المستلم ({settleChecked.size} من {settleOrders.length} طلب)
              </span>
              <span style={{ fontSize: 22, fontWeight: 900, color: 'var(--success)' }}>
                {money(settleTotal)}
              </span>
            </div>

            <div className="form-group">
              <label className="form-label">ملاحظة (اختيارية)</label>
              <input
                className="input" value={settleNote}
                onChange={e => setSettleNote(e.target.value)}
                placeholder="مثال: خصم 20 ج.م بنزين، أو تسليم نهاية الوردية"
              />
            </div>

            <div style={{ display: 'flex', gap: 10 }}>
              <button
                className="btn btn-success" style={{ flex: 1 }}
                disabled={settleBusy || settleChecked.size === 0}
                onClick={confirmSettle}
              >
                {settleBusy ? 'جاري التسجيل...' : `💵 تأكيد استلام ${money(settleTotal)}`}
              </button>
              <button className="btn btn-secondary" disabled={settleBusy} onClick={() => setSettling(null)}>
                إلغاء
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ---- Everything about one order, deleted ones included ---- */}
      {details && (
        <div className="modal-overlay" onClick={() => setDetails(null)}>
          <div className="modal" style={{ maxWidth: 560, maxHeight: '90vh', overflowY: 'auto' }} onClick={e => e.stopPropagation()}>
            <h2 className="modal-title">
              تفاصيل الطلب {details.invoice_number || `#${details.order_id}`}
            </h2>

            {details.deleted_at && (
              <div style={{
                padding: 12, marginBottom: 14, borderRadius: 'var(--radius-sm)',
                background: 'var(--danger-bg)', border: '1px solid rgba(217,45,32,0.28)',
                fontSize: 13, lineHeight: 1.9,
              }}>
                🗑️ <b>هذه الفاتورة محذوفة.</b> لا تدخل في أي تقرير أو حساب سائق، وقد
                رجعت موادها الخام إلى المخزون وقت الحذف.
                <div style={{ marginTop: 6 }}>
                  حذفها: <b>{details.deleted_by_name || '—'}</b> ·{' '}
                  {new Date(details.deleted_at.replace(' ', 'T')).toLocaleString('ar-EG')}
                </div>
              </div>
            )}

            {details.status === 'voided' && (
              <div style={{
                padding: 12, marginBottom: 14, borderRadius: 'var(--radius-sm)',
                background: 'var(--warning-bg)', fontSize: 13, lineHeight: 1.9,
              }}>
                ✕ <b>فاتورة ملغاة (Void).</b> السبب: {details.void_reason || 'بدون سبب'}
                {details.voided_by_name && <> · بواسطة <b>{details.voided_by_name}</b></>}
              </div>
            )}

            <div style={{
              background: 'var(--bg-card-hover)', padding: 14, borderRadius: 'var(--radius-sm)',
              marginBottom: 14, fontSize: 13, display: 'grid', gap: 6,
            }}>
              <Row k="الكاشير" v={details.cashier_name || '—'} />
              <Row k="وقت الطلب" v={new Date(details.created_at.replace(' ', 'T')).toLocaleString('ar-EG')} />
              <Row k="الحالة" v={details.delivery_status ? STATUS_BADGE[details.delivery_status].label : 'غير متتبَّعة'} />
              <Row k="السائق" v={details.driver_name || 'لم يُسنَد'} />
              {details.dispatched_at && (
                <Row k="خرج في" v={new Date(details.dispatched_at.replace(' ', 'T')).toLocaleString('ar-EG')} />
              )}
              {details.delivered_at && (
                <Row k="سُلّم في" v={new Date(details.delivered_at.replace(' ', 'T')).toLocaleString('ar-EG')} />
              )}
              <Row k="طريقة الدفع" v={details.payment_type === 'cash' ? 'نقدي (كاش)' : 'بطاقة (فيزا)'} />
              {details.payment_type === 'cash' && (
                <Row
                  k="نقدية السائق"
                  v={details.settlement_id
                    ? `استُلمت${details.settled_at ? ` — ${new Date(details.settled_at.replace(' ', 'T')).toLocaleString('ar-EG')}` : ''}`
                    : 'لم تُستلم'}
                />
              )}
            </div>

            <div style={{
              background: 'var(--bg-card-hover)', padding: 14, borderRadius: 'var(--radius-sm)',
              marginBottom: 14, fontSize: 13, display: 'grid', gap: 6,
            }}>
              <Row k="العميل" v={details.customer_name || '—'} />
              <Row k="الهاتف" v={details.customer_phone || '—'} />
              <Row k="العنوان" v={details.customer_address || '—'} />
              <Row k="المنطقة" v={details.area_name || '—'} />
            </div>

            {details.notes && (
              <div style={{
                padding: 10, marginBottom: 14, fontSize: 13,
                background: 'var(--info-bg)', borderRadius: 'var(--radius-sm)',
              }}>
                📝 <b>ملاحظة:</b> {details.notes}
              </div>
            )}

            <h3 style={{ fontSize: 14, fontWeight: 800, marginBottom: 8 }}>الأصناف:</h3>
            <div className="table-container" style={{ marginBottom: 14, maxHeight: 220 }}>
              <table style={{ fontSize: 12 }}>
                <thead>
                  <tr><th>الصنف</th><th style={{ textAlign: 'center' }}>الكمية</th><th>الإجمالي</th></tr>
                </thead>
                <tbody>
                  {(details.items ?? []).map(it => (
                    <tr key={it.order_item_id}>
                      <td style={{ fontWeight: 700 }}>
                        {it.item_name}
                        {it.variant_label && (
                          <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{it.variant_label}</div>
                        )}
                      </td>
                      <td style={{ textAlign: 'center' }}>×{it.quantity}</td>
                      <td>{money(it.unit_price * it.quantity)}</td>
                    </tr>
                  ))}
                  {(details.items ?? []).length === 0 && (
                    <tr><td colSpan={3} style={{ textAlign: 'center', color: 'var(--text-muted)' }}>لا توجد أصناف</td></tr>
                  )}
                </tbody>
              </table>
            </div>

            <div style={{ display: 'grid', gap: 4, fontSize: 13, borderTop: '1px solid var(--border)', paddingTop: 10, marginBottom: 16 }}>
              <Row k="المجموع الفرعي" v={money(details.subtotal)} />
              {details.discount > 0 && <Row k="الخصم" v={`-${money(details.discount)}`} />}
              {details.delivery_fee > 0 && <Row k="رسوم التوصيل" v={money(details.delivery_fee)} />}
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 16, fontWeight: 900, color: 'var(--accent)', marginTop: 4 }}>
                <span>الإجمالي</span>
                <span>{money(details.total_amount)}</span>
              </div>
            </div>

            <button className="btn btn-secondary" style={{ width: '100%' }} onClick={() => setDetails(null)}>
              إغلاق
            </button>
          </div>
        </div>
      )}

      {toast && <div className={`toast toast-${toast.type}`}>{toast.msg}</div>}
    </div>
  )
}

/** One label/value line in the detail panels above. */
function Row({ k, v }: { k: string; v: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
      <span style={{ color: 'var(--text-muted)' }}>{k}:</span>
      <span style={{ fontWeight: 700, textAlign: 'left' }}>{v}</span>
    </div>
  )
}
