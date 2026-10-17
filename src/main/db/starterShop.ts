/**
 * What a brand-new أبو الدهب till opens with: its three printers and a starter menu.
 *
 * The shop has no counter. The customer's invoice prints at the cashier, and the food
 * is split between two kitchens, each with its own printer:
 *
 *   كشري وطواجن      the koshary, its mixes, the pasta tagines, and their extras
 *   شاورما ومشويات   the chicken, the kofta, the shawarma sandwiches, the western
 *                    section, and their extras
 *
 * Every category below names the printer its prep ticket goes to — the same choice the
 * owner makes for a new category on the categories screen. Drinks and desserts are
 * handed over at the till, so they print no prep ticket at all.
 *
 * The printers arrive switched OFF and with no Windows printer chosen: which USB queue
 * is which kitchen is only knowable on the premises. The owner picks each one in
 * الإعدادات ← الطابعات and switches it on.
 *
 * The menu is the shop's own, as printed (abu_eldahab_menu.pdf, October 2026): every
 * section, every dish, every price, and what each meal comes with. Costs are left at 0
 * — the printed menu does not say what the shop pays, and a made-up cost would only
 * make the profit figures lie.
 *
 * Two lines on the printed menu are written so that only the price tells them apart,
 * which a kitchen ticket cannot show. They carry a size here, for the owner to rename
 * if they mean something else:
 *
 *   طبق أرز بسمتي  40 / 50   →  طبق أرز بسمتي صغير / كبير
 *   فتة شاورما     100 و 80  →  فتة شاورما كبيرة / صغيرة
 *
 * Where the menu lists the same add-on in several sections — سجق under the koshary,
 * the tagines and the western section — each section keeps its own, as printed: they
 * are priced separately and go to different kitchens.
 */

export interface StarterPrinter {
  /** Also the name categories below refer to it by. */
  name: string
  role: 'receipt' | 'kitchen'
  openDrawer?: boolean
}

export const STARTER_PRINTERS: StarterPrinter[] = [
  { name: 'الكاشير', role: 'receipt', openDrawer: true },
  { name: 'كشري وطواجن', role: 'kitchen' },
  { name: 'شاورما ومشويات', role: 'kitchen' },
]

/** No prep ticket — the cashier hands it over. Stored as printer_id 0. */
export const CASHIER_ONLY = 0

export interface StarterCategory {
  name: string
  /** A STARTER_PRINTERS name, or CASHIER_ONLY. */
  printer: string | typeof CASHIER_ONLY
  items: StarterItem[]
}

export interface StarterItem {
  name: string
  price: number
  /** What the meal comes with — shown on the item at the till. */
  description?: string
}

const KOSHARY = 'كشري وطواجن'
const GRILL = 'شاورما ومشويات'

/** What every chicken meal comes with, as the menu prints it. */
const WITH_CHICKEN = 'مع: أرز بسمتي + بطاطس + تومية + مخلل + عيش'
/** …and every kofta meal. */
const WITH_KOFTA = 'مع: أرز بسمتي + بطاطس + طحينة + عيش + مخلل'

export const STARTER_MENU: StarterCategory[] = [
  // ── page 1 ──
  {
    name: 'وجبات الفراخ - شواية',
    printer: GRILL,
    items: [
      { name: 'فرخة شواية', price: 400, description: WITH_CHICKEN },
      { name: 'نص فرخة شواية', price: 200, description: WITH_CHICKEN },
      { name: 'ربع فرخة صدر شواية', price: 120, description: WITH_CHICKEN },
      { name: 'ربع فرخة وراك شواية', price: 110, description: WITH_CHICKEN },
    ],
  },
  {
    name: 'وجبات الفراخ - على الفحم',
    printer: GRILL,
    items: [
      { name: 'فرخة على الفحم', price: 400, description: WITH_CHICKEN },
      { name: 'نص فرخة على الفحم', price: 200, description: WITH_CHICKEN },
      { name: 'ربع فرخة صدر على الفحم', price: 120, description: WITH_CHICKEN },
      { name: 'ربع فرخة وراك على الفحم', price: 110, description: WITH_CHICKEN },
    ],
  },
  {
    name: 'الكفتة',
    printer: GRILL,
    items: [
      { name: '1 كيلو كفتة', price: 600, description: WITH_KOFTA },
      { name: '1/2 كيلو كفتة', price: 300, description: WITH_KOFTA },
      { name: '1/4 كيلو كفتة', price: 150, description: WITH_KOFTA },
      { name: '1/8 كيلو كفتة', price: 100, description: WITH_KOFTA },
      { name: 'حواوشي على الفحم', price: 25 },
    ],
  },
  {
    name: 'إضافات الفراخ',
    printer: GRILL,
    items: [
      { name: 'طبق أرز بسمتي صغير', price: 40 },
      { name: 'طبق أرز بسمتي كبير', price: 50 },
      { name: 'باكت بطاطس', price: 25 },
      { name: 'طحينة', price: 10 },
      { name: 'تومية', price: 10 },
      { name: 'سلطة خضراء', price: 10 },
      { name: 'مخلل', price: 10 },
      { name: 'حواوشي على الفحم', price: 25 },
    ],
  },
  {
    name: 'الكشري',
    printer: KOSHARY,
    items: [
      { name: 'كشري كمالة', price: 25 },
      { name: 'كشري سوبر', price: 30 },
      { name: 'كشري اسبيشيال', price: 40 },
      { name: 'كشري على اسمو', price: 50 },
      { name: 'كشري أبو الدهب', price: 60 },
    ],
  },
  // ── page 2 ──
  {
    name: 'إضافات الكشري',
    printer: KOSHARY,
    items: [
      { name: 'شاورما فراخ', price: 40 },
      { name: 'سجق', price: 25 },
      { name: 'كبدة', price: 20 },
      { name: 'عيش توست', price: 10 },
      { name: 'تقلية أو ورد', price: 15 },
      { name: 'عدس بجبنة', price: 10 },
      { name: 'حمص شام', price: 10 },
      { name: 'صلصة', price: 10 },
      { name: 'دقة + شطة', price: 0, description: 'مجاناً' },
      { name: 'باكت بطاطس', price: 35 },
    ],
  },
  {
    name: 'ميكسات الكشري',
    printer: KOSHARY,
    items: [
      { name: 'طاجن ميكس كشري فراخ + عيش توست + مخلل', price: 75 },
      { name: 'طاجن لحمة مفرومة ميكس كشري + عيش', price: 75 },
      { name: 'طاجن ميكس البيتزا سجق بجبنة موزاريلا', price: 80 },
      { name: 'طاجن فراخ + شاورما + جبنة موزاريلا', price: 110 },
      { name: 'طاجن لحمة مفرومة ميكس سجق بالجبنة موزاريلا', price: 100 },
      { name: 'طبق ميكس شاورما + عيش توست + مخلل + كانز', price: 100 },
    ],
  },
  {
    name: 'الطواجن المكرونة',
    printer: KOSHARY,
    items: [
      { name: 'طاجن فراخ', price: 50 },
      { name: 'طاجن لحمة مفرومة', price: 50 },
      { name: 'طاجن سباجتي سجق', price: 50 },
      { name: 'طاجن سباجتي كبدة', price: 50 },
      { name: 'طاجن سباجتي شاورما فراخ', price: 70 },
    ],
  },
  {
    name: 'إضافات الطواجن',
    printer: KOSHARY,
    items: [
      { name: 'شاورما فراخ', price: 40 },
      { name: 'سجق', price: 25 },
      { name: 'كبدة', price: 20 },
      { name: 'جبنة موزاريلا', price: 25 },
      { name: 'عيش توست', price: 10 },
      { name: 'صلصة', price: 10 },
      { name: 'تقلية أو ورد', price: 15 },
      { name: 'دقة + شطة', price: 0, description: 'مجاناً' },
      { name: 'باكت بطاطس', price: 35 },
    ],
  },
  {
    name: 'سندوتشات الشاورما',
    printer: GRILL,
    items: [
      { name: 'سندوتش شاورما XL', price: 90 },
      { name: 'سندوتش شاورما X', price: 70 },
      { name: 'سندوتش كريسبي', price: 100 },
      { name: 'سندوتش زنجر', price: 100 },
      { name: 'سندوتش كفتة سوري', price: 100 },
      { name: 'سندوتش سجق سوري', price: 60 },
      { name: 'سندوتش كبدة سوري', price: 50 },
      { name: 'سندوتش بطاطس سوري', price: 40 },
    ],
  },
  {
    name: 'إضافات الشاورما',
    printer: GRILL,
    items: [
      { name: 'جبنة موزاريلا', price: 25 },
      { name: 'تومية', price: 10 },
      { name: 'مخلل', price: 10 },
      { name: 'بطاطس', price: 30 },
    ],
  },
  // ── page 3 ──
  {
    name: 'قسم الغربي',
    printer: GRILL,
    items: [
      { name: 'فتة شاورما كبيرة', price: 100 },
      { name: 'فتة شاورما صغيرة', price: 80 },
      { name: 'فتة كريسبي', price: 110 },
      { name: 'وجبة كريسبي 4 قطع', price: 160 },
      { name: 'وجبة كريسبي 3 قطع', price: 130 },
      { name: 'وجبة كريسبي 2 قطعة', price: 100 },
      { name: 'وجبة كريسبي 1 قطعة', price: 70 },
      { name: 'طبق سجق', price: 80 },
      { name: 'طبق كبدة', price: 80 },
      { name: 'وجبة عربي سنجل', price: 100 },
      { name: 'وجبة عربي دبل', price: 150 },
    ],
  },
  {
    name: 'إضافات الغربي',
    printer: GRILL,
    items: [
      { name: 'شاورما', price: 40 },
      { name: 'سجق', price: 25 },
      { name: 'كبدة', price: 20 },
      { name: 'جبنة موزاريلا', price: 25 },
      { name: 'تومية', price: 10 },
      { name: 'مخلل', price: 10 },
      { name: 'بطاطس', price: 30 },
    ],
  },
  {
    name: 'المشروبات والحلويات',
    printer: CASHIER_ONLY,
    items: [
      { name: 'أرز باللبن عادي', price: 25 },
      { name: 'أرز باللبن فرن', price: 25 },
      { name: 'كاستر', price: 25 },
      { name: 'كانز', price: 25 },
      { name: 'مياه صغيرة', price: 10 },
      { name: 'مياه كبيرة', price: 20 },
    ],
  },
]

/**
 * The made-up menu the first builds shipped with, before the shop's own existed.
 *
 * Kept only so menuUpgrade.ts can recognise those dishes in a till that already opened
 * with them, and take out the ones nobody has touched or sold. Never seeded.
 */
export const PLACEHOLDER_MENU: StarterCategory[] = [
  {
    name: 'كشري',
    printer: KOSHARY,
    items: [
      { name: 'كشري صغير', price: 35 },
      { name: 'كشري وسط', price: 45 },
      { name: 'كشري كبير', price: 60 },
      { name: 'كشري جامبو', price: 75 },
      { name: 'كشري عائلي', price: 160, description: 'يكفي 4 أفراد' },
    ],
  },
  {
    name: 'طواجن',
    printer: KOSHARY,
    items: [
      { name: 'طاجن مكرونة باللحمة', price: 110 },
      { name: 'طاجن مكرونة بالفراخ', price: 100 },
      { name: 'طاجن مكرونة بالسجق', price: 100 },
      { name: 'طاجن مكرونة بالبشاميل', price: 90 },
      { name: 'طاجن رز معمر', price: 90 },
      { name: 'طاجن بامية باللحمة', price: 150 },
    ],
  },
  {
    name: 'إضافات الكشري',
    printer: KOSHARY,
    items: [
      { name: 'صلصة زيادة', price: 10 },
      { name: 'دقة زيادة', price: 5 },
      { name: 'شطة زيادة', price: 5 },
      { name: 'بصل مقرمش زيادة', price: 10 },
      { name: 'حمص زيادة', price: 10 },
    ],
  },
  {
    name: 'شاورما',
    printer: GRILL,
    items: [
      { name: 'ساندوتش شاورما فراخ', price: 70 },
      { name: 'ساندوتش شاورما لحمة', price: 95 },
      { name: 'صاروخ شاورما فراخ', price: 100 },
      { name: 'صاروخ شاورما لحمة', price: 130 },
      { name: 'فتة شاورما فراخ', price: 130, description: 'رز + عيش محمص + شاورما + صوص ثوم' },
      { name: 'فتة شاورما لحمة', price: 170, description: 'رز + عيش محمص + شاورما + صوص ثوم' },
      { name: 'وجبة شاورما عربي فراخ', price: 150, description: 'شاورما + بطاطس + طحينة + مخلل' },
      { name: 'وجبة شاورما عربي لحمة', price: 200, description: 'شاورما + بطاطس + طحينة + مخلل' },
    ],
  },
  {
    name: 'مشويات',
    printer: GRILL,
    items: [
      { name: 'ربع فرخة مشوية', price: 110 },
      { name: 'نص فرخة مشوية', price: 200 },
      { name: 'فرخة كاملة مشوية', price: 380 },
      { name: 'ربع كيلو كفتة', price: 190 },
      { name: 'نص كيلو كفتة', price: 370 },
      { name: 'ربع كيلو كباب', price: 260 },
      { name: 'ربع كيلو مشكل كفتة وكباب', price: 230 },
      { name: 'ربع كيلو ريش ضاني', price: 300 },
      { name: 'ساندوتش كفتة', price: 60 },
    ],
  },
  {
    name: 'سلطات ومقبلات',
    printer: GRILL,
    items: [
      { name: 'طحينة', price: 15 },
      { name: 'بابا غنوج', price: 20 },
      { name: 'سلطة خضراء', price: 15 },
      { name: 'مخلل', price: 10 },
      { name: 'بطاطس محمرة', price: 30 },
      { name: 'رز أبيض', price: 25 },
      { name: 'عيش', price: 5 },
    ],
  },
  {
    name: 'حلويات',
    printer: KOSHARY,
    items: [
      { name: 'رز بلبن', price: 30 },
      { name: 'رز بلبن بالمكسرات', price: 45 },
      { name: 'أم علي', price: 50 },
    ],
  },
  {
    name: 'مشروبات',
    printer: CASHIER_ONLY,
    items: [
      { name: 'مياه صغيرة', price: 10 },
      { name: 'مياه كبيرة', price: 15 },
      { name: 'بيبسي كانز', price: 25 },
      { name: 'سفن أب كانز', price: 25 },
      { name: 'عصير كانز', price: 25 },
    ],
  },
]
