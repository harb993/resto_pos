import React, { useState } from 'react'
import { useAuthStore } from '../state/stores'

export default function LoginScreen() {
  const setUser = useAuthStore((s) => s.setUser)
  const [mode, setMode] = useState<'pin' | 'password'>('pin')
  const [pin, setPin] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const handlePinPress = async (digit: string) => {
    setError('')
    const newPin = pin + digit
    setPin(newPin)
    if (newPin.length >= 4) {
      setLoading(true)
      try {
        const res = await window.api.loginByPin(newPin)
        if (res.success) {
          setUser(res.data)
        } else {
          setError(res.error || 'Invalid PIN')
          setPin('')
        }
      } catch {
        setError('Login failed')
        setPin('')
      }
      setLoading(false)
    }
  }

  const handlePinClear = () => { setPin(''); setError('') }

  const handlePasswordLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const res = await window.api.login(username, password)
      if (res.success) {
        setUser(res.data)
      } else {
        setError(res.error || 'Invalid credentials')
      }
    } catch {
      setError('Login failed')
    }
    setLoading(false)
  }

  return (
    <div className="login-container">
      <div className="login-card animate-slide">
        <div className="login-logo">🍗</div>
        <h1 className="login-title">Resto POS</h1>
        <p className="login-subtitle">Sign in to start your shift</p>

        <div className="login-tabs">
          <button className={`login-tab ${mode === 'pin' ? 'active' : ''}`} onClick={() => { setMode('pin'); setError('') }}>
            PIN
          </button>
          <button className={`login-tab ${mode === 'password' ? 'active' : ''}`} onClick={() => { setMode('password'); setError('') }}>
            Password
          </button>
        </div>

        {error && (
          <div style={{ background: 'var(--danger-bg)', color: 'var(--danger)', padding: '10px 14px', borderRadius: 'var(--radius-sm)', marginBottom: 16, fontSize: 13, fontWeight: 500, textAlign: 'center' }}>
            {error}
          </div>
        )}

        {mode === 'pin' ? (
          <div>
            <div className="pin-display">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className={`pin-dot ${i < pin.length ? 'filled' : ''}`} />
              ))}
            </div>
            <div className="pin-grid">
              {['1','2','3','4','5','6','7','8','9','','0','⌫'].map((d) => (
                <button
                  key={d || 'empty'}
                  className="pin-btn"
                  onClick={() => {
                    if (d === '⌫') handlePinClear()
                    else if (d) handlePinPress(d)
                  }}
                  disabled={loading || !d}
                  style={!d ? { visibility: 'hidden' } : undefined}
                >
                  {d}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <form onSubmit={handlePasswordLogin}>
            <div className="form-group">
              <label className="form-label">Username</label>
              <input className="input" type="text" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Enter username" autoFocus />
            </div>
            <div className="form-group">
              <label className="form-label">Password</label>
              <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Enter password" />
            </div>
            <button className="btn btn-primary btn-lg" type="submit" disabled={loading} style={{ width: '100%', marginTop: 8 }}>
              {loading ? 'Signing in...' : 'Sign In'}
            </button>
          </form>
        )}
      </div>
    </div>
  )
}
