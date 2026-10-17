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
    for (const c of ['الكشري', 'إضافات الكشري', 'ميكسات الكشري', 'الطواجن المكرونة', 'إضافات الطواجن']) {
      expect(printerOf(c), c).toBe('كشري وطواجن')
    }
    for (const c of [
      'وجبات الفراخ - شواية', 'وجبات الفراخ - على الفحم', 'الكفتة', 'إضافات الفراخ',
      'سندوتشات الشاورما', 'إضافات الشاورما', 'قسم الغربي', 'إضافات الغربي',
    ]) {
      expect(printerOf(c), c).toBe('شاورما ومشويات')
    }
  })

  it('prints no prep ticket for drinks and desserts', () => {
    expect(printerOf('المشروبات والحلويات')).toBe('none')
  })

  it('is the shop menu as printed: 14 sections, 92 dishes', () => {
    const n = (sql: string) => (getDb().prepare(sql).get() as { n: number }).n
    expect(n('SELECT COUNT(*) AS n FROM categories')).toBe(14)
    expect(n('SELECT COUNT(*) AS n FROM menu_items')).toBe(92)
    const price = (cat: string, name: string) => (getDb().prepare(`
      SELECT mi.price FROM menu_items mi JOIN categories c ON c.category_id = mi.category_id
      WHERE c.name = ? AND mi.name = ?`).get(cat, name) as { price: number }).price
    expect(price('وجبات الفراخ - شواية', 'فرخة شواية')).toBe(400)
    expect(price('الكفتة', '1/8 كيلو كفتة')).toBe(100)
    expect(price('الكشري', 'كشري أبو الدهب')).toBe(60)
    expect(price('إضافات الفراخ', 'باكت بطاطس')).toBe(25)
    expect(price('إضافات الكشري', 'باكت بطاطس')).toBe(35)   // same add-on, its own price
    expect(price('إضافات الكشري', 'دقة + شطة')).toBe(0)     // مجاناً
    expect(price('المشروبات والحلويات', 'مياه كبيرة')).toBe(20)
  })

  it('says what each meal comes with', () => {
    const desc = (name: string) => (getDb().prepare(
      'SELECT description FROM menu_items WHERE name = ?').get(name) as { description: string }).description
    expect(desc('ربع فرخة صدر على الفحم')).toBe('مع: أرز بسمتي + بطاطس + تومية + مخلل + عيش')
    expect(desc('1/2 كيلو كفتة')).toBe('مع: أرز بسمتي + بطاطس + طحينة + عيش + مخلل')
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
    expect(printerOf('سندوتشات الشاورما')).toBeNull()
  })

  it('an emptied printer list stays empty', () => {
    getDb().prepare('UPDATE categories SET printer_id = NULL').run()
    getDb().prepare('DELETE FROM printers').run()
    restart()
    expect(printers()).toEqual([])
  })
})
