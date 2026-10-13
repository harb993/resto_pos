import React, { useState, useEffect, useCallback, useRef } from 'react'
import type { Customer } from '../../../shared/types'

/* ─────────────────────────── helpers ─────────────────────────── */

/** Egyptian number → WhatsApp international format (no +, no spaces). */
function toWhatsAppNumber(raw: string): string {
  const digits = raw.replace(/\D/g, '')
  // Already has country code
  if (digits.startsWith('20') && digits.length >= 11) return digits
  // Local format 01x → 201x
  if (digits.startsWith('0') && digits.length === 11) return '2' + digits
  return digits
}

function buildWaLink(phone: string, message: string): string {
  const num = toWhatsAppNumber(phone)
  const encoded = encodeURIComponent(message)
  return `https://wa.me/${num}?text=${encoded}`
}

type Segment = 'all' | 'repeat' | 'inactive' | 'top'
type Tab = 'campaign' | 'feedback'

interface Note {
  note_id: number
  phone: string
  note: string
  created_at: string
  creator_name?: string
}

/* ─────────────────────── sub-components ──────────────────────── */

function StatBubble({ value, label, color }: { value: string | number; label: string; color: string }) {
  return (
    <div style={{
      flex: 1, minWidth: 120,
      background: 'var(--bg-card)', border: `2px solid color-mix(in srgb, ${color} 13%, transparent)`,
      borderTop: `3px solid ${color}`, borderRadius: 10, padding: '12px 16px',
    }}>
      <div style={{ fontSize: 22, fontWeight: 900, color }}>{value}</div>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3 }}>{label}</div>
    </div>
  )
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
    'مرحباً 👋\nنتمنى تكون بخير!\nعندنا عروض مميزة جداً النهارده — تعالى وشوف 🍗🔥'
  )
  const [imageNote, setImageNote] = useState('')
  const imageInputRef = useRef<HTMLInputElement>(null)
  const [imageFileName, setImageFileName] = useState('')

  /* ── send progress ── */
  const [sending, setSending] = useState(false)
  const [sendIdx, setSendIdx] = useState(0)

  /* ── feedback tab ── */
  const [notePhone, setNotePhone] = useState<string | null>(null)
  const [notes, setNotes] = useState<Note[]>([])
  const [noteText, setNoteText] = useState('')
  const [notesLoading, setNotesLoading] = useState(false)
  const [feedbackSearch, setFeedbackSearch] = useState('')

  /* ─────── load customers ─────── */
  const load = useCallback(async () => {
    setLoading(true)
    const res = await window.api.listCustomers({})
    if (res.success) setCustomers(res.data)
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

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

  /* ─────── image picker ─────── */
  const pickImage = () => imageInputRef.current?.click()
  const onImagePicked = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) {
      setImageFileName(file.name)
      setImageNote(`[صورة: ${file.name}]`)
    }
  }

  /* ─────── send campaign ─────── */
  const targets = audience.filter(c => selected.has(c.phone))

  /*
    One WhatsApp window, one customer at a time.

    This used to open a link per customer on a timer, and every link was a new browser
    tab — fifty customers, fifty tabs. Now each chat loads into the SAME window, and
    the list only moves on when «التالي» is pressed, because the window has to stay on
    a customer until their message has actually been sent.

    The list is frozen when the run starts, so ticking a box half-way through cannot
    shift who "customer 12" is.
  */
  const [run, setRun] = useState<Customer[]>([])
  const [sendError, setSendError] = useState('')

  const openChat = async (customer: Customer) => {
    const fullMessage = imageFileName ? `${message}\n\n${imageNote}` : message
    const res = await window.api.openWhatsappChat(customer.phone, fullMessage)
    setSendError(res.success ? '' : (res.error || 'تعذر فتح واتساب'))
  }

  const startSending = async () => {
    if (!targets.length || !message.trim()) return
    setRun(targets)
    setSending(true)
    setSendIdx(0)
    await openChat(targets[0])
  }

  /** On to the next customer in the same window — or finished. */
  const nextCustomer = async () => {
    const next = sendIdx + 1
    if (next >= run.length) {
      setSendIdx(run.length)
      setSending(false)
      return
    }
    setSendIdx(next)
    await openChat(run[next])
  }

  const stopSending = () => {
    setSending(false)
    setSendIdx(0)
    setRun([])
  }

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

  /* ─────── stats ─────── */
  const totalCustomers = customers.length
  const repeatCustomers = customers.filter(c => c.order_count > 1).length

  /* ─────── render ─────── */
  return (
    <div className="animate-fade" dir="rtl" style={{ height: '100%', display: 'flex', flexDirection: 'column', gap: 0 }}>

      {/* ── Header ── */}
      <div className="page-header" style={{ marginBottom: 0, paddingBottom: 16 }}>
        <div>
          <h1 className="page-title" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 28 }}>💬</span> واتساب تسويق
          </h1>
          <p className="page-subtitle">أرسل عروض وصور الوجبات لعملائك مباشرة عبر واتساب — بدون اشتراك أو API</p>
        </div>
        <button className="btn btn-secondary" onClick={load} disabled={loading}>🔄 تحديث</button>
      </div>

      {/* ── Stats bar ── */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
        <StatBubble value={totalCustomers} label="إجمالي العملاء" color="#25D366" />
        <StatBubble value={repeatCustomers} label="عملاء متكررون" color="#128C7E" />
        <StatBubble value={audience.length} label="الجمهور المحدد" color="#075E54" />
        <StatBubble value={selected.size} label="سيُرسل لهم" color="var(--accent)" />
      </div>

      {/* ── Tab bar ── */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 20, borderBottom: '2px solid var(--border)', paddingBottom: 0 }}>
        {([['campaign', '📢 إرسال حملة'], ['feedback', '📝 ملاحظات وردود']] as [Tab, string][]).map(([id, label]) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              padding: '10px 22px', fontSize: 14, fontWeight: 700,
              color: tab === id ? '#25D366' : 'var(--text-secondary)',
              borderBottom: tab === id ? '3px solid #25D366' : '3px solid transparent',
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
          imageFileName={imageFileName}
          imageNote={imageNote}
          pickImage={pickImage}
          imageInputRef={imageInputRef}
          onImagePicked={onImagePicked}
          targets={sending || run.length > 0 ? run : targets}
          liveTargets={targets}
          nextCustomer={nextCustomer}
          stopSending={stopSending}
          reopenChat={() => run[sendIdx] && openChat(run[sendIdx])}
          sendError={sendError}
          sending={sending}
          sendIdx={sendIdx}
          setSendIdx={(n: number) => { setSendIdx(n); if (n === 0) setRun([]) }}
          startSending={startSending}
          loading={loading}
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

      {/* hidden file input */}
      <input
        ref={imageInputRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={onImagePicked}
      />
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
  imageFileName, imageNote, pickImage, imageInputRef, onImagePicked,
  targets, liveTargets, sending, sendIdx, setSendIdx, startSending, loading,
  nextCustomer, stopSending, reopenChat, sendError,
}: any) {
  const SEGMENTS: [Segment, string, string][] = [
    ['all', 'كل العملاء', '🌍'],
    ['repeat', 'متكررون فقط', '⭐'],
    ['inactive', 'غير نشطين', '😴'],
    ['top', 'أعلى إنفاقاً', '🏆'],
  ]

  const sendProgress = targets.length > 0 ? Math.round((sendIdx / targets.length) * 100) : 0

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 420px', gap: 20, flex: 1, minHeight: 0 }}>

      {/* ── LEFT: Audience ── */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minHeight: 0 }}>

        {/* Segment selector */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {SEGMENTS.map(([id, label, icon]) => (
            <button
              key={id}
              onClick={() => setSegment(id)}
              className={segment === id ? 'btn btn-primary btn-sm' : 'btn btn-secondary btn-sm'}
              style={segment === id ? { background: '#25D366', border: 'none' } : {}}
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
                <tr key={c.phone} style={selected.has(c.phone) ? { background: '#25D36610' } : {}}>
                  <td>
                    <input type="checkbox"
                      checked={selected.has(c.phone)}
                      onChange={() => toggle(c.phone)} />
                  </td>
                  <td style={{ fontFamily: 'monospace', fontWeight: 800, color: '#25D366' }}>{c.phone}</td>
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

      {/* ── RIGHT: Composer + Send ── */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

        {/* WhatsApp brand strip */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10,
          background: 'linear-gradient(135deg, #25D366, #128C7E)',
          borderRadius: 12, padding: '14px 18px', color: '#fff',
        }}>
          <span style={{ fontSize: 28 }}>💬</span>
          <div>
            <div style={{ fontWeight: 900, fontSize: 15 }}>واتساب تسويق</div>
            <div style={{ fontSize: 11, opacity: 0.85 }}>نافذة واحدة لكل العملاء — الرسالة تُكتب تلقائياً</div>
          </div>
        </div>

        {/* Message composer */}
        <div className="card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--text-secondary)' }}>✏️ نص الرسالة</div>

          {/* Quick emoji bar */}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
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
              width: '100%', minHeight: 140, resize: 'vertical',
              background: 'var(--bg-card-hover)', border: '1px solid var(--border)',
              borderRadius: 8, padding: 12, fontSize: 14, color: 'var(--text-primary)',
              fontFamily: 'inherit', direction: 'rtl', lineHeight: 1.6,
            }}
            placeholder="اكتب رسالتك هنا..."
          />
          <div style={{ fontSize: 11, color: 'var(--text-muted)', textAlign: 'left' }}>
            {message.length} حرف
          </div>

          {/* Image attach */}
          <button className="btn btn-secondary btn-sm" onClick={pickImage} style={{ alignSelf: 'flex-start' }}>
            🖼️ {imageFileName ? `تم اختيار: ${imageFileName}` : 'إرفاق صورة (اختياري)'}
          </button>
          {imageFileName && (
            <div style={{ fontSize: 12, color: 'var(--text-muted)', background: 'var(--bg-card-hover)', borderRadius: 8, padding: '8px 12px' }}>
              💡 ستُرسل عبر رسالة منفصلة في واتساب — جهّز الصورة قبل الضغط على إرسال.
            </div>
          )}
        </div>

        {/* WhatsApp preview bubble */}
        <div className="card" style={{ padding: 16 }}>
          <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--text-secondary)', marginBottom: 10 }}>👁️ معاينة</div>
          <div style={{
            background: '#DCF8C6', borderRadius: '0 12px 12px 12px',
            padding: '12px 14px', maxWidth: 280, fontSize: 14,
            color: '#111', whiteSpace: 'pre-wrap', direction: 'rtl',
            boxShadow: '0 1px 3px #0001',
          }}>
            {message || '...'}
            {imageFileName && (
              <div style={{ marginTop: 8, padding: '6px 10px', background: '#25D36620', borderRadius: 6, fontSize: 12, color: '#075E54' }}>
                🖼️ {imageFileName}
              </div>
            )}
            <div style={{ fontSize: 10, color: '#667', textAlign: 'left', marginTop: 6 }}>
              {new Date().toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' })} ✓✓
            </div>
          </div>
        </div>

        {/* Send button + progress */}
        {sending ? (
          <div className="card" style={{ padding: 18, textAlign: 'center' }}>
            <div style={{ fontWeight: 700, marginBottom: 10, color: '#25D366' }}>
              العميل {sendIdx + 1} من {targets.length}
            </div>
            <div style={{ height: 8, background: 'var(--border)', borderRadius: 4, overflow: 'hidden' }}>
              <div style={{
                height: '100%', background: '#25D366', borderRadius: 4,
                width: `${sendProgress}%`, transition: 'width 0.5s',
              }} />
            </div>
            <div style={{ fontSize: 15, fontWeight: 800, marginTop: 10 }}>
              {targets[sendIdx]?.name || 'عميل'}{' '}
              <span style={{ fontFamily: 'monospace', color: '#25D366' }}>{targets[sendIdx]?.phone || ''}</span>
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6, lineHeight: 1.7 }}>
              الرسالة مكتوبة في نافذة واتساب — اضغط «إرسال» هناك، ثم «التالي» هنا.
            </div>
            {sendError && (
              <div className="badge badge-danger" style={{ marginTop: 8, padding: '6px 10px' }}>⚠️ {sendError}</div>
            )}
            <button
              className="btn btn-primary"
              onClick={nextCustomer}
              style={{ width: '100%', marginTop: 12, background: '#25D366', border: 'none', fontWeight: 900, padding: '12px 0' }}
            >
              {sendIdx + 1 < targets.length ? 'التالي ⬅' : '✅ إنهاء'}
            </button>
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <button className="btn btn-secondary btn-sm" style={{ flex: 1 }} onClick={reopenChat}>🔁 افتح المحادثة مرة أخرى</button>
              <button className="btn btn-ghost btn-sm" style={{ flex: 1, color: 'var(--danger)' }} onClick={stopSending}>⏹ إيقاف</button>
            </div>
          </div>
        ) : sendIdx > 0 && sendIdx === targets.length ? (
          <div className="card" style={{ padding: 18, textAlign: 'center', borderTop: '3px solid #25D366' }}>
            <div style={{ fontSize: 24, marginBottom: 6 }}>✅</div>
            <div style={{ fontWeight: 700, color: '#25D366' }}>اكتمل الإرسال!</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
              تم المرور على {targets.length} عميل في نافذة واتساب واحدة
            </div>
            <button className="btn btn-secondary btn-sm" style={{ marginTop: 12 }}
              onClick={() => setSendIdx(0)}>
              إرسال مرة أخرى
            </button>
          </div>
        ) : (
          <button
            className="btn btn-primary"
            disabled={liveTargets.length === 0 || !message.trim()}
            onClick={startSending}
            style={{
              background: liveTargets.length > 0 && message.trim()
                ? 'linear-gradient(135deg, #25D366, #128C7E)'
                : undefined,
              border: 'none', fontSize: 15, padding: '14px 0',
              borderRadius: 12, fontWeight: 900, letterSpacing: 0.5,
            }}
          >
            🚀 ابدأ الإرسال لـ {liveTargets.length} عميل
          </button>
        )}

        <div style={{ fontSize: 11, color: 'var(--text-muted)', textAlign: 'center', lineHeight: 1.5 }}>
          تُفتح نافذة واتساب واحدة لكل العملاء (تسجيل الدخول مرة واحدة) —<br />
          اضغط «إرسال» في واتساب ثم «التالي» هنا لكل عميل
        </div>
      </div>
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

/* ─────── helpers ─────── */
function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
