// ===== User & Auth =====

export type UserRole = 'cashier' | 'owner'
export type PaymentType = 'cash' | 'card'
export type OrderStatus = 'completed' | 'voided'
export type StockTxnReason = 'sale' | 'restock' | 'waste' | 'adjustment'

export interface User {
  user_id: number
  username: string
  pin_hash: string | null
  password_hash: string
  role: UserRole
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
  description: string | null
  image_path: string | null
  is_active: number
  stock_quantity: number
  created_at: string
  updated_at: string
}

export interface MenuItemInput {
  item_id?: number
  category_id: number
  name: string
  price: number
  cost_price: number
  description?: string
  image_path?: string
  is_active?: number
  stock_quantity?: number
}

// ===== Orders =====

export interface OrderLine {
  menuItemId: number
  quantity: number
  unitPrice: number
  itemName: string
}

export interface CreateOrderInput {
  cashierId: number
  items: OrderLine[]
  paymentType: PaymentType
  subtotal: number
  tax: number
  discount: number
  totalAmount: number
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
  created_at: string
  items?: OrderItem[]
}

export interface OrderItem {
  order_item_id: number
  order_id: number
  menu_item_id: number
  item_name?: string
  quantity: number
  unit_price: number
  unit_cost: number
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
  marginPct: number
  quadrant: 'star' | 'plowhorse' | 'puzzle' | 'dog'
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
}

// ===== IPC Response Wrapper =====

export interface IpcResponse<T = unknown> {
  success: boolean
  data?: T
  error?: string
}

// ===== Receipt =====

export interface ReceiptData {
  orderId: number
  businessName: string
  businessAddress: string
  businessPhone: string
  cashierName: string
  items: { name: string; qty: number; unitPrice: number; total: number }[]
  subtotal: number
  tax: number
  discount: number
  total: number
  paymentType: PaymentType
  date: string
  receiptFooter: string
}
