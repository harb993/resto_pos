import React, { useState } from 'react'
import { useSettingsStore } from '../state/stores'
import { useWorkShiftStatus } from './WorkShift'

/**
 * «تقفيل الوردية» — one press to end the shift and print its slip.
 *
 * A single question first, with the closing password, because ending the shift stops
 * the till taking sales: a stray tap in the middle of service, or somebody who should
 * not be closing, must not do that. The password is checked in the main process. Then it closes, prints, and
 * says what it did — with the two figures the person closing up wants to see on the
 * screen as well as on paper: what was sold, and what should be in the drawer.
 *
 * If the shift had already ended at its configured time, the same button prints that
 * shift's slip instead.
 */

interface Result {
  closed: boolean
  shift: { name: string; openedAt: string; endsAt: string; workShiftId: number }
  printed: boolean
  printError: string | null
  printerName: string | null
  revenue: number
  orderCount: number
  outgoings: number
  expectedCash: number
}

export default function CloseShiftDialog({ onClose }: { onClose: () => void }) {
  const currency = useSettingsStore((s) => s.settings.currency_symbol) || 'ج.م'
  const { status } = useWorkShiftStatus()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [pin, setPin] = useState('')
  const [result, setResult] = useState<Result | null>(null)
  const [reprinting, setReprinting] = useState(false)

  const open = status?.open ?? null
  const last = status?.last ?? null

  const go = async () => {
    setBusy(true)
    setError('')
    const res = await window.api.closeWorkShiftAndPrint(pin)
    setBusy(false)
    if (res.success) setResult(res.data)
    else { setError(res.error || 'تعذر تقفيل الوردية'); setPin('') }
  }

  const reprint = async () => {
    if (!result) return
    setReprinting(true)
    const res = await window.api.printClosingReport(result.shift.workShiftId)
    setReprinting(false)
    setResult({
      ...result,
      printed: res.success,
      printError: res.success ? null : (res.error || 'تعذرت الطباعة'),
      printerName: res.success ? res.data?.printerName ?? result.printerName : result.printerName,
    })
  }

  const money = (n: number) =>
    (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  const ltr: React.CSSProperties = { direction: 'ltr', display: 'inline-block' }

  return (
    <div className="modal-overlay" onClick={busy ? undefined : onClose}>
      <div
        className="modal"
        dir="rtl"
        onClick={e => e.stopPropagation()}
        style={{ maxWidth: 440, textAlign: 'center' }}
        onKeyDown={e => { if (e.key === 'Enter' && !result && !busy && pin) void go() }}
      >
        {!result ? (
          <>
            <div style={{ fontSize: 42, marginBottom: 4 }}>🧾</div>
            <h2 className="modal-title" style={{ marginBottom: 8 }}>تقفيل الوردية</h2>
            <p style={{ fontSize: 14, lineHeight: 1.9, color: 'var(--text-secondary)', marginBottom: 18 }}>
              {open ? (
                <>
                  سيتم تقفيل وردية <b>{open.name}</b> (بدأت <b style={ltr}>{open.openedAt.slice(11)}</b>)
                  وطباعة ورقة التقفيل. بعدها لا تُسجَّل فواتير حتى تبدأ الوردية التالية.
                </>
              ) : last ? (
                <>
                  الوردية مقفلة بالفعل (انتهت <b style={ltr}>{last.endsAt.slice(11)}</b>).
                  ستتم طباعة ورقة تقفيلها.
                </>
              ) : 'جاري التحميل...'}
            </p>
            {(open || last) && (
              <input
                className="input"
                type="password"
                inputMode="numeric"
                placeholder="كلمة سر التقفيل"
                value={pin}
                onChange={e => { setPin(e.target.value); setError('') }}
                autoFocus
                style={{ textAlign: 'center', fontSize: 18, letterSpacing: 4, marginBottom: 14 }}
              />
            )}
            {error && (
              <div className="badge badge-danger" style={{ display: 'block', padding: '9px 12px', marginBottom: 12, whiteSpace: 'normal' }}>
                ⚠️ {error}
              </div>
            )}
            <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
              <button
                className="btn btn-primary"
                style={{ minWidth: 190, padding: '13px 18px', fontSize: 16 }}
                onClick={go}
                disabled={busy || !pin || (!open && !last)}
              >
                {busy ? '⏳ جاري التقفيل والطباعة...' : open ? '🧾 تقفيل وطباعة' : '🖨️ طباعة التقفيل'}
              </button>
              <button className="btn btn-secondary" onClick={onClose} disabled={busy}>إلغاء</button>
            </div>
          </>
        ) : (
          <>
            <div style={{ fontSize: 42, marginBottom: 4 }}>{result.printed ? '✅' : '⚠️'}</div>
            <h2 className="modal-title" style={{ marginBottom: 10 }}>
              {result.closed ? 'تم تقفيل الوردية' : 'ورقة التقفيل'}
            </h2>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 14 }}>
              <div style={{ background: 'var(--bg-card-hover)', borderRadius: 10, padding: '10px 8px' }}>
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>المبيعات ({result.orderCount} فاتورة)</div>
                <div style={{ fontSize: 19, fontWeight: 900 }}>{money(result.revenue)}</div>
              </div>
              <div style={{ background: 'var(--success-bg)', borderRadius: 10, padding: '10px 8px' }}>
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>النقدية في الدرج</div>
                <div style={{ fontSize: 19, fontWeight: 900, color: 'var(--success)' }}>{money(result.expectedCash)} {currency}</div>
              </div>
            </div>

            {result.printed ? (
              <p style={{ fontSize: 13.5, color: 'var(--text-secondary)', marginBottom: 16 }}>
                تمت طباعة ورقة التقفيل{result.printerName ? ` على «${result.printerName}»` : ''}.
              </p>
            ) : (
              <div className="badge badge-danger" style={{ display: 'block', padding: '9px 12px', marginBottom: 14, whiteSpace: 'normal', lineHeight: 1.7 }}>
                ⚠️ {result.closed ? 'تم تقفيل الوردية، لكن ' : ''}تعذرت الطباعة: {result.printError}
              </div>
            )}

            <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
              {!result.printed && (
                <button className="btn btn-primary" onClick={reprint} disabled={reprinting}>
                  {reprinting ? '⏳ جاري الطباعة...' : '🖨️ إعادة الطباعة'}
                </button>
              )}
              <button className="btn btn-secondary" onClick={onClose} autoFocus={result.printed}>تم</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
