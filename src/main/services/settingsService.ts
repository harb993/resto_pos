import { getDb } from '../db/db'
import type { AppSettings } from '../../shared/types'

export function getSettings(): AppSettings {
  const db = getDb()
  const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[]
  const map: Record<string, string> = {}
  for (const r of rows) map[r.key] = r.value
  return {
    tax_rate: parseFloat(map.tax_rate || '0.14'),
    currency_symbol: map.currency_symbol || 'EGP',
    business_name: map.business_name || 'Restaurant',
    business_address: map.business_address || '',
    business_phone: map.business_phone || '',
    receipt_footer: map.receipt_footer || '',
    max_cashier_discount: parseFloat(map.max_cashier_discount || '10'),
    backup_folder: map.backup_folder || '',
  }
}

export function updateSettings(settings: Partial<AppSettings>): void {
  const db = getDb()
  const upsert = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
  const txn = db.transaction(() => {
    for (const [k, v] of Object.entries(settings)) {
      if (v !== undefined) upsert.run(k, String(v))
    }
  })
  txn()
}
