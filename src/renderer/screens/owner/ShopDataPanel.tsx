import React, { useState, useEffect, useCallback } from 'react'
import type { ShopDataCounts, ShopDataExport } from '../../../shared/types'

/**
 * «تصدير البيانات» — the shop's own data out to a file, and back in.
 *
 * The menu, the stock, the customers and the settings: everything somebody typed in to
 * make this installation their restaurant. Not the invoices — a backup carries those —
 * and not the passwords.
 *
 * Export is one button. Import is two steps on purpose: choose the file and see what
 * is in it, THEN replace — because it does replace, and the moment to find out the
 * file is last month's is before that, not after.
 */

interface PickedFile {
  fileName: string
  businessName: string
  exportedAt: string
  counts: ShopDataCounts
  /** Why it cannot be imported right now, when it cannot. */
  blocked: string | null
}

export default function ShopDataPanel({ showToast, active }: {
  showToast: (msg: string, type?: string) => void
  /** Whether the tab is the one on screen — the counts are read when it is opened. */
  active: boolean
}) {
  const [counts, setCounts] = useState<ShopDataCounts | null>(null)
  const [exporting, setExporting] = useState(false)
  const [exported, setExported] = useState<ShopDataExport | null>(null)
  const [picked, setPicked] = useState<PickedFile | null>(null)
  const [busy, setBusy] = useState(false)

  const loadCounts = useCallback(async () => {
    const res = await window.api.getShopDataCounts()
    if (res.success) setCounts(res.data)
  }, [])

  useEffect(() => { if (active) void loadCounts() }, [active, loadCounts])

  const doExport = async () => {
    setExporting(true)
    const res = await window.api.exportShopData()
    setExporting(false)
    if (!res.success) { showToast(res.error || 'تعذر تصدير البيانات', 'error'); return }
    if (!res.data) return // the folder picker was closed
    setExported(res.data)
    showToast('تم تصدير بيانات المحل')
  }

  const pick = async () => {
    setBusy(true)
    const res = await window.api.pickShopDataImport()
    setBusy(false)
    if (!res.success) { showToast(res.error || 'تعذرت قراءة الملف', 'error'); return }
    if (res.data) setPicked(res.data)
  }

  const doImport = async () => {
    if (!picked) return
    if (!confirm(
      `سيتم استبدال القائمة والمخزون والعملاء والإعدادات الحالية ببيانات الملف:\n` +
      `${picked.businessName || picked.fileName} — ${picked.exportedAt}\n\nهل أنت متأكد؟`,
    )) return
    setBusy(true)
    const res = await window.api.importShopData()
    // On success the main process reloads the window, so nothing here runs after.
    if (!res.success) {
      setBusy(false)
      showToast(res.error || 'تعذر استيراد البيانات', 'error')
    }
  }

  return (
    <div className="grid-2" style={{ marginTop: 4 }}>
      {/* ---- Export ---- */}
      <div className="card">
        <div className="card-header">
          <span className="card-title">📤 تصدير بيانات المحل</span>
        </div>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 14, lineHeight: 1.9 }}>
          يحفظ <b>القائمة والمخزون والعملاء والإعدادات</b> في مجلد واحد: ملف Excel للقراءة
          والمراجعة، وملف بيانات يمكن استيراده في أي جهاز آخر.
        </p>

        {counts && <Counts counts={counts} />}

        <button className="btn btn-primary" onClick={doExport} disabled={exporting} style={{ marginTop: 14 }}>
          {exporting ? '⏳ جاري التصدير...' : '📤 تصدير البيانات'}
        </button>

        {exported && (
          <div style={{
            background: 'var(--success-bg)', borderRight: '3px solid var(--success)',
            padding: '10px 13px', borderRadius: 6, fontSize: 12.5, marginTop: 14, lineHeight: 1.8,
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
              <b>تم الحفظ — ملف Excel وملف البيانات</b>
              <button className="btn btn-sm btn-secondary" onClick={() => window.api.openShopDataFolder(exported.folder)}>
                📂 فتح المجلد
              </button>
            </div>
            <div style={{ color: 'var(--text-muted)', fontSize: 11.5, marginTop: 4, wordBreak: 'break-all', direction: 'ltr', textAlign: 'right' }}>
              {exported.folder}
            </div>
          </div>
        )}

        <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 14, lineHeight: 1.8 }}>
          لا يشمل الفواتير والمصروفات (تُحفظ في النسخ الاحتياطي)، ولا كلمات المرور، ولا ربط الأجهزة.
        </p>
      </div>

      {/* ---- Import ---- */}
      <div className="card">
        <div className="card-header">
          <span className="card-title">📥 استيراد بيانات من ملف</span>
        </div>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 14, lineHeight: 1.9 }}>
          يستبدل القائمة والمخزون والعملاء والإعدادات ببيانات ملف تم تصديره من البرنامج.
          متاح <b>قبل تسجيل أي فواتير</b> فقط — على جهاز جديد، أو بعد تصفير النظام.
        </p>

        <button className="btn btn-secondary" onClick={pick} disabled={busy}>
          📁 اختيار ملف البيانات (shop-data.json)
        </button>

        {picked && (
          <div style={{ marginTop: 14 }}>
            <div style={{ fontSize: 13, marginBottom: 10, lineHeight: 1.8 }}>
              <b>{picked.businessName || picked.fileName}</b>
              <span style={{ color: 'var(--text-muted)' }}> — صُدِّر في </span>
              <span style={{ direction: 'ltr', display: 'inline-block' }}>{picked.exportedAt}</span>
            </div>
            <Counts counts={picked.counts} />

            {picked.blocked ? (
              <div className="badge badge-danger" style={{ display: 'block', padding: '10px 13px', marginTop: 14, fontSize: 12.5, lineHeight: 1.8, whiteSpace: 'normal' }}>
                ⚠️ {picked.blocked}
              </div>
            ) : (
              <button className="btn btn-primary" onClick={doImport} disabled={busy} style={{ marginTop: 14 }}>
                {busy ? '⏳ جاري الاستيراد...' : '📥 استبدال بيانات المحل بهذا الملف'}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function Counts({ counts }: { counts: ShopDataCounts }) {
  const tiles: [string, number][] = [
    ['الأصناف', counts.menuItems],
    ['الخامات', counts.rawMaterials],
    ['العملاء', counts.customers],
    ['مناطق التوصيل', counts.deliveryAreas],
  ]
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
      {tiles.map(([label, n]) => (
        <div key={label} style={{ background: 'var(--bg-card-hover)', borderRadius: 8, padding: '9px 10px', textAlign: 'center' }}>
          <div style={{ fontSize: 18, fontWeight: 900 }}>{n}</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{label}</div>
        </div>
      ))}
    </div>
  )
}
