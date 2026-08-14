import React, { useState, useEffect } from 'react'
import type { AppSettings } from '../../shared/types'

export default function SettingsScreen() {
  const [settings, setSettings] = useState<Partial<AppSettings>>({})
  const [toast, setToast] = useState<{ msg: string; type: string } | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => { loadSettings() }, [])

  const loadSettings = async () => {
    const res = await window.api.getSettings()
    if (res.success) setSettings(res.data)
  }

  const save = async () => {
    setSaving(true)
    const res = await window.api.updateSettings(settings)
    if (res.success) {
      setToast({ msg: 'Settings saved', type: 'success' })
    } else {
      setToast({ msg: res.error || 'Failed', type: 'error' })
    }
    setTimeout(() => setToast(null), 3000)
    setSaving(false)
  }

  const handleBackup = async () => {
    const res = await window.api.backup()
    if (res.success) {
      setToast({ msg: `Backup saved to: ${res.data.path}`, type: 'success' })
    } else {
      setToast({ msg: res.error || 'Backup failed', type: 'error' })
    }
    setTimeout(() => setToast(null), 5000)
  }

  const update = (key: keyof AppSettings, value: string | number) => {
    setSettings((s) => ({ ...s, [key]: value }))
  }

  return (
    <div className="animate-fade">
      <div className="page-header">
        <div><h1 className="page-title">Settings</h1><p className="page-subtitle">App configuration</p></div>
        <button className="btn btn-primary" onClick={save} disabled={saving}>{saving ? 'Saving...' : 'Save Settings'}</button>
      </div>

      <div className="grid-2">
        <div className="card">
          <div className="card-header"><span className="card-title">Business Info</span></div>
          <div className="form-group"><label className="form-label">Business Name</label><input className="input" value={settings.business_name || ''} onChange={(e) => update('business_name', e.target.value)} /></div>
          <div className="form-group"><label className="form-label">Address</label><input className="input" value={settings.business_address || ''} onChange={(e) => update('business_address', e.target.value)} /></div>
          <div className="form-group"><label className="form-label">Phone</label><input className="input" value={settings.business_phone || ''} onChange={(e) => update('business_phone', e.target.value)} /></div>
          <div className="form-group"><label className="form-label">Receipt Footer</label><input className="input" value={settings.receipt_footer || ''} onChange={(e) => update('receipt_footer', e.target.value)} /></div>
        </div>

        <div className="card">
          <div className="card-header"><span className="card-title">Financial</span></div>
          <div className="form-group"><label className="form-label">Tax Rate (%)</label><input className="input" type="number" step="0.01" value={((settings.tax_rate || 0) * 100).toFixed(0)} onChange={(e) => update('tax_rate', Number(e.target.value) / 100)} /></div>
          <div className="form-group"><label className="form-label">Currency Symbol</label><input className="input" value={settings.currency_symbol || ''} onChange={(e) => update('currency_symbol', e.target.value)} /></div>
          <div className="form-group"><label className="form-label">Max Cashier Discount (%)</label><input className="input" type="number" value={settings.max_cashier_discount || 0} onChange={(e) => update('max_cashier_discount', Number(e.target.value))} /></div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 20 }}>
        <div className="card-header"><span className="card-title">Backup</span></div>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 12 }}>Create a backup of the database. Backups are automatically created on app launch and shutdown.</p>
        <button className="btn btn-secondary" onClick={handleBackup}>💾 Back Up Now</button>
      </div>

      {toast && <div className={`toast toast-${toast.type}`}>{toast.msg}</div>}
    </div>
  )
}
