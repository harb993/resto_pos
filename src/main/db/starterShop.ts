/**
 * What a brand-new أبو الدهب till opens with: its three printers and a starter menu.
 *
 * The shop has no counter. The customer's invoice prints at the cashier, and the food
 * is split between two kitchens, each with its own printer:
 *
 *   كشري وطواجن      the koshary, the tagines, their extras, and the desserts
 *   شاورما ومشويات   the shawarma, the grill, and the salads and sides served with them
 *
 * Every category below names the printer its prep ticket goes to — the same choice the
 * owner makes for a new category on the categories screen. Drinks are handed over at
 * the till, so they print no prep ticket at all.
 *
 * The printers arrive switched OFF and with no Windows printer chosen: which USB queue
 * is which kitchen is only knowable on the premises. The owner picks each one in
 * الإعدادات ← الطابعات and switches it on.
 *
 * The PRICES ARE A STARTING POINT, not the shop's price list. They are there so the
 * till can be tried on the first day; the owner sets the real ones from القائمة.
 * Costs are left at 0 for the same reason — nothing here knows what the shop pays.
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
  items: { name: string; price: number; description?: string }[]
}

const KOSHARY = 'كشري وطواجن'
const GRILL = 'شاورما ومشويات'

export const STARTER_MENU: StarterCategory[] = [
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
