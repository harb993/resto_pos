import React, { useState, useEffect } from 'react'
import type { ShiftReport } from '../../../shared/types'
import { resolveShift } from '../../../shared/shifts'
import { useSettingsStore } from '../../state/stores'

/**
 * The close-out sheet for one shift: takings, cash expected in the drawer, every
 * invoice, what was sold, what was spent and what stock moved.
 */
export default function ShiftReportModal({ shiftId, onClose, work }: {
  shiftId: number
  onClose: () => void
  /** The shop's whole shift — everyone's sales — rather than one cashier's session. */
  work?: boolean
}) {
  const currency = useSettingsStore((s) => s.settings.currency_symbol)
  const settings = useSettingsStore((s) => s.settings)

  const [report, setReport] = useState<ShiftReport | null>(null)
  const [error, setError] = useState('')
  const [exporting, setExporting] = useState(false)
  const [saved, setSaved] = useState<string | null>(null)
  // The pair of files the group gets: written together, then sent together.
  const [bundling, setBundling] = useState<'' | 'files' | 'share'>('')
  const [bundle, setBundle] = useState<any | null>(null)
  const [printing, setPrinting] = useState(false)

  /** The close-out slip on the counter printer — the shop's shift only. */
  const printSlip = async () => {
    setPrinting(true)
    const res = await window.api.printClosingReport(shiftId)
    setPrinting(false)
    if (!res.success) setError(res.error || 'تعذرت الطباعة')
    else setSaved(null)
  }

  useEffect(() => {
    let live = true
    window.api.getShiftReport(shiftId, work).then((res: any) => {
      if (!live) return
      if (res.success) setReport(res.data)
      else setError(res.error || 'تعذر تحميل تقرير الوردية')
    })
    return () => { live = false }
  }, [shiftId, work])

  const money = (n: number) =>
    n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

  const exportPdf = async () => {
    setExporting(true)
    const res = await window.api.exportShiftReportPdf(shiftId, work)
    setExporting(false)
    if (!res.success) { setError(res.error || 'فشل التصدير'); return }
    if (res.data?.filePath) setSaved(res.data.filePath) // cancelled dialog → stay quiet
  }

  /** Both files into the dated end-of-shift folder — the same pair sent to the group. */
  const exportBoth = async () => {
    setBundling('files')
    const res = await window.api.exportShiftFiles(shiftId, work)
    setBundling('')
    if (!res.success) { setError(res.error || 'فشل التصدير'); return }
    setBundle(res.data)
    setError('')
  }

  const shareToGroup = async () => {
    setBundling('share')
    const res = await window.api.shareShiftToGroup(shiftId, bundle ?? undefined, work)
    setBundling('')
    if (!res.success) { setError(res.error || 'تعذر فتح واتساب'); return }
    setBundle(res.data)
    setError('')
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal"
        onClick={e => e.stopPropagation()}
        style={{ maxWidth: 940, maxHeight: '92vh', overflowY: 'auto' }}
      >
        {!report && !error && (
          <div className="empty-state" style={{ padding: 40 }}>
            <div className="empty-state-icon" style={{ animation: 'pulse 1.5s infinite' }}>🧾</div>
            <div className="empty-state-text">جاري تجهيز تقرير الوردية...</div>
          </div>
        )}

        {error && (
          <div style={{ padding: 20 }}>
            <div className="badge badge-danger" style={{ padding: '10px 16px', fontSize: 14 }}>⚠️ {error}</div>
            <div style={{ marginTop: 18, textAlign: 'left' }}>
              <button className="btn btn-secondary" onClick={onClose}>إغلاق</button>
            </div>
          </div>
        )}

        {report && (() => {
          const r = report
          return (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6 }}>
                <div>
                  <h2 className="modal-title" style={{ marginBottom: 4 }}>
                    تقرير وردية — {resolveShift(r.shiftNumber, settings).icon}{' '}
                    {r.shiftName || resolveShift(r.shiftNumber, settings).name}
                  </h2>
                  <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                    {work ? 'كل المحل' : r.cashierName} · {r.shiftDate} · {r.startTime || '—'} → {r.isOpen ? 'جارية الآن' : (r.endTime || '—')}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                  {work && (
                    <button className="btn btn-primary" onClick={printSlip} disabled={printing}>
                      {printing ? '⏳ جاري...' : '🖨️ طباعة التقفيل'}
                    </button>
                  )}
                  <button className="btn btn-secondary" onClick={exportBoth} disabled={bundling !== ''}>
                    {bundling === 'files' ? '⏳ جاري...' : '📦 حفظ PDF + Excel'}
                  </button>
                  <button className="btn btn-success" onClick={shareToGroup} disabled={bundling !== ''}>
                    {bundling === 'share' ? '⏳ جاري...' : '💬 إرسال للجروب'}
                  </button>
                  <button className="btn btn-secondary" onClick={onClose}>إغلاق</button>
                </div>
              </div>

              {r.isOpen && (
                <div style={{ background: 'var(--warning-bg)', borderRight: '3px solid var(--warning)', padding: '9px 13px', borderRadius: 6, fontSize: 12, color: 'var(--text-secondary)', marginBottom: 14 }}>
                  ⚠️ الوردية ما زالت مفتوحة — الأرقام محسوبة حتى هذه اللحظة.
                </div>
              )}

              {saved && (
                <div style={{ background: 'var(--success-bg)', borderRight: '3px solid var(--success)', padding: '9px 13px', borderRadius: 6, fontSize: 12, marginBottom: 14, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span>تم حفظ التقرير بنجاح</span>
                  <button className="btn btn-sm btn-secondary" onClick={() => window.api.openExportedFile(saved)}>
                    فتح الملف
                  </button>
                </div>
              )}

              {bundle?.pdfPath && (
                <div style={{
                  background: 'var(--success-bg)', borderRight: '3px solid var(--success)',
                  padding: '10px 13px', borderRadius: 6, fontSize: 12.5, marginBottom: 14, lineHeight: 1.8,
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
                    <b>الملفان جاهزان — PDF و Excel في مجلد واحد</b>
                    <button className="btn btn-sm btn-secondary" onClick={() => window.api.openShiftExportFolder(bundle.folder)}>
                      📂 فتح المجلد
                    </button>
                  </div>
                  <div style={{ color: 'var(--text-muted)', fontSize: 11.5, marginTop: 4, wordBreak: 'break-all' }}>
                    {bundle.folder}
                  </div>
                  {bundle.prefilled === false && (
                    // An invite link opens the group but WhatsApp will not let a link
                    // carry a message, so say where the text went instead of pretending.
                    <div style={{ marginTop: 6 }}>
                      واتساب فتح الجروب بدون نص — انسخ الملخص من هنا والصقه، ثم اسحب
                      الملفين من المجلد المفتوح.
                      <button
                        className="btn btn-sm btn-ghost"
                        style={{ marginRight: 8 }}
                        onClick={() => navigator.clipboard?.writeText(bundle.summaryText || '')}
                      >
                        نسخ الملخص
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* Headline */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, marginBottom: 18 }}>
                <Tile label="إجمالي المبيعات" value={money(r.revenue)} color="var(--accent)" />
                <Tile label="عدد الفواتير" value={String(r.orderCount)} color="var(--success)" />
                <Tile label="متوسط الفاتورة" value={money(r.averageOrder)} color="var(--warning)" />
                <Tile label="صافي ربح الوردية" value={money(r.netProfit)} color={r.netProfit >= 0 ? 'var(--success)' : 'var(--danger)'} />
              </div>

              {/* Drawer reconciliation — the reason this report exists */}
              <div className="card" style={{ marginBottom: 18, border: '2px solid var(--success)', background: 'var(--success-bg)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <div style={{ fontWeight: 900, fontSize: 15 }}>النقدية المتوقعة في الدرج</div>
                    <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 4 }}>
                      مبيعات نقدية {money(r.cashSales)}
                      {r.driverCashOut > 0 && <> − مع السائقين {money(r.driverCashOut)}</>}
                      {r.settlementsReceived > 0 && <> + توريد السائقين {money(r.settlementsReceived)}</>}
                      {' '}− مصروفات {money(r.expensesTotal)}
                      {r.salariesTotal > 0 && <> − مرتبات {money(r.salariesTotal)}</>}
                      {r.supplierCashTotal > 0 && <> − موردين نقداً {money(r.supplierCashTotal)}</>}
                      {r.driverCashPending > 0 && <div>لم يُورَّد من السائقين بعد: {money(r.driverCashPending)}</div>}
                    </div>
                  </div>
                  <div style={{ fontSize: 26, fontWeight: 900, color: 'var(--success)' }}>
                    {money(r.expectedCash)} {currency}
                  </div>
                </div>
              </div>

              <Section title="ربح الوردية">
                <table>
                  <tbody>
                    <Row label={`المبيعات — نقدي ${money(r.cashSales)} · بطاقة ${money(r.cardSales)}`} value={`${money(r.revenue)} ${currency}`} />
                    <Row label="ضريبة القيمة المضافة — تُورَّد للضرائب وليست ربحاً" value={`− ${money(r.tax)} ${currency}`} color="var(--danger)" />
                    <Row label="تكلفة البضاعة المباعة" value={`− ${money(r.cogs)} ${currency}`} color="var(--danger)" />
                    <Row label="المصروفات التشغيلية" value={`− ${money(r.operatingExpenses)} ${currency}`} color="var(--danger)" />
                    {r.salariesTotal > 0 && <Row label="المرتبات" value={`− ${money(r.salariesTotal)} ${currency}`} color="var(--danger)" />}
                    {r.wasteValue > 0 && <Row label="الهالك" value={`− ${money(r.wasteValue)} ${currency}`} color="var(--danger)" />}
                    <Row label="صافي ربح الوردية" value={`${money(r.netProfit)} ${currency}`} bold color={r.netProfit >= 0 ? 'var(--success)' : 'var(--danger)'} />
                    {r.ingredientPurchases > 0 && (
                      <Row label="مشتريات خامات (من الدرج — لا تُخصم من الربح مرة ثانية)" value={`${money(r.ingredientPurchases)} ${currency}`} muted />
                    )}
                    {r.voidedCount > 0 && (
                      <Row label={`فواتير ملغاة (${r.voidedCount})`} value={`${money(r.voidedValue)} ${currency}`} color="var(--danger)" />
                    )}
                  </tbody>
                </table>
              </Section>

              <div className="grid-2" style={{ gap: 16, marginBottom: 4 }}>
                <Section title="حسب نوع الطلب">
                  <table>
                    <thead><tr><th>النوع</th><th>فواتير</th><th style={{ textAlign: 'left' }}>الإيراد</th></tr></thead>
                    <tbody>
                      {r.byOrderType.map(t => (
                        <tr key={t.type}>
                          <td>{t.label}</td><td>{t.orders}</td>
                          <td style={{ textAlign: 'left', fontWeight: 700 }}>{money(t.total)}</td>
                        </tr>
                      ))}
                      {r.byOrderType.length === 0 && <EmptyRow cols={3} />}
                    </tbody>
                  </table>
                </Section>

                <Section title="الأصناف المباعة">
                  <div style={{ maxHeight: 220, overflowY: 'auto' }}>
                    <table>
                      <thead><tr><th>الصنف</th><th>الكمية</th><th style={{ textAlign: 'left' }}>الإيراد</th></tr></thead>
                      <tbody>
                        {r.items.map((i, idx) => (
                          <tr key={idx}>
                            <td style={{ fontWeight: 700 }}>{i.name}</td><td>{i.units}</td>
                            <td style={{ textAlign: 'left' }}>{money(i.revenue)}</td>
                          </tr>
                        ))}
                        {r.items.length === 0 && <EmptyRow cols={3} />}
                      </tbody>
                    </table>
                  </div>
                </Section>
              </div>

              {r.expenses.length > 0 && (
                <Section title={`المصروفات خلال الوردية (${money(r.expensesTotal)} ${currency})`}>
                  <table>
                    <thead><tr><th>الوقت</th><th>النوع</th><th>البيان</th><th style={{ textAlign: 'left' }}>المبلغ</th></tr></thead>
                    <tbody>
                      {r.expenses.map((e, idx) => (
                        <tr key={idx}>
                          <td>{e.time}</td><td>{e.category}</td><td>{e.description}</td>
                          <td style={{ textAlign: 'left', fontWeight: 700 }}>{money(e.amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Section>
              )}

              {r.salaries.length + r.supplierPayments.length > 0 && (
                <Section title={`مرتبات ومدفوعات موردين خلال الوردية (${money(r.salariesTotal + r.supplierPaymentsTotal)} ${currency})`}>
                  <table>
                    <thead><tr><th>الوقت</th><th>النوع</th><th>الاسم</th><th style={{ textAlign: 'left' }}>المبلغ</th></tr></thead>
                    <tbody>
                      {r.salaries.map((s, idx) => (
                        <tr key={`w${idx}`}>
                          <td>{s.time}</td><td>مرتب</td><td>{s.workerName}</td>
                          <td style={{ textAlign: 'left', fontWeight: 700 }}>{money(s.amount)}</td>
                        </tr>
                      ))}
                      {r.supplierPayments.map((s, idx) => (
                        <tr key={`s${idx}`}>
                          <td>{s.time}</td><td>دفعة مورد{s.method === 'cash' ? '' : ' (غير نقدي)'}</td><td>{s.supplierName}</td>
                          <td style={{ textAlign: 'left', fontWeight: 700 }}>{money(s.amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Section>
              )}

              {r.stockMoves.length > 0 && (
                <Section title="حركة المخزون خلال الوردية">
                  <table>
                    <thead><tr><th>المادة</th><th>نوع الحركة</th><th style={{ textAlign: 'left' }}>التغيير</th></tr></thead>
                    <tbody>
                      {r.stockMoves.map((m, idx) => (
                        <tr key={idx}>
                          <td style={{ fontWeight: 700 }}>{m.name}</td><td>{m.reason}</td>
                          <td style={{ textAlign: 'left', fontWeight: 700, color: m.change < 0 ? 'var(--danger)' : 'var(--success)' }}>
                            {m.change > 0 ? '+' : ''}{m.change} {m.unit}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Section>
              )}

              <Section title={`كل الفواتير (${r.invoices.length})`}>
                <div style={{ maxHeight: 320, overflowY: 'auto' }}>
                  <table>
                    <thead>
                      <tr>
                        <th>الوقت</th><th>رقم الفاتورة</th><th>النوع</th><th>الدفع</th>
                        <th>أصناف</th><th style={{ textAlign: 'left' }}>الإجمالي</th>
                      </tr>
                    </thead>
                    <tbody>
                      {r.invoices.map(i => (
                        <tr key={i.orderId} style={i.status === 'voided'
                          ? { opacity: 0.5, textDecoration: 'line-through' } : undefined}>
                          <td>{i.time}</td>
                          <td style={{ fontWeight: 800, color: 'var(--accent)' }}>
                            {i.invoiceNumber || `#${i.orderId}`}
                          </td>
                          <td>{i.orderTypeLabel}</td>
                          <td>{i.paymentType === 'cash' ? 'نقدي' : 'بطاقة'}</td>
                          <td>{i.itemCount}</td>
                          <td style={{ textAlign: 'left', fontWeight: 800 }}>{money(i.total)}</td>
                        </tr>
                      ))}
                      {r.invoices.length === 0 && <EmptyRow cols={6} />}
                    </tbody>
                  </table>
                </div>
              </Section>
            </>
          )
        })()}
      </div>
    </div>
  )
}

function Tile({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{ background: 'var(--bg-card-hover)', borderTop: `3px solid ${color}`, borderRadius: 8, padding: '12px 14px' }}>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 900, color }}>{value}</div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{
        fontWeight: 800, fontSize: 14, marginBottom: 8, paddingBottom: 5,
        borderBottom: '2px solid var(--accent)',
      }}>
        {title}
      </div>
      {children}
    </div>
  )
}

function Row({ label, value, bold, muted, color }: {
  label: string; value: string; bold?: boolean; muted?: boolean; color?: string
}) {
  return (
    <tr>
      <td style={{
        fontWeight: bold ? 800 : 600,
        color: muted ? 'var(--text-muted)' : 'var(--text-primary)',
        fontSize: muted ? 13 : 14,
      }}>{label}</td>
      <td style={{
        textAlign: 'left', fontWeight: bold ? 900 : 700,
        color: color || (muted ? 'var(--text-muted)' : 'var(--text-primary)'),
        fontSize: bold ? 16 : 14,
      }}>{value}</td>
    </tr>
  )
}

function EmptyRow({ cols }: { cols: number }) {
  return (
    <tr>
      <td colSpan={cols} style={{ textAlign: 'center', padding: 20, color: 'var(--text-muted)' }}>
        لا توجد بيانات
      </td>
    </tr>
  )
}
