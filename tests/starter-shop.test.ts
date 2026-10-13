import { describe, it, expect, beforeAll } from 'vitest'
import { initDatabase, closeDatabase, getDb } from '../src/main/db/db'
import { getSettings } from '../src/main/services/settingsService'
import { deletePrinter } from '../src/main/services/printerService'

/**
 * What a brand-new أبو الدهب till opens with.
 *
 * One printer at the cashier for the customer's invoice and two kitchens — no counter —
 * with every starter category already sent to the kitchen that cooks it.
 */

const printers = () => getDb()
  .prepare('SELECT printer_id, name, role, is_active, open_drawer FROM printers ORDER BY display_order')
  .all() as { printer_id: number; name: string; role: string; is_active: number; open_drawer: number }[]

const printerOf = (category: string) => {
  const row = getDb().prepare(`
    SELECT c.printer_id, p.name FROM categories c LEFT JOIN printers p ON p.printer_id = c.printer_id
    WHERE c.name = ?
  `).get(category) as { printer_id: number | null; name: string | null }
  return row.printer_id === 0 ? 'none' : row.name
}

const restart = () => { closeDatabase(); initDatabase() }

beforeAll(() => { initDatabase() })

describe('the shop', () => {
  it('is أبو الدهب, with its phone and address on every receipt', () => {
    const s = getSettings()
    expect(s.business_name).toBe('أبو الدهب')
    expect(s.business_phone).toBe('01063033386')
    expect(s.business_address).toContain('زاوية العوامة')
    expect(s.business_address).toContain('ماركت أبو ربيع')
  })
})

describe('the printers', () => {
  it('are the cashier and the two kitchens — no counter', () => {
    expect(printers().map(p => [p.name, p.role])).toEqual([
      ['الكاشير', 'receipt'],
      ['كشري وطواجن', 'kitchen'],
      ['شاورما ومشويات', 'kitchen'],
    ])
  })

  it('arrive switched off until a Windows printer is chosen for each', () => {
    expect(printers().every(p => p.is_active === 0)).toBe(true)
  })

  it('open the cash drawer from the cashier only', () => {
    expect(printers().filter(p => p.open_drawer).map(p => p.name)).toEqual(['الكاشير'])
  })
})

describe('the starter menu', () => {
  it('sends each category to the kitchen that cooks it', () => {
    expect(printerOf('كشري')).toBe('كشري وطواجن')
    expect(printerOf('طواجن')).toBe('كشري وطواجن')
    expect(printerOf('إضافات الكشري')).toBe('كشري وطواجن')
    expect(printerOf('حلويات')).toBe('كشري وطواجن')
    expect(printerOf('شاورما')).toBe('شاورما ومشويات')
    expect(printerOf('مشويات')).toBe('شاورما ومشويات')
    expect(printerOf('سلطات ومقبلات')).toBe('شاورما ومشويات')
  })

  it('prints no prep ticket for drinks', () => {
    expect(printerOf('مشروبات')).toBe('none')
  })

  it('has something to sell in every category', () => {
    const empty = getDb().prepare(`
      SELECT c.name FROM categories c
      WHERE NOT EXISTS (SELECT 1 FROM menu_items m WHERE m.category_id = c.category_id AND m.price > 0)
    `).all()
    expect(empty).toEqual([])
  })

  it('brings no fried-chicken stock or Cairo delivery areas with it', () => {
    const count = (t: string) => (getDb().prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c
    expect(count('raw_materials')).toBe(0)
    expect(count('delivery_areas')).toBe(0)
  })
})

describe('once only', () => {
  it('a deleted starter printer does not come back on the next launch', () => {
    const grill = printers().find(p => p.name === 'شاورما ومشويات')!
    deletePrinter(grill.printer_id)
    restart()
    expect(printers().map(p => p.name)).toEqual(['الكاشير', 'كشري وطواجن'])
    // …and its categories went back to automatic rather than pointing at nothing.
    expect(printerOf('شاورما')).toBeNull()
  })

  it('an emptied printer list stays empty', () => {
    getDb().prepare('UPDATE categories SET printer_id = NULL').run()
    getDb().prepare('DELETE FROM printers').run()
    restart()
    expect(printers()).toEqual([])
  })
})
