import React, { useState, useEffect, useCallback } from 'react'
import type { WorkShift, WorkShiftStatus } from '../../shared/types'
import { useAuthStore } from '../state/stores'

/**
 * The shop's shift, as the screens see it.
 *
 * Everything here reads the same thing the main process decides: whether a shift is
 * running, which shifts there have been, and — for the owner — the button that starts
 * the next one before its time.
 */

const ltr: React.CSSProperties = { direction: 'ltr', display: 'inline-block' }

/** Is a shift running? Kept current by the main process's push and a slow poll. */
export function useWorkShiftStatus(): { status: WorkShiftStatus | null; refresh: () => void } {
  const [status, setStatus] = useState<WorkShiftStatus | null>(null)

  const refresh = useCallback(() => {
    window.api.getWorkShiftStatus().then((res: any) => {
      if (res?.success) setStatus(res.data)
    })
  }, [])

  useEffect(() => {
    refresh()
    // The push covers the moment a shift ends or starts; the poll covers a till that
    // was asleep when it happened.
    const timer = setInterval(refresh, 30_000)
    const off = window.api.onWorkShiftChanged?.((data: WorkShiftStatus) => setStatus(data))
    return () => { clearInterval(timer); off?.() }
  }, [refresh])

  return { status, refresh }
}

/** Every shift on the books, newest first. Re-read whenever one starts or ends. */
export function useWorkShifts(): WorkShift[] {
  const [shifts, setShifts] = useState<WorkShift[]>([])

  useEffect(() => {
    const load = () => window.api.listWorkShifts().then((res: any) => {
      if (res?.success) setShifts(res.data)
    })
    load()
    const off = window.api.onWorkShiftChanged?.(() => { load() })
    return () => { off?.() }
  }, [])

  return shifts
}

/** "مسائية — 13/09 17:00 ← 03:00", or "جارية الآن" for the one still running. */
export function workShiftLabel(s: WorkShift): string {
  const day = `${s.date.slice(8, 10)}/${s.date.slice(5, 7)}`
  return `${s.name} — ${day} ${s.openedAt.slice(11)} ← ${s.isOpen ? 'جارية الآن' : s.endsAt.slice(11)}`
}

export type ShiftChoice = 'all' | 'current' | number

/**
 * The «الوردية» box used by every report: the current shift, or any earlier one by
 * name — and, where the screen also works by date, "all shifts".
 */
export function WorkShiftSelect({ value, onChange, shifts, allowAll, allLabel }: {
  value: ShiftChoice
  onChange: (v: ShiftChoice) => void
  shifts: WorkShift[]
  allowAll?: boolean
  allLabel?: string
}) {
  return (
    <div className="form-group" style={{ marginBottom: 0 }}>
      <label className="form-label">الوردية</label>
      <select
        className="input"
        value={String(value)}
        onChange={e => {
          const v = e.target.value
          onChange(v === 'all' || v === 'current' ? v : Number(v))
        }}
      >
        {allowAll && <option value="all">{allLabel || 'كل الورديات (بالتاريخ)'}</option>}
        <option value="current">الوردية الحالية</option>
        {shifts.map(s => (
          <option key={s.workShiftId} value={s.workShiftId}>{workShiftLabel(s)}</option>
        ))}
      </select>
    </div>
  )
}

/** The shift a choice refers to — the newest one for "current". */
export function chosenShift(value: ShiftChoice, shifts: WorkShift[]): WorkShift | null {
  if (value === 'all') return null
  if (value === 'current') return shifts[0] ?? null
  return shifts.find(s => s.workShiftId === value) ?? null
}

/** "بدأت … — انتهت …" — when the shift began and ended, or that it is still running. */
export function ShiftTimes({ startedAt, endsAt, isOpen, name }: {
  startedAt: string; endsAt: string; isOpen: boolean; name: string
}) {
  return (
    <div style={{
      fontSize: 13, padding: '9px 13px', borderRadius: 6,
      background: isOpen ? 'var(--warning-bg)' : 'var(--success-bg)',
      borderRight: `3px solid ${isOpen ? 'var(--warning)' : 'var(--success)'}`,
    }}>
      🕒 وردية <b>{name}</b> — بدأت <b style={ltr}>{startedAt}</b>
      {isOpen
        ? <> — <b>جارية الآن</b> (تنتهي <span style={ltr}>{endsAt}</span>)، والأرقام محسوبة حتى هذه اللحظة</>
        : <> — انتهت <b style={ltr}>{endsAt}</b></>}
    </div>
  )
}

/**
 * Between shifts: say so, and let the owner start the next one.
 *
 * A dialog the first time, because the till has just stopped taking sales and somebody
 * has to notice; after it is dismissed, a strip across the top for as long as there is
 * no shift, so the reason a sale is refused is always on the screen.
 */
export function WorkShiftGate() {
  const { status, refresh } = useWorkShiftStatus()
  const isOwner = useAuthStore((s) => s.user?.role === 'owner')
  const [dismissedFor, setDismissedFor] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  if (!status || status.open) return null

  const last = status.last
  const next = status.next
  const key = last?.workShiftId ?? 0

  const start = async () => {
    setBusy(true)
    const res = await window.api.startWorkShift()
    setBusy(false)
    if (res.success) { setError(''); refresh() }
    else setError(res.error || 'تعذر بدء الوردية')
  }

  const startButton = isOwner ? (
    <button className="btn btn-primary" onClick={start} disabled={busy}>
      {busy ? '⏳ جاري...' : '▶ ابدأ وردية جديدة الآن'}
    </button>
  ) : null

  const explanation = (
    <>
      {last && <>انتهت وردية <b>{last.name}</b> الساعة <b style={ltr}>{last.endsAt.slice(11)}</b>. </>}
      لا يمكن تسجيل فواتير حتى تبدأ وردية جديدة.
      {next && (
        <> الوردية التالية (<b>{next.name}</b>) تبدأ تلقائياً الساعة <b style={ltr}>{next.startsAt.slice(11)}</b>.</>
      )}
    </>
  )

  if (dismissedFor === key) {
    return (
      <div style={{
        position: 'fixed', top: 0, left: 0, right: 0, zIndex: 9000,
        background: 'var(--warning, #b06a07)', color: '#fff', padding: '8px 16px',
        display: 'flex', gap: 14, alignItems: 'center', justifyContent: 'center',
        fontSize: 13.5, fontWeight: 700,
      }}>
        <span>🕒 {explanation}{!isOwner && ' اطلب من المدير بدء الوردية.'}</span>
        {isOwner && (
          <button className="btn btn-sm" style={{ background: '#fff', color: '#000' }} onClick={start} disabled={busy}>
            ▶ ابدأ وردية جديدة
          </button>
        )}
        {error && <span>⚠️ {error}</span>}
      </div>
    )
  }

  return (
    <div className="modal-overlay">
      <div className="modal" dir="rtl" style={{ maxWidth: 480, textAlign: 'center' }}>
        <div style={{ fontSize: 44, marginBottom: 6 }}>🕒</div>
        <h2 className="modal-title" style={{ marginBottom: 10 }}>انتهت الوردية</h2>
        <p style={{ fontSize: 14, lineHeight: 1.9, color: 'var(--text-secondary)', marginBottom: 16 }}>
          {explanation}
        </p>
        <p style={{ fontSize: 14, fontWeight: 800, marginBottom: 16 }}>
          {isOwner ? 'هل تريد بدء وردية جديدة الآن؟' : 'اطلب من المدير تسجيل الدخول وبدء وردية جديدة.'}
        </p>
        {error && (
          <div className="badge badge-danger" style={{ padding: '8px 12px', marginBottom: 12, display: 'block' }}>⚠️ {error}</div>
        )}
        <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
          {startButton}
          <button className="btn btn-secondary" onClick={() => setDismissedFor(key)}>
            {isOwner ? 'ليس الآن' : 'إغلاق'}
          </button>
        </div>
      </div>
    </div>
  )
}

/** The line in the sidebar: which shift is running, and since when. */
export function WorkShiftBadge() {
  const { status } = useWorkShiftStatus()
  if (!status) return null
  return (
    <div style={{ fontSize: 11.5, textAlign: 'center', marginBottom: 8, color: 'var(--text-muted)', lineHeight: 1.6 }}>
      {status.open
        ? <>🟢 وردية <b>{status.open.name}</b> منذ <span style={ltr}>{status.open.openedAt.slice(11)}</span> — تنتهي <span style={ltr}>{status.open.endsAt.slice(11)}</span></>
        : <>🔴 لا توجد وردية مفتوحة</>}
    </div>
  )
}
