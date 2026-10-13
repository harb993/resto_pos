import type Database from 'better-sqlite3'
import log from 'electron-log/main'

/**
 * Builds a month of believable trading in the DEMO database only.
 *
 * The point is to exercise every report with data that hangs together: invoices whose
 * line items sum to their own subtotals, stock movements that match what was sold,
 * shifts whose windows actually contain the orders attributed to them, and salaries
 * that equal days-attended × the daily wage. A report can only be trusted in testing
 * if the underlying numbers are consistent.
 *
 * Runs once — if the demo database already has orders, it is left alone.
 */

/**
 * What a day takes, in the showcase books.
 *
 * A per-DAY band rather than a month total, because this is what somebody being shown
 * the system actually looks at: they open today, or yesterday, and want the figure to
 * look like a real day's trading. Every day is drawn independently inside the band, so
 * the month has natural variation without any day falling outside what was promised.
 */
const DAY_SALES_MIN = 6_000
const DAY_SALES_MAX = 8_000
const DAYS = 30
/**
 * How far short of the day's target to stop — see the day loop.
 *
 * Larger than half the average ticket (~195/2) on purpose: the order that happens to
 * cross the line is more likely to be a big one, so the average overshoot is bigger
 * than half the mean. 165 was measured against the generated month and lands the
 * total within about 1% of the target.
 */
const STOP_SHORT_BY = 165

/** Deterministic PRNG, so a demo database is reproducible rather than different every time. */
function makeRandom(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0x100000000
  }
}

const pad = (n: number) => String(n).padStart(2, '0')
const dateStr = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const stamp = (d: Date, h: number, m: number) =>
  `${dateStr(d)} ${pad(h)}:${pad(m)}:${pad(Math.floor(Math.random() * 60))}`
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

/**
 * Throw away the showcase's TRADING, so a fresh window can be built ending today.
 *
 * Only what this file generates. The menu, the raw materials and the sign-in accounts
 * are left standing — they are the shop, not its history, and the seed below reads
 * them rather than creating them. Children before parents, because foreign keys are
 * on: order lines before orders, orders before the hand-overs they were settled in,
 * hand-overs before the drivers who made them.
 */
function clearDemoTrading(db: Database.Database): void {
  const wipe = db.transaction(() => {
    for (const table of [
      'order_items',
      'raw_material_transactions',
      'stock_transactions',
      'orders',
      'driver_settlements',
      'worker_attendance',
      'salaries',
      'workers',
      'expenses',
      'shifts',
      'delivery_drivers',
    ]) {
      const exists = db.prepare(
        `SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?`
      ).get(table)
      if (exists) db.prepare(`DELETE FROM ${table}`).run()
    }
  })
  wipe()

  const violations = db.pragma('foreign_key_check') as unknown[]
  if (violations.length > 0) {
    log.error(`[Demo] Rebuild left ${violations.length} foreign-key violation(s)`, violations)
  }
}

export function seedDemoData(db: Database.Database): void {
  /*
    Rebuilt whenever the books no longer reach today.

    A showcase is shown on the day somebody happens to be looking at it, and a month
    that stopped last Tuesday is the first thing they notice — every screen opens on an
    empty "today" and the dashboard reads zero. So the window follows the calendar: if
    the newest invoice is not from today, the demo trading is thrown away and a fresh
    thirty days ending today is generated.

    Only on the SHOWCASE database. The real one is never touched by any of this — see
    isDemoMode() at the call site.
  */
  const today = new Date()
  const todayStr = dateStr(today)

  const newest = db.prepare(
    `SELECT MAX(date(created_at)) AS d FROM orders`
  ).get() as { d: string | null }

  if (newest?.d === todayStr) {
    log.info('[Demo] Showcase books already reach today — left alone')
    return
  }

  if (newest?.d) {
    log.info(`[Demo] Showcase books end ${newest.d}, rebuilding to ${todayStr}`)
    clearDemoTrading(db)
  }

  /*
    Seeded from the DATE, so the figures are random day to day but settled within a
    day. A demo that reshuffled every time a screen was opened would show a different
    total each time somebody pressed refresh, in front of the customer — the one moment
    the numbers have to look like records rather than output.
  */
  const rand = makeRandom(
    today.getFullYear() * 10000 + (today.getMonth() + 1) * 100 + today.getDate()
  )
  const pick = <T>(arr: T[]): T => arr[Math.floor(rand() * arr.length)]
  const between = (lo: number, hi: number) => lo + rand() * (hi - lo)

  const run = db.transaction(() => {
    // ---- The account this database belongs to ----
    const bcrypt = require('bcryptjs')
    const already = db.prepare(`SELECT user_id FROM users WHERE username = 'fares'`).get() as any
    const faresId = already
      ? already.user_id as number
      : (db.prepare(
          `INSERT INTO users (username, password_hash, role, full_name) VALUES (?, ?, 'owner', ?)`
        ).run('fares', bcrypt.hashSync('fares123', 10), 'فارس').lastInsertRowid) as number

    const cashier1 = (db.prepare(`SELECT user_id FROM users WHERE slot = 'cashier1'`).get() as any)?.user_id ?? faresId
    const cashier2 = (db.prepare(`SELECT user_id FROM users WHERE slot = 'cashier2'`).get() as any)?.user_id ?? faresId
    const accountant = (db.prepare(`SELECT user_id FROM users WHERE slot = 'accountant'`).get() as any)?.user_id ?? faresId

    const menu = db.prepare(
      `SELECT item_id, name, price, cost_price FROM menu_items WHERE is_active = 1`
    ).all() as { item_id: number; name: string; price: number; cost_price: number }[]
    if (menu.length === 0) {
      log.warn('[Demo] No menu items — skipping demo seed')
      return
    }

    // Real tills sell far more drinks, sandwiches and sides than family buckets.
    // Weighting the pick keeps the average ticket believable (~130) instead of
    // producing a month of party orders.
    const cheapItems = menu.filter(m => m.price < 70)
    const midItems = menu.filter(m => m.price >= 70 && m.price < 150)
    const priceyItems = menu.filter(m => m.price >= 150)
    const pickItem = () => {
      const r = rand()
      const pool = r < 0.6 ? cheapItems : r < 0.88 ? midItems : priceyItems
      return pick(pool.length > 0 ? pool : menu)
    }

    const areas = db.prepare(`SELECT delivery_area_id, delivery_fee FROM delivery_areas WHERE is_active = 1`)
      .all() as { delivery_area_id: number; delivery_fee: number }[]

    // A fixed book of regulars rather than a new phone number every time. Real
    // delivery trade is mostly repeat custom, and without it the customer screen
    // has nothing to show: no order history, no regulars, no lifetime spend.
    const firstNames = ['أحمد', 'محمد', 'مصطفى', 'ياسمين', 'هبة', 'عمرو', 'سارة', 'خالد', 'منى', 'طارق']
    const lastNames = ['علي', 'حسن', 'إبراهيم', 'سمير', 'فؤاد', 'عبد الله', 'رشدي']
    const streets = ['شارع 9', 'شارع الهرم', 'ميدان الساعة', 'شارع النصر', 'شارع الجمهورية']
    const customerPool = Array.from({ length: 26 }, (_, i) => ({
      name: `${firstNames[i % firstNames.length]} ${lastNames[i % lastNames.length]}`,
      phone: '01' + pick(['0', '1', '2', '5']) +
             String(Math.floor(rand() * 1e8)).padStart(8, '0'),
      address: `${pick(streets)} — عمارة ${1 + Math.floor(rand() * 40)}`,
      area: areas.length > 0 ? pick(areas) : null,
    }))
    // Weighted so a handful order constantly and the rest occasionally — which is
    // what makes "repeat customers" a meaningful figure on the customer screen.
    const pickCustomer = () => {
      const r = rand()
      const idx = r < 0.55
        ? Math.floor(rand() * 6)                      // the regulars
        : 6 + Math.floor(rand() * (customerPool.length - 6))
      return customerPool[Math.min(idx, customerPool.length - 1)]
    }

    const recipes = new Map<number, { raw_material_id: number; quantity: number }[]>()
    for (const m of menu) {
      recipes.set(m.item_id, db.prepare(
        `SELECT raw_material_id, quantity FROM recipe_items WHERE menu_item_id = ?`
      ).all(m.item_id) as any[])
    }

    const taxRate = parseFloat(
      (db.prepare(`SELECT value FROM settings WHERE key = 'tax_rate'`).get() as any)?.value ?? '0.14'
    )

    // ---- Daily workers ----
    const workerIds: number[] = []
    const insertWorker = db.prepare(
      `INSERT INTO workers (full_name, role_title, daily_wage, is_active) VALUES (?, ?, ?, 1)`
    )
    for (const [name, role, wage] of [
      ['محمود سيد', 'طباخ', 350],
      ['علي حسن', 'مساعد مطبخ', 220],
      ['سعيد فتحي', 'عامل نظافة', 180],
      ['كريم مصطفى', 'مساعد تجهيز', 200],
    ] as [string, string, number][]) {
      workerIds.push(insertWorker.run(name, role, wage).lastInsertRowid as number)
    }

    // ---- Delivery drivers ----
    // Without them the delivery centre opens empty on the showcase account, and the
    // one screen that is entirely about who is holding the restaurant's money has
    // nothing to hold it.
    const insertDriver = db.prepare(
      `INSERT INTO delivery_drivers (full_name, phone, is_active) VALUES (?, ?, 1)`
    )
    const driverIds: number[] = []
    for (const [name, phone] of [
      ['أحمد رمضان', '01011122233'],
      ['سيد عبد الحميد', '01222334455'],
      ['مينا نبيل', '01099887766'],
    ] as [string, string][]) {
      driverIds.push(insertDriver.run(name, phone).lastInsertRowid as number)
    }

    // ---- Prepared statements ----
    const insOrder = db.prepare(`
      INSERT INTO orders (cashier_id, subtotal, tax, discount, total_amount, payment_type,
        order_type, customer_name, customer_phone, customer_address, delivery_area_id,
        delivery_fee, driver_id, delivery_status, dispatched_at, delivered_at,
        invoice_number, status, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    const insLine = db.prepare(`
      INSERT INTO order_items (order_id, menu_item_id, quantity, unit_price, unit_cost, variant_label)
      VALUES (?,?,?,?,?,?)`)
    const insRmTxn = db.prepare(`
      INSERT INTO raw_material_transactions (raw_material_id, change_amount, reason, related_order_id, created_by, created_at)
      VALUES (?,?,?,?,?,?)`)
    const deductRm = db.prepare(
      `UPDATE raw_materials SET stock_quantity = round(stock_quantity - ?, 3) WHERE raw_material_id = ?`)
    const addRm = db.prepare(
      `UPDATE raw_materials SET stock_quantity = round(stock_quantity + ?, 3) WHERE raw_material_id = ?`)
    const insShift = db.prepare(`
      INSERT INTO shifts (cashier_id, shift_date, shift_number, start_time, end_time, started_at, ended_at, set_by)
      VALUES (?,?,?,?,?,?,?,?)`)
    const insExpense = db.prepare(`
      INSERT INTO expenses (category, description, amount, recorded_by, expense_date, created_at)
      VALUES (?,?,?,?,?,?)`)
    const insAttend = db.prepare(
      `INSERT OR IGNORE INTO worker_attendance (worker_id, work_date, created_by, created_at) VALUES (?,?,?,?)`)
    const insSalary = db.prepare(`
      INSERT INTO salaries (worker_id, amount, pay_period_start, pay_period_end, paid_on, created_by, created_at)
      VALUES (?,?,?,?,?,?,?)`)

    const seq = { dine_in: 0, takeaway: 0, delivery: 0 }
    const prefix = { dine_in: 'DI', takeaway: 'TA', delivery: 'DL' }

    const today = new Date()
    const firstDay = new Date(today)
    firstDay.setDate(today.getDate() - (DAYS - 1))

    /*
      Each day's takings, drawn independently inside the band.

      The old version weighted the month for shape and then SCALED every day so the
      whole month hit one total — which meant no individual day was anything in
      particular. The promise here is about the day, so the day is what gets drawn:
      every date lands somewhere in 6,000–8,000, the weekend sits in the upper half of
      that band rather than above it, and the month is simply whatever those days add
      up to.
    */
    const dayTargets: number[] = []
    for (let i = 0; i < DAYS; i++) {
      const d = new Date(firstDay)
      d.setDate(firstDay.getDate() + i)
      const dow = d.getDay() // 5 = Friday, 6 = Saturday — the Egyptian weekend
      const weekend = dow === 5 || dow === 6
      // Busier at the weekend, but still inside the band: the top half of it.
      const lo = weekend ? (DAY_SALES_MIN + DAY_SALES_MAX) / 2 : DAY_SALES_MIN
      dayTargets.push(between(lo, DAY_SALES_MAX))
    }

    let salesTotal = 0
    let orderCount = 0
    // Everything drawn down (sales, prep consumption, waste) and everything prep
    // produced — the two together decide how much has to be bought in.
    const stockUsage = new Map<number, number>()
    const prepProduced = new Map<number, number>()

    for (let i = 0; i < DAYS; i++) {
      const day = new Date(firstDay)
      day.setDate(firstDay.getDate() + i)
      const ds = dateStr(day)
      const dayTarget = dayTargets[i]

      // ---- Two shifts, actually clocked ----
      const morningEnd = 17
      insShift.run(cashier1, ds, 1, '09:00', '17:00',
        `${ds} 09:0${Math.floor(rand() * 9)}:00`, `${ds} ${pad(morningEnd)}:0${Math.floor(rand() * 9)}:00`, cashier1)
      insShift.run(cashier2, ds, 2, '17:00', '01:00',
        `${ds} 17:0${Math.floor(rand() * 9)}:00`, `${ds} 23:5${Math.floor(rand() * 9)}:00`, cashier2)

      // ---- Orders through the day ----
      let dayTotal = 0
      let guard = 0
      /*
        Ring up orders until the day is done, then stop — where "done" is decided at
        the BOTTOM of the loop, after the order is known.

        The old condition sat at the top and stopped short of the target, letting the
        order that crossed the line settle the day either side of it. Good for shape,
        wrong at the edges: a big ticket on a day already near the top ended it above
        8,000, and a day whose target was near the bottom stopped 165 short and ended
        below 6,000. Both were measured on real generated dates.

        The band is a promise about the day, so the day is where it is enforced: the
        floor is the one thing that must be cleared before stopping, and the ceiling is
        checked against each order before it is written.
      */
      const stopAt = Math.max(dayTarget - STOP_SHORT_BY, DAY_SALES_MIN)
      while (guard++ < 400) {
        const hour = Math.floor(between(10, 23))
        const minute = Math.floor(rand() * 60)
        const cashier = hour < morningEnd ? cashier1 : cashier2
        const createdAt = stamp(day, hour, minute)

        const roll = rand()
        const orderType: 'dine_in' | 'takeaway' | 'delivery' =
          roll < 0.45 ? 'dine_in' : roll < 0.78 ? 'takeaway' : 'delivery'

        // A normal counter order: one or two things, usually one of each. Keeps the
        // average ticket near a real fast-food figure so the month has the order
        // VOLUME a restaurant actually does, not a handful of giant sales.
        const lineCount = 1 + Math.floor(rand() * 2)
        const chosen: { item: typeof menu[number]; qty: number }[] = []
        for (let l = 0; l < lineCount; l++) {
          const item = pickItem()
          if (chosen.some(c => c.item.item_id === item.item_id)) continue
          chosen.push({ item, qty: rand() < 0.75 ? 1 : 2 })
        }
        if (chosen.length === 0) continue

        const subtotal = round2(chosen.reduce((t, c) => t + c.item.price * c.qty, 0))
        // VAT applies to dine-in only, exactly as the live system does.
        const tax = orderType === 'dine_in' ? round2(subtotal * taxRate) : 0
        const discountPct = rand() < 0.12 ? pick([5, 10]) : 0
        const discount = round2((subtotal * discountPct) / 100)

        let deliveryFee = 0
        let areaId: number | null = null
        let customerName: string | null = null
        let customerPhone: string | null = null
        let customerAddress: string | null = null
        if (orderType === 'delivery' && areas.length > 0) {
          const customer = pickCustomer()
          const area = customer.area ?? pick(areas)
          areaId = area.delivery_area_id
          deliveryFee = round2(area.delivery_fee)
          customerName = customer.name
          customerPhone = customer.phone
          customerAddress = customer.address
        }

        const total = round2(Math.max(0, subtotal + tax - discount + deliveryFee))

        /*
          Never let one order carry the day out of the band.

          The loop deliberately stops SHORT of the target so the order that crosses the
          line leaves the day either side of it rather than always above. That is right
          for shape, but it means a big ticket landing on a day already near the top
          ends it above 8,000 — measured at 8,025.15 on one generated date. The band is
          a promise about the DAY, so it is enforced on the day: an order that would
          break the ceiling is simply not rung up, and since the day is past its target
          by then there is nothing left to add anyway.
        */
        if (dayTotal + total > DAY_SALES_MAX) break

        const paymentType = rand() < 0.72 ? 'cash' : 'card'
        // A couple of voids a month, so the void reporting has something to show.
        const status = rand() < 0.012 ? 'voided' : 'completed'

        seq[orderType] += 1
        const invoiceNumber = `${prefix[orderType]}-${String(seq[orderType]).padStart(6, '0')}`

        // ---- Where the delivery got to ----
        //
        // Every generated order arrives: a month of food still "on the road" would be
        // a demonstration of a shop that loses its dinners. Tonight's last few are
        // put back on the road afterwards — see the pass below the day loop.
        let driverId: number | null = null
        let deliveryStatus: string | null = null
        let dispatchedAt: string | null = null
        let deliveredAt: string | null = null

        if (orderType === 'delivery') {
          driverId = pick(driverIds)
          dispatchedAt = stamp(day, hour, Math.min(59, minute + 4))
          deliveryStatus = 'delivered'
          // ~25 minutes door to door, rolling into the next hour when it has to.
          const arrive = minute + Math.floor(between(18, 34))
          deliveredAt = stamp(day, hour + Math.floor(arrive / 60), arrive % 60)
        }

        const orderId = insOrder.run(
          cashier, subtotal, tax, discount, total, paymentType, orderType,
          customerName, customerPhone, customerAddress, areaId, deliveryFee,
          driverId, deliveryStatus, dispatchedAt, deliveredAt,
          invoiceNumber, status, createdAt
        ).lastInsertRowid as number

        for (const c of chosen) {
          insLine.run(orderId, c.item.item_id, c.qty, c.item.price, c.item.cost_price, null)

          // Draw the ingredients down, exactly as a real sale would.
          if (status === 'completed') {
            for (const ing of recipes.get(c.item.item_id) ?? []) {
              const used = round2(ing.quantity * c.qty)
              deductRm.run(used, ing.raw_material_id)
              insRmTxn.run(ing.raw_material_id, -used, 'sale', orderId, cashier, createdAt)
              stockUsage.set(ing.raw_material_id, (stockUsage.get(ing.raw_material_id) ?? 0) + used)
            }
          }
        }

        if (status === 'completed') {
          dayTotal += total
          salesTotal += total
          orderCount++
        }

        // Past the day's target AND clear of the floor — that is a day's trading.
        if (dayTotal >= stopAt) break
      }

      // ---- Daily workers attend, most days ----
      for (const wId of workerIds) {
        if (rand() < 0.87) insAttend.run(wId, ds, faresId, `${ds} 09:00:00`)
      }

      // ---- Running costs ----
      if (rand() < 0.5) {
        const [cat, desc, lo, hi] = pick([
          ['ingredients', 'مشتريات خضار وسلطات', 150, 400],
          ['ingredients', 'توريد دجاج من المورد', 800, 1800],
          ['utilities', 'فاتورة كهرباء', 250, 600],
          ['utilities', 'أنابيب غاز', 120, 300],
          ['maintenance', 'صيانة قلاية', 200, 700],
          ['delivery', 'بنزين سائقين', 100, 260],
          ['other', 'مصروفات نثرية', 50, 180],
        ] as [string, string, number, number][])
        insExpense.run(cat, desc, round2(between(lo, hi)),
          rand() < 0.5 ? accountant : cashier1, ds, `${ds} ${pad(Math.floor(between(10, 20)))}:15:00`)
      }

      // ---- Prep: butcher chickens into pieces every couple of days ----
      if (i % 2 === 0) {
        const conv = db.prepare(`SELECT * FROM prep_conversions LIMIT 1`).get() as any
        if (conv) {
          const batches = 8 + Math.floor(rand() * 10)
          const produced = round2(batches * conv.yield_quantity)
          deductRm.run(batches, conv.source_material_id)
          addRm.run(produced, conv.output_material_id)
          insRmTxn.run(conv.source_material_id, -batches, 'prep_out', null, cashier1, `${ds} 08:30:00`)
          insRmTxn.run(conv.output_material_id, produced, 'prep_in', null, cashier1, `${ds} 08:30:00`)
          // Prep eats the SOURCE material (whole chickens) without any sale touching
          // it, so it has to be counted here too — otherwise the restock pass below,
          // which only knew about sales, left the source deeply negative.
          stockUsage.set(conv.source_material_id,
            (stockUsage.get(conv.source_material_id) ?? 0) + batches)
          // ...and prep SUPPLIES the output, so that much does not need buying in.
          prepProduced.set(conv.output_material_id,
            (prepProduced.get(conv.output_material_id) ?? 0) + produced)
        }
      }

      // ---- A little waste, so the waste figure is not zero ----
      if (rand() < 0.18) {
        const rm = db.prepare(
          `SELECT raw_material_id FROM raw_materials WHERE is_active = 1 ORDER BY raw_material_id LIMIT 1 OFFSET ?`
        ).get(Math.floor(rand() * 20)) as any
        if (rm) {
          const qty = round2(between(0.5, 3))
          deductRm.run(qty, rm.raw_material_id)
          insRmTxn.run(rm.raw_material_id, -qty, 'waste', null, cashier1, `${ds} 22:00:00`)
          stockUsage.set(rm.raw_material_id, (stockUsage.get(rm.raw_material_id) ?? 0) + qty)
        }
      }
    }

    // ---- Tonight's round is still going ----
    //
    // A delivery board with nothing live on it demonstrates none of what the screen
    // is for, and the generated month is only about seven orders a day, so leaving
    // this to chance leaves it empty. Tonight's last three delivery orders are put
    // back where they would really be at this hour: one still waiting for a driver,
    // two out on the bikes.
    const tonight = db.prepare(`
      SELECT order_id FROM orders
      WHERE order_type = 'delivery' AND status = 'completed' AND deleted_at IS NULL
        AND date(created_at) = ?
      ORDER BY created_at DESC LIMIT 3
    `).all(dateStr(today)) as { order_id: number }[]

    if (tonight.length > 0) {
      // The newest has only just been rung up — it is with the kitchen, and no
      // driver has been named for it yet.
      db.prepare(`
        UPDATE orders
           SET delivery_status = 'preparing', driver_id = NULL,
               dispatched_at = NULL, delivered_at = NULL
         WHERE order_id = ?`).run(tonight[0].order_id)

      // Only put a second one back on the road if the day can spare it. A thin
      // Tuesday can produce two delivery orders in total, and taking both would
      // leave the demonstration with a delivered count of zero — the opposite of
      // the problem this pass exists to fix.
      if (tonight.length >= 3) {
        db.prepare(`
          UPDATE orders SET delivery_status = 'out', delivered_at = NULL
           WHERE order_id = ?`).run(tonight[1].order_id)
      }
    }

    // ---- Drivers hand in the cash at the end of each night ----
    //
    // Everything up to the night before last is settled and closed. The last two days
    // are not, which is the shape a real shop is in at any moment: a month of clean
    // history behind it, and the most recent takings still out on the bikes. It is
    // also what gives the delivery centre a "نقدية مع السائقين" figure worth looking
    // at, on a demo day that may only have produced two delivery orders.
    const insSettlement = db.prepare(`
      INSERT INTO driver_settlements (driver_id, order_count, total_amount, note, settled_by, settled_at)
      VALUES (?,?,?,?,?,?)`)
    const stampSettled = db.prepare(`
      UPDATE orders SET settlement_id = ?
      WHERE order_type = 'delivery' AND status = 'completed' AND deleted_at IS NULL
        AND delivery_status = 'delivered' AND payment_type = 'cash'
        AND driver_id = ? AND date(created_at) = ?`)

    const nights = db.prepare(`
      SELECT driver_id, date(created_at) AS d, COUNT(*) AS c, SUM(total_amount) AS t
      FROM orders
      WHERE order_type = 'delivery' AND status = 'completed' AND deleted_at IS NULL
        AND delivery_status = 'delivered' AND payment_type = 'cash'
        AND driver_id IS NOT NULL AND date(created_at) < date(?, '-1 day')
      GROUP BY driver_id, d
      ORDER BY d, driver_id
    `).all(dateStr(today)) as { driver_id: number; d: string; c: number; t: number }[]

    for (const n of nights) {
      const settlementId = insSettlement.run(
        n.driver_id, n.c, round2(n.t), null,
        rand() < 0.5 ? faresId : accountant, `${n.d} 23:45:00`,
      ).lastInsertRowid as number
      stampSettled.run(settlementId, n.driver_id, n.d)
    }

    // ---- Buy in what the month consumed, so the demo opens with sane balances ----
    // Dated before everything else, because supplies arrive and are then used.
    for (const [materialId, used] of stockUsage) {
      // A material the kitchen produces itself (chicken pieces) only needs buying in
      // for the shortfall prep did not cover.
      const shortfall = used - (prepProduced.get(materialId) ?? 0)
      if (shortfall <= 0) continue

      const topUp = round2(shortfall * 1.25 + 20)
      addRm.run(topUp, materialId)
      insRmTxn.run(materialId, topUp, 'restock', null, faresId,
        `${dateStr(firstDay)} 08:00:00`)
    }

    // ---- Pay the workers: two fortnightly runs, days attended × daily wage ----
    const mid = new Date(firstDay)
    mid.setDate(firstDay.getDate() + 14)
    const periods: [string, string][] = [
      [dateStr(firstDay), dateStr(mid)],
      [dateStr(new Date(mid.getTime() + 86_400_000)), dateStr(today)],
    ]
    for (const [from, to] of periods) {
      for (const wId of workerIds) {
        const days = (db.prepare(
          `SELECT COUNT(*) AS c FROM worker_attendance WHERE worker_id = ? AND work_date BETWEEN ? AND ?`
        ).get(wId, from, to) as any).c
        if (days === 0) continue
        const wage = (db.prepare(`SELECT daily_wage FROM workers WHERE worker_id = ?`).get(wId) as any).daily_wage
        insSalary.run(wId, round2(days * wage), from, to, to, accountant, `${to} 18:00:00`)
      }
    }

    // The invoice counters must continue from the demo data, not restart at 1.
    const setSeq = db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`)
    setSeq.run('invoice_seq_dine_in', String(seq.dine_in))
    setSeq.run('invoice_seq_takeaway', String(seq.takeaway))
    setSeq.run('invoice_seq_delivery', String(seq.delivery))

    log.info(
      `[Demo] Seeded ${orderCount} orders totalling ${round2(salesTotal)} over ${DAYS} days, ` +
      `plus ${workerIds.length} daily workers, attendance, salaries, expenses and stock movements`
    )
  })

  run()
}
