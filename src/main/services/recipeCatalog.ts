/**
 * What every dish on the menu is MADE OF — the components column of «ملخص الريسبى»,
 * turned into stock the restaurant can count.
 *
 * The menu catalogue beside this file carries prices and a costed figure per dish.
 * This one carries quantities: two pieces of chicken, two breads, a hundred grams of
 * potato. That is what makes a sale draw the store down, and what makes the sales
 * report able to say "you used 420 breads this week" instead of only "you sold 210
 * meals".
 *
 * ── On costs, deliberately ──
 *
 * Every material here arrives at a cost of ZERO, and that is not an oversight.
 *
 * The workbook costs DISHES, not ingredients: it says a 4-piece meal comes to 111.50,
 * never what a bread is worth. Those totals cannot be decomposed back into per-unit
 * prices — the arithmetic is not consistent enough to try (the same bread implies 9.00
 * in one meal and 3.50 in another), and inventing the difference would put made-up
 * numbers underneath every margin in the app.
 *
 * So the quantities are transcribed faithfully and the prices are left to the owner,
 * who is the only person who knows what he pays his suppliers. Until he fills them in,
 * `createOrder` keeps costing each dish from the workbook's own costed figure — see
 * the note there about a recipe that prices to zero. Nothing regresses; the stock side
 * starts working immediately and the money side starts improving the day the first
 * supplier price is entered.
 *
 * ── Units ──
 *
 * Grams and millilitres in the sheet become KILOS and LITRES here, because that is how
 * these things are bought and counted. 100جم بطاطس is 0.1 كجم.
 *
 * ── Things the sheet leaves loose ──
 *
 * «مخلل/كاتشب» and «خيار او فلفل هالبينو» are one-or-the-other on the sheet. They are
 * recorded as a single portion of the first, because stock has to pick one and the
 * first is what the kitchen reaches for; the owner can split them afterwards.
 */

export interface CatalogMaterial {
  name: string
  unit: string
  /** Opening stock. 0 — nobody has counted the store yet. */
  stock?: number
  /** Warn below this. A sensible order-again point for the unit. */
  lowStock: number
}

/** [material name, quantity per ONE of the dish] */
export type RecipeLine = [string, number]

/**
 * Every material the recipes below refer to. Names match the menu descriptions so a
 * shop that has already typed some of these in keeps what it has — the importer
 * matches on name and never duplicates.
 */
export const CATALOG_MATERIALS: CatalogMaterial[] = [
  // ---- Proteins ----
  { name: 'قطعة بروستيد', unit: 'قطعة', lowStock: 40 },
  { name: 'قطعة استربس', unit: 'قطعة', lowStock: 50 },
  { name: 'قطعة برجر دجاج', unit: 'قطعة', lowStock: 30 },
  { name: 'قطعة برجر لحمة', unit: 'قطعة', lowStock: 30 },
  { name: 'جمبرى', unit: 'كجم', lowStock: 2 },
  { name: 'سجق هوت دوج', unit: 'قطعة', lowStock: 30 },
  { name: 'سلامى', unit: 'شريحة', lowStock: 60 },
  { name: 'رومى مدخن', unit: 'شريحة', lowStock: 40 },

  // ---- Bread ----
  { name: 'خبز', unit: 'رغيف', lowStock: 60 },
  { name: 'لقمة تورتيلا', unit: 'رغيف', lowStock: 30 },
  { name: 'لقمة 27 لونج', unit: 'رغيف', lowStock: 30 },
  { name: 'لقمة كيزر', unit: 'رغيف', lowStock: 30 },

  // ---- Sides ----
  { name: 'بطاطس', unit: 'كجم', lowStock: 10 },
  { name: 'أرز', unit: 'كجم', lowStock: 8 },
  { name: 'كلوسلو', unit: 'علبة', lowStock: 20 },
  { name: 'نومية', unit: 'علبة', lowStock: 20 },
  { name: 'مخلل/كاتشب', unit: 'علبة', lowStock: 30 },
  { name: 'حلقات بصل', unit: 'قطعة', lowStock: 30 },
  { name: 'اصابع موزاريلا', unit: 'قطعة', lowStock: 30 },
  { name: 'استيك موزاريلا', unit: 'قطعة', lowStock: 20 },

  // ---- Salad ----
  { name: 'خس', unit: 'كجم', lowStock: 3 },
  { name: 'خيار', unit: 'كجم', lowStock: 3 },
  { name: 'فلفل هالبينو', unit: 'كجم', lowStock: 1 },

  // ---- Sauces ----
  { name: 'مايونيز + كاتشب', unit: 'كجم', lowStock: 3 },
  { name: 'صوص شيدر', unit: 'كجم', lowStock: 3 },
  { name: 'صوص رانش', unit: 'كجم', lowStock: 2 },
  { name: 'تيستى صوص', unit: 'كجم', lowStock: 2 },
  { name: 'صوص تشيلى', unit: 'كجم', lowStock: 2 },
  { name: 'صوص باربكيو', unit: 'كجم', lowStock: 2 },
  { name: 'صوص جبنة', unit: 'كجم', lowStock: 2 },
  { name: 'ثومية', unit: 'كجم', lowStock: 2 },

  // ---- Packaging. Consumed on every single order, so it belongs in stock. ----
  { name: 'تغليف', unit: 'علبة', lowStock: 100 },
]

/** Shorthand so the tables below read like the sheet does. */
const PACK: RecipeLine = ['تغليف', 1]
const PICKLE: RecipeLine = ['مخلل/كاتشب', 1]
const SLAW: RecipeLine = ['كلوسلو', 1]
const NOMIA: RecipeLine = ['نومية', 1]
const MAYO_KETCHUP: RecipeLine = ['مايونيز + كاتشب', 0.04]   // 40جم

/**
 * Keyed by the EXACT menu item name in menuCatalog.ts, so the importer can match them
 * up without guessing. A dish missing from here simply gets no recipe.
 */
export const CATALOG_RECIPES: Record<string, RecipeLine[]> = {
  // ═══ وجبات البروستيد ═══
  'وجبة 2 قطعة بروستيد': [
    ['قطعة بروستيد', 2], ['خبز', 2], ['بطاطس', 0.1], SLAW, PICKLE, PACK,
  ],
  'وجبة 2 قطعة بروستيد مع أرز': [
    ['قطعة بروستيد', 2], ['خبز', 2], ['بطاطس', 0.1], SLAW, PICKLE, ['أرز', 0.15], PACK,
  ],
  'وجبة 3 قطعة بروستيد': [
    ['قطعة بروستيد', 3], ['خبز', 2], ['بطاطس', 0.1], SLAW, PICKLE, PACK,
  ],
  'وجبة 3 قطعة بروستيد مع أرز': [
    ['قطعة بروستيد', 3], ['خبز', 2], ['بطاطس', 0.1], SLAW, PICKLE, ['أرز', 0.15], PACK,
  ],
  'وجبة 4 قطعة بروستيد': [
    ['قطعة بروستيد', 4], ['خبز', 3], ['بطاطس', 0.1], SLAW, PICKLE, PACK,
  ],
  'وجبة 4 قطعة بروستيد مع أرز': [
    ['قطعة بروستيد', 4], ['خبز', 3], ['بطاطس', 0.1], SLAW, PICKLE, ['أرز', 0.15], PACK,
  ],
  'وجبة 6 قطعة بروستيد': [
    ['قطعة بروستيد', 6], ['خبز', 4], ['بطاطس', 0.15], SLAW, PICKLE, PACK,
  ],
  'وجبة 6 قطعة بروستيد مع أرز': [
    ['قطعة بروستيد', 6], ['خبز', 4], ['بطاطس', 0.15], SLAW, PICKLE, ['أرز', 0.2], PACK,
  ],
  'وجبة 8 قطعة بروستيد': [
    ['قطعة بروستيد', 8], ['خبز', 6], ['بطاطس', 0.15], SLAW, PICKLE, PACK,
  ],
  'وجبة 8 قطعة بروستيد مع أرز': [
    ['قطعة بروستيد', 8], ['خبز', 6], ['بطاطس', 0.15], SLAW, PICKLE, ['أرز', 0.25], PACK,
  ],
  'وجبة 12 قطعة بروستيد': [
    ['قطعة بروستيد', 12], ['خبز', 8], ['بطاطس', 0.15], SLAW, PICKLE, PACK,
  ],
  'وجبة 12 قطعة بروستيد مع أرز': [
    ['قطعة بروستيد', 12], ['خبز', 8], ['بطاطس', 0.15], SLAW, PICKLE, ['أرز', 0.3], PACK,
  ],
  'وجبة ميكس': [
    ['قطعة بروستيد', 2], ['قطعة استربس', 2], ['خبز', 3], ['بطاطس', 0.1], SLAW, PICKLE, PACK,
  ],
  'وجبة ميكس مع أرز': [
    ['قطعة بروستيد', 2], ['قطعة استربس', 2], ['خبز', 3], ['بطاطس', 0.1], SLAW, PICKLE,
    ['أرز', 0.15], PACK,
  ],

  // ═══ وجبات الاستربس ═══
  'وجبة 2 قطعة استربس': [
    ['قطعة استربس', 2], ['خبز', 2], ['بطاطس', 0.08], NOMIA, PICKLE, PACK,
  ],
  'وجبة 2 قطعة استربس مع أرز': [
    ['قطعة استربس', 2], ['خبز', 2], ['بطاطس', 0.08], NOMIA, PICKLE, ['أرز', 0.2], PACK,
  ],
  'وجبة 3 قطعة استربس': [
    ['قطعة استربس', 3], ['خبز', 2], ['بطاطس', 0.1], NOMIA, PICKLE, PACK,
  ],
  'وجبة 3 قطعة استربس مع أرز': [
    ['قطعة استربس', 3], ['خبز', 2], ['بطاطس', 0.1], NOMIA, PICKLE, ['أرز', 0.2], PACK,
  ],
  'وجبة 5 قطعة استربس': [
    ['قطعة استربس', 5], ['خبز', 3], ['بطاطس', 0.15], NOMIA, PICKLE, PACK,
  ],
  'وجبة 5 قطعة استربس مع أرز': [
    ['قطعة استربس', 5], ['خبز', 3], ['بطاطس', 0.15], NOMIA, PICKLE, ['أرز', 0.25], PACK,
  ],
  'وجبة 8 قطعة استربس': [
    ['قطعة استربس', 8], ['خبز', 4], ['بطاطس', 0.15], NOMIA, PICKLE, PACK,
  ],
  'وجبة 8 قطعة استربس مع أرز': [
    ['قطعة استربس', 8], ['خبز', 4], ['بطاطس', 0.15], NOMIA, PICKLE, ['أرز', 0.3], PACK,
  ],

  // ═══ سندوتشات تورتيلا ═══
  'هوت دوج تورتيلا': [
    ['سجق هوت دوج', 1], ['لقمة تورتيلا', 1], ['استيك موزاريلا', 1],
    MAYO_KETCHUP, ['صوص شيدر', 0.035], PACK,
  ],
  'تشيكن راب': [
    ['قطعة استربس', 2], ['لقمة تورتيلا', 1], MAYO_KETCHUP,
    ['خيار', 0.02], ['صوص شيدر', 0.035], PACK,
  ],
  'توستر رول': [
    ['قطعة استربس', 2], ['لقمة تورتيلا', 1], MAYO_KETCHUP,
    ['خيار', 0.02], ['صوص شيدر', 0.035], PACK,
  ],
  'جمبرى رول': [
    ['جمبرى', 0.05], ['لقمة تورتيلا', 1], ['استيك موزاريلا', 1],
    ['صوص رانش', 0.02], ['خيار', 0.02], ['صوص شيدر', 0.02], PACK,
  ],
  'سوبريم رول': [
    ['قطعة استربس', 2], ['لقمة تورتيلا', 1], ['تيستى صوص', 0.025],
    ['سلامى', 3], ['خيار', 0.02], PACK,
  ],
  'رانش رول': [
    ['قطعة استربس', 2], ['لقمة تورتيلا', 1], ['صوص رانش', 0.035],
    ['خيار', 0.02], ['خس', 0.02], PACK,
  ],

  // ═══ سندوتشات 27 لونج ═══
  'هوت دوج 27 لونج': [
    ['سجق هوت دوج', 1], ['لقمة 27 لونج', 1], ['سلامى', 3], MAYO_KETCHUP, PACK,
  ],
  'تشيكن استربس': [
    ['قطعة استربس', 2], ['لقمة 27 لونج', 1], MAYO_KETCHUP,
    ['خس', 0.02], ['خيار', 0.02], PACK,
  ],
  'زنجر سوبريم': [
    ['قطعة استربس', 2], ['لقمة 27 لونج', 1], ['صوص تشيلى', 0.035],
    ['خيار', 0.02], ['خس', 0.02], ['سلامى', 3], PACK,
  ],
  'شرمب كريسبو': [
    ['جمبرى', 0.07], ['لقمة 27 لونج', 1], MAYO_KETCHUP,
    ['صوص شيدر', 0.035], ['خس', 0.02], PACK,
  ],
  'جمبرى استيك': [
    ['جمبرى', 0.07], ['لقمة 27 لونج', 1], MAYO_KETCHUP,
    ['صوص شيدر', 0.035], ['خس', 0.02], ['استيك موزاريلا', 1], PACK,
  ],
  'سوبر كرانشى': [
    ['قطعة استربس', 2], ['لقمة 27 لونج', 1], MAYO_KETCHUP,
    ['صوص رانش', 0.035], ['خيار', 0.02], ['خس', 0.02], ['رومى مدخن', 2], PACK,
  ],

  // ═══ البرجر ═══
  'تشيكن برجر': [
    ['قطعة برجر دجاج', 1], ['لقمة كيزر', 1], ['صوص شيدر', 0.035],
    MAYO_KETCHUP, ['خس', 0.02], PACK,
  ],
  'دبل تشيكن برجر': [
    ['قطعة برجر دجاج', 2], ['لقمة كيزر', 1], ['صوص شيدر', 0.035],
    MAYO_KETCHUP, ['خس', 0.02], PACK,
  ],
  'تريبل تشيكن برجر': [
    ['قطعة برجر دجاج', 3], ['لقمة كيزر', 1.5], ['صوص شيدر', 0.07],
    ['مايونيز + كاتشب', 0.08], ['خس', 0.02], PACK,
  ],
  'بيف برجر': [
    ['قطعة برجر لحمة', 1], ['لقمة كيزر', 1], ['تيستى صوص', 0.025],
    MAYO_KETCHUP, ['خس', 0.02], PACK,
  ],
  'دبل بيف برجر': [
    ['قطعة برجر لحمة', 2], ['لقمة كيزر', 1], ['تيستى صوص', 0.025],
    MAYO_KETCHUP, ['خس', 0.02], PACK,
  ],
  'تريبل بيف برجر': [
    ['قطعة برجر لحمة', 3], ['لقمة كيزر', 1.5], ['تيستى صوص', 0.05],
    ['مايونيز + كاتشب', 0.08], ['خس', 0.02], PACK,
  ],
  'AKM': [
    ['قطعة استربس', 2], ['لقمة كيزر', 1], ['صوص شيدر', 0.035],
    MAYO_KETCHUP, ['خس', 0.02], PACK,
  ],
  'بيج فاير': [
    ['قطعة استربس', 4], ['لقمة كيزر', 1], ['صوص شيدر', 0.035],
    MAYO_KETCHUP, ['خس', 0.02], PACK,
  ],
  'ميكس كريسبو': [
    ['قطعة برجر دجاج', 1], ['قطعة برجر لحمة', 1], ['لقمة كيزر', 1],
    ['صوص شيدر', 0.035], MAYO_KETCHUP, ['خس', 0.02], ['خيار', 0.02], PACK,
  ],
  'زنجر كريسبو': [
    ['قطعة استربس', 4], ['لقمة كيزر', 1], ['رومى مدخن', 2],
    ['صوص تشيلى', 0.035], MAYO_KETCHUP, ['خس', 0.02], PACK,
  ],
  'كريسبو تاور': [
    ['قطعة استربس', 4], ['لقمة كيزر', 1], ['اصابع موزاريلا', 2],
    ['صوص رانش', 0.035], MAYO_KETCHUP, ['خس', 0.02], PACK,
  ],
  'مارينا كينج': [
    ['قطعة برجر لحمة', 1], ['قطعة استربس', 2], ['لقمة كيزر', 1.5],
    ['حلقات بصل', 3], ['رومى مدخن', 2], ['صوص باربكيو', 0.035],
    ['صوص جبنة', 0.035], MAYO_KETCHUP, ['خس', 0.02], PACK,
  ],

  // ═══ الإضافات — each is the thing itself, one portion ═══
  'صوص رانش': [['صوص رانش', 0.035]],
  'صوص تشيلى': [['صوص تشيلى', 0.035]],
  'صوص تيستى': [['تيستى صوص', 0.035]],
  'صوص شيدر': [['صوص شيدر', 0.035]],
  'صوص باربكيو': [['صوص باربكيو', 0.035]],
  'كلوسلو': [SLAW],
  'ثومية': [['ثومية', 0.03]],
  'طبق أرز': [['أرز', 0.2]],
  'بطاطس': [['بطاطس', 0.15]],
  'قطعة برجر دجاج': [['قطعة برجر دجاج', 1]],
  'قطعة برجر لحمة': [['قطعة برجر لحمة', 1]],
  'قطعة استربس': [['قطعة استربس', 1]],
  'قطعة بروستيد ورك': [['قطعة بروستيد', 1]],
  'قطعة بروستيد صدر': [['قطعة بروستيد', 1]],
  'ريزو دجاج': [['أرز', 0.25], ['قطعة استربس', 2], PACK],
}

/** How many dishes this catalogue knows a recipe for. */
export function catalogRecipeCount(): number {
  return Object.keys(CATALOG_RECIPES).length
}
