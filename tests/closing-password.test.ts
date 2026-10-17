import { describe, it, expect, beforeAll } from 'vitest'
import { initDatabase } from '../src/main/db/db'
import { registerAuthIpc } from '../src/main/ipc/auth.ipc'
import { registerShiftIpc } from '../src/main/ipc/shift.ipc'
import { invokeLocal } from '../src/main/net/router'
import { login } from '../src/main/services/authService'
import { getWorkShiftStatus, startWorkShiftManually, tickWorkShift } from '../src/main/services/workShiftService'

/**
 * «تقفيل الوردية» asks for a fixed password, checked in the main process: without it
 * the shift keeps running, whatever the screen sends.
 */
const CASHIER_PASSWORD = 'cashier123'

describe('the closing password', () => {
  beforeAll(() => {
    initDatabase()
    registerAuthIpc()
    registerShiftIpc()
    tickWorkShift()
    const me = login('cashier1', CASHIER_PASSWORD)
    if (!getWorkShiftStatus().open) startWorkShiftManually(me.user.userId)
  })

  it('no password, or the wrong one, closes nothing', async () => {
    for (const pin of [undefined, '', '442299', '44229911']) {
      const res = await invokeLocal('workShift:closeAndPrint', { pin })
      expect(res.success, String(pin)).toBe(false)
      expect(res.error).toContain('كلمة سر التقفيل')
    }
    expect(getWorkShiftStatus().open).not.toBeNull()
  })

  it('the right one closes the shift — and still says why it could not print', async () => {
    const res = await invokeLocal('workShift:closeAndPrint', { pin: '44229910' })
    expect(res.success).toBe(true)
    expect(res.data.closed).toBe(true)
    expect(res.data.printed).toBe(false) // no printer set up in a test database
    expect(getWorkShiftStatus().open).toBeNull()
  })
})
