import React, { useState, useEffect, useCallback } from 'react'
import type { Customer } from '../../../shared/types'

/**
 * واتساب تسويق — choose who, write it once, press once.
 *
 * The sending itself happens in the main process (whatsappSender): one WhatsApp
 * window, each customer's chat in turn, the message and picture sent without anybody
 * pressing anything. This screen picks the audience, writes the message, and shows
 * the campaign going: who has had it, who could not be reached, how long is left.
 * The till can be used while it runs — and leaving this screen does not stop it.
 */

type Segment = 'all' | 'repeat' | 'inactive' | 'top'
type Tab = 'campaign' | 'feedback'

interface Note {
  note_id: number
  phone: string
  note: string
  created_at: string
  creator_name?: string
}

/** What the main process reports as a campaign goes — see whatsappSender. */
interface CampaignProgress {
  state: 'idle' | 'sending' | 'waiting-login' | 'finished' | 'stopped' | 'error'
  total: number
  done: number
  sent: number
  failed: number
  current: { phone: string; name: string | null } | null
  /** `permanent`: not on WhatsApp — a retry would not change it. */
  failures: { phone: string; name: string | null; reason: string; permanent: boolean }[]
  withPicture: boolean
  startedAt: number | null
  finishedAt: number | null
  secondsEach: number
  message: string | null
  /** How many customers of this campaign a retry would still reach. */
  again: number
}

const WA_GREEN = '#25D366'
const WA_DARK = '#128C7E'

/* ─────────────────────── sub-components ──────────────────────── */

/** "about 7 minutes" — a running campaign's time left, rounded to something sayable. */
function minutesLeft(seconds: number): string {
  if (seconds < 45) return 'أقل من دقيقة'
  const m = Math.round(seconds / 60)
  if (m <= 1) return 'حوالي دقيقة'
  if (m === 2) return 'حوالي دقيقتين'
  return `حوالي ${m} دقائق`
}

/* ─────────────────────── main component ──────────────────────── */

export default function WhatsappCampaignScreen() {
  /* ── data ── */
  const [customers, setCustomers] = useState<Customer[]>([])
  const [loading, setLoading] = useState(true)

  /* ── tabs ── */
  const [tab, setTab] = useState<Tab>('campaign')

  /* ── audience ── */
  const [segment, setSegment] = useState<Segment>('all')
  const [inactiveDays, setInactiveDays] = useState(30)
  const [topN, setTopN] = useState(20)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState('')

  /* ── composer ── */
  const [message, setMessage] = useState(
    'مرحباً {الاسم} 👋\nنتمنى تكون بخير!\nعندنا عروض مميزة جداً النهارده — تعالى وشوف 🍗🔥'
  )
  const [picture, setPicture] = useState<{ name: string; preview: string } | null>(null)
  const [error, setError] = useState('')

  /* ── the campaign, as the main process reports it ── */
  const [progress, setProgress] = useState<CampaignProgress | null>(null)

  /* ── feedback tab ── */
  const [notePhone, setNotePhone] = useState<string | null>(null)
  const [notes, setNotes] = useState<Note[]>([])
  const [noteText, setNoteText] = useState('')
  const [notesLoading, setNotesLoading] = useState(false)
  const [feedbackSearch, setFeedbackSearch] = useState('')

  /* ─────── load customers ─────── */
  const load = useCallback(async () => {
    setLoading(true)
    const res = await window.api.listCustomers({ limit: 100000 })
    if (res.success) setCustomers(res.data)
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  // A campaign started earlier is still going — or just finished — when the screen
  // is opened again; pick it up rather than show an empty form.
  useEffect(() => {
    window.api.whatsappCampaignStatus().then((res: any) => {
      if (res?.success && res.data.state !== 'idle') setProgress(res.data)
    })
    return window.api.onWhatsappProgress((p: CampaignProgress) => setProgress(p))
  }, [])

  /* ─────── filtered audience ─────── */
  const now = Date.now()
  const audience = customers.filter(c => {
    if (search && !c.phone.includes(search) && !(c.name || '').includes(search)) return false
    if (segment === 'repeat') return c.order_count > 1
    if (segment === 'inactive') {
      const days = Math.floor((now - new Date(c.last_order_at).getTime()) / 86_400_000)
      return days >= inactiveDays
    }
    if (segment === 'top') {
      const sorted = [...customers].sort((a, b) => b.total_spent - a.total_spent)
      const topSet = new Set(sorted.slice(0, topN).map(c => c.phone))
      return topSet.has(c.phone)
    }
    return true
  })

  // Auto-select all in current audience
  useEffect(() => {
    setSelected(new Set(audience.map(c => c.phone)))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segment, inactiveDays, topN, customers, search])

  const toggleAll = () => {
    if (selected.size === audience.length) setSelected(new Set())
    else setSelected(new Set(audience.map(c => c.phone)))
  }

  const toggle = (phone: string) => {
    setSelected(prev => {
      const s = new Set(prev)
      s.has(phone) ? s.delete(phone) : s.add(phone)
      return s
    })
  }

  /* ─────── picture ─────── */
  const pickPicture = async () => {
    const res = await window.api.whatsappPickImage()
    if (!res.success) { setError(res.error || 'تعذر فتح الصورة'); return }
    if (res.data) { setPicture(res.data); setError('') }
  }
  const removePicture = async () => {
    await window.api.whatsappClearImage()
    setPicture(null)
  }

  /* ─────── send ─────── */
  const targets = audience.filter(c => selected.has(c.phone))
  const running = progress?.state === 'sending' || progress?.state === 'waiting-login'

  const start = async (list: { phone: string; name?: string | null }[]) => {
    if (!list.length || (!message.trim() && !picture)) return
    const minutes = Math.max(1, Math.round((list.length * 12) / 60))
    if (!confirm(
      `سيتم إرسال الرسالة${picture ? ' والصورة' : ''} إلى ${list.length} عميل تلقائياً — حوالي ${minutes} دقيقة.\n` +
      `يمكنك استخدام البرنامج أثناء الإرسال.` +
      // WhatsApp restricts numbers that message a great many people at once.
      (list.length > 250 ? `\n\nتنبيه: الإرسال لعدد كبير مرة واحدة قد يجعل واتساب يقيّد رقم المحل — الأفضل تقسيمهم على أكثر من يوم.` : '') +
      `\n\nابدأ؟`,
    )) return
    setError('')
    const res = await window.api.whatsappCampaignStart(list, message, !!picture)
    if (!res.success) setError(res.error || 'تعذر بدء الإرسال')
  }

  const startAll = () => start(targets.map(c => ({ phone: c.phone, name: c.name })))

  // The same message and picture, to whoever the last campaign has not reached yet —
  // after a stop, a dropped connection, or a few that failed.
  const again = async () => {
    const n = progress?.again ?? 0
    if (!n) return
    const minutes = Math.max(1, Math.round((n * 12) / 60))
    if (!confirm(`سيتم إرسال نفس الرسالة إلى ${n} عميل لم تصلهم بعد — حوالي ${minutes} دقيقة. ابدأ؟`)) return
    setError('')
    const res = await window.api.whatsappCampaignAgain()
    if (!res.success) setError(res.error || 'تعذر بدء الإرسال')
  }
  const stop = () => window.api.whatsappCampaignStop()
  const showWhatsapp = () => window.api.whatsappShowWindow()

  /* ─────── feedback / notes ─────── */
  const openNotes = async (phone: string) => {
    setNotePhone(phone)
    setNotesLoading(true)
    setNoteText('')
    const res = await window.api.getCustomerNotes(phone)
    if (res.success) setNotes(res.data)
    setNotesLoading(false)
  }

  const saveNote = async () => {
    if (!notePhone || !noteText.trim()) return
    const res = await window.api.addCustomerNote({ phone: notePhone, note: noteText.trim() })
    if (res.success) {
      setNotes(prev => [res.data, ...prev])
      setNoteText('')
    }
  }

  const deleteNote = async (noteId: number) => {
    await window.api.deleteCustomerNote(noteId)
    setNotes(prev => prev.filter(n => n.note_id !== noteId))
  }

  /* ─────── render ─────── */
  return (
    <div className="animate-fade" dir="rtl" style={{ height: '100%', display: 'flex', flexDirection: 'column', gap: 0 }}>

      {/* ── Header ── */}
      <div className="page-header" style={{ marginBottom: 0, paddingBottom: 16 }}>
        <div>
          <h1 className="page-title" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 28 }}>💬</span> واتساب تسويق
          </h1>
          <p className="page-subtitle">اكتب الرسالة مرة واحدة واضغط إرسال — تصل لكل العملاء المحددين تلقائياً</p>
        </div>
        <button className="btn btn-secondary" onClick={load} disabled={loading}>🔄 تحديث</button>
      </div>

      {/* ── Tab bar ── */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 20, borderBottom: '2px solid var(--border)', paddingBottom: 0 }}>
        {([['campaign', '📢 إرسال حملة'], ['feedback', '📝 ملاحظات وردود']] as [Tab, string][]).map(([id, label]) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              padding: '10px 22px', fontSize: 14, fontWeight: 700, fontFamily: 'inherit',
              color: tab === id ? WA_GREEN : 'var(--text-secondary)',
              borderBottom: tab === id ? `3px solid ${WA_GREEN}` : '3px solid transparent',
              marginBottom: -2, transition: 'all 0.2s',
            }}
          >{label}</button>
        ))}
      </div>

      {tab === 'campaign' ? (
        <CampaignTab
          audience={audience}
          selected={selected}
          segment={segment}
          setSegment={setSegment}
          inactiveDays={inactiveDays}
          setInactiveDays={setInactiveDays}
          topN={topN}
          setTopN={setTopN}
          search={search}
          setSearch={setSearch}
          toggle={toggle}
          toggleAll={toggleAll}
          message={message}
          setMessage={setMessage}
          picture={picture}
          pickPicture={pickPicture}
          removePicture={removePicture}
          targets={targets}
          loading={loading}
          progress={progress}
          running={running}
          error={error}
          startAll={startAll}
          again={again}
          stop={stop}
          showWhatsapp={showWhatsapp}
          dismiss={() => setProgress(null)}
        />
      ) : (
        <FeedbackTab
          customers={customers}
          feedbackSearch={feedbackSearch}
          setFeedbackSearch={setFeedbackSearch}
          notePhone={notePhone}
          openNotes={openNotes}
          notes={notes}
          notesLoading={notesLoading}
          noteText={noteText}
          setNoteText={setNoteText}
          saveNote={saveNote}
          deleteNote={deleteNote}
          setNotePhone={setNotePhone}
        />
      )}
    </div>
  )
}

/* ═══════════════════════ Campaign Tab ═══════════════════════ */

function CampaignTab({
  audience, selected, segment, setSegment,
  inactiveDays, setInactiveDays, topN, setTopN,
  search, setSearch,
  toggle, toggleAll,
  message, setMessage,
  picture, pickPicture, removePicture,
  targets, loading, progress, running, error,
  startAll, again, stop, showWhatsapp, dismiss,
}: any) {
  const SEGMENTS: [Segment, string, string][] = [
    ['all', 'كل العملاء', '🌍'],
    ['repeat', 'متكررون فقط', '⭐'],
    ['inactive', 'غير نشطين', '😴'],
    ['top', 'أعلى إنفاقاً', '🏆'],
  ]

  // The preview shows the message as the first customer will get it.
  const sample = (targets[0]?.name as string | undefined)?.trim() || 'أحمد'
  const previewText = String(message).replace(/\{\s*الاسم\s*\}/g, sample)

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 420px', gap: 20, flex: 1, minHeight: 0 }}>

      {/* ── Audience ── */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minHeight: 0 }}>

        {/* Segment selector */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {SEGMENTS.map(([id, label, icon]) => (
            <button
              key={id}
              onClick={() => setSegment(id)}
              className={segment === id ? 'btn btn-primary btn-sm' : 'btn btn-secondary btn-sm'}
              style={segment === id ? { background: WA_GREEN, border: 'none' } : {}}
            >{icon} {label}</button>
          ))}
        </div>

        {segment === 'inactive' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'var(--bg-card)', borderRadius: 8, padding: '10px 14px' }}>
            <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>لم يطلب منذ أكثر من</span>
            <input
              type="number" min={1} value={inactiveDays}
              onChange={e => setInactiveDays(Number(e.target.value))}
              className="input" style={{ width: 80, textAlign: 'center' }}
            />
            <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>يوم</span>
          </div>
        )}

        {segment === 'top' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'var(--bg-card)', borderRadius: 8, padding: '10px 14px' }}>
            <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>أعلى</span>
            <input
              type="number" min={1} value={topN}
              onChange={e => setTopN(Number(e.target.value))}
              className="input" style={{ width: 80, textAlign: 'center' }}
            />
            <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>عميلاً من حيث الإنفاق</span>
          </div>
        )}

        {/* Search */}
        <input
          className="input"
          placeholder="بحث باسم أو رقم..."
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: -6 }}>
          👥 {audience.length} عميل في القائمة — <b style={{ color: WA_DARK }}>{selected.size}</b> محدد للإرسال
        </div>

        {/* Customer list */}
        <div className="table-container" style={{ flex: 1, overflowY: 'auto' }}>
          <table>
            <thead>
              <tr>
                <th>
                  <input type="checkbox"
                    checked={selected.size === audience.length && audience.length > 0}
                    onChange={toggleAll} />
                </th>
                <th>رقم الهاتف</th>
                <th>الاسم</th>
                <th>الطلبات</th>
                <th>آخر طلب</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={5} style={{ textAlign: 'center', padding: 30, color: 'var(--text-muted)' }}>جاري التحميل...</td></tr>
              )}
              {!loading && audience.length === 0 && (
                <tr><td colSpan={5} style={{ textAlign: 'center', padding: 30, color: 'var(--text-muted)' }}>
                  لا يوجد عملاء في هذه الفئة
                </td></tr>
              )}
              {audience.map((c: Customer) => (
                <tr key={c.phone} style={selected.has(c.phone) ? { background: `color-mix(in srgb, ${WA_GREEN} 7%, transparent)` } : {}}>
                  <td>
                    <input type="checkbox"
                      checked={selected.has(c.phone)}
                      onChange={() => toggle(c.phone)} />
                  </td>
                  <td style={{ fontFamily: 'monospace', fontWeight: 800, color: WA_DARK }}>{c.phone}</td>
                  <td style={{ fontWeight: 700 }}>{c.name || '—'}</td>
                  <td>
                    <span className={`badge ${c.order_count > 1 ? 'badge-success' : 'badge-warning'}`}>
                      {c.order_count}
                    </span>
                  </td>
                  <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                    {c.last_order_at?.slice(0, 10) || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Composer + Send ── */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, overflowY: 'auto', minHeight: 0 }}>

        {progress && progress.state !== 'idle' ? (
          <CampaignPanel
            progress={progress} running={running} error={error}
            stop={stop} again={again} showWhatsapp={showWhatsapp} dismiss={dismiss}
          />
        ) : (
          <>
            {/* Message composer */}
            <div className="card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ fontWeight: 800, fontSize: 14 }}>✏️ الرسالة</div>

              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                <button
                  className="btn btn-sm btn-secondary"
                  title="يُكتب مكانه اسم كل عميل"
                  onClick={() => setMessage((m: string) => m + '{الاسم}')}
                >
                  + اسم العميل
                </button>
                {['🍗', '🔥', '🎉', '⭐', '💰', '🆓', '👋', '❤️', '✅', '📞'].map(e => (
                  <button key={e}
                    style={{ fontSize: 18, background: 'var(--bg-card-hover)', border: '1px solid var(--border)', borderRadius: 6, padding: '2px 6px', cursor: 'pointer' }}
                    onClick={() => setMessage((m: string) => m + e)}
                  >{e}</button>
                ))}
              </div>

              <textarea
                value={message}
                onChange={e => setMessage(e.target.value)}
                style={{
                  width: '100%', minHeight: 110, resize: 'vertical',
                  background: 'var(--bg-input)', border: '1px solid var(--border)',
                  borderRadius: 8, padding: 12, fontSize: 14, color: 'var(--text-primary)',
                  fontFamily: 'inherit', direction: 'rtl', lineHeight: 1.6,
                }}
                placeholder="اكتب رسالتك هنا..."
              />
              <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                <b>{'{الاسم}'}</b> يُكتب مكانه اسم كل عميل · {String(message).length} حرف
              </div>

              {/* Picture */}
              {picture ? (
                <div style={{ display: 'flex', gap: 10, alignItems: 'center', background: 'var(--bg-card-hover)', borderRadius: 8, padding: 8 }}>
                  <img src={picture.preview} alt="" style={{ width: 64, height: 64, objectFit: 'cover', borderRadius: 6 }} />
                  <div style={{ flex: 1, fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    🖼️ {picture.name}
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>تُرسل مع الرسالة لكل عميل</div>
                  </div>
                  <button className="btn btn-sm btn-ghost" style={{ color: 'var(--danger)' }} onClick={removePicture}>✕</button>
                </div>
              ) : (
                <button className="btn btn-secondary btn-sm" onClick={pickPicture} style={{ alignSelf: 'flex-start' }}>
                  🖼️ إضافة صورة (اختياري)
                </button>
              )}
            </div>

            {/* WhatsApp preview bubble */}
            <div className="card" style={{ padding: 14 }}>
              <div style={{ fontWeight: 700, fontSize: 12.5, color: 'var(--text-secondary)', marginBottom: 8 }}>👁️ كما ستصل للعميل</div>
              <div style={{
                background: '#DCF8C6', borderRadius: '0 12px 12px 12px',
                padding: picture ? 6 : '10px 12px', maxWidth: 280, fontSize: 14,
                color: '#111', whiteSpace: 'pre-wrap', direction: 'rtl',
                boxShadow: '0 1px 3px #0001',
              }}>
                {picture && <img src={picture.preview} alt="" style={{ width: '100%', borderRadius: 8, display: 'block', marginBottom: 6 }} />}
                <div style={{ padding: picture ? '0 6px 4px' : 0 }}>{previewText || '...'}</div>
              </div>
            </div>

            {/* Pinned to the foot of the column, so it is on screen however long the
                message gets. */}
            <div style={{
              position: 'sticky', bottom: 0, background: 'var(--bg-app)',
              display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 6, marginTop: 'auto',
            }}>
              {error && (
                <div className="badge badge-danger" style={{ display: 'block', padding: '9px 12px', whiteSpace: 'normal' }}>⚠️ {error}</div>
              )}

              <button
                className="btn btn-primary"
                disabled={targets.length === 0 || (!String(message).trim() && !picture)}
                onClick={startAll}
                style={{
                  background: targets.length > 0 ? `linear-gradient(135deg, ${WA_GREEN}, ${WA_DARK})` : undefined,
                  border: 'none', fontSize: 16, padding: '14px 0',
                  borderRadius: 12, fontWeight: 900,
                }}
              >
                🚀 إرسال للكل ({targets.length} عميل)
              </button>

              <div style={{ fontSize: 11.5, color: 'var(--text-muted)', textAlign: 'center', lineHeight: 1.7 }}>
                يُرسل تلقائياً في الخلفية، عميل بعد عميل (حوالي 10 ثوانٍ لكل عميل) —
                <br />تقدر تستخدم البرنامج عادي أثناء الإرسال. أول مرة فقط: امسح كود واتساب من موبايل المحل.
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

/** The campaign going — or how it went. */
function CampaignPanel({ progress: p, running, error, stop, again, showWhatsapp, dismiss }: {
  progress: CampaignProgress
  running: boolean
  error: string
  stop: () => void
  again: () => void
  showWhatsapp: () => void
  dismiss: () => void
}) {
  const pct = p.total > 0 ? Math.round((p.done / p.total) * 100) : 0
  const remaining = Math.max(0, p.total - p.done)
  const eta = p.secondsEach > 0 ? minutesLeft(remaining * p.secondsEach) : null

  return (
    <div className="card" style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 12, borderTop: `3px solid ${WA_GREEN}` }}>
      {p.state === 'waiting-login' ? (
        <div style={{ textAlign: 'center', lineHeight: 1.9 }}>
          <div style={{ fontSize: 34 }}>📱</div>
          <b>امسح كود واتساب من موبايل المحل</b>
          <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>
            في الموبايل: واتساب ← الأجهزة المرتبطة ← ربط جهاز. مرة واحدة فقط — ثم يكمل الإرسال وحده.
          </div>
          <button className="btn btn-secondary btn-sm" style={{ marginTop: 8 }} onClick={showWhatsapp}>📱 إظهار كود واتساب</button>
        </div>
      ) : running ? (
        <div style={{ fontWeight: 800, color: WA_DARK, textAlign: 'center' }}>
          ⏳ جاري الإرسال… {p.done} من {p.total}
        </div>
      ) : (
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 30 }}>{p.state === 'finished' ? '✅' : p.state === 'stopped' ? '⏹' : '⚠️'}</div>
          <div style={{ fontWeight: 900, fontSize: 16 }}>
            {p.state === 'finished' ? 'تم الإرسال' : p.state === 'stopped' ? 'تم إيقاف الإرسال' : 'توقف الإرسال بسبب خطأ'}
          </div>
          {p.message && <div style={{ fontSize: 12, color: 'var(--danger)', marginTop: 4 }}>{p.message}</div>}
        </div>
      )}

      <div style={{ height: 10, background: 'var(--border)', borderRadius: 5, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${pct}%`, background: WA_GREEN, borderRadius: 5, transition: 'width 0.6s' }} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, textAlign: 'center' }}>
        <div style={{ background: 'var(--success-bg)', borderRadius: 8, padding: 8 }}>
          <div style={{ fontSize: 20, fontWeight: 900, color: 'var(--success)' }}>{p.sent}</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>وصلت</div>
        </div>
        <div style={{ background: 'var(--danger-bg)', borderRadius: 8, padding: 8 }}>
          <div style={{ fontSize: 20, fontWeight: 900, color: 'var(--danger)' }}>{p.failed}</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>لم تصل</div>
        </div>
        <div style={{ background: 'var(--bg-card-hover)', borderRadius: 8, padding: 8 }}>
          <div style={{ fontSize: 20, fontWeight: 900 }}>{remaining}</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>متبقي</div>
        </div>
      </div>

      {running && p.current && (
        <div style={{ fontSize: 13, textAlign: 'center' }}>
          الآن: <b>{p.current.name || 'عميل'}</b>{' '}
          <span style={{ fontFamily: 'monospace', color: WA_DARK }}>{p.current.phone}</span>
          {eta && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>الوقت المتبقي: {eta}</div>}
        </div>
      )}

      {p.failures.length > 0 && (
        <div style={{ maxHeight: 180, overflowY: 'auto', fontSize: 12, background: 'var(--bg-card-hover)', borderRadius: 8, padding: '6px 10px' }}>
          {p.failures.map((f, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '3px 0', borderBottom: '1px solid var(--border)' }}>
              <span>{f.name || '—'} <span style={{ fontFamily: 'monospace', color: 'var(--text-muted)' }}>{f.phone}</span></span>
              <span style={{ color: f.permanent ? 'var(--text-muted)' : 'var(--danger)' }}>{f.reason}</span>
            </div>
          ))}
        </div>
      )}

      {error && (
        <div className="badge badge-danger" style={{ display: 'block', padding: '9px 12px', whiteSpace: 'normal' }}>⚠️ {error}</div>
      )}

      {running ? (
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-secondary" style={{ flex: 1, color: 'var(--danger)' }} onClick={stop}>⏹ إيقاف الإرسال</button>
          <button className="btn btn-secondary" style={{ flex: 1 }} onClick={showWhatsapp}>👁️ عرض واتساب</button>
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {p.again > 0 && (
            <button className="btn btn-primary" style={{ flex: '1 1 100%', background: WA_GREEN, border: 'none' }} onClick={again}>
              🔁 إعادة المحاولة لمن لم تصلهم ({p.again})
            </button>
          )}
          <button className="btn btn-secondary" style={{ flex: 1 }} onClick={dismiss}>✏️ حملة جديدة</button>
        </div>
      )}

      {running && (
        <div style={{ fontSize: 11.5, color: 'var(--text-muted)', textAlign: 'center' }}>
          يمكنك استخدام البرنامج أو الخروج من هذه الشاشة — الإرسال مستمر في الخلفية.
        </div>
      )}
    </div>
  )
}

/* ═══════════════════════ Feedback Tab ═══════════════════════ */

function FeedbackTab({
  customers, feedbackSearch, setFeedbackSearch,
  notePhone, openNotes, notes, notesLoading,
  noteText, setNoteText, saveNote, deleteNote, setNotePhone,
}: any) {

  const filtered = customers.filter((c: Customer) =>
    !feedbackSearch ||
    c.phone.includes(feedbackSearch) ||
    (c.name || '').includes(feedbackSearch)
  )

  const openCustomer = customers.find((c: Customer) => c.phone === notePhone)

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 420px', gap: 20, flex: 1, minHeight: 0 }}>

      {/* Customer list */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <input
          className="input"
          placeholder="بحث باسم أو رقم..."
          value={feedbackSearch}
          onChange={e => setFeedbackSearch(e.target.value)}
        />

        <div className="table-container" style={{ flex: 1, overflowY: 'auto' }}>
          <table>
            <thead>
              <tr>
                <th>رقم الهاتف</th>
                <th>الاسم</th>
                <th>الطلبات</th>
                <th>ملاحظات</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((c: Customer) => (
                <tr key={c.phone}
                  style={notePhone === c.phone ? { background: '#25D36615' } : {}}
                >
                  <td style={{ fontFamily: 'monospace', fontWeight: 800, color: '#25D366' }}>{c.phone}</td>
                  <td style={{ fontWeight: 700 }}>{c.name || '—'}</td>
                  <td>
                    <span className={`badge ${c.order_count > 1 ? 'badge-success' : 'badge-warning'}`}>
                      {c.order_count}
                    </span>
                  </td>
                  <td>
                    <button className="btn btn-secondary btn-sm" onClick={() => openNotes(c.phone)}>
                      📝 ملاحظات
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Notes panel */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {!notePhone ? (
          <div className="card" style={{ padding: 40, textAlign: 'center' }}>
            <div style={{ fontSize: 36, marginBottom: 12 }}>📝</div>
            <div style={{ fontWeight: 700, color: 'var(--text-secondary)' }}>
              اختر عميلاً لتسجيل ملاحظاته وردوده
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8 }}>
              سجّل ما قاله العميل في واتساب — ردوده، شكاواه، أو اقتراحاته
            </div>
          </div>
        ) : (
          <>
            {/* Customer header */}
            <div className="card" style={{ padding: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div style={{ fontWeight: 900, fontSize: 16 }}>{openCustomer?.name || 'عميل'}</div>
                <div style={{ fontFamily: 'monospace', color: '#25D366', fontWeight: 700 }}>{notePhone}</div>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => window.api.openWhatsappChat(notePhone, '')}
                  style={{ color: '#25D366' }}
                >
                  💬 فتح واتساب
                </button>
                <button className="btn btn-secondary btn-sm" onClick={() => setNotePhone(null)}>✕</button>
              </div>
            </div>

            {/* Add note */}
            <div className="card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ fontWeight: 700, fontSize: 13 }}>➕ إضافة ملاحظة جديدة</div>
              <textarea
                value={noteText}
                onChange={e => setNoteText(e.target.value)}
                placeholder="اكتب ملاحظة عن هذا العميل..."
                style={{
                  width: '100%', minHeight: 80, resize: 'vertical',
                  background: 'var(--bg-card-hover)', border: '1px solid var(--border)',
                  borderRadius: 8, padding: 10, fontSize: 13, color: 'var(--text-primary)',
                  fontFamily: 'inherit', direction: 'rtl',
                }}
              />
              <button
                className="btn btn-primary btn-sm"
                onClick={saveNote}
                disabled={!noteText.trim()}
                style={{ background: '#25D366', border: 'none', alignSelf: 'flex-start' }}
              >
                💾 حفظ
              </button>
            </div>

            {/* Notes list */}
            <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10 }}>
              {notesLoading && (
                <div style={{ textAlign: 'center', padding: 30, color: 'var(--text-muted)' }}>جاري التحميل...</div>
              )}
              {!notesLoading && notes.length === 0 && (
                <div style={{ textAlign: 'center', padding: 30, color: 'var(--text-muted)' }}>لا توجد ملاحظات بعد</div>
              )}
              {notes.map((n: Note) => (
                <div key={n.note_id} className="card" style={{ padding: 14 }}>
                  <div style={{ fontSize: 13, whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>{n.note}</div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 10 }}>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                      {n.creator_name} · {n.created_at.slice(0, 16)}
                    </div>
                    <button
                      onClick={() => deleteNote(n.note_id)}
                      style={{
                        background: 'none', border: 'none', cursor: 'pointer',
                        color: 'var(--danger)', fontSize: 13, padding: '2px 6px',
                      }}
                    >🗑️</button>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
