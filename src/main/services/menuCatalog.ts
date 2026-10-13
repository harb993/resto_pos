/**
 * The restaurant's real menu, as costed in «ملخص الريسبى».
 *
 * Transcribed from that workbook one sheet per category. For every dish the sheet
 * gives its components, the raw cost of those components, a 5% safety margin on top,
 * and the shelf price. `cost` here is the figure AFTER the safety margin — the
 * «التكلفة بعد الامان» row — because that is the number the owner actually prices
 * against, and it is what the profit columns everywhere in this app should be
 * comparing the sale price to.
 *
 * Two deliberate departures from the sheet, both so a name means one thing:
 *
 *   - The broasted and strips sheets both call their meals «وجبة 2قطعة», «وجبة
 *     3قطعة» and so on, and the tortilla and 27-long sheets both have a «هوت دوج».
 *     Inside a sheet the heading disambiguates them; on a kitchen ticket, an invoice
 *     line or a sales report there is no heading, so each carries its family in the
 *     name here.
 *   - Two obvious typos are corrected: «صوص تبستى» → «صوص تيستى» (spelled «تيستى
 *     صوص» on every other sheet) and «يطاطس» → «بطاطس».
 *
 * The add-ons sheet prices its lines but does not cost them, so those come in with a
 * cost of 0 and the importer says so — they are the one part of the menu that still
 * needs a number from the owner before profit figures on them mean anything.
 */

export interface CatalogItem {
  name: string
  price: number
  /** «التكلفة بعد الامان» — raw materials and packaging, plus the 5% safety margin. */
  cost: number
  /** What goes in it, as the recipe sheet lists it. Shown on the item card. */
  description?: string
}

export interface CatalogCategory {
  name: string
  items: CatalogItem[]
}

const PACK = 'تغليف'

export const MENU_CATALOG: CatalogCategory[] = [
  {
    name: 'وجبات البروستيد',
    items: [
      { name: 'وجبة 2 قطعة بروستيد', price: 105, cost: 67.73,
        description: `2 قطعة + 2 خبز + 100جم بطاطس + كلوسلو + مخلل/كاتشب + ${PACK}` },
      { name: 'وجبة 2 قطعة بروستيد مع أرز', price: 130, cost: 77.18,
        description: `2 قطعة + 2 خبز + 100جم بطاطس + كلوسلو + مخلل/كاتشب + 150جم أرز + ${PACK}` },
      { name: 'وجبة 3 قطعة بروستيد', price: 160, cost: 87.68,
        description: `3 قطعة + 2 خبز + 100جم بطاطس + كلوسلو + مخلل/كاتشب + ${PACK}` },
      { name: 'وجبة 3 قطعة بروستيد مع أرز', price: 185, cost: 97.13,
        description: `3 قطعة + 2 خبز + 100جم بطاطس + كلوسلو + مخلل/كاتشب + 150جم أرز + ${PACK}` },
      { name: 'وجبة 4 قطعة بروستيد', price: 210, cost: 117.08,
        description: `4 قطعة + 3 خبز + 100جم بطاطس + كلوسلو + مخلل/كاتشب + ${PACK}` },
      { name: 'وجبة 4 قطعة بروستيد مع أرز', price: 235, cost: 126,
        description: `4 قطعة + 3 خبز + 100جم بطاطس + كلوسلو + مخلل/كاتشب + 150جم أرز + ${PACK}` },
      { name: 'وجبة 6 قطعة بروستيد', price: 310, cost: 164.85,
        description: `6 قطعة + 4 خبز + 150جم بطاطس + كلوسلو + مخلل/كاتشب + ${PACK}` },
      { name: 'وجبة 6 قطعة بروستيد مع أرز', price: 335, cost: 177.98,
        description: `6 قطعة + 4 خبز + 150جم بطاطس + كلوسلو + مخلل/كاتشب + 200جم أرز + ${PACK}` },
      { name: 'وجبة 8 قطعة بروستيد', price: 450, cost: 227.85,
        description: `8 قطعة + 6 خبز + 150جم بطاطس + كلوسلو + مخلل/كاتشب + ${PACK}` },
      { name: 'وجبة 8 قطعة بروستيد مع أرز', price: 475, cost: 243.6,
        description: `8 قطعة + 6 خبز + 150جم بطاطس + كلوسلو + مخلل/كاتشب + 250جم أرز + ${PACK}` },
      { name: 'وجبة 12 قطعة بروستيد', price: 630, cost: 323.93,
        description: `12 قطعة + 8 خبز + 150جم بطاطس + كلوسلو + مخلل/كاتشب + ${PACK}` },
      { name: 'وجبة 12 قطعة بروستيد مع أرز', price: 660, cost: 341.25,
        description: `12 قطعة + 8 خبز + 150جم بطاطس + كلوسلو + مخلل/كاتشب + 300جم أرز + ${PACK}` },
      { name: 'وجبة ميكس', price: 175, cost: 91.35,
        description: `2 ق بروستيد + 2 ق استربس + 3 خبز + 100جم بطاطس + كلوسلو + مخلل/كاتشب + ${PACK}` },
      { name: 'وجبة ميكس مع أرز', price: 200, cost: 101.33,
        description: `2 ق بروستيد + 2 ق استربس + 3 خبز + 100جم بطاطس + كلوسلو + مخلل/كاتشب + 150جم أرز + ${PACK}` },
    ],
  },
  {
    name: 'وجبات الاستربس',
    items: [
      { name: 'وجبة 2 قطعة استربس', price: 85, cost: 46.73,
        description: `2 قطعة + 2 خبز + 80جم بطاطس + نومية + مخلل/كاتشب + ${PACK}` },
      { name: 'وجبة 2 قطعة استربس مع أرز', price: 110, cost: 58.8,
        description: `2 قطعة + 2 خبز + 80جم بطاطس + نومية + مخلل/كاتشب + 200جم أرز + ${PACK}` },
      { name: 'وجبة 3 قطعة استربس', price: 120, cost: 60.38,
        description: `3 قطعة + 2 خبز + 100جم بطاطس + نومية + مخلل/كاتشب + ${PACK}` },
      { name: 'وجبة 3 قطعة استربس مع أرز', price: 145, cost: 72.45,
        description: `3 قطعة + 2 خبز + 100جم بطاطس + نومية + مخلل/كاتشب + 200جم أرز + ${PACK}` },
      { name: 'وجبة 5 قطعة استربس', price: 195, cost: 95.03,
        description: `5 قطعة + 3 خبز + 150جم بطاطس + نومية + مخلل/كاتشب + ${PACK}` },
      { name: 'وجبة 5 قطعة استربس مع أرز', price: 225, cost: 109.73,
        description: `5 قطعة + 3 خبز + 150جم بطاطس + نومية + مخلل/كاتشب + 250جم أرز + ${PACK}` },
      { name: 'وجبة 8 قطعة استربس', price: 280, cost: 133.35,
        description: `8 قطعة + 4 خبز + 150جم بطاطس + نومية + مخلل/كاتشب + ${PACK}` },
      { name: 'وجبة 8 قطعة استربس مع أرز', price: 315, cost: 150.68,
        description: `8 قطعة + 4 خبز + 150جم بطاطس + نومية + مخلل/كاتشب + 300جم أرز + ${PACK}` },
    ],
  },
  {
    name: 'سندوتشات تورتيلا',
    items: [
      { name: 'هوت دوج تورتيلا', price: 95, cost: 54.6,
        description: `1 قطعة + لقمة تورتيلا + 1 استيك موزاريلا + 40جم مايونيز وكاتشب + 35جم صوص شيدر + ${PACK}` },
      { name: 'تشيكن راب', price: 95, cost: 49.35,
        description: `2 قطعة استربس + لقمة تورتيلا + 40جم مايونيز وكاتشب + خيار + 35جم صوص شيدر + ${PACK}` },
      { name: 'توستر رول', price: 95, cost: 49.35,
        description: `2 قطعة استربس + لقمة تورتيلا + 40جم مايونيز وكاتشب + خيار أو هالبينو + 35جم صوص شيدر + ${PACK}` },
      { name: 'جمبرى رول', price: 120, cost: 70.88,
        description: `50جم جمبرى + لقمة تورتيلا + 1 استيك موزاريلا + 20جم صوص رانش + خيار + 20جم صوص شيدر + ${PACK}` },
      { name: 'سوبريم رول', price: 100, cost: 54.08,
        description: `2 قطعة استربس + لقمة تورتيلا + 25جم تيستى صوص + 3 ق سلامى + خيار أو هالبينو + ${PACK}` },
      { name: 'رانش رول', price: 95, cost: 46.73,
        description: `2 قطعة استربس + لقمة تورتيلا + 35جم صوص رانش + خيار + خس + ${PACK}` },
    ],
  },
  {
    name: 'سندوتشات 27 لونج',
    items: [
      { name: 'هوت دوج 27 لونج', price: 95, cost: 44.1,
        description: `1 قطعة + لقمة 27 لونج + 3 ق سلامى + 40جم مايونيز وكاتشب + ${PACK}` },
      { name: 'تشيكن استربس', price: 95, cost: 44.63,
        description: `2 قطعة استربس + لقمة 27 لونج + 40جم مايونيز وكاتشب + خس + خيار + ${PACK}` },
      { name: 'زنجر سوبريم', price: 100, cost: 49.88,
        description: `2 قطعة استربس + لقمة 27 لونج + تشيلى + خيار + خس + 3 ق سلامى + ${PACK}` },
      { name: 'شرمب كريسبو', price: 160, cost: 79.28,
        description: `70جم جمبرى + لقمة 27 لونج + 40جم مايونيز وكاتشب + 35جم صوص شيدر + خس + ${PACK}` },
      { name: 'جمبرى استيك', price: 175, cost: 89.25,
        description: `70جم جمبرى + لقمة 27 لونج + 40جم مايونيز وكاتشب + 35جم صوص شيدر + خس + 1 استيك موزاريلا + ${PACK}` },
      { name: 'سوبر كرانشى', price: 140, cost: 65.63,
        description: `2 قطعة استربس + لقمة 27 لونج + 40جم مايونيز وكاتشب + 35جم صوص رانش + خيار + خس + 2 ق رومى مدخن + ${PACK}` },
    ],
  },
  {
    name: 'البرجر',
    items: [
      { name: 'تشيكن برجر', price: 85, cost: 40.43,
        description: `1 قطعة + لقمة كيزر + 35جم صوص شيدر + 40جم مايونيز وكاتشب + خس + ${PACK}` },
      { name: 'دبل تشيكن برجر', price: 120, cost: 57.23,
        description: `2 قطعة + لقمة كيزر + 35جم صوص شيدر + 40جم مايونيز وكاتشب + خس + ${PACK}` },
      { name: 'تريبل تشيكن برجر', price: 180, cost: 87.68,
        description: `3 قطعة + 1.5 لقمة كيزر + 70جم صوص شيدر + 80جم مايونيز وكاتشب + خس + ${PACK}` },
      { name: 'بيف برجر', price: 95, cost: 46.73,
        description: `1 قطعة + لقمة كيزر + 25جم تيستى صوص + 40جم مايونيز وكاتشب + خس + ${PACK}` },
      { name: 'دبل بيف برجر', price: 135, cost: 66.68,
        description: `2 قطعة + لقمة كيزر + 25جم تيستى صوص + 40جم مايونيز وكاتشب + خس + ${PACK}` },
      { name: 'تريبل بيف برجر', price: 210, cost: 103.43,
        description: `3 قطعة + 1.5 لقمة كيزر + 50جم تيستى صوص + 80جم مايونيز وكاتشب + خس + ${PACK}` },
      { name: 'AKM', price: 100, cost: 47.78,
        description: `2 قطعة استربس + لقمة كيزر + 35جم صوص شيدر + 40جم مايونيز وكاتشب + خس + ${PACK}` },
      { name: 'بيج فاير', price: 145, cost: 70.88,
        description: `4 قطعة استربس + لقمة كيزر + 35جم صوص شيدر + 40جم مايونيز وكاتشب + خس + ${PACK}` },
      { name: 'ميكس كريسبو', price: 125, cost: 60.38,
        description: `1 قطعة فراخ + 1 قطعة لحمة + لقمة كيزر + 35جم صوص شيدر + 40جم مايونيز وكاتشب + خس وخيار مخلل + ${PACK}` },
      { name: 'زنجر كريسبو', price: 175, cost: 86.1,
        description: `4 قطعة استربس + لقمة كيزر + 2 ق رومى مدخن + 35جم صوص تشيلى + 40جم مايونيز وكاتشب + خس + ${PACK}` },
      { name: 'كريسبو تاور', price: 185, cost: 90.83,
        description: `4 قطعة استربس + لقمة كيزر + 2 اصابع موزاريلا + 35جم صوص رانش + 40جم مايونيز وكاتشب + خس + ${PACK}` },
      { name: 'مارينا كينج', price: 200, cost: 97.65,
        description: `1 قطعة لحمة + 2 ق استربس + 1.5 لقمة كيزر + حلقات بصل + 2 ق رومى مدخن + 35جم صوص باربكيو + 35جم صوص جبنة + 40جم مايونيز وكاتشب + خس + ${PACK}` },
    ],
  },
  {
    // The sheet prices these but never costs them, so every cost here is 0 on purpose.
    name: 'الإضافات',
    items: [
      { name: 'صوص رانش', price: 25, cost: 0 },
      { name: 'صوص تشيلى', price: 25, cost: 0 },
      { name: 'صوص تيستى', price: 25, cost: 0 },
      { name: 'صوص شيدر', price: 25, cost: 0 },
      { name: 'صوص باربكيو', price: 25, cost: 0 },
      { name: 'كلوسلو', price: 25, cost: 0 },
      { name: 'ثومية', price: 20, cost: 0 },
      { name: 'طبق أرز', price: 30, cost: 0 },
      { name: 'بطاطس', price: 30, cost: 0 },
      { name: 'قطعة برجر دجاج', price: 35, cost: 0 },
      { name: 'قطعة برجر لحمة', price: 40, cost: 0 },
      { name: 'قطعة استربس', price: 40, cost: 0 },
      { name: 'قطعة بروستيد ورك', price: 55, cost: 0 },
      { name: 'قطعة بروستيد صدر', price: 65, cost: 0 },
      { name: 'ريزو دجاج', price: 85, cost: 0 },
    ],
  },
]

/** Every item in the catalogue, flattened — for counting and for tests. */
export function catalogItemCount(): number {
  return MENU_CATALOG.reduce((n, c) => n + c.items.length, 0)
}
