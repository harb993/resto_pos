import React, { useState, useEffect, useCallback, useRef } from 'react'
import type { NetworkStatus, TillRow } from '../../../shared/types'
import NumberInput from '../../components/NumberInput'

/**
 * Linking the shop's tills over the LAN, and the master's control panel for them.
 *
 * One machine is the MASTER: it holds the single database, it dials every other till,
 * and it is the only machine anybody configures. The others are TILLS (nodes): they
 * hold no books of their own, they wait to be dialled, and they do as they are told.
 *
 * The obvious alternative — putting restaurant.db in a shared folder and pointing both
 * machines at it — corrupts the file. SQLite's locking is unreliable over a network
 * share, and this database runs in WAL mode, which needs shared memory a share cannot
 * provide. That is why there is no "database folder" box here.
 *
 * ---- Why this screen looks the way it does ----
 *
 * It used to be run from the wrong end. The second till had to be told the master's
 * address, so somebody walked over and typed an IP; the master's "add a device"
 * button promoted whichever machine you pressed it on, so pressing it on the wrong PC
 * gave you two masters and a till that could never connect; and every one of those
 * mistakes showed the same message on the far machine — "cannot reach the master,
 * check the cable" — which is how a shop spends a night checking a cable that was
 * never the problem.
 *
 * So the direction is reversed. The master finds tills, adopts them with one press,
 * and holds the link. Nothing is typed on the other machine, ever. And when a till
 * cannot be reached, this screen says which machine, at which address, and what it
 * actually answered.
 */

type Mode = 'standalone' | 'master' | 'node'

const MODES: { value: Mode; icon: string; label: string; hint: string }[] = [
  {
    value: 'standalone',
    icon: '💻',
    label: 'جهاز واحد',
    hint: 'الجهاز يعمل بمفرده ويملك قاعدة البيانات — الوضع الافتراضي',
  },
  {
    value: 'master',
    icon: '🗄️',
    label: 'الجهاز الرئيسي (ماستر)',
    hint: 'يحتفظ بقاعدة البيانات، ويتصل هو بالأجهزة الأخرى ويتحكم فيها',
  },
  {
    value: 'node',
    icon: '🖥️',
    label: 'جهاز تابع (نود)',
    hint: 'ينتظر أن يتصل به الجهاز الرئيسي — لا يحتاج إدخال أي عنوان',
  },
]

interface ScanDevice {
  ip: string
  port: number
  kind: 'till' | 'printer' | 'this-machine' | 'unknown'
  role?: 'master' | 'node' | 'standalone'
  machineName?: string
  name?: string
  appVersion?: string
  connectedNodes?: number
  adoptable?: boolean
  linked?: boolean
}

const ROLE_LABEL: Record<string, string> = {
  master: '🗄️ جهاز رئيسي',
  node: '🖥️ جهاز تابع',
  standalone: '💻 يعمل بمفرده',
}

/** What each link state looks like on the master's list. */
const STATE_BADGE: Record<TillRow['state'], { cls: string; text: string }> = {
  connected: { cls: 'badge-success', text: 'متصل' },
  connecting: { cls: 'badge-warning', text: 'جارٍ الاتصال…' },
  relocating: { cls: 'badge-warning', text: 'يبحث عن الجهاز…' },
  unreachable: { cls: 'badge-danger', text: 'غير متصل' },
}

interface Books {
  orders: number
  firstOrder: string | null
  lastOrder: string | null
  menuItems: number
  rawMaterials: number
}

/**
 * Does this machine look like it holds the shop's real books?
 *
 * A deliberately blunt test. It is not trying to be clever about what a real
 * database looks like — it is trying to catch the one mistake that matters: making
 * a scratch or freshly-installed machine the master, so every till in the shop
 * starts trading on an empty menu with no stock.
 */
function looksEmpty(b: Books | null): boolean {
  if (!b) return false
  return b.orders < 20 || b.menuItems < 5
}

interface BackupHealth {
  lastDailyDate: string
  lastFailure: { at: number; error: string } | null
  copiedTo: string[]
  hour: number
}

interface Props {
  showToast: (msg: string, type?: string) => void
}

function when(ms: number | null | undefined): string {
  if (!ms) return '—'
  return new Date(ms).toLocaleString('ar-EG', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  })
}

function sizeMb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} م.ب`
}

export default function NetworkSettings({ showToast }: Props) {
  const [status, setStatus] = useState<NetworkStatus | null>(null)
  const [mode, setMode] = useState<Mode>('standalone')
  const [port, setPort] = useState(47615)
  const [addresses, setAddresses] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [busyTill, setBusyTill] = useState<string | null>(null)
  const [adopting, setAdopting] = useState<string | null>(null)

  const [books, setBooks] = useState<Books | null>(null)
  const [backup, setBackup] = useState<BackupHealth | null>(null)
  const [backingUp, setBackingUp] = useState(false)

  // What the last LAN sweep found. Held rather than re-scanned on render — a sweep is
  // a few seconds of network traffic, not something to repeat on every keystroke.
  const [scanning, setScanning] = useState(false)
  const [scanResult, setScanResult] = useState<{
    devices: ScanDevice[]
    scanned: number
    networks: string[]
  } | null>(null)

  /**
   * Has the owner started changing the mode or the port?
   *
   * This screen refreshes itself every three seconds, because links come and go on
   * their own and the list has to follow. That refresh used to write the SAVED mode and
   * port straight back into the two controls the owner edits — so typing a port meant
   * watching it revert a second or two later, and picking «الرئيسي» could snap back to
   * «جهاز واحد» before it was saved.
   *
   * It reads as an input that will not take input, and it happens on the one screen
   * somebody is on precisely when they are trying to connect two machines.
   *
   * So the live refresh keeps updating everything it is FOR — the link states, the
   * addresses, the till list — and stops touching the two fields being edited until
   * they have been saved.
   */
  const editing = useRef(false)

  const load = useCallback(async () => {
    const [st, addr, bk, bo] = await Promise.all([
      window.api.getNetworkStatus(),
      window.api.getLocalAddresses(),
      window.api.getBackupHealth(),
      window.api.getBooksSummary(),
    ])
    if (st.success) {
      setStatus(st.data)
      if (!editing.current) {
        setMode(st.data.mode as Mode)
        setPort(st.data.port)
      }
    }
    if (addr.success) setAddresses(addr.data.addresses ?? [])
    if (bk.success) setBackup(bk.data)
    if (bo.success) setBooks(bo.data)
  }, [])

  useEffect(() => { load() }, [load])

  // Links come and go on their own — a till is switched off, a master finds one that
  // has moved — so the list has to follow rather than showing whatever was true when
  // the screen opened.
  const liveRef = useRef(load)
  liveRef.current = load
  useEffect(() => {
    const id = setInterval(() => { liveRef.current() }, 3000)
    return () => clearInterval(id)
  }, [])

  const scan = async () => {
    setScanning(true)
    const res = await window.api.discoverDevices()
    setScanning(false)
    if (!res.success) {
      showToast(res.error || 'تعذر فحص الشبكة', 'error')
      return
    }
    setScanResult(res.data)
    const tills = res.data.devices.filter((d: ScanDevice) => d.kind === 'till').length
    const printers = res.data.devices.filter((d: ScanDevice) => d.kind === 'printer').length
    showToast(`تم العثور على ${tills} جهاز كاشير و${printers} طابعة شبكة`)
  }

  const saveMode = async (next: Mode) => {
    // The master is whichever machine owns the books. Picking the wrong one is the
    // only choice on this screen that cannot be undone by pressing a different
    // button — every other till then trades on this machine's data, and a scratch
    // database with two menu items and no stock looks exactly like a working till
    // until somebody tries to sell something.
    if (next === 'master' && mode !== 'master' && looksEmpty(books)) {
      const ok = window.confirm(
        'انتبه — قاعدة البيانات على هذا الجهاز تبدو شبه فارغة:\n\n' +
        `  الفواتير: ${books!.orders}\n` +
        `  الأصناف: ${books!.menuItems}\n` +
        `  المواد الخام: ${books!.rawMaterials}\n\n` +
        'الجهاز الرئيسي هو صاحب البيانات، وكل الأجهزة الأخرى ستعمل على هذه القاعدة.\n' +
        'إذا كانت بيانات المحل على جهاز آخر، اجعل ذلك الجهاز هو الرئيسي بدلاً من هذا.\n\n' +
        'هل تريد المتابعة رغم ذلك؟'
      )
      if (!ok) return
    }
    setSaving(true)
    const res = await window.api.setNetworkMode({ mode: next, port })
    setSaving(false)
    if (res.success) {
      setStatus(res.data)
      setMode(next)
      // Saved — what is on screen and what is stored agree again, so the live refresh
      // can go back to keeping these two in step with the machine.
      editing.current = false
      showToast('تم حفظ وضع الشبكة')
    } else {
      showToast(res.error || 'تعذر حفظ الوضع', 'error')
    }
  }

  const adopt = async (d: ScanDevice) => {
    setAdopting(d.ip)
    const res = await window.api.adoptTill(d.ip, d.port)
    setAdopting(null)
    if (res.success) {
      showToast(`تمت إضافة «${d.machineName || d.ip}» — سيتصل به هذا الجهاز تلقائياً`)
      await load()
      await scan()
    } else {
      showToast(res.error || 'تعذرت الإضافة', 'error')
      // The list may still be describing what that machine WAS when it was last
      // scanned. Refresh it so the row agrees with the reason just given, instead of
      // still offering a button that has just been refused.
      await scan()
    }
  }

  const command = async (till: TillRow, kind: string, confirmText?: string) => {
    if (confirmText && !window.confirm(confirmText)) return
    setBusyTill(till.id)
    const res = await window.api.commandTill(till.id, { kind })
    setBusyTill(null)
    if (res.success) {
      showToast(`تم تنفيذ الأمر على «${till.machineName}»`)
      await load()
    } else {
      showToast(res.error || 'تعذر تنفيذ الأمر', 'error')
    }
  }

  const drop = async (till: TillRow) => {
    if (!window.confirm(
      `فصل «${till.machineName}» نهائياً؟\n\n` +
      'سيعود الجهاز للعمل بمفرده ولن يصل إلى بيانات هذا الجهاز حتى تعيد إضافته.'
    )) return
    setBusyTill(till.id)
    const res = await window.api.dropTill(till.id)
    setBusyTill(null)
    if (res.success) {
      showToast(`تم فصل «${till.machineName}»`)
      await load()
    } else {
      showToast(res.error || 'تعذر الفصل', 'error')
    }
  }

  const backupNow = async () => {
    setBackingUp(true)
    const res = await window.api.runBackupNow()
    setBackingUp(false)
    if (res.success) {
      setBackup(res.data)
      const to = res.data.copiedTo ?? []
      showToast(to.length
        ? `تمت النسخة الاحتياطية ونُسخت إلى: ${to.join('، ')}`
        : 'تمت النسخة الاحتياطية على هذا الجهاز فقط — لا يوجد جهاز تابع متصل')
    } else {
      showToast(res.error || 'فشلت النسخة الاحتياطية', 'error')
    }
  }

  const saveBackupHour = async (hour: number) => {
    const res = await window.api.setBackupHour(hour)
    if (res.success) {
      setBackup(res.data)
      showToast(`سيتم النسخ الاحتياطي يومياً الساعة ${hour}:00`)
    } else {
      showToast(res.error || 'تعذر الحفظ', 'error')
    }
  }

  const tills = status?.tills ?? []
  const foundTills = (scanResult?.devices ?? []).filter(d => d.kind === 'till')
  const alreadyAdded = new Set(tills.map(t => t.machineName))

  return (
    <div style={{ display: 'grid', gap: 16 }}>

      {/* ---- What this machine is ---- */}
      <div className="card">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
          <h3 style={{ margin: 0 }}>الربط بين الأجهزة</h3>
          {status && (
            <span className={`badge ${status.running ? 'badge-success' : 'badge-danger'}`}>
              {status.running ? `يستمع على المنفذ ${status.port}` : 'الخدمة متوقفة'}
            </span>
          )}
          <span style={{ marginInlineStart: 'auto', fontSize: 12, color: 'var(--text-muted)' }}>
            {status?.machineName} · إصدار {status?.appVersion}
          </span>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
          {MODES.map(m => (
            <button
              key={m.value}
              disabled={saving}
              onClick={() => saveMode(m.value)}
              className={`card ${mode === m.value ? 'card-selected' : ''}`}
              style={{
                textAlign: 'start', cursor: 'pointer', padding: 12,
                border: mode === m.value ? '2px solid var(--primary)' : '1px solid var(--border)',
              }}
            >
              <div style={{ fontSize: 22 }}>{m.icon}</div>
              <div style={{ fontWeight: 700, marginTop: 4 }}>{m.label}</div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>{m.hint}</div>
            </button>
          ))}
        </div>

        <div style={{ display: 'flex', gap: 12, alignItems: 'end', marginTop: 12 }}>
          <div style={{ width: 160 }}>
            <label className="form-label">المنفذ</label>
            <NumberInput
              value={port}
              onValueChange={(v) => { editing.current = true; setPort(v) }}
              decimals={0}
            />
          </div>
          <button className="btn" disabled={saving} onClick={() => saveMode(mode)}>
            حفظ المنفذ
          </button>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', flex: 1 }}>
            عناوين هذا الجهاز على الشبكة: <b>{addresses.join('، ') || 'لا يوجد'}</b>
          </div>
        </div>

        {/* What is on THIS machine. The master is whichever machine owns the books,
            and that is not something anyone can tell by looking at two identical
            PCs — so say it here, where the choice is made. */}
        {books && (
          <div style={{
            marginTop: 12, padding: '8px 12px', borderRadius: 6, fontSize: 12,
            background: looksEmpty(books) ? 'var(--danger-bg, #fdecec)' : 'var(--bg-muted, #f4f4f5)',
            color: looksEmpty(books) ? 'var(--danger, #a11)' : 'var(--text-muted)',
          }}>
            {looksEmpty(books) ? '⚠️ ' : '📚 '}
            قاعدة البيانات على هذا الجهاز:{' '}
            <b>{books.orders}</b> فاتورة، <b>{books.menuItems}</b> صنف،{' '}
            <b>{books.rawMaterials}</b> مادة خام
            {books.lastOrder && <> · آخر فاتورة {books.lastOrder}</>}
            {looksEmpty(books) && (
              <div style={{ marginTop: 4 }}>
                هذه القاعدة تبدو شبه فارغة — لا تجعل هذا الجهاز هو «الرئيسي» إلا إذا كنت
                متأكداً أن بيانات المحل موجودة عليه.
              </div>
            )}
          </div>
        )}
      </div>

      {/* ================= MASTER ================= */}
      {mode === 'master' && (
        <>
          <div className="card">
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
              <h3 style={{ margin: 0 }}>الأجهزة التابعة</h3>
              <span className="badge badge-info">
                {status?.connectedNodes ?? 0} متصل من {tills.length}
              </span>
            </div>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 0 }}>
              هذا الجهاز هو الذي يتصل بالأجهزة الأخرى ويتحكم فيها. إذا تغيّر عنوان أي جهاز
              على الشبكة، يبحث عنه هذا الجهاز باسمه ويعيد الاتصال به تلقائياً — لا تحتاج
              لإدخال أي عنوان في أي مكان.
            </p>

            {tills.length === 0 && (
              <div style={{ padding: 16, textAlign: 'center', color: 'var(--text-muted)' }}>
                لا توجد أجهزة تابعة بعد. اضغط «ابحث عن الأجهزة» بالأسفل ثم «أضف» أمام الجهاز.
              </div>
            )}

            {tills.map(t => {
              const badge = STATE_BADGE[t.state]
              const busy = busyTill === t.id
              return (
                <div key={t.id} className="card" style={{ padding: 12, marginTop: 10 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                    <b style={{ fontSize: 15 }}>🖥️ {t.machineName}</b>
                    <span className={`badge ${badge.cls}`}>{badge.text}</span>
                    {t.locked && <span className="badge badge-danger">🔒 مقفول</span>}
                    <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                      {t.host}:{t.port}
                    </span>
                    <span style={{ marginInlineStart: 'auto', fontSize: 12 }}>
                      {t.signedInAs
                        ? <>المستخدم: <b>{t.signedInAs}</b></>
                        : <span style={{ color: 'var(--text-muted)' }}>لا أحد مسجّل الدخول</span>}
                    </span>
                  </div>

                  {/* The failure, in words. This is the line that used to say "check the
                      cable" no matter what had actually gone wrong. */}
                  {t.state !== 'connected' && t.lastError && (
                    <div style={{
                      marginTop: 8, padding: '6px 10px', borderRadius: 6, fontSize: 12,
                      background: 'var(--danger-bg, #fdecec)', color: 'var(--danger, #a11)',
                    }}>
                      ⚠️ {t.lastError}
                      <span style={{ opacity: 0.7 }}>  · آخر محاولة {when(t.lastErrorAt)}</span>
                    </div>
                  )}

                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>
                    {t.connectedSince
                      ? `متصل منذ ${when(t.connectedSince)}`
                      : `آخر اتصال ناجح: ${when(t.lastSeen)}`}
                    {t.appVersion && ` · إصدار ${t.appVersion}`}
                  </div>

                  <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                    <button className="btn btn-sm" disabled={busy}
                      onClick={() => command(t, 'signOut', `تسجيل خروج المستخدم على «${t.machineName}»؟`)}>
                      🚪 تسجيل خروج
                    </button>
                    {t.locked ? (
                      <button className="btn btn-sm btn-primary" disabled={busy}
                        onClick={() => command(t, 'unlock')}>
                        🔓 إلغاء القفل
                      </button>
                    ) : (
                      <button className="btn btn-sm" disabled={busy}
                        onClick={() => command(t, 'lock', `قفل «${t.machineName}»؟ لن يتمكن من تسجيل أي طلب حتى تفتحه.`)}>
                        🔒 قفل الجهاز
                      </button>
                    )}
                    <button className="btn btn-sm" disabled={busy}
                      onClick={() => command(t, 'refresh')}>
                      ↻ تحديث الشاشة
                    </button>
                    <button className="btn btn-sm" disabled={busy}
                      onClick={() => command(t, 'restart', `إعادة تشغيل البرنامج على «${t.machineName}»؟`)}>
                      ⟳ إعادة تشغيل
                    </button>
                    <button className="btn btn-sm btn-danger" disabled={busy}
                      style={{ marginInlineStart: 'auto' }}
                      onClick={() => drop(t)}>
                      ✕ فصل الجهاز
                    </button>
                  </div>
                </div>
              )
            })}
          </div>

        </>
      )}

      {/* ---- Adding a till ----

           Shown on a standalone machine too, deliberately. Hiding it until you had
           already chosen "master" meant the only way to FIND this button was to make
           the machine a master — so anyone connecting two tills pressed master on
           both, and then neither would accept the other. Adopting a till is what
           makes a machine a master; there is nothing to choose beforehand. */}
      {mode !== 'node' && (
          <div className="card">
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <h3 style={{ margin: 0 }}>إضافة جهاز</h3>
              <button className="btn btn-primary btn-sm" disabled={scanning} onClick={scan}>
                {scanning ? 'جارٍ الفحص…' : '🔍 ابحث عن الأجهزة'}
              </button>
              {scanResult && (
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                  تم فحص {scanResult.scanned} عنوان على {scanResult.networks.join('، ')}
                </span>
              )}
            </div>

            {foundTills.length > 0 && (
              <div style={{ marginTop: 10, display: 'grid', gap: 8 }}>
                {foundTills.map(d => {
                  const added = !!d.machineName && alreadyAdded.has(d.machineName)
                  const self = d.kind === 'this-machine'
                  return (
                    <div key={`${d.ip}:${d.port}`} style={{
                      display: 'flex', alignItems: 'center', gap: 10,
                      padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 8,
                    }}>
                      <b>{d.machineName || d.ip}</b>
                      <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{d.ip}</span>
                      <span className="badge">{ROLE_LABEL[d.role ?? ''] || 'غير معروف'}</span>
                      {d.name && <span style={{ fontSize: 12 }}>{d.name}</span>}
                      <span style={{ marginInlineStart: 'auto' }}>
                        {self ? <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>هذا الجهاز</span>
                          : added ? <span className="badge badge-success">مضاف</span>
                            : d.role === 'master' ? (
                              <span style={{ fontSize: 12, color: 'var(--danger, #a11)' }}>
                                مضبوط كجهاز رئيسي — اضبطه «جهاز واحد» على ذلك الجهاز ثم أعد الفحص
                              </span>
                            )
                              : (
                                <button className="btn btn-sm btn-primary"
                                  disabled={adopting === d.ip}
                                  onClick={() => adopt(d)}>
                                  {adopting === d.ip ? 'جارٍ الإضافة…' : '➕ أضف'}
                                </button>
                              )}
                      </span>
                    </div>
                  )
                })}
              </div>
            )}

            {scanResult && foundTills.length === 0 && (
              <div style={{ marginTop: 10, fontSize: 12, color: 'var(--text-muted)' }}>
                لم يُعثر على أي جهاز يعمل عليه البرنامج. تأكد أن البرنامج مفتوح على الجهاز
                الآخر وأنه على نفس الشبكة.
              </div>
            )}
          </div>
      )}

      {/* ================= NODE ================= */}
      {mode === 'node' && status && (
        <div className="card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <h3 style={{ margin: 0 }}>حالة هذا الجهاز</h3>
            <span className={`badge ${status.linked ? 'badge-success' : 'badge-danger'}`}>
              {status.linked ? `متصل بـ ${status.masterName}` : 'غير متصل'}
            </span>
            {status.locked && <span className="badge badge-danger">🔒 مقفول من الجهاز الرئيسي</span>}
          </div>

          <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            هذا الجهاز لا يحتاج إدخال أي عنوان. الجهاز الرئيسي هو الذي يتصل به، ومنه
            تُدار الإضافة والفصل والقفل.
          </p>

          {!status.linked && (
            <div style={{
              padding: '8px 12px', borderRadius: 6, fontSize: 13,
              background: 'var(--danger-bg, #fdecec)', color: 'var(--danger, #a11)',
            }}>
              ⚠️ {status.reason || 'لم يتصل الجهاز الرئيسي بعد'}
              <div style={{ marginTop: 4, fontSize: 12 }}>
                يمكن الاطلاع على البيانات المحفوظة محلياً، لكن لا يمكن تسجيل أي طلب أو
                تعديل حتى يعود الاتصال.
              </div>
            </div>
          )}

          {status.locked && status.lockReason && (
            <div style={{ marginTop: 8, fontSize: 13 }}>سبب القفل: <b>{status.lockReason}</b></div>
          )}

          <div style={{ marginTop: 12, fontSize: 13, display: 'grid', gap: 4 }}>
            <div>الجهاز الرئيسي: <b>{status.masterName || '—'}</b>
              {status.masterAddress && <span style={{ color: 'var(--text-muted)' }}> ({status.masterAddress})</span>}
            </div>
            <div>
              النسخة المحلية للقراءة:{' '}
              {status.mirror
                ? <b>{when(status.mirror.at)} · {sizeMb(status.mirror.bytes)}</b>
                : <span style={{ color: 'var(--text-muted)' }}>لم تصل بعد</span>}
            </div>
          </div>
        </div>
      )}

      {/* ================= BACKUPS ================= */}
      {mode !== 'node' && (
        <div className="card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <h3 style={{ margin: 0 }}>النسخ الاحتياطي اليومي</h3>
            {backup?.lastFailure
              ? <span className="badge badge-danger">فشلت آخر محاولة</span>
              : backup?.lastDailyDate
                ? <span className="badge badge-success">آخر نسخة: {backup.lastDailyDate}</span>
                : <span className="badge badge-warning">لم تُنفَّذ بعد</span>}
          </div>

          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
            تُؤخذ نسخة كاملة كل ليلة على هذا الجهاز، ثم تُرسل نسخة منها إلى كل جهاز تابع
            متصل ليحتفظ بها عنده. هكذا لا يضيع تاريخ المحل لو تعطّل جهاز واحد.
          </p>

          {backup?.lastFailure && (
            <div style={{
              padding: '8px 12px', borderRadius: 6, fontSize: 13, marginBottom: 10,
              background: 'var(--danger-bg, #fdecec)', color: 'var(--danger, #a11)',
            }}>
              ⚠️ فشلت النسخة الاحتياطية ({when(backup.lastFailure.at)}): {backup.lastFailure.error}
            </div>
          )}

          {backup && backup.copiedTo.length > 0 && (
            <div style={{ fontSize: 12, marginBottom: 10 }}>
              آخر نسخة محفوظة أيضاً على: <b>{backup.copiedTo.join('، ')}</b>
            </div>
          )}

          <div style={{ display: 'flex', gap: 12, alignItems: 'end', flexWrap: 'wrap' }}>
            <div style={{ width: 160 }}>
              <label className="form-label">ساعة النسخ (0–23)</label>
              <NumberInput
                value={backup?.hour ?? 3}
                onValueChange={(h: number) => { void saveBackupHour(h) }}
                decimals={0}
              />
            </div>
            <button className="btn btn-primary" disabled={backingUp} onClick={backupNow}>
              {backingUp ? 'جارٍ النسخ…' : '💾 خذ نسخة الآن'}
            </button>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', flex: 1 }}>
              لو كان الجهاز مغلقاً في موعد النسخ، تُؤخذ النسخة عند أول تشغيل بعده — فلا
              يمر يوم بدون نسخة.
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
