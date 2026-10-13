import { create } from 'zustand'
import type {
  SessionUser, MenuItem, OrderLine, AppSettings, OrderType, VariantOption,
} from '../../shared/types'

export type { OrderType }

// ===== Auth Store =====
interface AuthState {
  user: SessionUser | null
  setUser: (user: SessionUser | null) => void
  isOwner: () => boolean
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  setUser: (user) => set({ user }),
  isOwner: () => get().user?.role === 'owner',
}))

// ===== Cart Store =====

export interface CartItem extends OrderLine {
  /**
   * Identifies a cart ROW, not a menu item. The same item ordered عادي and حار is two
   * rows, and every mutation must address exactly one of them — keying edits by
   * menuItemId alone made "+" on one row silently bump the other.
   */
  lineId: string
  name: string
  notes?: string
}

/**
 * One row per (item, exact set of chosen options).
 *
 * Keyed on the option IDS, not the label: two different options could be named the
 * same ("كبير" of a size group and "كبير" of a portion group), and keying on text
 * would merge them into one row priced as whichever was added first. Sorted so the
 * order the cashier happened to tap the options in cannot split one row into two.
 */
function makeLineId(menuItemId: number, optionIds: number[] = []): string {
  return `${menuItemId}::${[...optionIds].sort((a, b) => a - b).join('-')}`
}

interface CartState {
  items: CartItem[]
  paymentType: 'cash' | 'card'
  /**
   * The discount is held as a PERCENTAGE, never as a frozen amount. Storing the
   * amount meant that adding an item after picking "10%" left the old cash figure
   * in place while the screen still said 10%.
   */
  discountPercent: number
  orderType: OrderType
  tenderedAmount: number
  customerName: string
  customerPhone: string
  customerAddress: string
  deliveryAreaId: number | null
  driverId: number | null
  deliveryFee: number
  /** Free text for the kitchen or the counter — printed only when it has content. */
  orderNote: string
  /**
   * `options` is the one option chosen from each of the item's variant groups —
   * empty for an item that asks nothing, like a bottle of water. The price shown is
   * base + the deltas; the main process recomputes it from the same option ids
   * before anything is charged.
   */
  addItem: (item: MenuItem, options?: VariantOption[]) => void
  removeItem: (lineId: string) => void
  updateQuantity: (lineId: string, quantity: number) => void
  setPaymentType: (type: 'cash' | 'card') => void
  setDiscountPercent: (percent: number) => void
  setOrderType: (type: OrderType) => void
  setTenderedAmount: (amount: number) => void
  setCustomerName: (name: string) => void
  setCustomerPhone: (phone: string) => void
  setCustomerAddress: (address: string) => void
  setDeliveryAreaId: (id: number | null) => void
  setDriverId: (id: number | null) => void
  setDeliveryFee: (fee: number) => void
  setOrderNote: (note: string) => void
  clear: () => void
  getSubtotal: () => number
  /** Total units of a menu item across all its variant rows. */
  getItemQuantity: (menuItemId: number) => number
  /** Always derived from the CURRENT subtotal, so it can never go stale. */
  getDiscount: () => number
  getTax: (taxRate: number) => number
  getTotal: (taxRate: number) => number
  getChange: (taxRate: number) => number
}

export const useCartStore = create<CartState>((set, get) => ({
  items: [],
  paymentType: 'cash',
  discountPercent: 0,
  orderType: 'dine_in',
  tenderedAmount: 0,
  customerName: '',
  customerPhone: '',
  customerAddress: '',
  deliveryAreaId: null,
  driverId: null,
  deliveryFee: 0,
  orderNote: '',

  addItem: (item: MenuItem, options: VariantOption[] = []) => {
    const optionIds = options.map(o => o.variant_option_id)
    const lineId = makeLineId(item.item_id, optionIds)

    // Never below zero, matching what the main process will charge.
    const unitPrice = Math.max(
      0,
      item.price + options.reduce((sum, o) => sum + (Number(o.price_delta) || 0), 0),
    )
    const variantLabel = options.map(o => o.option_name).join(' · ') || undefined

    set((state) => {
      if (state.items.some((i) => i.lineId === lineId)) {
        return {
          items: state.items.map((i) =>
            i.lineId === lineId ? { ...i, quantity: i.quantity + 1 } : i
          ),
        }
      }
      return {
        items: [
          ...state.items,
          {
            lineId,
            menuItemId: item.item_id,
            quantity: 1,
            unitPrice,
            itemName: item.name,
            name: item.name,
            variantLabel,
            variantOptionIds: optionIds.length > 0 ? optionIds : undefined,
          },
        ],
      }
    })
  },

  removeItem: (lineId: string) => {
    set((state) => ({
      items: state.items.filter((i) => i.lineId !== lineId),
    }))
  },

  updateQuantity: (lineId: string, quantity: number) => {
    if (quantity <= 0) {
      get().removeItem(lineId)
      return
    }
    set((state) => ({
      items: state.items.map((i) =>
        i.lineId === lineId ? { ...i, quantity } : i
      ),
    }))
  },

  setPaymentType: (type) => set({ paymentType: type }),
  setDiscountPercent: (percent) =>
    set({ discountPercent: Math.max(0, Math.min(100, Number(percent) || 0)) }),
  setOrderType: (orderType) => set({ orderType }),
  setTenderedAmount: (tenderedAmount) => set({ tenderedAmount }),
  setCustomerName: (customerName) => set({ customerName }),
  setCustomerPhone: (customerPhone) => set({ customerPhone }),
  setCustomerAddress: (customerAddress) => set({ customerAddress }),
  setDeliveryAreaId: (deliveryAreaId) => set({ deliveryAreaId }),
  setDriverId: (driverId) => set({ driverId }),
  setDeliveryFee: (deliveryFee) => set({ deliveryFee }),
  setOrderNote: (orderNote) => set({ orderNote }),
  clear: () => set({
    items: [], discountPercent: 0, paymentType: 'cash', tenderedAmount: 0,
    customerName: '', customerPhone: '', customerAddress: '',
    orderType: 'dine_in', deliveryAreaId: null, driverId: null, deliveryFee: 0,
    orderNote: '',
  }),

  getSubtotal: () => get().items.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0),

  getItemQuantity: (menuItemId: number) =>
    get().items.reduce((sum, i) => (i.menuItemId === menuItemId ? sum + i.quantity : sum), 0),

  getDiscount: () => {
    const subtotal = get().getSubtotal()
    return (subtotal * get().discountPercent) / 100
  },

  getTax: (taxRate: number) => {
    // VAT applies to dine-in orders only — takeaway and delivery are tax-free.
    if (get().orderType !== 'dine_in') return 0
    // …and on what the customer actually pays for the food, so a discount lowers the
    // taxable amount with it. This has to match orderService.createOrder exactly: the
    // main process recomputes every figure before writing, so taxing the undiscounted
    // subtotal here quoted the customer a higher total than the receipt then printed.
    const taxable = Math.max(0, get().getSubtotal() - get().getDiscount())
    return taxable * taxRate
  },
  getTotal: (taxRate: number) => {
    const subtotal = get().getSubtotal()
    const tax = get().getTax(taxRate)
    // These figures drive the on-screen preview only — the main process recomputes
    // all of them before anything is written to the database.
    return Math.max(0, subtotal + tax - get().getDiscount() + get().deliveryFee)
  },
  getChange: (taxRate: number) => {
    const total = get().getTotal(taxRate)
    const tendered = get().tenderedAmount
    return tendered > 0 ? Math.max(0, tendered - total) : 0
  },
}))

// ===== UI Store =====
interface UIState {
  sidebarCollapsed: boolean
  activeScreen: string
  lowStockAlerts: any[]
  toggleSidebar: () => void
  setActiveScreen: (screen: string) => void
  setLowStockAlerts: (alerts: any[]) => void
}

export const useUIStore = create<UIState>((set) => ({
  sidebarCollapsed: false,
  activeScreen: 'pos',
  lowStockAlerts: [],
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  setActiveScreen: (screen) => set({ activeScreen: screen }),
  setLowStockAlerts: (alerts) => set({ lowStockAlerts: alerts }),
}))

// ===== Settings Store =====
//
// ONE copy of the settings for the whole app. Screens used to each fetch their own
// on mount, so saving a new VAT rate, currency or shift time left every other screen
// showing the old value until it was remounted. The main process pushes
// 'app:settingsChanged' on every save (see settings.ipc.ts) and App.tsx feeds it
// straight into this store, so everything re-renders at once.

/** Used until the real settings load, and for any key the main process omits. */
export const SETTINGS_DEFAULTS: AppSettings = {
  tax_rate: 0.14,
  currency_symbol: 'ج.م',
  business_name: 'Crispo Fried Chicken',
  business_address: '',
  business_phone: '',
  receipt_footer: '',
  max_cashier_discount: 10,
  backup_folder: '',
  shifts_per_day: 2,
  shift1_name: 'صباحية',
  shift1_start: '09:00',
  shift1_end: '17:00',
  shift2_name: 'مسائية',
  shift2_start: '17:00',
  shift2_end: '01:00',
  print_auto: 1,
  print_logo: 1,
  print_feed_lines: 2,
  print_font_scale: 100,
  net_mode: 'standalone',
  net_port: 47615,
  net_token: '',
  net_fleet_id: '',
  net_master_name: '',
  net_locked: 0,
  net_lock_reason: '',
  net_tills: '[]',
  backup_hour: 3,
  backup_last_daily: '',
  shift_export_auto: 1,
  shift_export_folder: '',
  whatsapp_group: '',
}

interface SettingsState {
  settings: AppSettings
  loaded: boolean
  /** Fetch from the main process. Called on login and after a screen needs a refresh. */
  loadSettings: () => Promise<void>
  /** Merge in values pushed by the main process after an owner saves. */
  applySettings: (partial: Partial<AppSettings>) => void
}

export const useSettingsStore = create<SettingsState>((set) => ({
  settings: SETTINGS_DEFAULTS,
  loaded: false,
  loadSettings: async () => {
    const res = await window.api.getSettings()
    if (res.success && res.data) {
      // Before login the main process returns only the public keys, so merge onto the
      // defaults rather than replacing — a partial payload must not blank the rest.
      set((s) => ({ settings: { ...s.settings, ...res.data }, loaded: true }))
    }
  },
  applySettings: (partial) => set((s) => ({ settings: { ...s.settings, ...partial } })),
}))
