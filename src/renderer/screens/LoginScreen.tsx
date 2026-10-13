import React, { useState, useEffect } from 'react'
import { useAuthStore, useSettingsStore } from '../state/stores'
import logoUrl from '../assets/logo.png'

export default function LoginScreen() {
  const setUser = useAuthStore((s) => s.setUser)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const businessName = useSettingsStore((s) => s.settings.business_name)
  const loadSettings = useSettingsStore((s) => s.loadSettings)

  // Pre-login this returns the public branding keys only, which is all this screen needs.
  useEffect(() => { loadSettings() }, [loadSettings])

  // Signing in opens the shift on the main-process side, so the hours are measured
  // from this moment rather than being entered by hand later.
  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const res = await window.api.login(username.trim(), password)
      if (res.success) {
        setUser(res.data)
      } else {
        setError(res.error || 'اسم المستخدم أو كلمة المرور غير صحيحة')
      }
    } catch {
      setError('فشل تسجيل الدخول')
    }
    setLoading(false)
  }

  return (
    <div className="login-container" dir="rtl">
      <div className="login-card animate-slide">
        <div className="login-logo">
          <img src={logoUrl} alt="أبو الدهب" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
        </div>
        <h1 className="login-title">{businessName}</h1>
        <p className="login-subtitle">نظام المبيعات والإدارة</p>

        {error && (
          <div
            style={{
              background: 'var(--danger-bg)', color: 'var(--danger)',
              border: '1px solid rgba(239,68,68,0.3)', padding: '10px 14px',
              borderRadius: 'var(--radius-sm)', marginBottom: 16, fontSize: 13,
              fontWeight: 700, textAlign: 'center',
            }}
          >
            ⚠️ {error}
          </div>
        )}

        <form onSubmit={handleLogin}>
          <div className="form-group" style={{ textAlign: 'right' }}>
            <label className="form-label">اسم المستخدم</label>
            <input
              className="input"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="مثال: cashier1"
              autoFocus
              autoComplete="username"
            />
          </div>

          <div className="form-group" style={{ textAlign: 'right' }}>
            <label className="form-label">كلمة المرور</label>
            <input
              className="input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="أدخل كلمة المرور"
              autoComplete="current-password"
            />
          </div>

          <button
            className="btn btn-primary btn-lg"
            type="submit"
            disabled={loading || !username.trim() || !password}
            style={{ width: '100%', marginTop: 8 }}
          >
            {loading ? 'جاري التحقق...' : 'تسجيل الدخول'}
          </button>
        </form>
      </div>
    </div>
  )
}
