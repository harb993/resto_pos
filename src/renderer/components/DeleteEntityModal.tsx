import React, { useState, useEffect } from 'react'
import type { DeletableKind, DeleteImpact } from '../../shared/types'

/**
 * One confirmation dialog for deleting a category, a menu item or a raw material.
 *
 * It asks the main process what the deletion would affect BEFORE offering any button,
 * so the owner reads the consequences rather than discovering them. Where past
 * invoices are involved the safe action (deactivate) is the default, and erasing it
 * anyway is a separate red path that re-asks for the owner password.
 */
export default function DeleteEntityModal({ kind, id, onClose, onDone }: {
  kind: DeletableKind
  id: number
  onClose: () => void
  onDone: (message: string) => void
}) {
  const [impact, setImpact] = useState<DeleteImpact | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [showForce, setShowForce] = useState(false)
  const [password, setPassword] = useState('')

  useEffect(() => {
    let live = true
    window.api.getDeleteImpact(kind, id).then((res: any) => {
      if (!live) return
      if (res.success) setImpact(res.data)
      else setError(res.error || 'تعذر فحص العناصر المرتبطة')
    })
    return () => { live = false }
  }, [kind, id])

  const run = async (force: boolean) => {
    setBusy(true)
    const res = await window.api.deleteEntity(kind, id, force, force ? password : undefined)
    setBusy(false)
    if (res.success) onDone(res.data.message)
    else setError(res.error || 'تعذر التنفيذ')
  }

  const KIND_LABEL: Record<DeletableKind, string> = {
    category: 'القسم',
    menuItem: 'الصنف',
    rawMaterial: 'المادة الخام',
  }

  return (
    <div className="modal-overlay" onClick={() => !busy && onClose()}>
      <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 520 }}>
        <h2 className="modal-title" style={{ color: 'var(--danger)' }}>
          حذف {KIND_LABEL[kind]}{impact ? `: ${impact.name}` : ''}
        </h2>

        {!impact && !error && (
          <div className="empty-state" style={{ padding: 26 }}>
            <div className="empty-state-text">جاري فحص العناصر المرتبطة...</div>
          </div>
        )}

        {error && (
          <div className="badge badge-danger" style={{ padding: '10px 14px', display: 'block', marginBottom: 14 }}>
            ⚠️ {error}
          </div>
        )}

        {impact && (
          <>
            {impact.cascades.length > 0 && (
              <div style={{
                background: 'var(--warning-bg)', borderRight: '3px solid var(--warning)',
                borderRadius: 'var(--radius-sm)', padding: '10px 13px', marginBottom: 12, fontSize: 13,
              }}>
                <b>سيُحذف معه:</b>
                <ul style={{ margin: '6px 0 0', paddingRight: 18 }}>
                  {impact.cascades.map((c, i) => <li key={i}>{c}</li>)}
                </ul>
              </div>
            )}

            {impact.canHardDelete ? (
              <div style={{
                background: 'var(--success-bg)', borderRight: '3px solid var(--success)',
                borderRadius: 'var(--radius-sm)', padding: '10px 13px', marginBottom: 14, fontSize: 13,
              }}>
                ✅ لا توجد فواتير سابقة مرتبطة به — سيُحذف نهائياً ويعود كل شيء
                لما كان عليه قبل إضافته.
              </div>
            ) : (
              <div style={{
                background: 'var(--danger-bg)', border: '1px solid rgba(217,45,32,0.28)',
                borderRadius: 'var(--radius-sm)', padding: '12px 14px', marginBottom: 14, fontSize: 13,
              }}>
                <b>⚠️ مرتبط بسجلات سابقة:</b>
                <ul style={{ margin: '6px 0 8px', paddingRight: 18 }}>
                  {impact.blockers.map((b, i) => <li key={i}>{b}</li>)}
                </ul>
                {impact.supportsDeactivate
                  ? <>سيتم <b>إيقافه</b> بدلاً من حذفه: يختفي من نقطة البيع ومن كل القوائم،
                     بينما تظل الفواتير والتقارير القديمة صحيحة.</>
                  : <>احذف أو انقل الأصناف المرتبطة أولاً، أو استخدم الحذف النهائي.</>}
              </div>
            )}

            {!showForce ? (
              <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                <button className="btn btn-secondary" onClick={onClose} disabled={busy}>إلغاء</button>
                {!impact.canHardDelete && (
                  <button
                    className="btn btn-ghost"
                    style={{ color: 'var(--danger)' }}
                    onClick={() => { setShowForce(true); setError('') }}
                    disabled={busy}
                  >
                    حذف نهائي رغم ذلك
                  </button>
                )}
                <button
                  className="btn btn-danger"
                  onClick={() => run(false)}
                  disabled={busy || (!impact.canHardDelete && !impact.supportsDeactivate)}
                >
                  {busy ? 'جاري التنفيذ...'
                    : impact.canHardDelete ? 'تأكيد الحذف' : 'إيقافه (الأكثر أماناً)'}
                </button>
              </div>
            ) : (
              <>
                <div style={{
                  background: 'var(--danger-bg)', border: '1px solid rgba(217,45,32,0.35)',
                  borderRadius: 'var(--radius-sm)', padding: '12px 14px', marginBottom: 14, fontSize: 13,
                }}>
                  <b>الحذف النهائي لا يمكن التراجع عنه.</b> ستفقد الفواتير السابقة ارتباطها
                  بهذا العنصر، وقد تتغير أرقام الأرباح المعروضة عن شهور سابقة.
                </div>
                <div className="form-group">
                  <label className="form-label">كلمة مرور المدير للتأكيد *</label>
                  <input
                    className="input" type="password" autoComplete="off" autoFocus
                    value={password} onChange={e => setPassword(e.target.value)}
                    placeholder="أدخل كلمة مرور المدير"
                  />
                </div>
                <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                  <button className="btn btn-secondary" onClick={() => setShowForce(false)} disabled={busy}>
                    رجوع
                  </button>
                  <button className="btn btn-danger" onClick={() => run(true)} disabled={busy || !password}>
                    {busy ? 'جاري الحذف...' : 'حذف نهائي'}
                  </button>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}
