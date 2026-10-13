import { describe, it, expect, beforeAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase, getDb } from '../src/main/db/db'
import { updateSettings } from '../src/main/services/settingsService'
import { getShiftReport } from '../src/main/services/shiftReportService'
import { writeShiftWorkbook, shiftSummaryText, whatsappTarget } from '../src/main/services/shiftExportService'

/**
 * The report that goes to the restaurant's group at the end of every shift.
 *
 * The two things worth pinning down here are the ones a person reads on a phone and
 * acts on: the figures in the workbook have to be numbers rather than text, or the
 * accountant cannot sum them; and the summary has to carry the drawer figure, because
 * that is what the person handing over cash is being asked to match.
 */

let shiftId: number
let userId: number

beforeAll(() => {
  initDatabase()
  const db = getDb()
  userId = (db.prepare(`SELECT user_id FROM users WHERE role = 'owner'`).get() as any).user_id

  shiftId = Number(db.prepare(`
    INSERT INTO shifts (cashier_id, shift_date, shift_number, start_time, end_time,
                        started_at, ended_at, set_by)
    VALUES (?, '2026-09-07', 2, '17:00', '01:00',
            '2026-09-07 17:00:00', '2026-09-08 01:00:00', ?)
  `).run(userId, userId).lastInsertRowid)

  const catId = Number(db.prepare(`INSERT INTO categories (name, display_order) VALUES ('برجر', 1)`)
    .run().lastInsertRowid)
  const itemId = Number(db.prepare(
    `INSERT INTO menu_items (category_id, name, price, cost_price) VALUES (?, 'تشيكن برجر', 85, 40.43)`
  ).run(catId).lastInsertRowid)

  const orderId = Number(db.prepare(`
    INSERT INTO orders (cashier_id, subtotal, tax, discount, total_amount, payment_type, created_at)
    VALUES (?, 170, 0, 0, 170, 'cash', '2026-09-07 20:00:00')
  `).run(userId).lastInsertRowid)
  db.prepare(
    `INSERT INTO order_items (order_id, menu_item_id, quantity, unit_price, unit_cost)
     VALUES (?, ?, 2, 85, 40.43)`
  ).run(orderId, itemId)

  db.prepare(`
    INSERT INTO expenses (category, description, amount, recorded_by, expense_date, created_at)
    VALUES ('utilities', 'كهرباء', 50, ?, '2026-09-07', '2026-09-07 21:00:00')
  `).run(userId)
})

describe('the end-of-shift workbook', () => {
  it('writes a real spreadsheet with a sheet per thing the owner asks about', async () => {
    const report = getShiftReport(shiftId)
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'shift-export-')), 'shift.xlsx')

    await writeShiftWorkbook(report, file)
    expect(fs.existsSync(file)).toBe(true)

    const ExcelJS = require('exceljs')
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.readFile(file)

    const names = wb.worksheets.map((w: any) => w.name)
    expect(names).toEqual([
      'ملخص الوردية', 'الفواتير', 'الأصناف المباعة', 'المصروفات', 'مرتبات وموردين', 'حركة المخزون',
    ])

    // Money has to arrive as numbers. Written as text it looks identical on screen
    // and cannot be summed, which is the only reason to send a workbook at all.
    const summary = wb.getWorksheet('ملخص الوردية')
    const revenueRow = summary.getRow(8) // header + 7 rows in
    expect(revenueRow.getCell(1).value).toContain('إجمالي المبيعات')
    expect(typeof revenueRow.getCell(2).value).toBe('number')
    expect(revenueRow.getCell(2).value).toBe(170)

    const invoices = wb.getWorksheet('الفواتير')
    // one header + one invoice + one total row
    expect(invoices.rowCount).toBe(3)
  })
})

describe('the message that goes in the group', () => {
  it('leads with the takings and the drawer figure', () => {
    const text = shiftSummaryText(getShiftReport(shiftId))

    expect(text).toContain('170.00')            // takings
    expect(text).toContain('120.00')            // 170 cash less the 50 paid out
    expect(text).toContain('المتوقع في الدرج')
    expect(text).toContain('2026-09-07')
    expect(text).toContain('PDF + Excel')
  })
})

describe('where "send to the group" points', () => {
  it('pre-fills the message when the owner gave a phone number', () => {
    updateSettings({ whatsapp_group: '+20 100 123 4567' } as never)
    const target = whatsappTarget('مرحبا')
    expect(target.url).toContain('wa.me/201001234567')
    expect(target.url).toContain(encodeURIComponent('مرحبا'))
    expect(target.prefilled).toBe(true)
  })

  it('opens the group itself for an invite link, and admits it cannot carry the text', () => {
    updateSettings({ whatsapp_group: 'https://chat.whatsapp.com/AbCdEf' } as never)
    const target = whatsappTarget('مرحبا')
    expect(target.url).toBe('https://chat.whatsapp.com/AbCdEf')
    // WhatsApp will not accept a message on an invite link. Saying so is what lets
    // the screen offer "copy the summary" instead of silently dropping it.
    expect(target.prefilled).toBe(false)
  })

  it('falls back to the share sheet when no group has been set', () => {
    updateSettings({ whatsapp_group: '' } as never)
    const target = whatsappTarget('مرحبا')
    expect(target.url.startsWith('https://wa.me/?text=')).toBe(true)
    expect(target.prefilled).toBe(true)
  })
})
