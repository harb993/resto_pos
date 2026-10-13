import React, { useState, useEffect, useCallback } from 'react'
import type { ClosingReport } from '../../shared/types'
import { useSettingsStore } from '../state/stores'
import { WorkShiftSelect, useWorkShifts, type ShiftChoice } from './WorkShift'

/**
 * «تقفيل الوردية» — the till's close-out for a shift as the settings define it.
 *
 * Opens on the shift running now, because that is the one being closed nine times in
 * ten; an earlier one is a date and a shift away. Everything shown comes from the main
 * process, and printing asks it again rather than sending these figures back.
 */
export default function ClosingModal({ onClose, workShiftId }: { onClose: () => void; workShiftId?: number }) {
  const settings = useSettingsStore((s) => s.settings)
  const currency = settings.currency_symbol
  const shifts = useWorkShifts()
  // 'current' = the shift running now; the main process works out which that is.
  const [choice, setChoice] = useState<ShiftChoice>(workShiftId ?? 'current')
  const shiftId = typeof choice === 'number' ? choice : undefined
  const [report, setReport] = useState<ClosingReport | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [printing, setPrinting] = useState(false)
  const [note, setNote] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    const res = await window.api.getClosingReport(shiftId)
    setLoading(false)
    if (res.success) { setReport(res.data); setError('') }
    else { setReport(null); setError(res.error || 'تعذر تحميل التقفيل') }
  }, [shiftId])

  useEffect(() => { void load() }, [load])

  const print = async () => {
    setPrinting(true)
    setNote('')
    const res = await window.api.printClosingReport(shiftId)
    setPrinting(false)
    if (res.success) { setNote(`تمت الطباعة على "${res.data?.printerName ?? 'الطابعة'}"`); setError('') }
    else setError(res.error || 'تعذرت الطباعة')
  }

  const money = (n: number) =>
    (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

  const r = report

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal"
        dir="rtl"
        onClick={e => e.stopPropagation()}
        style={{ maxWidth: 860, maxHeight: '92vh', overflowY: 'auto' }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 12 }}>
          <div>
            <h2 className="modal-title" style={{ marginBottom: 4 }}>
              🧾 تقفيل الوردية{r ? ` — ${r.shiftName}` : ''}
            </h2>
            {r && (
              <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                {r.shiftDate} · <span style={{ direction: 'ltr', display: 'inline-block' }}>{r.startTime}</span>
                {' '}→ <span style={{ direction: 'ltr', display: 'inline-block' }}>{r.endTime}</span>
                {r.isOpen && ' · جارية الآن'}
              </div>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-primary" onClick={print} disabled={!r || printing}>
              {printing ? '⏳ جاري الطباعة...' : '🖨️ طباعة التقفيل'}
            </button>
            <button className="btn btn-secondary" onClick={onClose}>إغلاق</button>
          </div>
        </div>

        {/* Which shift */}
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 14 }}>
          <WorkShiftSelect value={choice} onChange={setChoice} shifts={shifts} />
          <button className="btn btn-sm btn-ghost" onClick={load} disabled={loading}>🔄 تحديث</button>
        </div>

        {error && (
          <div className="badge badge-danger" style={{ padding: '10px 16px', fontSize: 14, marginBottom: 12, display: 'block' }}>
            ⚠️ {error}
          </div>
        )}
        {note && (
          <div style={{ background: 'var(--success-bg)', borderRight: '3px solid var(--success)', padding: '9px 13px', borderRadius: 6, fontSize: 12.5, marginBottom: 12 }}>
            ✅ {note}
          </div>
        )}

        {loading && !r && (
          <div className="empty-state" style={{ padding: 40 }}>
            <div className="empty-state-text">جاري تجهيز التقفيل...</div>
          </div>
        )}

        {r && (
          <>
            {r.isOpen && (
              <div style={{ background: 'var(--warning-bg)', borderRight: '3px solid var(--warning)', padding: '9px 13px', borderRadius: 6, fontSize: 12, color: 'var(--text-secondary)', marginBottom: 14 }}>
                ⚠️ الوردية لم تنتهِ بعد — الأرقام محسوبة حتى الآن.
              </div>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, marginBottom: 16 }}>
              <Tile label={`إجمالي المبيعات (${r.orderCount} فاتورة)`} value={money(r.revenue)} color="var(--success)" />
              <Tile label="إجمالي المدفوع (مصروفات ومرتبات وموردين)" value={money(r.outgoingsTotal)} color="var(--danger)" />
            </div>

            <div className="card" style={{ marginBottom: 16, border: '2px solid var(--success)', background: 'var(--success-bg)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
                <div>
                  <div style={{ fontWeight: 900, fontSize: 15 }}>النقدية المتوقعة في الدرج</div>
                  <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 4 }}>
                    نقدي {money(r.cashSales)}
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

            <Section title="المبيعات">
              <table>
                <tbody>
                  <Line label={`نقدي (${r.cashOrders} فاتورة)`} value={money(r.cashSales)} />
                  <Line label={`بطاقة (${r.cardOrders} فاتورة)`} value={money(r.cardSales)} />
                  {r.byOrderType.map(t => (
                    <Line key={t.type} label={`${t.label} (${t.orders})`} value={money(t.total)} muted />
                  ))}
                  {r.byCashier.length > 1 && r.byCashier.map(c => (
                    <Line key={c.name} label={`الكاشير ${c.name} (${c.orders})`} value={money(c.total)} muted />
                  ))}
                  {r.discount > 0 && <Line label="الخصومات" value={money(r.discount)} muted />}
                  {r.voidedCount > 0 && <Line label={`فواتير ملغاة (${r.voidedCount})`} value={money(r.voidedValue)} muted />}
                </tbody>
              </table>
            </Section>

            <Section title={`كل المصروفات (${money(r.outgoingsTotal)} ${currency})`}>
              <div style={{ maxHeight: 240, overflowY: 'auto' }}>
                <table>
                  <thead><tr><th>الوقت</th><th>النوع</th><th>البيان</th><th>بواسطة</th><th style={{ textAlign: 'left' }}>المبلغ</th></tr></thead>
                  <tbody>
                    {r.expenses.map((e, i) => (
                      <tr key={`e${i}`}>
                        <td>{e.time}</td><td>{e.category}</td><td>{e.description}</td><td>{e.recordedBy}</td>
                        <td style={{ textAlign: 'left', fontWeight: 700 }}>{money(e.amount)}</td>
                      </tr>
                    ))}
                    {r.supplierPayments.map((s, i) => (
                      <tr key={`s${i}`}>
                        <td>{s.time}</td><td>دفعة مورد{s.method === 'cash' ? '' : ' (غير نقدي)'}</td>
                        <td>{s.supplierName}</td><td>—</td>
                        <td style={{ textAlign: 'left', fontWeight: 700 }}>{money(s.amount)}</td>
                      </tr>
                    ))}
                    {r.salaries.map((s, i) => (
                      <tr key={`w${i}`}>
                        <td>{s.time}</td><td>مرتب</td><td>{s.workerName}</td><td>—</td>
                        <td style={{ textAlign: 'left', fontWeight: 700 }}>{money(s.amount)}</td>
                      </tr>
                    ))}
                    {r.expenses.length + r.supplierPayments.length + r.salaries.length === 0 && (
                      <tr><td colSpan={5} style={{ textAlign: 'center', padding: 18, color: 'var(--text-muted)' }}>لا توجد مصروفات</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </Section>

            <Section title={`فواتير البيع (${r.invoices.length})`}>
              <div style={{ maxHeight: 300, overflowY: 'auto' }}>
                <table>
                  <thead>
                    <tr>
                      <th>الوقت</th><th>رقم الفاتورة</th><th>النوع</th><th>الدفع</th><th>الكاشير</th>
                      <th style={{ textAlign: 'left' }}>الإجمالي</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.invoices.map(i => (
                      <tr key={i.orderId} style={i.status === 'voided' ? { opacity: 0.5, textDecoration: 'line-through' } : undefined}>
                        <td>{i.time}</td>
                        <td style={{ fontWeight: 800, color: 'var(--accent)' }}>{i.invoiceNumber || `#${i.orderId}`}</td>
                        <td>{i.orderTypeLabel}</td>
                        <td>{i.paymentType === 'cash' ? 'نقدي' : 'بطاقة'}</td>
                        <td>{i.cashierName}</td>
                        <td style={{ textAlign: 'left', fontWeight: 800 }}>{money(i.total)}</td>
                      </tr>
                    ))}
                    {r.invoices.length === 0 && (
                      <tr><td colSpan={6} style={{ textAlign: 'center', padding: 18, color: 'var(--text-muted)' }}>لا توجد فواتير</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </Section>
          </>
        )}
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
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontWeight: 800, fontSize: 14, marginBottom: 8, paddingBottom: 5, borderBottom: '2px solid var(--accent)' }}>
        {title}
      </div>
      {children}
    </div>
  )
}

function Line({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <tr>
      <td style={{ fontWeight: 600, fontSize: muted ? 13 : 14, color: muted ? 'var(--text-muted)' : 'var(--text-primary)' }}>{label}</td>
      <td style={{ textAlign: 'left', fontWeight: 700, color: muted ? 'var(--text-muted)' : 'var(--text-primary)' }}>{value}</td>
    </tr>
  )
}
