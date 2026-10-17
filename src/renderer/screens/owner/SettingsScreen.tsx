import React, { useState, useEffect } from 'react'
import type { AppSettings, DeliveryArea, DeliveryDriver, BackupFile } from '../../../shared/types'
import { useSettingsStore } from '../../state/stores'
import NumberInput from '../../components/NumberInput'
import PrinterSettings from './PrinterSettings'
import NetworkSettings from './NetworkSettings'
import ShopDataPanel from './ShopDataPanel'
import UsersScreen from './UsersScreen'
import { THEMES, currentTheme, setTheme, type ThemeId } from '../../lib/theme'

/**
 * The settings open on a PIN, every time.
 *
 * Being signed in as the owner is not enough on its own: that password ends up with
 * whoever is running the shop that week, and this screen is where the tax rate, the
 * shift hours and the discount cap are set. The PIN is checked in the main process and
 * the screen locks again the moment it is left.
 */
export default function SettingsScreen() {
  const [open, setOpen] = useState(false)
  const [pin, setPin] = useState('')
  const [error, setError] = useState('')
  const [checking, setChecking] = useState(false)

  // Leaving the screen locks it, so coming back asks again.
  useEffect(() => () => { void window.api.lockSettings() }, [])

  if (open) return <SettingsBody />

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!pin || checking) return
    setChecking(true)
    const res = await window.api.unlockSettings(pin)
    setChecking(false)
    setPin('')
    if (res.success) { setError(''); setOpen(true) }
    else setError(res.error || 'الرقم السري غير صحيح')
  }

  return (
    <div className="animate-fade" dir="rtl" style={{ display: 'flex', justifyContent: 'center', paddingTop: '12vh' }}>
      <form className="card" onSubmit={submit} style={{ width: 360, textAlign: 'center', padding: 28 }}>
        <div style={{ fontSize: 40, marginBottom: 8 }}>🔒</div>
        <h2 style={{ marginBottom: 6 }}>إعدادات النظام</h2>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 18 }}>
          أدخل الرقم السري لفتح الإعدادات
        </p>
        <input
          className="input"
          type="password"
          inputMode="numeric"
          autoComplete="off"
          autoFocus
          value={pin}
          onChange={e => setPin(e.target.value.replace(/\D/g, '').slice(0, 12))}
          style={{ textAlign: 'center', fontSize: 22, letterSpacing: 6, direction: 'ltr' }}
        />
        {error && (
          <div className="badge badge-danger" style={{ marginTop: 12, padding: '8px 12px', fontSize: 13 }}>
            ⚠️ {error}
          </div>
        )}
        <button className="btn btn-primary" type="submit" disabled={!pin || checking} style={{ width: '100%', marginTop: 16 }}>
          {checking ? '⏳ جاري التحقق...' : 'فتح الإعدادات'}
        </button>
      </form>
    </div>
  )
}

type SettingsTab = 'shop' | 'shifts' | 'delivery' | 'printing' | 'network' | 'users' | 'data' | 'security'

const SETTINGS_TABS: { id: SettingsTab; label: string }[] = [
  { id: 'shop', label: '🏢 المطعم والضريبة' },
  { id: 'shifts', label: '🕒 الورديات' },
  { id: 'delivery', label: '🛵 التوصيل' },
  { id: 'printing', label: '🖨️ الطابعات' },
  { id: 'network', label: '🖧 الأجهزة والشبكة' },
  // The four sign-in accounts: behind the settings PIN with everything else that
  // decides who may do what, rather than an entry of their own in the sidebar.
  { id: 'users', label: '🔑 المستخدمون' },
  { id: 'data', label: '📦 تصدير البيانات' },
  { id: 'security', label: '🛡️ الأمان والنسخ الاحتياطي' },
]

function SettingsBody() {
  const storeSettings = useSettingsStore((s) => s.settings)
  const [settings, setSettings] = useState<Partial<AppSettings>>(storeSettings)
  const [areas, setAreas] = useState<DeliveryArea[]>([])
  const [drivers, setDrivers] = useState<DeliveryDriver[]>([])
  const [toast, setToast] = useState<{ msg: string; type: string } | null>(null)
  const [saving, setSaving] = useState(false)

  // Forms for new delivery area and driver
  const [newAreaName, setNewAreaName] = useState('')
  const [newAreaFee, setNewAreaFee] = useState('')
  const [newDriverName, setNewDriverName] = useState('')
  const [newDriverPhone, setNewDriverPhone] = useState('')

  // Inline editing of an existing delivery area
  const [editingAreaId, setEditingAreaId] = useState<number | null>(null)
  const [editAreaName, setEditAreaName] = useState('')
  const [editAreaFee, setEditAreaFee] = useState('')

  // Changing your own password
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [changingCreds, setChangingCreds] = useState(false)

  // Backups & restore
  const [backups, setBackups] = useState<BackupFile[]>([])
  const [restoreTarget, setRestoreTarget] = useState<BackupFile | null>(null)
  const [restoreCheck, setRestoreCheck] = useState<{ ok: boolean; error?: string; orders?: number } | null>(null)
  const [restorePassword, setRestorePassword] = useState('')
  const [restoring, setRestoring] = useState(false)

  // Starting the system over
  const [resetOpen, setResetOpen] = useState(false)
  const [resetPassword, setResetPassword] = useState('')
  const [resetWord, setResetWord] = useState('')
  const [resetting, setResetting] = useState(false)
  // The showcase account rebuilds itself daily; resetting it would mean nothing, and
  // the main process refuses it regardless. Do not offer what cannot happen.
  const [isShowcase, setIsShowcase] = useState(false)

  useEffect(() => {
    window.api.getAppMode?.().then((res: any) => {
      if (res?.success) setIsShowcase(!!res.data.demo)
    })
  }, [])

  useEffect(() => {
    loadDeliveryData()
    loadBackups()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /**
   * Has anyone actually typed in this form yet?
   *
   * The draft is a COPY of the shared store, so a push from the main process cannot
   * overwrite half-typed text. Seeding it once on mount was wrong though: the store is
   * filled in asynchronously — before sign-in the main process only returns the public
   * branding keys, and the real set arrives a moment later — so a screen opened
   * quickly enough copied the DEFAULTS instead.
   *
   * The result was a settings page showing 14% VAT and two shifts to a shop that had
   * neither, warning about unsaved changes nobody had made, and writing those defaults
   * over the real values the moment anything was saved. Whether it happened came down
   * to how fast the owner clicked, which is exactly the kind of bug that gets reported
   * as "sometimes".
   *
   * So the draft keeps following the store until somebody edits it, and from that
   * moment it is theirs alone.
   */
  // One group of settings on screen at a time. Everything stays mounted — a tab only
  // hides — so a half-typed change in one group survives a look at another.
  const [tab, setTab] = useState<SettingsTab>('shop')
  // The colours are this screen's own business — they apply at once and are not part
  // of the settings saved with the button above.
  const [theme, setThemeState] = useState<ThemeId>(() => currentTheme())
  const chooseTheme = (id: ThemeId) => { setTheme(id); setThemeState(id) }
  const only = (t: SettingsTab): React.CSSProperties => (tab === t ? {} : { display: 'none' })
  // The showcase account does not show this installation's real usernames.
  const [showcase, setShowcase] = useState(false)
  useEffect(() => {
    window.api?.getAppMode?.().then((res: any) => { if (res?.success) setShowcase(!!res.data.demo) })
  }, [])

  const touched = React.useRef(false)

  useEffect(() => {
    if (touched.current) return
    setSettings(storeSettings)
  }, [storeSettings])

  /** Does the draft differ from what is actually saved? Drives the unsaved warning. */
  const dirty = React.useMemo(() => {
    const keys = new Set([...Object.keys(settings), ...Object.keys(storeSettings)])
    for (const k of keys) {
      const a = (settings as any)[k]
      const b = (storeSettings as any)[k]
      if (a === undefined && b === undefined) continue
      if (String(a ?? '') !== String(b ?? '')) return true
    }
    return false
  }, [settings, storeSettings])

  const loadDeliveryData = async () => {
    const [areaRes, driverRes] = await Promise.all([
      window.api.listDeliveryAreas(),
      window.api.listDeliveryDrivers()
    ])
    if (areaRes.success) setAreas(areaRes.data)
    if (driverRes.success) setDrivers(driverRes.data)
  }

  const showToast = (msg: string, type = 'success') => {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3000)
  }

  const save = async () => {
    setSaving(true)
    const res = await window.api.updateSettings(settings)
    if (res.success) {
      // Saved, so the draft and the store agree again — let it follow along once more.
      // Without this a node whose master changes something would sit showing the old
      // values until the screen was closed and reopened.
      touched.current = false
      showToast('تم حفظ وتحديث الإعدادات بنجاح')
    } else {
      showToast(res.error || 'فشل حفظ الإعدادات', 'error')
    }
    setSaving(false)
  }

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!currentPassword || !newPassword) return
    if (newPassword.length < 6) {
      showToast('كلمة المرور يجب أن تكون 6 أحرف على الأقل', 'error')
      return
    }

    setChangingCreds(true)
    try {
      const res = await window.api.changeOwnPassword(currentPassword, newPassword)
      if (res.success) {
        showToast('تم تحديث كلمة المرور بنجاح')
        setCurrentPassword(''); setNewPassword('')
      } else {
        showToast(res.error || 'فشل تغيير كلمة المرور', 'error')
      }
    } catch (err: any) {
      showToast(err?.message || 'فشل تحديث بيانات الدخول', 'error')
    }
    setChangingCreds(false)
  }

  const handleBackup = async () => {
    const res = await window.api.backup()
    if (res.success) {
      showToast('تم إنشاء نسخة احتياطية بنجاح')
      loadBackups()
    } else {
      showToast(res.error || 'فشل إنشاء النسخة الاحتياطية', 'error')
    }
  }

  const loadBackups = async () => {
    const res = await window.api.listBackups()
    if (res.success) setBackups(res.data)
  }

  /** Check the file before offering to restore it, so a corrupt one is caught early. */
  const askRestore = async (backup: BackupFile) => {
    setRestoreTarget(backup)
    setRestorePassword('')
    setRestoreCheck(null)
    const res = await window.api.verifyBackup(backup.filePath)
    setRestoreCheck(res.success ? res.data : { ok: false, error: res.error })
  }

  const doRestore = async () => {
    if (!restoreTarget) return
    setRestoring(true)
    const res = await window.api.restoreBackup(restoreTarget.filePath, restorePassword)
    // On success the main process reloads the window, so nothing here runs after.
    if (!res.success) {
      setRestoring(false)
      showToast(res.error || 'فشلت الاستعادة', 'error')
    }
  }

  const doReset = async () => {
    setResetting(true)
    const res = await window.api.resetSystem(resetPassword)
    // On success the main process reloads the window, so nothing here runs after.
    if (!res.success) {
      setResetting(false)
      showToast(res.error || 'تعذر تصفير النظام', 'error')
    }
  }

  const update = (key: keyof AppSettings, value: string | number) => {
    // From the first keystroke the draft stops following the store — see `touched`.
    touched.current = true
    setSettings((s: Partial<AppSettings>) => ({ ...s, [key]: value }))
  }

  const handleAddArea = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newAreaName.trim() || isNaN(Number(newAreaFee))) return
    const res = await window.api.upsertDeliveryArea({
      areaName: newAreaName,
      deliveryFee: Number(newAreaFee)
    })
    if (res.success) {
      showToast('تم إضافة المنطقة بنجاح')
      setNewAreaName('')
      setNewAreaFee('')
      loadDeliveryData()
    }
  }

  const handleToggleArea = async (area: DeliveryArea) => {
    const res = await window.api.upsertDeliveryArea({
      areaId: area.delivery_area_id,
      areaName: area.area_name,
      deliveryFee: area.delivery_fee,
      isActive: area.is_active ? 0 : 1
    })
    if (res.success) loadDeliveryData()
  }

  const startEditArea = (area: DeliveryArea) => {
    setEditingAreaId(area.delivery_area_id)
    setEditAreaName(area.area_name)
    setEditAreaFee(String(area.delivery_fee))
  }

  const cancelEditArea = () => {
    setEditingAreaId(null)
    setEditAreaName('')
    setEditAreaFee('')
  }

  const saveEditArea = async (area: DeliveryArea) => {
    if (!editAreaName.trim() || isNaN(Number(editAreaFee))) return
    const res = await window.api.upsertDeliveryArea({
      areaId: area.delivery_area_id,
      areaName: editAreaName,
      deliveryFee: Number(editAreaFee),
      isActive: area.is_active
    })
    if (res.success) {
      showToast('تم تحديث منطقة التوصيل بنجاح')
      cancelEditArea()
      loadDeliveryData()
    } else {
      showToast(res.error || 'فشل تحديث المنطقة', 'error')
    }
  }

  /**
   * Both of these ask first, then report what the main process actually did — it
   * deletes a zone or driver with no history, and retires one that invoices point at
   * rather than breaking the link. The confirm text says which is about to happen so
   * nobody presses "حذف" expecting one and getting the other.
   */
  const handleDeleteArea = async (area: DeliveryArea) => {
    if (!confirm(
      `حذف منطقة "${area.area_name}"؟\n\n` +
      `إذا كانت هناك فواتير توصيل سابقة لهذه المنطقة سيتم إيقافها بدلاً من حذفها، ` +
      `حتى تظل تلك الفواتير صحيحة.`
    )) return

    const res = await window.api.deleteDeliveryArea(area.delivery_area_id)
    if (res.success) {
      showToast(res.data.message)
      loadDeliveryData()
    } else {
      showToast(res.error || 'تعذر حذف المنطقة', 'error')
    }
  }

  const handleDeleteDriver = async (driver: DeliveryDriver) => {
    if (!confirm(
      `حذف السائق "${driver.full_name}"؟\n\n` +
      `إذا كان مرتبطاً بطلبات أو تسويات سابقة سيتم إيقافه بدلاً من حذفه. ` +
      `ولو كان معه تحصيل لم يُسلَّم بعد فلن يُحذف حتى تسوية حسابه.`
    )) return

    const res = await window.api.deleteDeliveryDriver(driver.driver_id)
    if (res.success) {
      showToast(res.data.message)
      loadDeliveryData()
    } else {
      showToast(res.error || 'تعذر حذف السائق', 'error')
    }
  }

  const handleAddDriver = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newDriverName.trim()) return
    const res = await window.api.upsertDeliveryDriver({
      fullName: newDriverName,
      phone: newDriverPhone
    })
    if (res.success) {
      showToast('تم إضافة السائق بنجاح')
      setNewDriverName('')
      setNewDriverPhone('')
      loadDeliveryData()
    }
  }

  const handleToggleDriver = async (driver: DeliveryDriver) => {
    const res = await window.api.upsertDeliveryDriver({
      driverId: driver.driver_id,
      fullName: driver.full_name,
      phone: driver.phone,
      isActive: driver.is_active ? 0 : 1
    })
    if (res.success) loadDeliveryData()
  }

  return (
    <div className="animate-fade" dir="rtl" style={{ overflowY: 'auto', maxHeight: '100%' }}>
      {/* Page Header */}
      <div className="page-header">
        <div>
          <h1 className="page-title">إعدادات النظام والمطعم</h1>
          <p className="page-subtitle">تخصيص بيانات الفاتورة، الضرائب، التوصيل، العملة، والنسخ الاحتياطي</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {dirty && (
            <span className="badge badge-warning" style={{ padding: '7px 12px', fontSize: 12.5 }}>
              ⚠️ تغييرات لم تُحفظ
            </span>
          )}
          <button className="btn btn-primary" onClick={save} disabled={saving}>
            {saving ? 'جاري الحفظ...' : '💾 حفظ التغييرات'}
          </button>
        </div>
      </div>

      {/*
        Nothing on this screen takes effect until the button above is pressed. That is
        fine for a text box, which plainly still has a cursor in it — but the shift
        toggle below is a pair of buttons that light up the moment they are pressed, so
        choosing "وردية واحدة" looked like it had applied and had not. The consequence
        showed up much later and somewhere else: reports and the files sent to the
        group kept being headed «مسائية» for a night shift the shop no longer ran.
      */}
      {dirty && (
        <div
          style={{
            background: 'var(--warning-bg)', borderRight: '3px solid var(--warning)',
            borderRadius: 'var(--radius-sm)', padding: '10px 14px', marginBottom: 16, fontSize: 13,
          }}
        >
          لديك تعديلات لم تُحفظ بعد — اضغط <b>💾 حفظ التغييرات</b> حتى تُطبَّق على النظام.
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 18 }}>
        {SETTINGS_TABS.filter(x => !(showcase && x.id === 'users')).map(x => (
          <button
            key={x.id}
            className={`cat-pill-btn ${tab === x.id ? 'active' : ''}`}
            onClick={() => setTab(x.id)}
          >
            {x.label}
          </button>
        ))}
      </div>

      {/* Colours — first on the first tab, because it is the one setting that changes
          how every other one looks. */}
      <div className="card" style={{ marginBottom: 18, ...only('shop') }}>
        <div className="card-header">
          <span className="card-title">🎨 ألوان البرنامج</span>
        </div>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          {THEMES.map(t => (
            <button
              key={t.id}
              type="button"
              onClick={() => chooseTheme(t.id)}
              style={{
                flex: '1 1 260px', textAlign: 'right', cursor: 'pointer', fontFamily: 'inherit',
                padding: '12px 14px', borderRadius: 'var(--radius-md)',
                background: theme === t.id ? 'var(--accent-subtle)' : 'var(--bg-card-hover)',
                border: `2px solid ${theme === t.id ? 'var(--accent)' : 'var(--border)'}`,
                color: 'var(--text-primary)',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
                <b style={{ fontSize: 15 }}>{theme === t.id ? '✓ ' : ''}{t.label}</b>
                <span style={{ display: 'flex', gap: 4 }}>
                  {t.swatches.map(c => (
                    <span key={c} style={{ width: 20, height: 20, borderRadius: 6, background: c, border: '1px solid rgba(0,0,0,0.15)' }} />
                  ))}
                </span>
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 5 }}>{t.hint}</div>
            </button>
          ))}
        </div>
        <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 10 }}>
          يتغير فوراً، ويُحفظ على هذا الجهاز فقط.
        </p>
      </div>

      <div className="grid-2" style={tab === 'shop' || tab === 'shifts' || tab === 'delivery' ? undefined : { display: 'none' }}>
        {/* Business Information */}
        <div className="card" style={only('shop')}>
          <div className="card-header">
            <span className="card-title">🏢 بيانات المطعم والفاتورة</span>
          </div>
          <div className="form-group">
            <label className="form-label">اسم المطعم / المنشأة</label>
            <input className="input" value={settings.business_name || ''} onChange={(e) => update('business_name', e.target.value)} placeholder="مطعم تشيكن كينج" />
          </div>
          <div className="form-group">
            <label className="form-label">العنوان (يظهر في الفاتورة)</label>
            <input className="input" value={settings.business_address || ''} onChange={(e) => update('business_address', e.target.value)} placeholder="شارع النصر، المعادي، القاهرة" />
          </div>
          <div className="form-group">
            <label className="form-label">رقم الهاتف والتواصل</label>
            <input className="input" value={settings.business_phone || ''} onChange={(e) => update('business_phone', e.target.value)} placeholder="01012345678" />
          </div>
          <div className="form-group">
            <label className="form-label">جملة تذييل الفاتورة</label>
            <input className="input" value={settings.receipt_footer || ''} onChange={(e) => update('receipt_footer', e.target.value)} placeholder="شكراً لزيارتكم! بالهناء والشفاء ❤️" />
          </div>
        </div>

        {/* Financial & Taxes */}
        <div className="card" style={only('shop')}>
          <div className="card-header">
            <span className="card-title">💰 الضرائب والعملة والخصومات</span>
          </div>
          <div className="form-group">
            <label className="form-label">نسبة ضريبة القيمة المضافة (%)</label>
            <NumberInput
              // Kept to 4 decimal places of a RATE (2 of a percent), so 14.5% survives
              // the trip to the database and back instead of being rounded to 15.
              value={Number.isFinite(settings.tax_rate)
                ? Math.round((settings.tax_rate as number) * 10000) / 100
                : 0}
              onValueChange={(v) => update('tax_rate', Math.round(v * 100) / 10000)}
              decimals={2}
              placeholder="14"
            />
            <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.7 }}>
              تُحسب على طلبات <b>الصالة (الداخلي)</b> فقط — التيك أواي والدليفري بدون ضريبة.
              {' '}اكتب <b>0</b> لإيقاف الضريبة نهائياً.
            </p>
          </div>
          <div className="form-group">
            <label className="form-label">رمز العملة (مثال: ج.م أو EGP أو ر.س)</label>
            <input className="input" value={settings.currency_symbol || ''} onChange={(e) => update('currency_symbol', e.target.value)} placeholder="ج.م" />
          </div>
          <div className="form-group">
            <label className="form-label">الحد الأقصى لخصم الكاشير (%)</label>
            <NumberInput
              value={settings.max_cashier_discount}
              onValueChange={(v) => update('max_cashier_discount', v)}
              decimals={0}
              placeholder="15"
            />
            <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.7 }}>
              يُطبَّق على <b>الكاشير فقط</b>. المدير والمحاسب ليس عليهما حد — لو جرّبته
              {' '}وأنت داخل بحساب المدير ستجده يقبل أي نسبة، وهذا مقصود.
            </p>
          </div>
        </div>

        {/* Shift Times */}
        <div className="card" style={only('shifts')}>
          <div className="card-header">
            <span className="card-title">🕒 مواعيد الورديات</span>
          </div>
          <ul style={{ fontSize: 13, color: 'var(--text-muted)', margin: '0 0 14px', paddingRight: 18, lineHeight: 2 }}>
            <li><b>الوردية تبدأ وتنتهي تلقائياً</b> في المواعيد المحددة هنا.</li>
            <li>بعد نهاية الوردية <b>لا يمكن تسجيل فواتير</b> حتى تبدأ الوردية التالية في موعدها — أو يبدأ المدير وردية إضافية يدوياً.</li>
            <li><b>ترقيم الفواتير يبدأ من 0001 مع كل وردية</b>، وكل المبيعات والمصروفات والمرتبات تُحسب على الوردية التي حدثت فيها.</li>
            <li>لو نهاية الوردية بعد منتصف الليل (مثلاً <span style={{ direction: 'ltr', display: 'inline-block' }}>03:00</span>) اكتبها كما هي.</li>
          </ul>
          <div className="form-group" style={{ marginBottom: 14 }}>
            <label className="form-label">عدد الورديات في اليوم</label>
            <div style={{ display: 'flex', gap: 8 }}>
              {[1, 2].map(n => (
                <button
                  key={n}
                  type="button"
                  className={`btn ${Number(settings.shifts_per_day ?? 2) === n ? 'btn-primary' : ''}`}
                  onClick={() => update('shifts_per_day', n)}
                  style={{ flex: 1 }}
                >
                  {n === 1 ? 'وردية واحدة' : 'ورديتان'}
                </button>
              ))}
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginBottom: 14 }}>
            <div className="form-group">
              <label className="form-label">اسم الوردية الأولى</label>
              <input className="input" value={settings.shift1_name || ''} onChange={(e) => update('shift1_name', e.target.value)} placeholder="صباحية" />
            </div>
            <div className="form-group">
              <label className="form-label">بداية الوردية الأولى</label>
              <input className="input" type="time" value={settings.shift1_start || ''} onChange={(e) => update('shift1_start', e.target.value)} />
            </div>
            <div className="form-group">
              <label className="form-label">نهاية الوردية الأولى</label>
              <input className="input" type="time" value={settings.shift1_end || ''} onChange={(e) => update('shift1_end', e.target.value)} />
            </div>
          </div>
          {/* Hidden, not deleted, on one-shift days: the times stay in the settings so
              switching back to two restores what was there before. */}
          {Number(settings.shifts_per_day ?? 2) === 2 ? (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
              <div className="form-group">
                <label className="form-label">اسم الوردية الثانية</label>
                <input className="input" value={settings.shift2_name || ''} onChange={(e) => update('shift2_name', e.target.value)} placeholder="مسائية" />
              </div>
              <div className="form-group">
                <label className="form-label">بداية الوردية الثانية</label>
                <input className="input" type="time" value={settings.shift2_start || ''} onChange={(e) => update('shift2_start', e.target.value)} />
              </div>
              <div className="form-group">
                <label className="form-label">نهاية الوردية الثانية</label>
                <input className="input" type="time" value={settings.shift2_end || ''} onChange={(e) => update('shift2_end', e.target.value)} />
              </div>
            </div>
          ) : (
            <div style={{
              background: 'var(--bg-card-hover)', borderRadius: 'var(--radius-sm)',
              padding: 12, fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.8,
            }}>
              وردية واحدة تغطي اليوم كله: تبدأ
              {' '}<b style={{ direction: 'ltr', display: 'inline-block' }}>{settings.shift1_start || '09:00'}</b>{' '}
              وتُقفل تلقائياً
              {' '}<b style={{ direction: 'ltr', display: 'inline-block' }}>{settings.shift1_end || '17:00'}</b>.
              مواعيد الوردية الثانية محفوظة ولم تُحذف.
            </div>
          )}
        </div>

        {/* End-of-shift report — written automatically, sent by hand */}
        <div className="card" style={only('shifts')}>
          <div className="card-header">
            <span className="card-title">📤 تقرير نهاية الوردية</span>
          </div>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 14, lineHeight: 1.9 }}>
            عند انتهاء كل وردية يُكتب تقريرها تلقائياً بصيغتَي <b>PDF</b> و<b>Excel</b> — تقرير واحد
            للوردية كلها: المبيعات، المصروفات، المرتبات، الربح، والنقدية المتوقعة في الدرج.
            الوردية التي لم يُباع فيها شيء لا يُكتب لها تقرير. ويمكنك دائماً فتح تقرير أي وردية من
            شاشة «الورديات».
          </p>
          <label style={{ display: 'flex', gap: 9, alignItems: 'flex-start', fontSize: 13, marginBottom: 14 }}>
            <input
              type="checkbox"
              checked={Number(settings.shift_export_auto ?? 1) === 1}
              onChange={e => update('shift_export_auto', e.target.checked ? 1 : 0)}
              style={{ marginTop: 3 }}
            />
            <span>
              <b>كتابة التقرير تلقائياً عند إقفال الوردية</b>
              <div style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 2 }}>
                بإيقافها لن يُكتب أي تقرير إلا بالضغط على «حفظ PDF + Excel» من شاشة الورديات.
              </div>
            </span>
          </label>

          <div className="form-group">
            <label className="form-label">جروب المطعم على واتساب</label>
            <input
              className="input"
              dir="ltr"
              value={settings.whatsapp_group || ''}
              onChange={e => update('whatsapp_group', e.target.value)}
              placeholder="https://chat.whatsapp.com/...  أو رقم موبايل"
            />
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6, lineHeight: 1.8 }}>
              زر «إرسال للجروب» يفتح واتساب على هذا الجروب ويفتح معه المجلد الذي فيه
              الملفان لسحبهما داخل المحادثة. واتساب لا يسمح لأي برنامج بإرسال ملف إلى
              جروب من تلقاء نفسه، فالإرسال يظل بضغطة منك — لكن كل ما قبلها جاهز.
              {' '}<b>رقم موبايل</b> يجعل نص الملخص مكتوباً مسبقاً؛ <b>رابط الجروب</b>
              {' '}يفتح الجروب فقط لأن واتساب لا يقبل نصاً مع الرابط.
            </div>
          </div>

          <div className="form-group">
            <label className="form-label">مجلد حفظ التقارير</label>
            <input
              className="input"
              dir="ltr"
              value={settings.shift_export_folder || ''}
              onChange={e => update('shift_export_folder', e.target.value)}
              placeholder="اتركه فارغاً للحفظ بجوار قاعدة البيانات"
            />
          </div>

          <button
            className="btn btn-secondary btn-sm"
            type="button"
            onClick={() => window.api.openShiftExportFolder()}
          >
            📂 فتح مجلد التقارير
          </button>
        </div>

        {/* Delivery Areas */}
        <div className="card" style={only('delivery')}>
          <div className="card-header">
            <span className="card-title">🗺️ مناطق التوصيل</span>
          </div>
          <form onSubmit={handleAddArea} style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
            <input className="input" style={{ flex: 2 }} placeholder="اسم المنطقة..." value={newAreaName} onChange={e => setNewAreaName(e.target.value)} required />
            <NumberInput
              style={{ flex: 1 }}
              placeholder="رسوم التوصيل..."
              value={newAreaFee === '' ? null : Number(newAreaFee)}
              onValueChange={v => setNewAreaFee(v === 0 ? '' : String(v))}
            />
            <button className="btn btn-secondary" type="submit">إضافة</button>
          </form>
          <div style={{ maxHeight: 200, overflowY: 'auto' }}>
            <table className="receipt-table">
              <tbody>
                {areas.map(a => (
                  <tr key={a.delivery_area_id} style={{ opacity: a.is_active ? 1 : 0.5 }}>
                    {editingAreaId === a.delivery_area_id ? (
                      <>
                        <td>
                          <input className="input" style={{ padding: '4px 8px', fontSize: 13 }} value={editAreaName} onChange={e => setEditAreaName(e.target.value)} />
                        </td>
                        <td>
                          <NumberInput
                            style={{ padding: '4px 8px', fontSize: 13, width: 90 }}
                            value={editAreaFee === '' ? null : Number(editAreaFee)}
                            onValueChange={v => setEditAreaFee(v === 0 ? '' : String(v))}
                          />
                        </td>
                        <td style={{ textAlign: 'left', whiteSpace: 'nowrap' }}>
                          <button className="btn btn-sm btn-primary" onClick={() => saveEditArea(a)}>حفظ</button>
                          <button className="btn btn-sm btn-ghost" onClick={cancelEditArea}>إلغاء</button>
                        </td>
                      </>
                    ) : (
                      <>
                        <td>{a.area_name}</td>
                        <td>{a.delivery_fee.toFixed(2)} ج.م</td>
                        <td style={{ textAlign: 'left', whiteSpace: 'nowrap' }}>
                          <button className="btn btn-sm btn-ghost" onClick={() => startEditArea(a)}>تعديل</button>
                          <button className="btn btn-sm btn-ghost" onClick={() => handleToggleArea(a)}>
                            {a.is_active ? 'إيقاف' : 'تفعيل'}
                          </button>
                          <button
                            className="btn btn-sm btn-ghost" style={{ color: 'var(--danger)' }}
                            onClick={() => handleDeleteArea(a)}
                          >
                            حذف
                          </button>
                        </td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Delivery Drivers */}
        <div className="card" style={only('delivery')}>
          <div className="card-header">
            <span className="card-title">🛵 السائقين (الطيارين)</span>
          </div>
          <form onSubmit={handleAddDriver} style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
            <input className="input" style={{ flex: 2 }} placeholder="اسم السائق..." value={newDriverName} onChange={e => setNewDriverName(e.target.value)} required />
            <input className="input" style={{ flex: 2 }} placeholder="رقم الهاتف (اختياري)..." value={newDriverPhone} onChange={e => setNewDriverPhone(e.target.value)} />
            <button className="btn btn-secondary" type="submit">إضافة</button>
          </form>
          <div style={{ maxHeight: 200, overflowY: 'auto' }}>
            <table className="receipt-table">
              <tbody>
                {drivers.map(d => (
                  <tr key={d.driver_id} style={{ opacity: d.is_active ? 1 : 0.5 }}>
                    <td>{d.full_name}</td>
                    <td>{d.phone || '-'}</td>
                    <td style={{ textAlign: 'left', whiteSpace: 'nowrap' }}>
                      <button className="btn btn-sm btn-ghost" onClick={() => handleToggleDriver(d)}>
                        {d.is_active ? 'إيقاف' : 'تفعيل'}
                      </button>
                      <button
                        className="btn btn-sm btn-ghost" style={{ color: 'var(--danger)' }}
                        onClick={() => handleDeleteDriver(d)}
                      >
                        حذف
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Printers. The per-printer settings save themselves as they are edited; the
          three global toggles inside ride along with this page's حفظ button. */}
      <div style={only('printing')}>
        <PrinterSettings settings={settings} update={update} showToast={showToast} />
      </div>

      {/* Linking a second till. Saves and applies itself — it is not part of this
          page's حفظ button, because switching mode restarts the network layer. */}
      <div style={only('network')}>
        <NetworkSettings showToast={showToast} />
      </div>

      {tab === 'users' && !showcase && <UsersScreen />}

      <div style={only('data')}>
        <ShopDataPanel showToast={showToast} active={tab === 'data'} />
      </div>

      {/* Change your own credentials — the app ships with known defaults, so this
          is the screen the default-credentials banner sends people to. */}
      <div className="card" style={{ marginTop: 20, ...only('security') }}>
        <div className="card-header">
          <span className="card-title">🔐 تغيير بيانات الدخول الخاصة بك</span>
        </div>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 14 }}>
          يُشحن النظام بكلمة مرور افتراضية معروفة. غيّرها فوراً بعد أول تشغيل.
        </p>

        <form onSubmit={handleChangePassword} style={{ display: 'grid', gap: 12, maxWidth: 520 }}>
          <div className="form-group">
            <label className="form-label">كلمة المرور الحالية</label>
            <input
              className="input" type="password" value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              placeholder="أدخل كلمة المرور الحالية"
              autoComplete="current-password"
            />
          </div>

          <div className="form-group">
            <label className="form-label">كلمة المرور الجديدة</label>
            <input
              className="input" type="password" value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="6 أحرف على الأقل"
              autoComplete="new-password"
            />
          </div>

          <div style={{ display: 'flex', gap: 10 }}>
            <button
              className="btn btn-primary"
              type="submit"
              disabled={changingCreds || !currentPassword || !newPassword}
            >
              {changingCreds ? 'جاري الحفظ...' : '💾 حفظ كلمة المرور'}
            </button>
          </div>
        </form>
      </div>

      {/* Database backup & restore */}
      <div className="card" style={{ marginTop: 20, marginBottom: 30, ...only('security') }}>
        <div className="card-header">
          <span className="card-title">🛡️ النسخ الاحتياطي واستعادة البيانات</span>
          <button className="btn btn-secondary btn-sm" onClick={() => window.api.openBackupFolder()}>
            📂 فتح مجلد النسخ
          </button>
        </div>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 14 }}>
          يحفظ النظام نسخة تلقائياً عند بدء التشغيل، عند الإغلاق، و<b>كل ساعة أثناء العمل</b> —
          حتى لا يضيع عمل يوم كامل عند انقطاع الكهرباء. تُحفظ كل نسخ آخر يومين، ثم نسخة يومية لمدة 60 يوماً.
        </p>

        <div style={{ display: 'flex', gap: 10, marginBottom: 18 }}>
          <button className="btn btn-primary" onClick={handleBackup}>
            💾 إنشاء نسخة احتياطية الآن
          </button>
          <button className="btn btn-secondary" onClick={loadBackups}>🔄 تحديث القائمة</button>
        </div>

        <div style={{ fontWeight: 800, fontSize: 13, marginBottom: 8 }}>
          النسخ المتاحة ({backups.length})
        </div>
        <div className="table-container" style={{ maxHeight: 260, overflowY: 'auto' }}>
          <table>
            <thead>
              <tr><th>التاريخ والوقت</th><th>النوع</th><th>الحجم</th><th>استعادة</th></tr>
            </thead>
            <tbody>
              {backups.map(b => (
                <tr key={b.filePath}>
                  <td style={{ fontWeight: 700 }}>
                    {new Date(b.createdAt).toLocaleString('ar-EG')}
                  </td>
                  <td>
                    {b.isPreRestore
                      ? <span className="badge badge-warning">قبل استعادة سابقة</span>
                      : <span className="badge badge-info">نسخة دورية</span>}
                  </td>
                  <td style={{ color: 'var(--text-muted)' }}>
                    {(b.sizeBytes / 1024 / 1024).toFixed(2)} MB
                  </td>
                  <td>
                    <button className="btn btn-danger btn-sm" onClick={() => askRestore(b)}>
                      ♻️ استعادة
                    </button>
                  </td>
                </tr>
              ))}
              {backups.length === 0 && (
                <tr><td colSpan={4} style={{ textAlign: 'center', padding: 20, color: 'var(--text-muted)' }}>
                  لا توجد نسخ احتياطية بعد
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Start the system over. Hidden entirely on the showcase account, which has
          nothing of its own to reset. */}
      {!isShowcase && (
        <div className="card" style={{ marginTop: 20, border: '1px solid rgba(217,45,32,0.35)', ...only('security') }}>
          <div className="card-header">
            <span className="card-title" style={{ color: 'var(--danger)' }}>🧹 تصفير النظام</span>
          </div>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 14, lineHeight: 1.7 }}>
            يبدأ الدفاتر من جديد: تُمسح الفواتير والمبيعات والمصروفات والمرتبات والحضور
            والورديات وحسابات الموردين، ويعود ترقيم الفواتير إلى 1.
            <br />
            <b>تبقى قائمة الطعام والمخزون كما هما</b> — نفس الأصناف بأسعارها وتكاليفها
            ومكوناتها، ونفس المواد الخام بأرصدتها الحالية. تبقى كذلك حسابات الدخول
            والإعدادات والطابعات.
            <br />
            <b>تُحفظ نسخة احتياطية تلقائياً قبل التصفير</b>، ولا يمكن التراجع بغير استعادتها.
          </p>
          <button className="btn btn-danger" onClick={() => { setResetOpen(true); setResetPassword('') }}>
            🧹 تصفير الحسابات والبدء من جديد
          </button>
        </div>
      )}

      {/* Reset confirmation — owner password, and the word typed out */}
      {resetOpen && (
        <div className="modal-overlay" onClick={() => !resetting && setResetOpen(false)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 500 }}>
            <h2 className="modal-title" style={{ color: 'var(--danger)' }}>⚠️ تصفير الحسابات</h2>

            <div style={{
              background: 'var(--danger-bg)', border: '1px solid rgba(217,45,32,0.28)',
              borderRadius: 'var(--radius-sm)', padding: 14, marginBottom: 12, fontSize: 13,
            }}>
              <b>سيُحذف نهائياً:</b>
              <ul style={{ margin: '8px 0 0', paddingRight: 18, lineHeight: 1.9 }}>
                <li>كل الفواتير والطلبات وسجل المبيعات</li>
                <li>حركات المخزون والتوريدات وحسابات الموردين</li>
                <li>المصروفات والمرتبات والحضور والورديات</li>
                <li>سجل عملاء الدليفري وتحصيلات السائقين</li>
              </ul>
            </div>

            <div style={{
              background: 'var(--success-bg)', borderRight: '3px solid var(--success)',
              borderRadius: 'var(--radius-sm)', padding: 14, marginBottom: 14, fontSize: 13,
            }}>
              <b>✅ يبقى كما هو:</b>
              <ul style={{ margin: '8px 0 0', paddingRight: 18, lineHeight: 1.9 }}>
                <li><b>قائمة الطعام كاملة</b> — الأقسام والأصناف وأسعارها وتكاليفها
                    ومكوناتها واختياراتها</li>
                <li><b>المخزون</b> — المواد الخام بأرصدتها الحالية وعمليات التجهيز</li>
                <li>حسابات الدخول، الإعدادات، الطابعات، مناطق التوصيل والسائقين، والعمال</li>
              </ul>
              <div style={{ marginTop: 10, fontSize: 12.5, color: 'var(--text-muted)' }}>
                أرصدة المخزون تبقى وتصبح رصيداً افتتاحياً — سجل الحركات تحتها هو ما يبدأ
                من الصفر. ويعود ترقيم الفواتير إلى 1.
              </div>
            </div>

            <div className="form-group">
              <label className="form-label">اكتب كلمة «تصفير» للتأكيد *</label>
              <input
                className="input" type="text" autoComplete="off" autoFocus
                value={resetWord} onChange={e => setResetWord(e.target.value)}
                placeholder="تصفير"
              />
            </div>

            <div className="form-group">
              <label className="form-label">كلمة مرور المدير *</label>
              <input
                className="input" type="password" autoComplete="off"
                value={resetPassword} onChange={e => setResetPassword(e.target.value)}
                placeholder="أدخل كلمة مرور المدير"
              />
            </div>

            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 18 }}>
              <button className="btn btn-secondary" onClick={() => setResetOpen(false)} disabled={resetting}>
                إلغاء
              </button>
              <button
                className="btn btn-danger"
                onClick={doReset}
                disabled={resetting || !resetPassword || resetWord.trim() !== 'تصفير'}
              >
                {resetting ? 'جاري التصفير...' : 'تصفير النظام'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Restore confirmation — owner password required */}
      {restoreTarget && (
        <div className="modal-overlay" onClick={() => !restoring && setRestoreTarget(null)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 480 }}>
            <h2 className="modal-title" style={{ color: 'var(--danger)' }}>⚠️ استعادة نسخة احتياطية</h2>

            <div style={{ background: 'var(--danger-bg)', border: '1px solid rgba(217,45,32,0.28)', borderRadius: 'var(--radius-sm)', padding: 14, marginBottom: 16, fontSize: 13 }}>
              سيتم <b>استبدال كل البيانات الحالية</b> بالبيانات الموجودة في هذه النسخة:
              الفواتير، المخزون، المصروفات، المرتبات — كل شيء.
              <div style={{ marginTop: 8, fontWeight: 800 }}>
                {new Date(restoreTarget.createdAt).toLocaleString('ar-EG')}
              </div>
              {restoreCheck?.ok && (
                <div style={{ marginTop: 6, color: 'var(--text-secondary)' }}>
                  تحتوي على <b>{restoreCheck.orders}</b> فاتورة.
                </div>
              )}
              {restoreCheck && !restoreCheck.ok && (
                <div style={{ marginTop: 6, fontWeight: 800 }}>❌ {restoreCheck.error}</div>
              )}
            </div>

            <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
              سيتم حفظ نسخة من البيانات الحالية قبل الاستبدال، حتى يمكن التراجع إذا اخترت النسخة الخطأ.
            </p>

            <div className="form-group">
              <label className="form-label">كلمة مرور المدير للتأكيد *</label>
              <input
                className="input"
                type="password"
                value={restorePassword}
                onChange={e => setRestorePassword(e.target.value)}
                placeholder="أدخل كلمة مرور المدير"
                autoComplete="off"
                autoFocus
              />
            </div>

            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 18 }}>
              <button className="btn btn-secondary" onClick={() => setRestoreTarget(null)} disabled={restoring}>
                إلغاء
              </button>
              <button
                className="btn btn-danger"
                onClick={doRestore}
                disabled={restoring || !restorePassword || !restoreCheck?.ok}
              >
                {restoring ? 'جاري الاستعادة...' : 'تأكيد الاستعادة'}
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && <div className={`toast toast-${toast.type}`}>{toast.msg}</div>}
    </div>
  )
}
