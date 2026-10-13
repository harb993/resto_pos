import React, { useEffect } from 'react'
import { useAuthStore, useUIStore, useSettingsStore } from './state/stores'
import { setMasterOffset } from './lib/clock'
import LoginScreen from './screens/LoginScreen'
import ActivationScreen from './screens/ActivationScreen'
import POSScreen from './screens/cashier/POSScreen'
import OrderHistoryScreen from './screens/cashier/OrderHistoryScreen'
import DashboardScreen from './screens/owner/DashboardScreen'
import MenuManagementScreen from './screens/owner/MenuManagementScreen'
import RawMaterialsScreen from './screens/owner/RawMaterialsScreen'
import CustomersScreen from './screens/owner/CustomersScreen'
import DeliveryCenterScreen from './screens/owner/DeliveryCenterScreen'
// Charting pulls in recharts, so the accountant's report loads on demand like Analytics.
const FinanceScreen = React.lazy(() => import('./screens/owner/FinanceScreen'))
import logoUrl from './assets/logo.png'
// recharts is ~1 MB and is used by this screen alone. Loading it on demand keeps
// it off the POS startup path, which matters on the low-spec PCs a till runs on.
const AnalyticsScreen = React.lazy(() => import('./screens/owner/AnalyticsScreen'))
import UsersScreen from './screens/owner/UsersScreen'
import SettingsScreen from './screens/owner/SettingsScreen'
import ExpensesScreen from './screens/owner/ExpensesScreen'
import SuppliersScreen from './screens/owner/SuppliersScreen'
import WorkersScreen from './screens/owner/WorkersScreen'
import SalariesScreen from './screens/owner/SalariesScreen'
import ShiftsScreen from './screens/owner/ShiftsScreen'
import WhatsappCampaignScreen from './screens/owner/WhatsappCampaignScreen'
import ClosingModal from './components/ClosingModal'
import { WorkShiftGate, WorkShiftBadge } from './components/WorkShift'

/**
 * Screens the showcase account does not show.
 *
 * `users` manages the four real sign-in accounts of THIS installation. On the demo
 * books those rows mean nothing, and putting somebody's usernames on screen during a
 * sales demonstration has no upside at all.
 */
const SHOWCASE_HIDDEN = new Set<string>(['users'])

function App() {
  const user = useAuthStore((s) => s.user)
  const setUser = useAuthStore((s) => s.setUser)
  const activeScreen = useUIStore((s) => s.activeScreen)
  const setActiveScreen = useUIStore((s) => s.setActiveScreen)
  const lowStockAlerts = useUIStore((s) => s.lowStockAlerts)
  const setLowStockAlerts = useUIStore((s) => s.setLowStockAlerts)
  const businessName = useSettingsStore((s) => s.settings.business_name)
  const loadSettings = useSettingsStore((s) => s.loadSettings)
  const applySettings = useSettingsStore((s) => s.applySettings)
  // Is this PC allowed to run at all? Asked before anything else, because on an
  // unactivated machine every other channel answers with a refusal and the screens
  // would come up empty and confusing. `null` means the answer is not back yet.
  const [licence, setLicence] = React.useState<
    { activated: boolean; deviceId: string; reason?: string } | null
  >(null)

  const checkLicence = React.useCallback(() => {
    window.api.getLicenseStatus()
      .then((res: any) => {
        if (res?.success) setLicence(res.data)
        // A licence check that fails outright is treated as unactivated rather than
        // waved through: failing open would make the check pointless.
        else setLicence({ activated: false, deviceId: '—', reason: res?.error })
      })
      .catch(() => setLicence({ activated: false, deviceId: '—' }))
  }, [])

  useEffect(() => { checkLicence() }, [checkLicence])

  /*
    What is running low — the number beside «المخزون».

    It used to be set only by a push that followed a SALE, and only when something was
    low. So it appeared after the first invoice and then never moved: a delivery that
    filled the shelves left "32" on the screen, and so did a stocktake, because nothing
    that was not a sale ever told it to look again — and nothing at all could clear it.

    Now it is read from the stock itself: once at sign-in, and again whenever anything
    changes a balance — a sale, a delivery, a count, a void, an edited alert level.
  */
  const refreshLowStock = React.useCallback(async () => {
    const res = await window.api.getLowStockMaterials()
    if (res?.success) setLowStockAlerts(res.data)
  }, [setLowStockAlerts])

  useEffect(() => {
    if (!user) { setLowStockAlerts([]); return }
    void refreshLowStock()
    const offStock = window.api.onStockChanged?.(() => { void refreshLowStock() })
    const offAlert = window.api.onLowStockAlert?.(() => { void refreshLowStock() })
    return () => { offStock?.(); offAlert?.() }
  }, [user, refreshLowStock, setLowStockAlerts])

  // Keep the shared settings store live for the whole app: load once here, then let
  // the main process push every subsequent save straight in. This is what makes a
  // change in the Settings screen take effect everywhere without a restart.
  useEffect(() => {
    if (window.api?.onSettingsChanged) {
      const unsub = window.api.onSettingsChanged((fresh) => applySettings(fresh))
      return unsub
    }
  }, [applySettings])

  // Re-fetch on login: before authenticating the main process only returns the
  // public branding keys, so the full set has to be pulled once a session exists.
  useEffect(() => {
    loadSettings()
  }, [user, loadSettings])

  // On a node till, the state of the link the master holds to this machine. A cashier
  // needs to know the moment it drops — before they try to ring something up — rather
  // than discovering it from a failed sale with a customer waiting.
  //
  // The reason travels with it now. "The master's app is closed", "this till was
  // locked from the master" and "that PC is not on the network" need different
  // actions from whoever reads the banner, and they used to all say "check the cable".
  const [link, setLink] = React.useState<{
    linked: boolean; reason: string; locked: boolean; lockReason: string
    masterName: string; mirror: { at: number; bytes: number } | null
  } | null>(null)
  useEffect(() => {
    if (!window.api?.onMasterLink) return
    return window.api.onMasterLink(data => {
      setLink(data)
      // Follow the master's clock, so both tills agree what "today" is, which shift
      // a sale falls in, and how long an order has been out with a driver.
      setMasterOffset((data as { masterTimeOffsetMs?: number }).masterTimeOffsetMs)
    })
  }, [])

  // The master signed this till out from its own screen.
  useEffect(() => {
    if (!window.api?.onForceSignOut) return
    return window.api.onForceSignOut(() => { window.location.reload() })
  }, [])

  /**
   * Is this the showcase account rather than a real shop?
   *
   * Signing in as `fares` swaps the whole database for a demonstration one. What is
   * being shown there is what the system DOES — the till, the reports, the delivery
   * board. The four sign-in accounts are not that: they are this installation's own
   * credentials, they mean nothing on a made-up restaurant, and putting somebody's
   * usernames on screen in front of a prospective customer is the one thing on that
   * menu with no upside. Re-asked whenever the user changes, because that is exactly
   * when the database underneath has been swapped.
   */
  const [showcase, setShowcase] = React.useState(false)
  useEffect(() => {
    let live = true
    window.api?.getAppMode?.().then((res: any) => {
      if (live && res?.success) setShowcase(!!res.data.demo)
    })
    return () => { live = false }
  }, [user])

  // A shift closed and its close-out report has been written. Shown as a card that
  // stays put rather than a toast that fades: the whole point is that somebody sends
  // it to the group, and a banner that disappears after three seconds at 1am is a
  // report nobody sends.
  const [shiftExport, setShiftExport] = React.useState<any | null>(null)
  const [closingOpen, setClosingOpen] = React.useState(false)
  // Which sidebar group has been opened by hand, besides the one in use.
  const [openGroup, setOpenGroup] = React.useState<string | null>(null)
  useEffect(() => {
    if (!window.api?.onShiftExported) return
    return window.api.onShiftExported((data: any) => setShiftExport(data))
  }, [])

  // Wait for the licence answer rather than flashing the activation screen at a
  // machine that turns out to be fine.
  if (licence === null) return null

  // Not activated → the activation screen is the whole application.
  // Activating reloads so networking, which startup skipped, comes up properly.
  if (!licence.activated) {
    return (
      <ActivationScreen
        deviceId={licence.deviceId}
        reason={licence.reason}
        onActivated={() => window.location.reload()}
      />
    )
  }

  // Not logged in → show login
  if (!user) return <LoginScreen />

  const handleLogout = async () => {
    await window.api.logout()
    setUser(null)
    setActiveScreen('pos')
  }

  // These MUST match the role guards on the IPC channels each screen calls, or the
  // user gets a menu entry that opens straight into "Insufficient permissions".
  //
  // Grouped, because seventeen entries in one column is a list nobody reads: the four
  // headings are what an owner is actually looking for — sell, count the money, see
  // how it is going, set things up — and only the group in use is open.
  const navItems = [
    { id: 'pos', group: 'sell', label: 'نقطة البيع', icon: '🖥️', roles: ['cashier', 'owner'] },
    { id: 'orders', group: 'sell', label: 'الفواتير', icon: '📋', roles: ['cashier', 'owner', 'accountant'] },
    // The cashier is the one standing at the counter when the driver walks back in,
    // so the board is theirs to keep current; counting the cash in is owner/accountant
    // only, and the screen's own button enforces that.
    { id: 'delivery', group: 'sell', label: 'الدليفري', icon: '🛵', roles: ['cashier', 'owner', 'accountant'] },

    { id: 'shifts', group: 'money', label: 'الورديات', icon: '🕒', roles: ['owner', 'accountant'] },
    // The accountant's home: P&L, every pound spent, and the PDF/Excel exports.
    { id: 'finance', group: 'money', label: 'الأرباح والمركز المالي', icon: '💵', roles: ['owner', 'accountant'] },
    { id: 'expenses', group: 'money', label: 'المصروفات', icon: '💸', roles: ['cashier', 'owner', 'accountant'] },
    { id: 'salaries', group: 'money', label: 'المرتبات', icon: '💰', roles: ['owner', 'accountant'] },
    { id: 'suppliers', group: 'money', label: 'الموردون', icon: '🚚', roles: ['owner', 'accountant'] },

    { id: 'dashboard', group: 'watch', label: 'لوحة التحكم', icon: '📊', roles: ['owner', 'accountant'] },
    { id: 'analytics', group: 'watch', label: 'تحليلات المبيعات', icon: '📈', roles: ['owner', 'accountant'] },

    { id: 'menu', group: 'manage', label: 'قائمة الطعام', icon: '🍗', roles: ['owner'] },
    // Inventory IS the raw material store — chickens, buns, sauces, packaging.
    // Finished meals are never stocked, so there is no separate meal-stock screen.
    // Accountants get a read-only view; every write on it is owner-gated in main.
    { id: 'inventory', group: 'manage', label: 'المخزون', icon: '📦', roles: ['owner', 'accountant'] },
    // The accountant reads the roster and pays people; only the owner hires or sets a wage.
    { id: 'workers', group: 'manage', label: 'العمال', icon: '👨‍🍳', roles: ['owner', 'accountant'] },
    { id: 'customers', group: 'manage', label: 'العملاء', icon: '👥', roles: ['owner', 'accountant'] },
    { id: 'whatsapp', group: 'manage', label: 'واتساب تسويق', icon: '💬', roles: ['owner'] },
    { id: 'users', group: 'manage', label: 'المستخدمون', icon: '🔑', roles: ['owner'] },
    { id: 'settings', group: 'manage', label: 'الإعدادات', icon: '⚙️', roles: ['owner'] },
  ]

  const NAV_GROUPS = [
    { id: 'sell', label: 'البيع' },
    { id: 'money', label: 'الحسابات' },
    { id: 'watch', label: 'المتابعة' },
    { id: 'manage', label: 'الإدارة' },
  ]

  const allowedScreens = navItems.filter(
    (n) => n.roles.includes(user.role) && !(showcase && SHOWCASE_HIDDEN.has(n.id)),
  )
  // An accountant has no POS entry, so falling back to <POSScreen/> would drop them
  // onto a till they are not meant to operate. Land everyone on their own home screen:
  // the till for whoever sells, the accounts for whoever counts.
  const currentScreen = allowedScreens.some((n) => n.id === activeScreen)
    ? activeScreen
    : (allowedScreens.find(n => n.id === 'pos') ?? allowedScreens.find(n => n.id === 'finance')
        ?? allowedScreens[0])?.id ?? 'orders'

  // A cashier has four entries and needs no headings; anybody with more gets groups.
  const grouped = allowedScreens.length > 6
  const currentGroup = navItems.find(n => n.id === currentScreen)?.group
  const screens: Record<string, React.ReactNode> = {
    pos: <POSScreen />,
    finance: <FinanceScreen />,
    orders: <OrderHistoryScreen />,
    delivery: <DeliveryCenterScreen />,
    customers: <CustomersScreen />,
    dashboard: <DashboardScreen />,
    menu: <MenuManagementScreen />,
    inventory: <RawMaterialsScreen />,
    analytics: <AnalyticsScreen />,
    expenses: <ExpensesScreen />,
    suppliers: <SuppliersScreen />,
    workers: <WorkersScreen />,
    salaries: <SalariesScreen />,
    shifts: <ShiftsScreen />,
    users: <UsersScreen />,
    settings: <SettingsScreen />,
    whatsapp: <WhatsappCampaignScreen />,
  }

  return (
    <div className="app-layout" dir="rtl">
      {/* This till cannot record anything: either the master is away or it has locked
          this machine deliberately. Said across the whole screen rather than letting a
          cashier find out from a failed sale — and said with the actual reason, so
          nobody goes hunting a cable that was never the problem. */}
      {link && (link.locked || !link.linked) && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, zIndex: 10000,
          background: 'var(--danger, var(--danger))', color: '#fff',
          padding: '10px 16px', textAlign: 'center', fontWeight: 700, fontSize: 14,
          lineHeight: 1.5,
          /*
            Something to READ, not to press — there is nothing in here to click.

            Fixed across the full width at z-index 10000 with nothing pushing the page
            down, it lies on top of the header and the first row of every screen. Left
            clickable it swallows every press and keystroke aimed at what is underneath,
            for as long as the master is away — which on a till being set up is most of
            the time. That is the "input blocking": not a dead field, a sheet of glass
            over the top of the screen.
          */
          pointerEvents: 'none',
        }}>
          {link.locked ? (
            <>
              🔒 هذا الجهاز مقفول من {link.masterName || 'الجهاز الرئيسي'} — لا يمكن تسجيل أي طلب.
              {link.lockReason && <> السبب: {link.lockReason}</>}
            </>
          ) : (
            <>
              ⚠️ {link.masterName || 'الجهاز الرئيسي'} غير متصل بهذا الجهاز — لا يمكن تسجيل أي طلب حتى يعود.
              <div style={{ fontWeight: 500, fontSize: 12, marginTop: 2, opacity: 0.95 }}>
                {link.reason}
                {link.mirror
                  ? ' — يمكنك الاطلاع على البيانات المحفوظة محلياً فقط.'
                  : ' — لا توجد نسخة محلية على هذا الجهاز بعد.'}
              </div>
            </>
          )}
        </div>
      )}

      {/* Sidebar (RTL Right) */}
      <aside className="sidebar">
        <div className="sidebar-header">
          <div className="sidebar-logo">
            <img src={logoUrl} alt="أبو الدهب" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
          </div>
          <div className="sidebar-brand">
            <span className="sidebar-title">{businessName}</span>
            <span className="sidebar-subtitle">نظام المبيعات السريع</span>
          </div>
        </div>

        <nav className="sidebar-nav">
          {(grouped ? NAV_GROUPS : [{ id: '', label: '' }]).map(g => {
            const items = allowedScreens.filter(n => !grouped || n.group === g.id)
            if (items.length === 0) return null
            // The group in use is always open; any other opens when its heading is pressed.
            const open = !grouped || g.id === currentGroup || openGroup === g.id
            const hasAlert = g.id === 'manage' && lowStockAlerts.length > 0
            return (
              <div key={g.id || 'all'}>
                {grouped && (
                  <button
                    onClick={() => setOpenGroup(openGroup === g.id ? null : g.id)}
                    style={{
                      width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                      background: g.id === currentGroup ? 'transparent' : 'rgba(255,255,255,0.05)',
                      border: 'none', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit',
                      padding: '11px 14px', margin: '4px 0', fontSize: 14.5, fontWeight: 800,
                      color: g.id === currentGroup ? 'var(--sidebar-highlight)' : 'rgba(255,255,255,0.82)',
                    }}
                  >
                    <span>
                      {g.label}
                      {hasAlert && !open && (
                        <span className="badge badge-danger" style={{ marginRight: 8, fontSize: 10 }}>{lowStockAlerts.length}</span>
                      )}
                    </span>
                    <span style={{ fontSize: 12, opacity: 0.8 }}>{open ? '▾' : '◂'}</span>
                  </button>
                )}
                {open && items.map((n) => (
                  <button
                    key={n.id}
                    className={`nav-item ${currentScreen === n.id ? 'active' : ''}`}
                    onClick={() => setActiveScreen(n.id)}
                  >
                    <span className="nav-icon">{n.icon}</span>
                    <span>{n.label}</span>
                    {n.id === 'inventory' && lowStockAlerts.length > 0 && (
                      <span className="badge badge-danger" style={{ marginRight: 'auto', fontSize: 11 }}>
                        {lowStockAlerts.length}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )
          })}
        </nav>

        <div className="sidebar-footer">
          <div className="user-info">
            <div className="user-avatar">{user.fullName.charAt(0)}</div>
            <div className="user-details">
              <div className="user-name">{user.fullName}</div>
              <div className="user-role-badge">
                {user.role === 'owner' ? '👑 مدير النظام' : user.role === 'accountant' ? '📊 محاسب مالي' : '💼 كاشير مبيعات'}
              </div>
            </div>
          </div>
          <WorkShiftBadge />
          {/* Here rather than on one screen: whoever closes the till — cashier, owner
              or accountant — has to reach it from wherever they happen to be. */}
          <button className="btn btn-secondary btn-sm" style={{ width: '100%', marginBottom: 6 }} onClick={() => setClosingOpen(true)}>
            🧾 تقفيل الوردية
          </button>
          <button className="btn btn-ghost btn-sm" style={{ width: '100%', color: 'var(--danger)' }} onClick={handleLogout}>
            🚪 تسجيل الخروج
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="main-content">
        <React.Suspense
          fallback={<div className="empty-state"><div className="empty-state-text">جاري التحميل...</div></div>}
        >
          {screens[currentScreen]}
        </React.Suspense>
      </main>

      {closingOpen && <ClosingModal onClose={() => setClosingOpen(false)} />}
      <WorkShiftGate />
      {shiftExport && <ShiftExportBanner data={shiftExport} onClose={() => setShiftExport(null)} />}
    </div>
  )
}

/**
 * "The shift's report is ready" — with the two things anybody would do next.
 *
 * Pinned bottom-left and dismissed by hand. A shift closes when the person who worked
 * it is walking out, so this has to survive being ignored for a few minutes.
 */
function ShiftExportBanner({ data, onClose }: { data: any; onClose: () => void }) {
  const [busy, setBusy] = React.useState(false)
  const [note, setNote] = React.useState('')

  if (data?.error) {
    return (
      <div className="card" style={bannerStyle}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
          <b style={{ color: 'var(--danger)' }}>⚠️ تعذر كتابة تقرير الوردية</b>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>✕</button>
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>{data.error}</div>
      </div>
    )
  }

  const money = (n: number) =>
    (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

  const share = async () => {
    setBusy(true)
    const res = await window.api.shareShiftToGroup(data.shiftId, data, !!data.work)
    setBusy(false)
    if (!res.success) { setNote(res.error || 'تعذر فتح واتساب'); return }
    setNote(res.data?.prefilled === false
      ? 'واتساب فتح الجروب بدون نص — الملخص في الحافظة، والمجلد مفتوح لسحب الملفين.'
      : 'اسحب الملفين من المجلد المفتوح داخل المحادثة.')
    if (res.data?.prefilled === false) {
      try { await navigator.clipboard?.writeText(data.summaryText || '') } catch { /* no clipboard */ }
    }
  }

  return (
    <div className="card" style={bannerStyle}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
        <div>
          <b>✅ تقرير الوردية جاهز</b>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3, lineHeight: 1.7 }}>
            {data.shiftName} · {data.shiftDate} · {data.cashierName}
            <br />
            المبيعات {money(data.revenue)} · {data.orderCount} فاتورة ·
            {' '}الدرج {money(data.expectedCash)}
          </div>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={onClose}>✕</button>
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <button className="btn btn-success btn-sm" onClick={share} disabled={busy}>
          {busy ? '⏳' : '💬 إرسال للجروب'}
        </button>
        <button
          className="btn btn-secondary btn-sm"
          onClick={() => window.api.openShiftExportFolder(data.folder)}
        >
          📂 PDF + Excel
        </button>
      </div>

      {note && <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 8, lineHeight: 1.7 }}>{note}</div>}
    </div>
  )
}

const bannerStyle: React.CSSProperties = {
  position: 'fixed', bottom: 18, left: 18, zIndex: 900,
  width: 330, padding: 14, boxShadow: '0 10px 30px rgba(0,0,0,0.25)',
}

export default App
