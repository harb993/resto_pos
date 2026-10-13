import React, { useState, useEffect, useCallback } from 'react'
import type {
  AppSettings, Category, Printer, PrinterConnection, PrinterRole, PrinterStation, SystemPrinter,
} from '../../../shared/types'
import NumberInput from '../../components/NumberInput'

/**
 * The owner's view of the thermal printers on the premises.
 *
 * Everything here is written in terms of what a printer DOES rather than how it is
 * wired: "فاتورة العميل" and "المطبخ", not roles and transports. The wiring is still
 * exposed, because someone eventually has to move a printer onto the network, but it
 * sits below the choice that actually matters.
 */

/** The prep stations — the roles that print a priceless ticket for one work area. */
const STATION_ROLES: PrinterRole[] = ['counter', 'kitchen', 'bar']
const isStationRole = (role?: PrinterRole): boolean => !!role && STATION_ROLES.includes(role)

const ROLE_LABELS: Record<PrinterRole, { label: string; hint: string; icon: string }> = {
  receipt: {
    icon: '🧾',
    label: 'الكاشير (فاتورة العميل)',
    hint: 'الفاتورة الكاملة بالأسعار — تُطبع مع كل طلب وتُسلَّم للعميل',
  },
  counter: {
    icon: '🧑‍🍳',
    label: 'موظف الكاونتر (التجهيز)',
    hint: 'تذكرة تجهيز وتسليم بدون أسعار — كل أصناف الطلب افتراضياً',
  },
  kitchen: {
    icon: '🔥',
    label: 'المطبخ',
    hint: 'تذكرة تحضير بدون أسعار وبخط كبير — عادةً أقسام الطعام الساخن فقط',
  },
  bar: {
    icon: '🥤',
    label: 'المشروبات',
    hint: 'مثل تذكرة المطبخ، لكن لقسم المشروبات وحده',
  },
  delivery: {
    icon: '🛵',
    label: 'نسخة الدليفري',
    hint: 'نسخة إضافية من الفاتورة للسائق — لطلبات التوصيل فقط',
  },
}

const CONNECTION_LABELS: Record<PrinterConnection, { label: string; hint: string }> = {
  windows_raw: {
    label: 'USB / مثبتة في ويندوز (مباشر)',
    hint: 'الوضع الموصى به لطابعات الـ USB. يرسل الأوامر كما هي، فيعمل القص وفتح الدرج.',
  },
  windows_driver: {
    label: 'USB / مثبتة في ويندوز (عبر التعريف)',
    hint: 'استخدمه فقط إذا تعذّر الوضع المباشر. القص وفتح الدرج يتحكم بهما تعريف الطابعة.',
  },
  network: {
    label: 'شبكة (عنوان IP)',
    hint: 'الطابعة موصولة بالشبكة ولها عنوان IP خاص. لا تحتاج تعريفاً على الجهاز.',
  },
}

type Draft = {
  printerId?: number
  name: string
  role: PrinterRole
  connection: PrinterConnection
  deviceName: string
  host: string
  port: number
  paperWidth: number
  copies: number
  cutPaper: boolean
  openDrawer: boolean
  beep: boolean
  categoryIds: number[]
  station: PrinterStation
  autoPrint: boolean
  isActive: boolean
}

const BLANK: Draft = {
  name: '',
  role: 'receipt',
  connection: 'windows_raw',
  deviceName: '',
  host: '',
  port: 9100,
  paperWidth: 80,
  copies: 1,
  cutPaper: true,
  openDrawer: false,
  beep: false,
  categoryIds: [],
  station: 'any',
  autoPrint: true,
  isActive: true,
}

function toDraft(p: Printer): Draft {
  let categoryIds: number[] = []
  try {
    const parsed = p.category_ids ? JSON.parse(p.category_ids) : []
    if (Array.isArray(parsed)) categoryIds = parsed.map(Number).filter(Number.isFinite)
  } catch { /* a malformed value means "all categories", same as empty */ }

  return {
    printerId: p.printer_id,
    name: p.name,
    role: p.role,
    connection: p.connection,
    deviceName: p.device_name || '',
    host: p.host || '',
    port: p.port,
    paperWidth: p.paper_width,
    copies: p.copies,
    cutPaper: !!p.cut_paper,
    openDrawer: !!p.open_drawer,
    beep: !!p.beep,
    categoryIds,
    station: (p.station ?? 'any') as PrinterStation,
    autoPrint: !!p.auto_print,
    isActive: !!p.is_active,
  }
}

interface Props {
  settings: Partial<AppSettings>
  update: (key: keyof AppSettings, value: string | number) => void
  showToast: (msg: string, type?: string) => void
}

export default function PrinterSettings({ settings, update, showToast }: Props) {
  const [printers, setPrinters] = useState<Printer[]>([])
  const [systemPrinters, setSystemPrinters] = useState<SystemPrinter[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [draft, setDraft] = useState<Draft | null>(null)
  const [saving, setSaving] = useState(false)
  /** Which printer currently has a test in flight, so its button can say so. */
  const [busyId, setBusyId] = useState<number | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<Printer | null>(null)

  const load = useCallback(async () => {
    const [printersRes, catsRes] = await Promise.all([
      window.api.listPrinters(),
      window.api.listCategories(),
    ])
    if (printersRes.success) setPrinters(printersRes.data)
    if (catsRes.success) setCategories(catsRes.data)
  }, [])

  const loadSystemPrinters = useCallback(async () => {
    const res = await window.api.listSystemPrinters()
    if (res.success) setSystemPrinters(res.data)
    else showToast(res.error || 'تعذر قراءة طابعات ويندوز', 'error')
  }, [showToast])

  useEffect(() => { load(); loadSystemPrinters() }, [load, loadSystemPrinters])

  const openAdd = () => setDraft({ ...BLANK, name: `طابعة ${printers.length + 1}` })
  const openEdit = (p: Printer) => setDraft(toDraft(p))

  const setField = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft(d => (d ? { ...d, [key]: value } : d))

  const saveDraft = async () => {
    if (!draft) return
    setSaving(true)
    const res = await window.api.upsertPrinter({
      printerId: draft.printerId,
      name: draft.name,
      role: draft.role,
      connection: draft.connection,
      deviceName: draft.deviceName || null,
      host: draft.host || null,
      port: draft.port,
      paperWidth: draft.paperWidth,
      copies: draft.copies,
      cutPaper: draft.cutPaper,
      openDrawer: draft.openDrawer,
      beep: draft.beep,
      // Only a prep station's ticket is ever split by category; keeping a stale
      // filter on a receipt printer would be a trap for whoever edits it next.
      categoryIds: isStationRole(draft.role) ? draft.categoryIds : [],
      station: draft.connection === 'network' ? 'any' : draft.station,
      autoPrint: draft.autoPrint,
      isActive: draft.isActive,
    })
    setSaving(false)

    if (res.success) {
      showToast(draft.printerId ? 'تم تحديث الطابعة' : 'تمت إضافة الطابعة')
      setDraft(null)
      load()
    } else {
      showToast(res.error || 'تعذر حفظ الطابعة', 'error')
    }
  }

  const doDelete = async () => {
    if (!confirmDelete) return
    const res = await window.api.deletePrinter(confirmDelete.printer_id)
    setConfirmDelete(null)
    if (res.success) { showToast('تم حذف الطابعة'); load() }
    else showToast(res.error || 'تعذر حذف الطابعة', 'error')
  }

  const runTestPage = async (p: Printer) => {
    setBusyId(p.printer_id)
    const res = await window.api.testPrinter(p.printer_id)
    setBusyId(null)
    if (res.success) showToast(`تم إرسال صفحة اختبار إلى "${p.name}"`)
    else showToast(res.error || 'فشل الاختبار', 'error')
  }

  const runTestConnection = async (p: Printer) => {
    setBusyId(p.printer_id)
    const res = await window.api.testPrinterConnection(p.printer_id)
    setBusyId(null)
    if (res.success) showToast(`"${p.name}" متصلة وجاهزة`)
    else showToast(res.error || 'تعذر الوصول إلى الطابعة', 'error')
  }

  const kickDrawer = async (p: Printer) => {
    setBusyId(p.printer_id)
    const res = await window.api.openCashDrawer(p.printer_id)
    setBusyId(null)
    if (res.success) showToast('تم إرسال أمر فتح الدرج')
    else showToast(res.error || 'تعذر فتح الدرج', 'error')
  }

  /** Buzzer on its own, no paper — so the beeper can be proven before a live ticket. */
  const testBeep = async (p: Printer) => {
    setBusyId(p.printer_id)
    const res = await window.api.testPrinterBeep(p.printer_id)
    setBusyId(null)
    if (res.success) {
      showToast('تم إرسال أمر الصوت — إذا لم تسمع شيئاً فالطابعة بلا صفّارة')
    } else {
      showToast(res.error || 'تعذر إرسال أمر الصوت', 'error')
    }
  }

  /**
   * What a prep station prints, in one line: the categories sent to it from the
   * categories screen, then whatever its own list adds from the ones left automatic.
   */
  const stationSummary = (p: Printer): string => {
    const chosen = categories.filter(c => c.printer_id === p.printer_id).map(c => c.name)
    const automatic = categories.filter(c => c.printer_id == null).length
    const ownList = !!p.category_ids && p.category_ids !== '[]'
    const rest = automatic === 0 ? ''
      : ownList ? 'أقسام محددة'
      : chosen.length ? 'باقي الأقسام التلقائية' : 'كل الأقسام'
    if (!chosen.length) return rest || 'لا أقسام'
    return `${chosen.join('، ')}${rest ? ` + ${rest}` : ''}`
  }

  /** The printer a category was sent to on the categories screen, if any. */
  const chosenPrinterName = (c: Category): string | null => {
    if (c.printer_id === 0) return 'الكاشير فقط'
    if (c.printer_id == null) return null
    return printers.find(p => p.printer_id === c.printer_id)?.name ?? 'طابعة محذوفة'
  }

  const isNetwork = draft?.connection === 'network'
  const isStation = isStationRole(draft?.role)

  return (
    <>
      <div className="card" style={{ marginTop: 20 }}>
        <div className="card-header">
          <span className="card-title">🖨️ الطابعات</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-secondary btn-sm" onClick={loadSystemPrinters}>
              🔄 تحديث قائمة ويندوز
            </button>
            <button className="btn btn-primary btn-sm" onClick={openAdd}>
              ➕ إضافة طابعة
            </button>
          </div>
        </div>

        <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 16, lineHeight: 1.8 }}>
          أضف كل طابعة مرة واحدة وحدّد <b>وظيفتها</b>، وسيتولى النظام إرسال ما يخصها مع كل
          طلب. الطباعة تتم داخل البرنامج مباشرة بدون نافذة طباعة ويندوز، والنص العربي
          يُرسل كصورة حتى يخرج متصلاً وسليماً — وهو ما لا تدعمه خطوط الطابعة نفسها.
          {' '}قبل الإضافة تأكد من تثبيت تعريف الطابعة الموجود على اسطوانة الطابعة
          (<b>XPrinter Driver Setup</b>) وظهورها ضمن طابعات ويندوز.
        </p>

        {/* Global printing behaviour. Saved with the page's main حفظ button. */}
        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))',
          gap: 14, padding: 14, marginBottom: 18,
          background: 'var(--bg-card-hover)', borderRadius: 'var(--radius-sm)',
        }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={!!settings.print_auto}
              onChange={e => update('print_auto', e.target.checked ? 1 : 0)}
            />
            <span>
              <b>طباعة تلقائية عند تأكيد الطلب</b>
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                بدونها لن تخرج أي فاتورة إلا بالضغط على زر الطباعة
              </div>
            </span>
          </label>

          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={!!settings.print_logo}
              onChange={e => update('print_logo', e.target.checked ? 1 : 0)}
            />
            <span>
              <b>طباعة الشعار أعلى الفاتورة</b>
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                إيقافه يوفّر ورقاً ويجعل الطباعة أسرع
              </div>
            </span>
          </label>

          <div className="form-group" style={{ margin: 0 }}>
            <label className="form-label">حجم الخط في الفاتورة (%)</label>
            <NumberInput
              decimals={0}
              value={settings.print_font_scale ?? 100}
              onValueChange={v => update('print_font_scale', Math.max(70, Math.min(200, v)))}
            />
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
              100% هو الحجم المعتاد. ارفعه إلى 120–140% إذا كان الخط صغيراً على الورق،
              واخفضه لتوفير الورق. احفظ التغييرات ثم اضغط "اختبار" لمعاينة النتيجة.
            </div>
          </div>

          <div className="form-group" style={{ margin: 0 }}>
            <label className="form-label">أسطر فارغة قبل القص</label>
            <NumberInput
              decimals={0}
              value={settings.print_feed_lines ?? 2}
              onValueChange={v => update('print_feed_lines', Math.max(0, Math.min(12, v)))}
            />
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
              زِدها إذا كان القص يقطع آخر سطر من الفاتورة
            </div>
          </div>
        </div>

        <div className="table-container">
          <table>
            <thead>
              <tr>
                <th>الطابعة</th>
                <th>الوظيفة</th>
                <th>التوصيل</th>
                <th>الورق</th>
                <th>الحالة</th>
                <th>إجراءات</th>
              </tr>
            </thead>
            <tbody>
              {printers.map(p => {
                const role = ROLE_LABELS[p.role]
                const busy = busyId === p.printer_id
                return (
                  <tr key={p.printer_id} style={{ opacity: p.is_active ? 1 : 0.5 }}>
                    <td style={{ fontWeight: 800 }}>{p.name}</td>
                    <td>
                      <span>{role.icon} {role.label}</span>
                      {isStationRole(p.role) && (
                        <div style={{ fontSize: 11, color: 'var(--text-muted)', maxWidth: 260 }}>
                          {stationSummary(p)}
                        </div>
                      )}
                    </td>
                    <td style={{ fontSize: 12 }}>
                      {p.connection === 'network'
                        ? <>شبكة<div style={{ color: 'var(--text-muted)' }}>{p.host}:{p.port}</div></>
                        : p.device_name
                          ? <>ويندوز<div style={{ color: 'var(--text-muted)' }}>{p.device_name}</div></>
                          // A starter printer: its job is set, which Windows queue it is
                          // can only be chosen on the premises.
                          : <span style={{ color: 'var(--danger)', fontWeight: 700 }}>
                              ⚠️ لم تُحدد بعد — اضغط «تعديل» واختر الطابعة ثم فعّلها
                            </span>}
                    </td>
                    <td>{p.paper_width} مم{p.copies > 1 ? ` × ${p.copies}` : ''}</td>
                    <td>
                      {p.is_active
                        ? (p.auto_print
                          ? <span className="badge badge-success">تلقائية</span>
                          : <span className="badge badge-info">يدوية</span>)
                        : <span className="badge badge-warning">موقوفة</span>}
                      {!!p.open_drawer && <div style={{ fontSize: 11, marginTop: 4 }}>💰 الدرج</div>}
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => runTestConnection(p)}>
                        {busy ? '...' : '📡 فحص'}
                      </button>
                      <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => runTestPage(p)}>
                        {busy ? '...' : '🖨️ اختبار'}
                      </button>
                      {!!p.open_drawer && (
                        <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => kickDrawer(p)}>
                          💰 الدرج
                        </button>
                      )}
                      {!!p.beep && (
                        <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => testBeep(p)}>
                          🔔 جرّب الصوت
                        </button>
                      )}
                      <button className="btn btn-sm btn-ghost" onClick={() => openEdit(p)}>تعديل</button>
                      <button className="btn btn-sm btn-ghost" onClick={() => setConfirmDelete(p)}>حذف</button>
                    </td>
                  </tr>
                )
              })}
              {printers.length === 0 && (
                <tr>
                  <td colSpan={6} style={{ textAlign: 'center', padding: 24, color: 'var(--text-muted)' }}>
                    لا توجد طابعات معرّفة بعد — اضغط "إضافة طابعة" للبدء.
                    <br />
                    <span style={{ fontSize: 12 }}>
                      إلى أن تُضاف طابعة، يعرض النظام الفاتورة على الشاشة فقط.
                    </span>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Add / edit */}
      {draft && (
        <div className="modal-overlay" onClick={() => !saving && setDraft(null)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 620, maxHeight: '90vh', overflowY: 'auto' }}>
            <h3 style={{ marginBottom: 18, fontSize: 18, fontWeight: 800 }}>
              {draft.printerId ? '✏️ تعديل الطابعة' : '➕ إضافة طابعة'}
            </h3>

            <div className="form-group">
              <label className="form-label">اسم الطابعة (كما تناديها في المطعم)</label>
              <input
                className="input" value={draft.name} autoFocus
                onChange={e => setField('name', e.target.value)}
                placeholder="كاشير 1 / المطبخ / المشروبات"
              />
            </div>

            <div className="form-group">
              <label className="form-label">وظيفة الطابعة</label>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                {(Object.keys(ROLE_LABELS) as PrinterRole[]).map(role => (
                  <button
                    key={role}
                    type="button"
                    className={draft.role === role ? 'btn btn-primary' : 'btn btn-secondary'}
                    style={{ flexDirection: 'column', alignItems: 'flex-start', height: 'auto', padding: '10px 12px', textAlign: 'right' }}
                    onClick={() => setField('role', role)}
                  >
                    <span style={{ fontWeight: 800 }}>{ROLE_LABELS[role].icon} {ROLE_LABELS[role].label}</span>
                    <span style={{ fontSize: 11, opacity: 0.85, fontWeight: 500 }}>{ROLE_LABELS[role].hint}</span>
                  </button>
                ))}
              </div>
            </div>

            {isStation && (
              <div className="form-group">
                <label className="form-label">الأقسام التي تخص هذه المحطة</label>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>
                  اترك الكل بدون تحديد لتطبع كل الأصناف. إذا حددت أقساماً فلن تخرج تذكرة
                  أصلاً للطلبات التي لا تحتوي على أي صنف منها.
                  {' '}الأقسام المعلَّمة 🔒 اختيرت طابعتها من <b>شاشة الأقسام</b> وتُغيَّر من هناك.
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {categories.map(c => {
                    const fixedTo = chosenPrinterName(c)
                    if (fixedTo) {
                      const here = c.printer_id === draft.printerId
                      return (
                        <button
                          key={c.category_id} type="button" disabled
                          className={here ? 'btn btn-sm btn-primary' : 'btn btn-sm btn-secondary'}
                          title="اختيرت طابعة هذا القسم من شاشة الأقسام"
                        >
                          🔒 {c.name} {here ? '' : `← ${fixedTo}`}
                        </button>
                      )
                    }
                    const on = draft.categoryIds.includes(c.category_id)
                    return (
                      <button
                        key={c.category_id}
                        type="button"
                        className={on ? 'btn btn-sm btn-primary' : 'btn btn-sm btn-secondary'}
                        onClick={() => setField(
                          'categoryIds',
                          on
                            ? draft.categoryIds.filter(id => id !== c.category_id)
                            : [...draft.categoryIds, c.category_id],
                        )}
                      >
                        {on ? '✓ ' : ''}{c.name}
                      </button>
                    )
                  })}
                  {categories.length === 0 && (
                    <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>لا توجد أقسام بعد</span>
                  )}
                </div>
              </div>
            )}

            <div className="form-group">
              <label className="form-label">طريقة التوصيل</label>
              <select
                className="input"
                value={draft.connection}
                onChange={e => setField('connection', e.target.value as PrinterConnection)}
              >
                {(Object.keys(CONNECTION_LABELS) as PrinterConnection[]).map(c => (
                  <option key={c} value={c}>{CONNECTION_LABELS[c].label}</option>
                ))}
              </select>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>
                {CONNECTION_LABELS[draft.connection].hint}
              </div>
            </div>

            {isNetwork ? (
              <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 10 }}>
                <div className="form-group">
                  <label className="form-label">عنوان IP الطابعة</label>
                  <input
                    className="input" value={draft.host} dir="ltr"
                    onChange={e => setField('host', e.target.value)}
                    placeholder="192.168.1.100"
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">المنفذ</label>
                  <NumberInput decimals={0} value={draft.port} onValueChange={v => setField('port', v || 9100)} />
                </div>
              </div>
            ) : (
              <>
              <div className="form-group">
                <label className="form-label">هذه الطابعة موصولة بأي جهاز؟</label>
                <select
                  className="input"
                  value={draft.station}
                  onChange={e => setField('station', e.target.value as PrinterStation)}
                >
                  <option value="any">هذا الجهاز فقط (نظام بجهاز واحد)</option>
                  <option value="master">الجهاز الرئيسي (الماستر)</option>
                  <option value="node">الجهاز التابع (النود)</option>
                </select>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6, lineHeight: 1.7 }}>
                  طابعة الـ USB لا يشغّلها إلا الجهاز الموصولة به. عند ربط جهازين حدد
                  الجهاز الصحيح، وسيتولى النظام إرسال التذكرة إليه عبر الشبكة تلقائياً.
                  <b> طابعة الشبكة (IP) لا تحتاج هذا الخيار</b> — يصل إليها الجهازان معاً.
                </div>
              </div>

              <div className="form-group">
                <label className="form-label">الطابعة المثبتة في ويندوز</label>
                <select
                  className="input"
                  value={draft.deviceName}
                  onChange={e => setField('deviceName', e.target.value)}
                >
                  <option value="">— اختر طابعة —</option>
                  {systemPrinters.map(sp => (
                    <option key={sp.name} value={sp.name}>
                      {sp.displayName}{sp.isDefault ? ' (الافتراضية)' : ''}
                    </option>
                  ))}
                  {/* A printer saved earlier and since unplugged must still be editable
                      rather than silently losing its name when the form opens. */}
                  {draft.deviceName && !systemPrinters.some(sp => sp.name === draft.deviceName) && (
                    <option value={draft.deviceName}>{draft.deviceName} (غير متصلة حالياً)</option>
                  )}
                </select>
                {systemPrinters.length === 0 && (
                  <div style={{ fontSize: 11, color: 'var(--warning, #b45309)', marginTop: 6 }}>
                    لم يعثر النظام على أي طابعة مثبتة. ثبّت تعريف الطابعة من اسطوانتها ثم اضغط
                    "تحديث قائمة ويندوز".
                  </div>
                )}
              </div>
              </>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <div className="form-group">
                <label className="form-label">عرض الورق</label>
                <select
                  className="input"
                  value={draft.paperWidth}
                  onChange={e => setField('paperWidth', Number(e.target.value))}
                >
                  <option value={80}>80 مم (الأشهر)</option>
                  <option value={58}>58 مم</option>
                </select>
              </div>
              <div className="form-group">
                <label className="form-label">عدد النسخ لكل طلب</label>
                <NumberInput
                  decimals={0}
                  value={draft.copies}
                  onValueChange={v => setField('copies', Math.max(1, Math.min(5, v || 1)))}
                />
              </div>
            </div>

            <div style={{ display: 'grid', gap: 10, marginBottom: 18 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                <input type="checkbox" checked={draft.cutPaper} onChange={e => setField('cutPaper', e.target.checked)} />
                <span>قص الورق بعد كل فاتورة</span>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                <input type="checkbox" checked={draft.openDrawer} onChange={e => setField('openDrawer', e.target.checked)} />
                <span>
                  فتح درج النقدية مع الطباعة
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    {' '}— للطابعة الموصول بها الدرج فقط
                  </span>
                </span>
              </label>
              <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer' }}>
                <input
                  type="checkbox" checked={draft.beep} style={{ marginTop: 4 }}
                  onChange={e => setField('beep', e.target.checked)}
                />
                <span>
                  🔔 صوت تنبيه بعد الطباعة
                  <span style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block', lineHeight: 1.7 }}>
                    للمطبخ، حتى يعرف الشيف أن طلباً نزل دون النظر إلى الطابعة.
                    {' '}<b>ليست كل الطابعات بها صفّارة</b> — فعِّل الخيار، احفظ، ثم اضغط
                    {' '}«🔔 جرّب الصوت» في القائمة. إذا لم تسمع صوتاً أو خرجت رموز غريبة
                    {' '}على الورق فأوقفه؛ هذا الطراز لا يدعمها.
                  </span>
                </span>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                <input type="checkbox" checked={draft.autoPrint} onChange={e => setField('autoPrint', e.target.checked)} />
                <span>
                  تطبع تلقائياً مع كل طلب
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    {' '}— بدونها تطبع عند الطلب اليدوي فقط
                  </span>
                </span>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                <input type="checkbox" checked={draft.isActive} onChange={e => setField('isActive', e.target.checked)} />
                <span>الطابعة مفعّلة</span>
              </label>
            </div>

            {draft.connection === 'windows_driver' && (
              <div style={{
                fontSize: 12, padding: 10, marginBottom: 16, lineHeight: 1.7,
                background: 'rgba(180,83,9,0.12)', borderRadius: 'var(--radius-sm)',
              }}>
                في هذا الوضع يتولى تعريف الطابعة القص وفتح الدرج، فلن يكون للخيارين أعلاه
                تأثير — اضبطهما من خصائص الطابعة في ويندوز.
              </div>
            )}

            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn btn-primary" style={{ flex: 1 }} disabled={saving} onClick={saveDraft}>
                {saving ? 'جاري الحفظ...' : '💾 حفظ الطابعة'}
              </button>
              <button className="btn btn-secondary" disabled={saving} onClick={() => setDraft(null)}>إلغاء</button>
            </div>
          </div>
        </div>
      )}

      {confirmDelete && (
        <div className="modal-overlay" onClick={() => setConfirmDelete(null)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 420 }}>
            <h3 style={{ marginBottom: 12, fontSize: 17, fontWeight: 800 }}>حذف الطابعة</h3>
            <p style={{ marginBottom: 18, color: 'var(--text-muted)' }}>
              سيتوقف إرسال أي شيء إلى "<b>{confirmDelete.name}</b>". يمكنك إضافتها من جديد
              في أي وقت. إن كنت تريد إيقافها مؤقتاً فقط، استخدم "تعديل" وأزل التفعيل بدلاً من الحذف.
            </p>
            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn btn-danger" style={{ flex: 1 }} onClick={doDelete}>حذف نهائياً</button>
              <button className="btn btn-secondary" onClick={() => setConfirmDelete(null)}>إلغاء</button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
