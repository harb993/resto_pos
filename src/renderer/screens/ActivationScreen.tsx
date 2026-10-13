import React, { useState } from 'react'
import logoUrl from '../assets/logo.png'

interface Props {
  /** This PC's id, already grouped for reading. */
  deviceId: string
  /** Why a previously working installation stopped, when that is what happened. */
  reason?: string
  onActivated: () => void
}

/**
 * The only screen an unactivated machine can reach.
 *
 * It exists to move one string in each direction: the device id out to the owner, and
 * the key the owner signs for it back in. Everything else — the till, the books, the
 * printers — stays refused by the main process until that exchange is done, so there
 * is deliberately no way past this screen from here.
 */
export default function ActivationScreen({ deviceId, reason, onActivated }: Props) {
  const [key, setKey] = useState('')
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)

  const copyDeviceId = async () => {
    try {
      await navigator.clipboard.writeText(deviceId)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // A clipboard that refuses is not worth an error dialog — the id is on screen
      // in full, and reading it out is the fallback anyone would reach for anyway.
    }
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      const res = await window.api.activateLicense(key.trim())
      if (res.success) {
        onActivated()
      } else {
        setError(res.error || 'المفتاح غير صحيح')
      }
    } catch {
      setError('تعذر التحقق من المفتاح')
    }
    setBusy(false)
  }

  return (
    <div className="login-container" dir="rtl">
      <div className="login-card animate-slide" style={{ maxWidth: 560 }}>
        <div className="login-logo">
          <img src={logoUrl} alt="أبو الدهب" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
        </div>
        <h1 className="login-title">تفعيل البرنامج</h1>
        <p className="login-subtitle">هذا الجهاز غير مُفعَّل بعد</p>

        {reason && (
          <div style={{
            background: 'var(--danger-bg)', color: 'var(--danger)',
            border: '1px solid rgba(239,68,68,0.3)', padding: '10px 14px',
            borderRadius: 'var(--radius-sm)', marginBottom: 16, fontSize: 13,
            fontWeight: 700, textAlign: 'center',
          }}>
            ⚠️ {reason}
          </div>
        )}

        <div style={{
          background: 'var(--bg-card-hover)', borderRadius: 'var(--radius-sm)',
          padding: 16, marginBottom: 18, textAlign: 'center',
        }}>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8, fontWeight: 700 }}>
            رقم هذا الجهاز
          </div>
          <div
            className="num"
            style={{
              fontFamily: 'monospace', fontSize: 20, fontWeight: 800,
              letterSpacing: 1, direction: 'ltr', wordBreak: 'break-all',
              color: 'var(--accent)', marginBottom: 10,
            }}
          >
            {deviceId}
          </div>
          <button type="button" className="btn" onClick={copyDeviceId}>
            {copied ? '✅ تم النسخ' : '📋 نسخ رقم الجهاز'}
          </button>
        </div>

        <p style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.9, marginBottom: 16 }}>
          أرسل رقم الجهاز إلى صاحب البرنامج ليصدر لك مفتاح تفعيل خاصاً به.
          المفتاح يعمل على هذا الجهاز فقط ولا يعمل على أي جهاز آخر.
        </p>

        {error && (
          <div style={{
            background: 'var(--danger-bg)', color: 'var(--danger)',
            border: '1px solid rgba(239,68,68,0.3)', padding: '10px 14px',
            borderRadius: 'var(--radius-sm)', marginBottom: 16, fontSize: 13,
            fontWeight: 700, textAlign: 'center',
          }}>
            ⚠️ {error}
          </div>
        )}

        <form onSubmit={submit}>
          <div className="form-group" style={{ textAlign: 'right' }}>
            <label className="form-label">مفتاح التفعيل</label>
            <textarea
              className="input"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="الصق المفتاح هنا"
              rows={4}
              autoFocus
              spellCheck={false}
              style={{
                fontFamily: 'monospace', direction: 'ltr', textAlign: 'left',
                resize: 'vertical', lineHeight: 1.6,
              }}
            />
          </div>

          <button
            className="btn btn-primary btn-lg"
            type="submit"
            disabled={busy || !key.trim()}
            style={{ width: '100%', marginTop: 8 }}
          >
            {busy ? 'جاري التحقق...' : 'تفعيل'}
          </button>
        </form>
      </div>
    </div>
  )
}
