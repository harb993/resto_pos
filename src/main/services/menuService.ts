import { getDb } from '../db/db'
import log from 'electron-log/main'
import { forgetCategoryOnPrinters } from './deletionService'
import type {
  Category, MenuItem, MenuItemInput, VariantGroup, VariantOption, VariantGroupInput,
} from '../../shared/types'

export function listCategories(): Category[] {
  const db = getDb()
  return db.prepare('SELECT * FROM categories ORDER BY display_order, name').all() as Category[]
}

export function upsertCategory(name: string, displayOrder: number, categoryId?: number): Category {
  const db = getDb()

  if (categoryId) {
    db.prepare('UPDATE categories SET name = ?, display_order = ? WHERE category_id = ?')
      .run(name, displayOrder, categoryId)
    log.info(`[Menu] Category updated: ${name} (id: ${categoryId})`)
    return db.prepare('SELECT * FROM categories WHERE category_id = ?').get(categoryId) as Category
  } else {
    const result = db.prepare('INSERT INTO categories (name, display_order) VALUES (?, ?)')
      .run(name, displayOrder)
    const newId = result.lastInsertRowid as number
    log.info(`[Menu] Category created: ${name} (id: ${newId})`)
    return db.prepare('SELECT * FROM categories WHERE category_id = ?').get(newId) as Category
  }
}

export function deleteCategory(categoryId: number): void {
  const db = getDb()
  // Check if any menu items reference this category
  const items = db.prepare('SELECT COUNT(*) as count FROM menu_items WHERE category_id = ?').get(categoryId) as { count: number }
  if (items.count > 0) {
    throw new Error('لا يمكن حذف القسم — ما زال به أصناف. انقلها أو احذفها أولاً.')
  }

  // The questions set ON the category point back at it, so they have to go first —
  // otherwise an empty category still refuses to delete with "FOREIGN KEY constraint
  // failed", which says nothing about what is actually in the way.
  const remove = db.transaction(() => {
    db.prepare(
      'DELETE FROM item_variant_options WHERE variant_group_id IN ' +
      '(SELECT variant_group_id FROM item_variant_groups WHERE category_id = ?)'
    ).run(categoryId)
    db.prepare('DELETE FROM item_variant_groups WHERE category_id = ?').run(categoryId)
    forgetCategoryOnPrinters(categoryId)
    db.prepare('DELETE FROM categories WHERE category_id = ?').run(categoryId)
  })
  remove()
  log.info(`[Menu] Category deleted: ${categoryId}`)
}

/**
 * Arranging the POS grid.
 *
 * Alphabetical is the wrong order for a till. The cashier reaches for the same few
 * things all day and should find them under their thumb, not hunt for them between
 * «أصابع موزاريلا» and «بطاطس». So the owner drags the tiles into the order the shop
 * works in, on the POS itself, and these save what the grid ends up looking like.
 *
 * The whole list is written each time rather than a nudge applied to one row. A drag
 * moves everything after the tile that was dropped, and every row starts life at
 * display_order 0 — so "what position is this now" is a question only the finished
 * arrangement can answer. Writing 1, 2, 3… down the list it was given makes the
 * database say exactly what the screen says, with no arithmetic in between.
 *
 * Ids that are not in the category are ignored rather than rejected, and any item the
 * caller left out keeps its place at the end. A stale screen can therefore save a
 * slightly out-of-date list without scattering items it never knew about.
 */
export function reorderMenuItems(categoryId: number, itemIds: number[]): MenuItem[] {
  const db = getDb()

  const run = db.transaction(() => {
    const mine = new Set(
      (db.prepare('SELECT item_id FROM menu_items WHERE category_id = ?')
        .all(categoryId) as { item_id: number }[]).map(r => r.item_id)
    )
    if (mine.size === 0) throw new Error('القسم غير موجود أو لا يحتوي أصنافاً')

    const set = db.prepare(
      `UPDATE menu_items SET display_order = ?, updated_at = datetime('now','localtime')
       WHERE item_id = ? AND category_id = ?`
    )

    let position = 0
    const placed = new Set<number>()
    for (const id of itemIds) {
      if (!mine.has(id) || placed.has(id)) continue
      set.run(++position, id, categoryId)
      placed.add(id)
    }

    // Anything the screen did not mention goes after what it did, keeping the order it
    // already had. An item added on the other till mid-drag is not lost.
    const rest = db.prepare(
      'SELECT item_id FROM menu_items WHERE category_id = ? ORDER BY display_order, name'
    ).all(categoryId) as { item_id: number }[]
    for (const r of rest) {
      if (!placed.has(r.item_id)) set.run(++position, r.item_id, categoryId)
    }
  })

  run()
  log.info(`[Menu] Category #${categoryId} rearranged — ${itemIds.length} item(s)`)
  return listMenuItems(true)
}

/** The same, for the category strip along the top of the POS. */
export function reorderCategories(categoryIds: number[]): Category[] {
  const db = getDb()

  const run = db.transaction(() => {
    const known = new Set(
      (db.prepare('SELECT category_id FROM categories').all() as { category_id: number }[])
        .map(r => r.category_id)
    )
    const set = db.prepare('UPDATE categories SET display_order = ? WHERE category_id = ?')

    let position = 0
    const placed = new Set<number>()
    for (const id of categoryIds) {
      if (!known.has(id) || placed.has(id)) continue
      set.run(++position, id)
      placed.add(id)
    }
    const rest = db.prepare(
      'SELECT category_id FROM categories ORDER BY display_order, name'
    ).all() as { category_id: number }[]
    for (const r of rest) {
      if (!placed.has(r.category_id)) set.run(++position, r.category_id)
    }
  })

  run()
  log.info(`[Menu] Category strip rearranged — ${categoryIds.length} section(s)`)
  return listCategories()
}

export function listMenuItems(includeInactive = false): MenuItem[] {
  const db = getDb()
  // recipe_count = 0 means the item has no ingredients defined yet, so nothing is
  // drawn down when it sells. available_portions is how many can still be made from
  // the ingredients on hand (the limiting ingredient wins) — NULL when there is no
  // recipe. Both are advisory: a shortage warns, it never blocks a sale.
  const sql = `
    SELECT mi.*, c.name as category_name,
      (SELECT COUNT(*) FROM recipe_items ri WHERE ri.menu_item_id = mi.item_id) as recipe_count,
      (SELECT MIN(CAST(rm.stock_quantity / ri.quantity AS INTEGER))
         FROM recipe_items ri
         JOIN raw_materials rm ON rm.raw_material_id = ri.raw_material_id
        WHERE ri.menu_item_id = mi.item_id) as available_portions
    FROM menu_items mi
    JOIN categories c ON c.category_id = mi.category_id
    ${includeInactive ? '' : 'WHERE mi.is_active = 1'}
    -- The owner's arrangement first, the name only to break a tie. Everything sits at
    -- 0 until the grid is arranged, so an untouched menu stays alphabetical — and an
    -- arranged one never shuffles on its own.
    ORDER BY c.display_order, c.name, mi.display_order, mi.name
  `
  const items = db.prepare(sql).all() as MenuItem[]

  // Attached here rather than fetched per card: the POS needs to know, for every tile
  // on the grid, whether tapping it rings the item up or opens a chooser.
  const variants = getVariantsByItem()
  for (const item of items) item.variants = variants[item.item_id] ?? []

  return items
}

export function getMenuItem(itemId: number): MenuItem | undefined {
  const db = getDb()
  return db.prepare(`
    SELECT mi.*, c.name as category_name
    FROM menu_items mi
    JOIN categories c ON c.category_id = mi.category_id
    WHERE mi.item_id = ?
  `).get(itemId) as MenuItem | undefined
}

export function upsertMenuItem(input: MenuItemInput): MenuItem {
  const db = getDb()

  /*
    «تكلفة خامات وتغليف» is only written when the caller actually sent one.

    COALESCE(?, baseline_cost) rather than a plain assignment: the costing tab measures
    from this figure, and a screen that edits a dish without offering the field — or an
    older node still sending the old shape — would otherwise silently zero it and take
    that dish out of the comparison for good.
  */
  const baseline = input.baseline_cost === undefined || input.baseline_cost === null
    ? null
    : Math.max(0, Number(input.baseline_cost) || 0)

  if (input.item_id) {
    db.prepare(`
      UPDATE menu_items
      SET category_id = ?, name = ?, price = ?, cost_price = ?,
          baseline_cost = COALESCE(?, baseline_cost),
          description = ?, image_path = ?, is_active = ?,
          stock_quantity = ?, updated_at = datetime('now','localtime')
      WHERE item_id = ?
    `).run(
      input.category_id, input.name, input.price, input.cost_price,
      baseline,
      input.description || null, input.image_path || null,
      input.is_active ?? 1, input.stock_quantity ?? 0,
      input.item_id
    )
    log.info(`[Menu] Item updated: ${input.name} (id: ${input.item_id})`)
    return getMenuItem(input.item_id)!
  } else {
    /*
      A new dish goes to the END of its category, not the front.

      The column defaults to 0, and once a category has been arranged its items hold
      1, 2, 3… — so a new item left at 0 would sort ahead of every one of them and land
      at the front of a grid somebody had deliberately ordered. Adding a soft drink
      should not push the meal the shop sells most off the first row.
    */
    const last = db.prepare(
      'SELECT COALESCE(MAX(display_order), 0) AS n FROM menu_items WHERE category_id = ?'
    ).get(input.category_id) as { n: number }

    // A dish added by hand with no materials figure of its own is costed at whatever
    // cost was entered for it — the same thing the sheet import does. Left at 0 it
    // would simply never appear in the costing comparison, which is not what leaving
    // a field blank means.
    const result = db.prepare(`
      INSERT INTO menu_items (category_id, name, price, cost_price, baseline_cost, description, image_path, is_active, stock_quantity, display_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ${last.n + 1})
    `).run(
      input.category_id, input.name, input.price, input.cost_price,
      baseline ?? Math.max(0, Number(input.cost_price) || 0),
      input.description || null, input.image_path || null,
      input.is_active ?? 1, input.stock_quantity ?? 0
    )
    const newId = result.lastInsertRowid as number
    log.info(`[Menu] Item created: ${input.name} (id: ${newId})`)
    return getMenuItem(newId)!
  }
}

export function setMenuItemActive(itemId: number, isActive: boolean): void {
  const db = getDb()
  db.prepare(`UPDATE menu_items SET is_active = ?, updated_at = datetime('now','localtime') WHERE item_id = ?`)
    .run(isActive ? 1 : 0, itemId)
  log.info(`[Menu] Item ${itemId} ${isActive ? 'activated' : '86\'d'}`)
}

export function deleteMenuItem(itemId: number): void {
  const db = getDb()
  // Soft delete — just deactivate
  setMenuItemActive(itemId, false)
}

// ===== Variants =====

/**
 * The questions one item asks, with their answers, in the order they should be shown.
 * An item with none of these is rung up in a single tap.
 */
/** Attach each group's answers, dropping any group that has none to give. */
function withOptions(groups: Omit<VariantGroup, 'options'>[]): VariantGroup[] {
  if (groups.length === 0) return []
  const optionsFor = getDb().prepare(`
    SELECT variant_option_id, variant_group_id, option_name, price_delta, display_order
    FROM item_variant_options
    WHERE variant_group_id = ?
    ORDER BY display_order, variant_option_id
  `)
  return groups
    .map(g => ({ ...g, options: optionsFor.all(g.variant_group_id) as VariantOption[] }))
    // A group with no answers would stall the cashier on an unanswerable question.
    .filter(g => g.options.length > 0)
}

/** The groups defined ON one item — not counting anything inherited from its category. */
export function getItemVariants(menuItemId: number): VariantGroup[] {
  return withOptions(getDb().prepare(`
    SELECT variant_group_id, menu_item_id, category_id, group_name, display_order
    FROM item_variant_groups
    WHERE menu_item_id = ?
    ORDER BY display_order, variant_group_id
  `).all(menuItemId) as Omit<VariantGroup, 'options'>[])
}

/**
 * The groups defined on a CATEGORY — inherited by every item in it, including items
 * added later. This is where "chicken asks spicy" is said, once.
 */
export function getCategoryVariants(categoryId: number): VariantGroup[] {
  return withOptions(getDb().prepare(`
    SELECT variant_group_id, menu_item_id, category_id, group_name, display_order
    FROM item_variant_groups
    WHERE category_id = ?
    ORDER BY display_order, variant_group_id
  `).all(categoryId) as Omit<VariantGroup, 'options'>[])
}

/** Replace a category's questions. Same wholesale rewrite as the item version. */
export function setCategoryVariants(categoryId: number, groups: VariantGroupInput[]): VariantGroup[] {
  const db = getDb()
  const category = db.prepare('SELECT category_id FROM categories WHERE category_id = ?').get(categoryId)
  if (!category) throw new Error('القسم غير موجود')

  validateGroups(groups)

  const replace = db.transaction(() => {
    const old = db.prepare(
      'SELECT variant_group_id FROM item_variant_groups WHERE category_id = ?'
    ).all(categoryId) as { variant_group_id: number }[]
    const delOptions = db.prepare('DELETE FROM item_variant_options WHERE variant_group_id = ?')
    for (const g of old) delOptions.run(g.variant_group_id)
    db.prepare('DELETE FROM item_variant_groups WHERE category_id = ?').run(categoryId)

    const insGroup = db.prepare(
      'INSERT INTO item_variant_groups (category_id, group_name, display_order) VALUES (?, ?, ?)'
    )
    const insOption = db.prepare(
      `INSERT INTO item_variant_options (variant_group_id, option_name, price_delta, display_order)
       VALUES (?, ?, ?, ?)`
    )
    groups.forEach((g, gi) => {
      const groupId = insGroup.run(categoryId, g.groupName.trim(), gi).lastInsertRowid as number
      g.options.forEach((o, oi) => {
        insOption.run(groupId, o.optionName.trim(), Number(o.priceDelta) || 0, oi)
      })
    })
  })

  replace()
  log.info(`[Menu] Variants set for category ${categoryId}: ${groups.length} group(s)`)
  return getCategoryVariants(categoryId)
}

/** Turn category inheritance on or off for one item. */
export function setItemInheritsCategoryVariants(menuItemId: number, inherit: boolean): void {
  getDb().prepare(
    `UPDATE menu_items SET inherit_category_variants = ?, updated_at = datetime('now','localtime')
     WHERE item_id = ?`
  ).run(inherit ? 1 : 0, menuItemId)
  log.info(`[Menu] Item ${menuItemId} ${inherit ? 'inherits' : 'ignores'} its category's variants`)
}

/**
 * The questions EVERY item actually asks, resolved in one pass so the POS grid does
 * not query per card.
 *
 * An item's questions are its category's (unless it opts out) followed by its own.
 * Category first because that is the broad choice — "spicy or not", "how many
 * layers" — and the item-level group is the refinement on top.
 */
export function getVariantsByItem(): Record<number, VariantGroup[]> {
  const db = getDb()

  const groups = db.prepare(`
    SELECT variant_group_id, menu_item_id, category_id, group_name, display_order
    FROM item_variant_groups ORDER BY display_order, variant_group_id
  `).all() as Omit<VariantGroup, 'options'>[]

  const options = db.prepare(`
    SELECT variant_option_id, variant_group_id, option_name, price_delta, display_order
    FROM item_variant_options ORDER BY display_order, variant_option_id
  `).all() as VariantOption[]

  const byGroup = new Map<number, VariantOption[]>()
  for (const o of options) {
    const list = byGroup.get(o.variant_group_id)
    if (list) list.push(o)
    else byGroup.set(o.variant_group_id, [o])
  }

  const items = db.prepare(
    'SELECT item_id, category_id, inherit_category_variants FROM menu_items'
  ).all() as { item_id: number; category_id: number; inherit_category_variants: number }[]

  const ownGroups = new Map<number, VariantGroup[]>()
  const catGroups = new Map<number, VariantGroup[]>()
  for (const g of groups) {
    const full = { ...g, options: byGroup.get(g.variant_group_id) ?? [] }
    // A group with no options left would stall the cashier on a question that has no
    // answers, so it is simply not offered.
    if (full.options.length === 0) continue
    const target = g.menu_item_id != null ? ownGroups : catGroups
    const key = g.menu_item_id ?? g.category_id!
    const list = target.get(key)
    if (list) list.push(full)
    else target.set(key, [full])
  }

  const byItem: Record<number, VariantGroup[]> = {}
  for (const item of items) {
    const inherited = item.inherit_category_variants ? (catGroups.get(item.category_id) ?? []) : []
    const own = ownGroups.get(item.item_id) ?? []
    if (inherited.length || own.length) byItem[item.item_id] = [...inherited, ...own]
  }
  return byItem
}

/**
 * Replace an item's entire variant setup.
 *
 * Rewritten wholesale rather than diffed, because the option ids are what past
 * orders were priced from — and those are already recorded on the order lines as a
 * label and a price at time of sale. Deleting an option therefore cannot rewrite
 * history; it only stops it being offered from now on.
 */
function validateGroups(groups: VariantGroupInput[]): void {
  for (const g of groups) {
    if (!g.groupName?.trim()) throw new Error('اسم مجموعة الاختيارات مطلوب')
    if (!Array.isArray(g.options) || g.options.length === 0) {
      throw new Error(`المجموعة "${g.groupName}" يجب أن تحتوي على اختيار واحد على الأقل`)
    }
    for (const o of g.options) {
      if (!o.optionName?.trim()) throw new Error(`اسم الاختيار مطلوب في "${g.groupName}"`)
      if (!Number.isFinite(Number(o.priceDelta))) {
        throw new Error(`فرق السعر غير صحيح في "${g.groupName}"`)
      }
    }
    const names = g.options.map(o => o.optionName.trim())
    if (new Set(names).size !== names.length) {
      throw new Error(`يوجد اختيار مكرر في "${g.groupName}"`)
    }
  }
}

export function setItemVariants(menuItemId: number, groups: VariantGroupInput[]): VariantGroup[] {
  const db = getDb()

  const item = db.prepare('SELECT item_id FROM menu_items WHERE item_id = ?').get(menuItemId)
  if (!item) throw new Error('الصنف غير موجود')

  validateGroups(groups)

  const replace = db.transaction(() => {
    const oldGroups = db.prepare(
      'SELECT variant_group_id FROM item_variant_groups WHERE menu_item_id = ?'
    ).all(menuItemId) as { variant_group_id: number }[]

    const delOptions = db.prepare('DELETE FROM item_variant_options WHERE variant_group_id = ?')
    for (const g of oldGroups) delOptions.run(g.variant_group_id)
    db.prepare('DELETE FROM item_variant_groups WHERE menu_item_id = ?').run(menuItemId)

    const insGroup = db.prepare(
      'INSERT INTO item_variant_groups (menu_item_id, group_name, display_order) VALUES (?, ?, ?)'
    )
    const insOption = db.prepare(
      `INSERT INTO item_variant_options (variant_group_id, option_name, price_delta, display_order)
       VALUES (?, ?, ?, ?)`
    )

    groups.forEach((g, gi) => {
      const groupId = insGroup.run(menuItemId, g.groupName.trim(), gi).lastInsertRowid as number
      g.options.forEach((o, oi) => {
        insOption.run(groupId, o.optionName.trim(), Number(o.priceDelta) || 0, oi)
      })
    })
  })

  replace()
  log.info(`[Menu] Variants set for item ${menuItemId}: ${groups.length} group(s)`)
  return getItemVariants(menuItemId)
}
