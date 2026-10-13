import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../src/main/db/db'
import {
  listCategories, listMenuItems, reorderMenuItems, reorderCategories,
  upsertCategory, upsertMenuItem,
} from '../src/main/services/menuService'

/**
 * Arranging the POS grid by dragging the tiles.
 *
 * Alphabetical is the wrong order for a till: the cashier reaches for the same few
 * things all day and should find them under their thumb, not between «أصابع موزاريلا»
 * and «بطاطس».
 *
 * The save takes the FINISHED order rather than "this moved two places", because that
 * is what a drag produces — dropping a tile shifts everything after it. It also side-
 * steps the trap underneath: every row starts at display_order 0, so a nudge-based
 * scheme has no positions to nudge within until something has been arranged once.
 */

let chicken: number
let burgers: number

const namesIn = (categoryId: number) =>
  listMenuItems(true).filter(i => i.category_id === categoryId).map(i => i.name)

const idOf = (name: string) => listMenuItems(true).find(i => i.name === name)!.item_id

const addItem = (categoryId: number, name: string) =>
  upsertMenuItem({ category_id: categoryId, name, price: 50, cost_price: 20 } as never).item_id

beforeAll(() => { initDatabase() })

beforeEach(() => {
  const db = getDb()
  db.prepare('DELETE FROM order_items').run()
  db.prepare('DELETE FROM recipe_items').run()
  db.prepare('DELETE FROM item_variant_options').run()
  db.prepare('DELETE FROM item_variant_groups').run()
  db.prepare('DELETE FROM menu_items').run()
  db.prepare('DELETE FROM categories').run()

  chicken = upsertCategory('دجاج', 0).category_id
  burgers = upsertCategory('برجر', 0).category_id
})

describe('the order a menu starts in', () => {
  it('leaves an EXISTING menu exactly as it was — alphabetical', () => {
    // What the migration produces: every row at 0, so the name breaks every tie and
    // nobody's grid rearranges itself the day they install the update.
    const db = getDb()
    for (const name of ['وجبة', 'بطاطس', 'أصابع موزاريلا']) {
      db.prepare(
        `INSERT INTO menu_items (category_id, name, price, cost_price, display_order)
         VALUES (?, ?, 50, 20, 0)`
      ).run(chicken, name)
    }
    expect(namesIn(chicken)).toEqual(['أصابع موزاريلا', 'بطاطس', 'وجبة'])
  })

  it('keeps NEW items in the order they were added', () => {
    addItem(chicken, 'وجبة')
    addItem(chicken, 'بطاطس')
    addItem(chicken, 'أصابع موزاريلا')
    expect(namesIn(chicken)).toEqual(['وجبة', 'بطاطس', 'أصابع موزاريلا'])
  })
})

describe('dropping a tile somewhere else', () => {
  beforeEach(() => {
    addItem(chicken, 'أصابع موزاريلا')
    addItem(chicken, 'بطاطس')
    addItem(chicken, 'وجبة')
  })

  it('saves exactly the order the grid was left in', () => {
    reorderMenuItems(chicken, [idOf('وجبة'), idOf('بطاطس'), idOf('أصابع موزاريلا')])
    expect(namesIn(chicken)).toEqual(['وجبة', 'بطاطس', 'أصابع موزاريلا'])
  })

  it('works from a menu where everything still sits at 0', () => {
    // The case a nudge-based scheme cannot express: no row has a position yet.
    const db = getDb()
    db.prepare('UPDATE menu_items SET display_order = 0').run()

    reorderMenuItems(chicken, [idOf('وجبة'), idOf('أصابع موزاريلا'), idOf('بطاطس')])
    expect(namesIn(chicken)).toEqual(['وجبة', 'أصابع موزاريلا', 'بطاطس'])
  })

  it('survives being saved twice', () => {
    const order = [idOf('وجبة'), idOf('بطاطس'), idOf('أصابع موزاريلا')]
    reorderMenuItems(chicken, order)
    reorderMenuItems(chicken, order)
    expect(namesIn(chicken)).toEqual(['وجبة', 'بطاطس', 'أصابع موزاريلا'])
  })

  it('cannot drag an item into another category', () => {
    const burger = addItem(burgers, 'تشيكن برجر')

    // A screen that somehow sends a foreign id must not move it.
    reorderMenuItems(chicken, [burger, idOf('وجبة')])

    expect(namesIn(burgers)).toEqual(['تشيكن برجر'])
    expect(namesIn(chicken)).toHaveLength(3)
    expect(namesIn(chicken)[0]).toBe('وجبة')
  })

  it('keeps an item the screen never knew about, at the end', () => {
    // Added on the other till while this one was mid-drag.
    addItem(chicken, 'كولا')
    const stale = [idOf('وجبة'), idOf('بطاطس'), idOf('أصابع موزاريلا')]

    reorderMenuItems(chicken, stale)

    expect(namesIn(chicken)).toEqual(['وجبة', 'بطاطس', 'أصابع موزاريلا', 'كولا'])
  })

  it('ignores a duplicated id rather than listing the item twice', () => {
    const meal = idOf('وجبة')
    reorderMenuItems(chicken, [meal, meal, idOf('بطاطس')])

    const names = namesIn(chicken)
    expect(names).toHaveLength(3)
    expect(new Set(names).size).toBe(3)
    expect(names[0]).toBe('وجبة')
  })

  it('holds when a new item is added afterwards', () => {
    reorderMenuItems(chicken, [idOf('وجبة'), idOf('بطاطس'), idOf('أصابع موزاريلا')])
    addItem(chicken, 'كولا')

    // The new one lands at the end; the arrangement is untouched.
    expect(namesIn(chicken)).toEqual(['وجبة', 'بطاطس', 'أصابع موزاريلا', 'كولا'])
  })

  it('keeps an 86’d item in place, so it returns where it was left', () => {
    reorderMenuItems(chicken, [idOf('وجبة'), idOf('بطاطس'), idOf('أصابع موزاريلا')])
    const meal = idOf('وجبة')

    getDb().prepare('UPDATE menu_items SET is_active = 0 WHERE item_id = ?').run(meal)
    getDb().prepare('UPDATE menu_items SET is_active = 1 WHERE item_id = ?').run(meal)

    expect(namesIn(chicken)[0]).toBe('وجبة')
  })

  it('refuses a category with nothing in it', () => {
    expect(() => reorderMenuItems(999999, [])).toThrow()
  })
})

describe('arranging the category strip', () => {
  it('saves the order the strip was left in', () => {
    expect(listCategories().map(c => c.name)).toEqual(['برجر', 'دجاج'])

    reorderCategories([chicken, burgers])
    expect(listCategories().map(c => c.name)).toEqual(['دجاج', 'برجر'])
  })

  it('carries the items with it', () => {
    addItem(chicken, 'وجبة')
    addItem(burgers, 'تشيكن برجر')

    reorderCategories([chicken, burgers])

    // listMenuItems orders by category first.
    expect(listMenuItems(true).map(i => i.name)).toEqual(['وجبة', 'تشيكن برجر'])
  })

  it('keeps a category the screen left out', () => {
    const drinks = upsertCategory('مشروبات', 0).category_id
    reorderCategories([chicken, burgers])

    const names = listCategories().map(c => c.name)
    expect(names).toHaveLength(3)
    expect(names.slice(0, 2)).toEqual(['دجاج', 'برجر'])
    expect(names).toContain('مشروبات')
    expect(drinks).toBeTruthy()
  })

  it('ignores an id that is not a category', () => {
    reorderCategories([999999, chicken, burgers])
    expect(listCategories().map(c => c.name)).toEqual(['دجاج', 'برجر'])
  })
})
