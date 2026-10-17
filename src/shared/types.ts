// ===== User & Auth =====

export type UserRole = 'cashier' | 'owner' | 'accountant'

/**
 * The four fixed people who operate the system. Two cashiers (one per shift), the
 * owner and the accountant — nobody else gets a login. Everyone else is a daily
 * worker (see Worker), paid per day and tracked through attendance.
 */
export type UserSlot = 'cashier1' | 'cashier2' | 'owner' | 'accountant'
export type PaymentType = 'cash' | 'card'
export type OrderStatus = 'completed' | 'voided'
export type StockTxnReason = 'sale' | 'restock' | 'waste' | 'adjustment' | 'conversion' | 'void'
export type OrderType = 'dine_in' | 'takeaway' | 'delivery'

/**
 * Where a delivery order has got to. `null` on anything that never leaves the shop —
 * and on delivery orders taken before this was tracked, which must not be guessed at.
 *
 * 'preparing' is the kitchen's; 'pending' means cooked, bagged and waiting for a
 * driver. They are separate because "late" means two different things in each: in
 * the first the kitchen is behind, in the second there is nobody to carry it.
 */
export type DeliveryStatus = 'preparing' | 'pending' | 'out' | 'delivered' | 'returned'
export type ExpenseCategory = 'ingredients' | 'utilities' | 'maintenance' | 'delivery' | 'other'

export interface User {
  user_id: number
  username: string
  pin_hash: string | null
  password_hash: string
  role: UserRole
  /** Which of the four fixed posts this account holds. */
  slot: UserSlot | null
  full_name: string
  is_active: number
  created_at: string
}

export interface SessionUser {
  userId: number
  role: UserRole
  fullName: string
  username: string
}

export interface LoginResult {
  success: boolean
  user?: SessionUser
  error?: string
}

// ===== Menu =====

export interface Category {
  category_id: number
  name: string
  display_order: number
}

export interface MenuItem {
  item_id: number
  category_id: number
  category_name?: string
  name: string
  price: number
  cost_price: number
  /**
   * «التكلفة المبدئية» — the sheet's «تكلفة الخامات والتغليف»: what «ملخص الريسبى»
   * costed this dish at, its ingredients plus its packaging, with the 5% safety margin
   * on top («التكلفة بعد الامان»). The figure the selling price was set against.
   *
   * It does not follow `cost_price`, and that is the point: it is what the shop is
   * measuring FROM, so the costing tab can say whether today's ingredient prices have
   * moved away from the plan. 0 = never costed.
   */
  baseline_cost: number
  description: string | null
  image_path: string | null
  is_active: number
  stock_quantity: number
  /** Where it sits on the POS grid within its category. */
  display_order?: number
  /** 0 when this item should NOT be asked its category's questions. */
  inherit_category_variants?: number
  created_at: string
  updated_at: string
  /** Everything this item asks: its category's questions, then its own. */
  variants?: VariantGroup[]
  /**
   * Number of ingredient lines. > 0 means selling this item draws down raw
   * materials; 0 means the item is not stock-tracked at all.
   */
  recipe_count?: number
  /**
   * Portions still makeable from the ingredients on hand, decided by the limiting
   * ingredient. null when the item has no recipe. May be negative if a count has
   * drifted below zero — a shortage warns, it never blocks a sale.
   */
  available_portions?: number | null
}

export interface MenuItemInput {
  item_id?: number
  category_id: number
  name: string
  price: number
  cost_price: number
  /**
   * «التكلفة المبدئية» — see `MenuItem.baseline_cost`. Omitted leaves whatever the
   * dish already has, so a screen that does not offer the field cannot wipe it.
   */
  baseline_cost?: number
  description?: string
  image_path?: string
  is_active?: number
  stock_quantity?: number
}

// ===== Variants =====

/**
 * One question an item asks when it is rung up — "الحجم", "الطابق", "النوع".
 *
 * An item with no groups goes straight into the cart (water, cola). An item with
 * groups asks one question per group and takes exactly one answer to each. Nothing
 * about which items ask what is hard-coded: it is entirely what the owner sets up.
 */
export interface VariantGroup {
  variant_group_id: number
  /** Set when this group belongs to ONE item. Null when it belongs to a category. */
  menu_item_id: number | null
  /** Set when this group is asked of every item in a category. */
  category_id: number | null
  group_name: string
  display_order: number
  options: VariantOption[]
}

export interface VariantOption {
  variant_option_id: number
  variant_group_id: number
  option_name: string
  /**
   * Added to the item's base price when this option is chosen. Large fries are +15,
   * a triple burger +40, حار the same as عادي at 0. May be negative for a size that
   * sells below the item's default price.
   */
  price_delta: number
  display_order: number
}

/** What the owner sends when editing an item's variants. Replaces the whole set. */
export interface VariantGroupInput {
  groupName: string
  options: { optionName: string; priceDelta: number }[]
}

// ===== Orders =====

export interface OrderLine {
  menuItemId: number
  quantity: number
  unitPrice: number
  itemName: string
  variantLabel?: string
  /**
   * The variant options chosen for this line, one per group.
   *
   * These — not `unitPrice`, and not `variantLabel` — are what the main process
   * prices from: it looks each option up, checks it really belongs to this item, and
   * adds its `price_delta` to the base. A renderer that asked for a triple burger at
   * single-burger money would simply be recomputed.
   */
  variantOptionIds?: number[]
}

/**
 * What the renderer sends. Note that `subtotal`, `tax`, `deliveryFee` and
 * `totalAmount` are deliberately NOT part of this contract: the main process
 * recomputes every one of them from the database so a buggy or tampered-with
 * renderer cannot decide what the customer is charged.
 *
 * `discountPercent` is a request, not a command — it is clamped server-side to
 * the `max_cashier_discount` setting for cashier sessions.
 */
export interface CreateOrderInput {
  cashierId: number
  items: OrderLine[]
  paymentType: PaymentType
  discountPercent: number
  orderType: OrderType
  customerName?: string
  customerPhone?: string
  customerAddress?: string
  deliveryAreaId?: number
  driverId?: number
  /** Free text for the kitchen or the counter. Printed only when it has content. */
  notes?: string
}

/** The authoritative totals, computed in the main process. The receipt prints these. */
export interface CreateOrderResult {
  orderId: number
  invoiceNumber: string
  subtotal: number
  tax: number
  discount: number
  discountPercent: number
  deliveryFee: number
  totalAmount: number
  /** Set when the requested discount was reduced to the configured cap. */
  discountCapped?: boolean
  /**
   * Raw materials that went to (or further below) zero on this order. The sale is
   * still recorded — a miscount must not stop service — but the cashier is told so
   * the count can be corrected.
   */
  stockWarnings?: string[]
}

export interface Order {
  order_id: number
  cashier_id: number
  cashier_name?: string
  subtotal: number
  tax: number
  discount: number
  total_amount: number
  payment_type: PaymentType
  status: OrderStatus
  voided_by: number | null
  void_reason: string | null
  order_type: OrderType
  customer_name: string | null
  customer_phone: string | null
  customer_address: string | null
  delivery_area_id: number | null
  delivery_fee: number
  driver_id: number | null
  delivery_status: DeliveryStatus | null
  dispatched_at: string | null
  delivered_at: string | null
  /** Set once the driver has handed in the cash for this order. */
  settlement_id: number | null
  deleted_at: string | null
  deleted_by: number | null
  invoice_number: string | null
  notes: string | null
  created_at: string
  items?: OrderItem[]
  // Joined fields
  area_name?: string
  driver_name?: string
  settled_at?: string | null
  /** Who deleted it — only ever set on a soft-deleted order. */
  deleted_by_name?: string
  voided_by_name?: string
}

export interface OrderItem {
  order_item_id: number
  order_id: number
  menu_item_id: number
  item_name?: string
  quantity: number
  unit_price: number
  unit_cost: number
  variant_label: string | null
}

// ===== Stock =====

export interface StockTransaction {
  stock_txn_id: number
  inventory_id: number | null
  menu_item_id: number | null
  item_name: string
  change_amount: number
  reason: StockTxnReason
  related_order_id: number | null
  created_by: number
  created_by_name?: string
  created_at: string
}

export interface StockConversion {
  conversion_id: number
  source_inventory_id: number
  output_inventory_id: number
  yield_quantity: number
  source_name?: string
  output_name?: string
}

// ===== Raw materials (المواد الخام) =====

export type RawMaterialTxnReason =
  | 'sale' | 'restock' | 'waste' | 'adjustment' | 'prep_out' | 'prep_in' | 'void'

/** A manual stock movement the owner can record from the inventory screen. */
export type RawMaterialManualReason = 'restock' | 'waste' | 'adjustment'

export interface RawMaterial {
  raw_material_id: number
  name: string
  unit: string
  stock_quantity: number
  cost_per_unit: number
  low_stock_threshold: number
  is_active: number
  created_at: string
}

export interface RawMaterialInput {
  rawMaterialId?: number
  name: string
  unit: string
  costPerUnit: number
  lowStockThreshold: number
  isActive?: number
  /** Opening balance — only honoured when creating a new material. */
  openingStock?: number
}

export interface RawMaterialTransaction {
  rm_txn_id: number
  raw_material_id: number
  material_name?: string
  unit?: string
  change_amount: number
  reason: RawMaterialTxnReason
  related_order_id: number | null
  created_by: number
  created_by_name?: string
  created_at: string
}

// ===== Recipes (BOM) =====

/** One ingredient line: how much of a raw material goes into ONE unit of a menu item. */
export interface RecipeItem {
  recipe_item_id: number
  menu_item_id: number
  raw_material_id: number
  quantity: number
  // Joined fields
  material_name?: string
  unit?: string
  cost_per_unit?: number
  stock_quantity?: number
}

export interface RecipeLineInput {
  rawMaterialId: number
  quantity: number
}

// ===== Prep conversions (التجهيز — e.g. 1 chicken → 8 pieces) =====

export interface PrepConversion {
  prep_conversion_id: number
  source_material_id: number
  output_material_id: number
  yield_quantity: number
  // Joined fields
  source_name?: string
  source_unit?: string
  source_stock?: number
  output_name?: string
  output_unit?: string
  output_stock?: number
}

// ===== Delivery =====

export interface DeliveryArea {
  delivery_area_id: number
  area_name: string
  delivery_fee: number
  is_active: number
}

export interface DeliveryDriver {
  driver_id: number
  full_name: string
  phone: string | null
  is_active: number
}

/** One hand-over of collected cash from a driver to the restaurant. */
export interface DriverSettlement {
  settlement_id: number
  driver_id: number
  order_count: number
  total_amount: number
  note: string | null
  settled_by: number
  settled_at: string
  // Joined
  driver_name?: string
  settled_by_name?: string
}

/**
 * What one driver owes and what he is carrying, right now.
 *
 * `cashOwed` counts ONLY delivered cash orders that have not been settled. A card
 * order is money the customer paid the machine — the driver never touched it, so it
 * can never be something he owes. An order still out is not owed either: it has not
 * been delivered, so no money has changed hands yet.
 */
export interface DriverBalance {
  driver_id: number
  full_name: string
  phone: string | null
  is_active: number
  /** Orders with him now — dispatched, not yet delivered or returned. */
  outCount: number
  outValue: number
  /** Delivered, paid in cash, not yet handed in. */
  unsettledCount: number
  cashOwed: number
  /** Delivered by him in the period being looked at, however it was paid. */
  deliveredCount: number
  deliveredValue: number
  returnedCount: number
  /** Delivery fees on the orders he delivered in the period — his round's earnings. */
  feesCollected: number
  lastSettledAt: string | null
}

/** The shop-wide counters across the top of the delivery centre. */
export interface DeliverySummary {
  /** With the kitchen — not cooked yet. */
  preparingCount: number
  /** Cooked and bagged, with nobody to carry it. */
  pendingCount: number
  outCount: number
  /** Delivery invoices that were deleted. Hidden everywhere else by design. */
  deletedCount: number
  deliveredCount: number
  returnedCount: number
  /** Delivered orders' money in the period, cash and card together. */
  deliveredValue: number
  /** Still in drivers' pockets across every driver — the number that must reach zero. */
  cashOwed: number
  unsettledCount: number
  /** Delivery orders from before this tracking existed, so they are not silently lost. */
  untrackedCount: number
}

// ===== Delivery customers =====

/**
 * A delivery client, derived from their orders rather than stored separately — so
 * the book can never disagree with what was actually sold. Identified by phone.
 */
export interface Customer {
  phone: string
  name: string | null
  address: string | null
  delivery_area_id: number | null
  area_name: string | null
  order_count: number
  total_spent: number
  average_order: number
  first_order_at: string
  last_order_at: string
}

export interface CustomerOrder {
  order_id: number
  invoice_number: string | null
  created_at: string
  total_amount: number
  payment_type: PaymentType
  status: OrderStatus
  customer_address: string | null
  area_name: string | null
  item_count: number
  items_summary: string | null
}

// ===== Workers =====

/** A daily worker — kitchen or cleaning help, paid per day, never logs in. */
export interface Worker {
  worker_id: number
  full_name: string
  role_title: string | null
  /** Pay for one day worked. Salary = days present × this. */
  daily_wage: number
  /** The shift they normally work. Only a default — the day worked is what counts. */
  default_shift: 1 | 2 | null
  is_active: number
  linked_user_id: number | null
  linked_username?: string

  // ---- The running account, computed by listWorkers() ----
  /** Every day he has been marked present, ever. */
  daysWorked?: number
  /** daysWorked × daily_wage — what he has earned in total. */
  earned?: number
  /** Every salary payment recorded against him. */
  paid?: number
  /**
   * earned − paid. Positive means the restaurant owes HIM; negative means he has
   * been paid ahead of the days he has worked, i.e. he owes the restaurant.
   */
  balance?: number
  lastPaidOn?: string | null
}

// ===== Worker Attendance =====

export interface WorkerAttendance {
  attendance_id: number
  worker_id: number
  work_date: string
  /** The shift actually worked that day — may differ from the worker's usual one. */
  shift_number: 1 | 2 | null
  created_by: number
  created_at: string
}

// ===== Expenses =====

export interface Expense {
  expense_id: number
  category: ExpenseCategory
  description: string | null
  amount: number
  recorded_by: number
  recorded_by_name?: string
  expense_date: string
  created_at: string
}

// ===== Salaries =====

export interface Salary {
  salary_id: number
  worker_id: number
  worker_name?: string
  amount: number
  pay_period_start: string
  pay_period_end: string
  paid_on: string | null
  created_by: number
  created_at: string
  // Joined / computed by salaryService
  daily_wage?: number
  /** The day the money counts: paid_on, or the period end when not yet paid. */
  effective_date?: string
  /** Attendance days inside the period — what the amount should be based on. */
  days_in_period?: number
}

// ===== Shifts =====

/**
 * A recorded work session. Opened when a user signs in, closed when they sign out
 * or the app shuts down — never entered by hand, so the hours are what was worked.
 */
export interface Shift {
  shift_id: number
  cashier_id: number
  cashier_name?: string
  cashier_slot?: UserSlot | null
  shift_date: string
  shift_number: 1 | 2
  /** Plain HH:MM, for display. */
  start_time: string | null
  end_time: string | null
  /** Full timestamps — the hours are computed from these. */
  started_at: string | null
  ended_at: string | null
  set_by: number
  created_at: string
  // Computed by listShifts()
  /** Hours worked; measured up to now while the session is still open. */
  hours_worked?: number
  /** 1 while the user is still signed in. */
  is_open?: number
}

// ===== Finance (accountant reporting) =====

/** One line of money leaving the business. */
export interface LedgerEntry {
  date: string
  kind: 'expense' | 'salary'
  label: string
  category: string
  amount: number
  by: string
}

/**
 * A full profit-and-loss for a date range, plus the itemised money-out ledger.
 * Everything the accountant screen shows, and everything the PDF/Excel exports
 * print, comes from this one object so the three can never disagree.
 */
/** How much of the shop a data file holds — or the open database would export. */
export interface ShopDataCounts {
  categories: number
  menuItems: number
  rawMaterials: number
  recipeLines: number
  customers: number
  deliveryAreas: number
  printers: number
  settings: number
}

/** Where an export of the shop's data was written. */
export interface ShopDataExport {
  folder: string
  /** The complete file — what «استيراد» reads back. */
  jsonPath: string
  /** The same data as a workbook, for a person to read. */
  excelPath: string
  counts: ShopDataCounts
}

/** One of the shop's shifts — a trading period that was actually opened and closed. */
export interface WorkShift {
  workShiftId: number
  shiftNumber: 1 | 2
  name: string
  /** The day it started on. */
  date: string
  /** `YYYY-MM-DD HH:MM` — when it began, and when it ended (or is due to). */
  openedAt: string
  endsAt: string
  isOpen: boolean
  /** Started by the owner before its time, rather than by the clock. */
  manual: boolean
  /** `YYYY-MM-DD HH:MM:SS` — everything recorded in [from, to) belongs to this shift. */
  from: string
  to: string
}

export interface WorkShiftStatus {
  /** The shift running now, or null when the shop is between shifts. */
  open: WorkShift | null
  /** With none open: the one that ended last. */
  last: WorkShift | null
  /** With none open: when the next one starts by itself. */
  next: { shiftNumber: number; name: string; startsAt: string } | null
}

/** The configured shift a report was narrowed to, with when it began and ended. */
export interface ReportShift {
  number: 1 | 2
  name: string
  /** The day the shift STARTED on. */
  date: string
  /** `YYYY-MM-DD HH:MM` — when it began, and when it ends as configured. */
  startedAt: string
  endsAt: string
  /** True while it has not reached its configured end — figures are up to now. */
  isOpen: boolean
}

export interface FinanceReport {
  period: { start: string; end: string }
  /** Set when the report covers one shift rather than whole days. */
  shift?: ReportShift

  // Money in
  revenue: number
  subtotal: number
  tax: number
  discount: number
  deliveryFees: number
  orderCount: number
  averageOrder: number

  /** Sales less the VAT inside them — VAT is collected for the tax authority, not earned. */
  netSales: number

  // Cost of goods actually sold
  cogs: number
  /** netSales − cogs. */
  grossProfit: number
  grossMarginPct: number

  // Money out
  /** Every expense recorded — what was paid out. */
  expensesTotal: number
  /** The part of it that bought ingredients: paid out, but in the profit through `cogs`. */
  ingredientPurchases: number
  /** expensesTotal − ingredientPurchases — what counts against the profit. */
  operatingExpenses: number
  salariesTotal: number
  /** expensesTotal + salariesTotal — everything paid out. */
  totalSpent: number

  /** grossProfit − operatingExpenses − salaries − waste. */
  netProfit: number
  netMarginPct: number

  /** For one shift only: what should be in the drawer, and how it is arrived at. */
  drawer?: {
    cashSales: number
    driverCashOut: number
    driverCashPending: number
    settlementsReceived: number
    supplierCashTotal: number
    expectedCash: number
  }

  voidedCount: number
  voidedValue: number

  /** Informational — outside the profit maths: what was sold is already in `cogs`. */
  stockPurchaseValue: number
  /** Buying and paying suppliers. Sits BESIDE the P&L, never inside it. */
  suppliers?: SupplierTotals
  /** Stock written off. Deducted from the profit: bought, never sold, so in no invoice's cost. */
  wasteValue: number

  byOrderType: { type: string; label: string; orders: number; revenue: number }[]
  byPayment: { type: string; label: string; orders: number; revenue: number }[]
  expensesByCategory: { category: string; label: string; count: number; total: number }[]

  daily: {
    date: string
    revenue: number
    cogs: number
    expenses: number
    salaries: number
    profit: number
  }[]

  topItemsByProfit: {
    name: string
    units: number
    revenue: number
    cost: number
    profit: number
    marginPct: number
  }[]

  /** EVERY item sold in the period, by quantity — the stock-taking list. */
  itemsSold: {
    name: string
    category: string
    units: number
    revenue: number
    cost: number
    profit: number
  }[]

  /**
   * What those sales consumed off the shelf: bread, cola, pieces of chicken, rice,
   * packaging. A meal is one line on an invoice but many things out of the store, and
   * the store is what gets re-ordered. Only items that have a recipe appear here.
   */
  materialsUsed: {
    name: string
    unit: string
    quantity: number
    cost: number
  }[]

  expenses: {
    date: string
    category: string
    description: string
    amount: number
    recordedBy: string
  }[]

  salaries: {
    workerName: string
    periodStart: string
    periodEnd: string
    paidOn: string | null
    amount: number
  }[]

  ledger: LedgerEntry[]
}

// ===== Shift close-out report =====

/**
 * Everything that happened during one work session: what was sold, what was taken
 * in cash, what was spent, what stock moved. The close-out sheet a cashier hands
 * over at the end of a shift.
 */
export interface ShiftReport {
  shiftId: number
  cashierId: number
  cashierName: string
  cashierSlot: UserSlot | null
  username: string
  shiftDate: string
  shiftNumber: 1 | 2
  startedAt: string | null
  endedAt: string | null
  startTime: string | null
  endTime: string | null
  /** True while the cashier is still signed in — figures are up to now. */
  isOpen: boolean
  hoursWorked: number

  orderCount: number
  revenue: number
  subtotal: number
  tax: number
  discount: number
  deliveryFees: number
  averageOrder: number
  /** Sales less the VAT inside them — VAT is collected for the tax authority, not earned. */
  netSales: number
  cogs: number
  /** netSales − cogs. */
  grossProfit: number
  /** Expenses other than ingredient purchases, which reach the profit through `cogs`. */
  operatingExpenses: number
  ingredientPurchases: number
  wasteValue: number
  /** grossProfit − operatingExpenses − salaries − waste. */
  netProfit: number

  cashSales: number
  cardSales: number
  cashOrders: number
  cardOrders: number
  /** Cash from this period's delivery orders that left with a driver, and what is still out. */
  driverCashOut: number
  driverCashPending: number
  /** What drivers paid in during the period. */
  settlementsReceived: number
  /** Cash in the drawer: till sales + driver settlements − everything paid out. */
  expectedCash: number

  voidedCount: number
  voidedValue: number

  byOrderType: { type: string; label: string; orders: number; total: number }[]

  invoices: {
    orderId: number
    invoiceNumber: string | null
    time: string
    createdAt: string
    orderType: string
    orderTypeLabel: string
    paymentType: string
    itemCount: number
    subtotal: number
    tax: number
    discount: number
    deliveryFee: number
    total: number
    status: string
    customerName: string | null
  }[]

  items: { name: string; units: number; revenue: number }[]

  expenses: { time: string; category: string; description: string; amount: number }[]
  expensesTotal: number

  /** Wages paid out during the shift. */
  salaries: { time: string; workerName: string; amount: number }[]
  salariesTotal: number
  /** Suppliers paid during the shift; only the cash ones come off the drawer. */
  supplierPayments: { time: string; supplierName: string; method: string; amount: number }[]
  supplierPaymentsTotal: number
  supplierCashTotal: number
  /** Set when this is the whole shop's shift rather than one cashier's session. */
  workShiftId?: number
  /** The shift's own name where it has one — «إضافية» for a shift started by hand. */
  shiftName?: string

  stockMoves: { name: string; unit: string; reason: string; change: number }[]
}

/**
 * The till's close-out («تقفيل الوردية») for one configured shift.
 *
 * Unlike ShiftReport, which follows one person's sign-in, this follows the SHIFT the
 * owner set in the settings: every invoice rung up and every pound paid out between
 * this shift's start and the next shift's start, whoever was at the till.
 */
export interface ClosingReport {
  shiftNumber: 1 | 2
  shiftName: string
  /** The day the shift STARTED on — a night shift keeps its date past midnight. */
  shiftDate: string
  /** `YYYY-MM-DD HH:MM:SS` — what the figures cover. */
  from: string
  to: string
  /** The hours as configured, `HH:MM`. */
  startTime: string
  endTime: string
  /** `YYYY-MM-DD HH:MM:SS` — when it ended (or is due to): a night shift ends the next day. */
  endsAt: string
  /** True while the shift has not reached its configured end — figures are up to now. */
  isOpen: boolean

  orderCount: number
  revenue: number
  subtotal: number
  tax: number
  discount: number
  deliveryFees: number
  cashSales: number
  cardSales: number
  cashOrders: number
  cardOrders: number
  voidedCount: number
  voidedValue: number

  byOrderType: { type: string; label: string; orders: number; total: number }[]
  byCashier: { name: string; orders: number; total: number }[]

  invoices: {
    orderId: number
    invoiceNumber: string | null
    time: string
    orderTypeLabel: string
    paymentType: string
    total: number
    status: string
    cashierName: string
  }[]

  expenses: { time: string; category: string; description: string; amount: number; recordedBy: string }[]
  expensesTotal: number
  supplierPayments: { time: string; supplierName: string; method: string; amount: number }[]
  supplierPaymentsTotal: number
  /** The part of the supplier payments that left the drawer as cash. */
  supplierCashTotal: number
  salaries: { time: string; workerName: string; amount: number }[]
  salariesTotal: number

  /** Expenses + supplier payments + salaries — everything paid out. */
  outgoingsTotal: number
  /** Cash from this shift's delivery orders that left with a driver, and what is still out. */
  driverCashOut: number
  driverCashPending: number
  /** What drivers paid in during the shift. */
  settlementsReceived: number
  /** Cash in the drawer: till sales + driver settlements − everything paid out in cash. */
  expectedCash: number
}

// ===== Analytics =====

export interface SummaryCard {
  label: string
  value: number
  previousValue: number
  orderCount?: number
}

export interface TrendPoint {
  date: string
  revenue: number
  orderCount: number
}

export interface TopItem {
  name: string
  unitsSold: number
  revenue: number
}

export interface MenuEngineeringItem {
  name: string
  unitsSold: number
  avgMargin: number
  /** null for zero-priced items — margin percentage is undefined against a price of 0. */
  marginPct: number
  /** 'unclassified' when marginPct is null, so giveaways are not scored as 0% margin. */
  quadrant: 'star' | 'plowhorse' | 'puzzle' | 'dog' | 'unclassified'
}

export interface PeakHourCell {
  dayOfWeek: number
  hourOfDay: number
  orderCount: number
  revenue: number
}

export interface CategoryBreakdown {
  name: string
  revenue: number
}

// ===== Deleting things other records depend on =====

export type DeletableKind = 'category' | 'menuItem' | 'rawMaterial'

/** What deleting something would affect — shown before anything is touched. */
export interface DeleteImpact {
  kind: DeletableKind
  id: number
  name: string
  /** True when nothing in the books refers to it, so it can be erased cleanly. */
  canHardDelete: boolean
  /** History that prevents a clean delete (past invoices, stock movements). */
  blockers: string[]
  /** Things that would be removed along with it. */
  cascades: string[]
  recommendation: 'delete' | 'deactivate'
  /** Categories have no active flag, so hiding them is not an option. */
  supportsDeactivate: boolean
}

export interface DeleteResult {
  action: 'deleted' | 'deactivated'
  name: string
  message: string
}

/** One line of stock handed back when an invoice is voided or deleted. */
export interface ReturnedStockLine {
  name: string
  unit: string
  quantity: number
}

// ===== Loading the costed menu from «ملخص الريسبى» =====

/** What one press of "استيراد القائمة" actually did. */
export interface MenuImportResult {
  categoriesCreated: number
  itemsCreated: number
  itemsUpdated: number
  /** Already present and left exactly as they were. */
  itemsUnchanged: number
  /** Priced in the sheet but never costed — the add-ons. Still need a cost. */
  itemsWithoutCost: number
  categories: { name: string; created: number; updated: number; unchanged: number }[]
}

/**
 * «Sales Products» — how many of everything was sold in a period, by section, and
 * what that took out of the store. The counting report, not the profit one.
 */
export interface SalesProductsReport {
  period: { start: string; end: string }
  storeName: string
  currency: string
  orderCount: number
  totalQuantity: number
  grandTotal: number
  groups: {
    category: string
    quantity: number
    total: number
    items: { name: string; quantity: number; unit: string; total: number; cost: number }[]
  }[]
  /** The re-ordering list: what the sales above consumed off the shelf. */
  materials: { name: string; unit: string; quantity: number; cost: number }[]
}

/**
 * «التكلفة المبدئية مقابل الفعلية» — what the sheet costed each dish at, against what
 * its ingredients cost today. The gap is whether a dish still earns what it was
 * priced to earn.
 */
export interface CostingReport {
  currency: string
  totalItems: number
  /** How many dishes have a fully priced recipe, so can actually be compared. */
  comparedItems: number
  notCostedItems: number
  overPlanCount: number
  averageDriftPct: number
  items: {
    itemId: number
    name: string
    category: string
    isActive: boolean
    price: number
    /** From «ملخص الريسبى». Fixed — the plan the shelf price was set against. */
    baselineCost: number
    /** Today's ingredient cost. `null` when the recipe is missing or unpriced. */
    actualCost: number | null
    plannedProfit: number | null
    actualProfit: number | null
    /** Positive means it costs MORE than the sheet said. */
    drift: number | null
    driftPct: number | null
    recipeLines: number
    pricedLines: number
  }[]
}

/** What loading the recipes from «ملخص الريسبى» did. */
export interface RecipeImportResult {
  materialsCreated: number
  /** Already in the store under the same name, so reused rather than duplicated. */
  materialsReused: number
  itemsLinked: number
  /** In the recipe sheet but not on the menu — import the menu first. */
  itemsSkipped: number
  /** Left exactly as they were, because somebody had already described them. */
  itemsAlreadyHadRecipe: number
  /**
   * Materials still priced at 0. The sheet costs dishes, not ingredients, so these
   * need the owner's supplier prices before the recipe drives the profit figures.
   */
  materialsWithoutCost: number
  missingItems: string[]
}

// ===== The shift close-out, exported for the group =====

/** The files one shift close produced, and where they were written. */
export interface ShiftExport {
  /** True when shiftId is the shop's shift (work_shifts) rather than a cashier's session. */
  work?: boolean
  shiftId: number
  shiftDate: string
  shiftNumber: number
  shiftName: string
  cashierName: string
  /** Folder both files were written into. */
  folder: string
  pdfPath: string
  excelPath: string
  /** The takings summary, ready to paste into the group chat. */
  summaryText: string
  revenue: number
  orderCount: number
  expectedCash: number
}

// ===== Backups & invoice numbering =====

export interface BackupFile {
  fileName: string
  filePath: string
  sizeBytes: number
  createdAt: string
  /** A safety copy taken automatically just before a restore. */
  isPreRestore: boolean
}

export interface InvoiceCounter {
  orderType: OrderType
  label: string
  prefix: string
  /** The number the next invoice of this type will carry. */
  nextNumber: number
  /** The highest number issued TODAY — numbering restarts each day, so a number on
   *  its own repeats; it is the date that tells two invoices apart. */
  highestIssued: number
  /** The number this type goes back to at the start of every day. */
  startNumber: number
}

// ===== Settings =====

export interface AppSettings {
  tax_rate: number
  currency_symbol: string
  business_name: string
  business_address: string
  business_phone: string
  receipt_footer: string
  max_cashier_discount: number
  backup_folder: string
  /** 1 or 2. Two means the day is split; one means a single window covers it all. */
  shifts_per_day: 1 | 2
  shift1_name: string
  shift1_start: string
  shift1_end: string
  shift2_name: string
  shift2_start: string
  shift2_end: string
  /** Print the tickets the moment an order is confirmed, without asking. */
  print_auto: number
  /** Put the app logo at the top of the receipt. */
  print_logo: number
  /** Extra blank lines under the footer, for printers whose blade sits high. */
  print_feed_lines: number
  /** Ticket text size as a percentage of the default. 70–200. */
  print_font_scale: number

  // ===== Two-till networking =====
  /** 'standalone' | 'master' | 'node'. See net/protocol.ts. */
  net_mode: string
  /** Port every till listens on. The master dials it; the node accepts on it. */
  net_port: number
  /** Shared secret every till in this shop holds. */
  net_token: string
  /** Which shop this till belongs to — set at enrolment, checked on every link. */
  net_fleet_id: string
  /** node only — the name of the master that adopted it, for the screen to show. */
  net_master_name: string
  /** node only — 1 while the master has this till locked. Survives a restart. */
  net_locked: number
  net_lock_reason: string
  /** master only — the enrolled tills, as a JSON array of EnrolledTill. */
  net_tills: string
  /** Hour of the night the daily backup runs. 0–23. */
  backup_hour: number
  /** `YYYY-MM-DD` of the last successful daily backup. */
  backup_last_daily: string

  // ===== The end-of-shift report =====
  /** Write the close-out PDF and workbook automatically when a shift closes. */
  shift_export_auto: number
  /** Where they are written. Empty means `<data folder>/تقارير الورديات`. */
  shift_export_folder: string
  /** The restaurant's group: a chat.whatsapp.com invite link, a number, or empty. */
  whatsapp_group: string
}

/** One till as the master's control panel sees it. */
export interface TillRow {
  id: string
  machineName: string
  host: string
  port: number
  addedAt: number
  locked: boolean
  lockReason: string
  /** What the link is doing right now. */
  state: 'connected' | 'connecting' | 'unreachable' | 'relocating'
  /** Why it is not connected, in words fit to put on a screen. */
  lastError: string
  lastErrorAt: number
  lastSeen: number
  /** Who is signed in at that till, as the master sees it. */
  signedInAs: string | null
  appVersion: string
  connectedSince: number | null
}

/** What the settings screen shows about this machine's place on the network. */
export interface NetworkStatus {
  mode: string
  /** Whether this machine's presence server is listening at all. */
  running: boolean
  port: number
  /** This machine's LAN addresses. */
  addresses: string[]
  machineName: string
  appVersion: string

  // ----- master only -----
  /** Every till on the books, connected or not. */
  tills?: TillRow[]
  connectedNodes?: number

  // ----- node only -----
  /** Whether the master currently has a link open to this till. */
  linked?: boolean
  masterName?: string
  masterAddress?: string
  /** Why there is no link, when there is none. */
  reason?: string
  locked?: boolean
  lockReason?: string
  /** When the read-only copy of the master's books was last refreshed. */
  mirror?: { at: number; bytes: number } | null
  /**
   * Milliseconds to add to this machine's clock to get the master's.
   *
   * A node follows the master's clock for everything it displays, so both tills agree
   * on what "today" is, which shift a sale falls in, and how long an order has been
   * out with a driver.
   */
  masterTimeOffsetMs?: number
}

// ===== Printers =====

/**
 * How the app reaches a printer.
 *
 *  - `windows_raw`   the printer is installed in Windows (the XPrinter driver from
 *                    the DVD) and we push ESC/POS bytes straight through the spooler.
 *                    This is the one to use for the USB printers: it keeps the cut
 *                    and the cash-drawer kick under the app's control.
 *  - `windows_driver` same installed printer, but the receipt goes through the
 *                    driver as a normal page. Slower, and cut/drawer are whatever the
 *                    driver is configured to do — kept as the fallback for a machine
 *                    where raw spooling is blocked.
 *  - `network`       the printer has its own IP address; ESC/POS over TCP, no driver
 *                    involved at all.
 */
export type PrinterConnection = 'windows_raw' | 'windows_driver' | 'network'

/**
 * What a printer is for. Decides which ticket it gets, and whether it gets one.
 *
 *   receipt   the customer's priced invoice — the till
 *   counter   the handover ticket for whoever assembles and bags the order
 *   kitchen   the cook's prep ticket, usually filtered to the hot-food categories
 *   bar       the same, for drinks, so it can be switched off on its own
 *   delivery  a second copy of the invoice for the rider, delivery orders only
 *
 * counter, kitchen and bar all print the same priceless ticket: money on a prep
 * ticket is only something to mis-read. They are separate roles so each can be
 * pointed at its own printer and given its own categories.
 */
export type PrinterRole = 'receipt' | 'counter' | 'kitchen' | 'bar' | 'delivery'

export interface Printer {
  printer_id: number
  name: string
  role: PrinterRole
  connection: PrinterConnection
  /** Windows spooler name — `windows_raw` / `windows_driver` only. */
  device_name: string | null
  /** IP or hostname — `network` only. */
  host: string | null
  port: number
  /** Paper width in millimetres: 58 or 80. */
  paper_width: number
  copies: number
  cut_paper: number
  open_drawer: number
  /** Sound the buzzer after the ticket is cut. */
  beep: number
  /**
   * JSON array of category ids this printer is responsible for. Empty or null means
   * everything — which is what a single kitchen printer wants. Only consulted for
   * kitchen/bar tickets; a receipt is never split by category.
   */
  category_ids: string | null
  /**
   * Which machine this printer is physically attached to, once two tills share one
   * database. 'any' is a network printer with its own IP — either till can reach it.
   * 'master' / 'node' are USB printers, which only the machine they are plugged into
   * can drive, so the master hands those jobs to that machine to run.
   */
  station: PrinterStation
  auto_print: number
  is_active: number
  display_order: number
  created_at: string
}

export type PrinterStation = 'any' | 'master' | 'node'

/** What the settings screen sends when adding or editing a printer. */
export interface PrinterInput {
  printerId?: number
  name: string
  role: PrinterRole
  connection: PrinterConnection
  deviceName?: string | null
  host?: string | null
  port?: number
  paperWidth?: number
  copies?: number
  cutPaper?: boolean
  openDrawer?: boolean
  beep?: boolean
  categoryIds?: number[]
  station?: PrinterStation
  autoPrint?: boolean
  isActive?: boolean
  displayOrder?: number
}

/** A printer Windows already knows about, offered as a pick-list when adding one. */
export interface SystemPrinter {
  name: string
  displayName: string
  description: string
  status: number
  isDefault: boolean
}

/** The outcome of one ticket on one printer. */
export interface PrintJobResult {
  printerId: number
  printerName: string
  role: PrinterRole
  ok: boolean
  /** Set when ok is false — already in Arabic, ready to show. */
  error?: string
  /** True when there was nothing for this printer to print (no matching items). */
  skipped?: boolean
}

// ===== Suppliers (الموردون) =====

export interface Supplier {
  supplier_id: number
  name: string
  phone: string | null
  notes: string | null
  is_active: number
  created_at: string
}

export interface SupplierInput {
  supplierId?: number
  name: string
  phone?: string
  notes?: string
  isActive?: boolean
}

export interface SupplierInvoiceItem {
  supplier_invoice_item_id: number
  supplier_invoice_id: number
  raw_material_id: number
  quantity: number
  unit_cost: number
  line_total: number
  // Joined
  material_name?: string
  material_unit?: string
}

export interface SupplierInvoice {
  supplier_invoice_id: number
  supplier_id: number
  invoice_date: string
  reference: string | null
  total_amount: number
  notes: string | null
  created_by: number
  created_at: string
  items?: SupplierInvoiceItem[]
  // Joined
  supplier_name?: string
  created_by_name?: string
}

/**
 * One delivery being recorded. Every line names a raw material that already exists —
 * goods with no name are refused, and stock could not be added to them anyway.
 */
export interface SupplierDeliveryInput {
  supplierId: number
  invoiceDate?: string
  reference?: string
  notes?: string
  lines: { rawMaterialId: number; quantity: number; unitCost: number }[]
}

export type SupplierPaymentMethod = 'cash' | 'card' | 'transfer'

export interface SupplierPayment {
  supplier_payment_id: number
  supplier_id: number
  amount: number
  paid_on: string
  method: SupplierPaymentMethod
  notes: string | null
  created_by: number
  created_at: string
  created_by_name?: string
}

export interface SupplierPaymentInput {
  supplierId: number
  amount: number
  paidOn?: string
  method?: SupplierPaymentMethod
  notes?: string
}

/** One line of the suppliers list: supplied, paid, and what is still owed. */
export interface SupplierSummary {
  supplierId: number
  name: string
  phone: string | null
  isActive: number
  supplied: number
  paid: number
  /** supplied − paid. Negative means the restaurant has paid ahead. */
  owed: number
  deliveries: number
  lastDelivery: string | null
}

export interface SupplierAccount {
  supplier: Supplier
  invoices: SupplierInvoice[]
  payments: SupplierPayment[]
  supplied: number
  paid: number
  owed: number
}

/** The supplier block of the finance report. Deliberately outside the P&L — see below. */
export interface SupplierTotals {
  purchasedInRange: number
  deliveriesInRange: number
  paidInRange: number
  paymentsInRange: number
  /** Across ALL time, not just the range — what is owed today. */
  totalOwed: number
  bySupplier: SupplierSummary[]
}

// ===== IPC Response Wrapper =====

export interface IpcResponse<T = unknown> {
  success: boolean
  data?: T
  error?: string
  /**
   * Why it failed, when the failure came from the link between two tills rather than
   * from the handler.
   *
   * `error` is the sentence to show someone; this is what the interface branches on.
   * It exists because "the master is switched off", "you are not allowed to do this
   * offline" and "the master locked this till" need three different screens, and
   * matching on the text of a message to tell them apart is how a translation change
   * silently breaks the interface.
   *
   * See LinkErrorCode in net/protocol.ts.
   */
  code?: string
}

// ===== Receipt =====

export interface ReceiptData {
  orderId: number
  businessName: string
  businessAddress: string
  businessPhone: string
  cashierName: string
  items: { name: string; qty: number; unitPrice: number; total: number; variantLabel?: string }[]
  subtotal: number
  tax: number
  discount: number
  deliveryFee: number
  total: number
  paymentType: PaymentType
  orderType: OrderType
  customerName?: string
  customerPhone?: string
  customerAddress?: string
  date: string
  receiptFooter: string
}
