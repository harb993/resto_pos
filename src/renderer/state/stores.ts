import { create } from 'zustand'
import type { SessionUser, MenuItem, OrderLine, AppSettings } from '../../shared/types'

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
interface CartItem extends OrderLine {
  name: string
}

interface CartState {
  items: CartItem[]
  paymentType: 'cash' | 'card'
  discount: number
  addItem: (item: MenuItem) => void
  removeItem: (menuItemId: number) => void
  updateQuantity: (menuItemId: number, quantity: number) => void
  setPaymentType: (type: 'cash' | 'card') => void
  setDiscount: (discount: number) => void
  clear: () => void
  getSubtotal: () => number
  getTax: (taxRate: number) => number
  getTotal: (taxRate: number) => number
}

export const useCartStore = create<CartState>((set, get) => ({
  items: [],
  paymentType: 'cash',
  discount: 0,

  addItem: (item: MenuItem) => {
    set((state) => {
      const existing = state.items.find((i) => i.menuItemId === item.item_id)
      if (existing) {
        return {
          items: state.items.map((i) =>
            i.menuItemId === item.item_id
              ? { ...i, quantity: i.quantity + 1 }
              : i
          ),
        }
      }
      return {
        items: [
          ...state.items,
          {
            menuItemId: item.item_id,
            quantity: 1,
            unitPrice: item.price,
            itemName: item.name,
            name: item.name,
          },
        ],
      }
    })
  },

  removeItem: (menuItemId: number) => {
    set((state) => ({
      items: state.items.filter((i) => i.menuItemId !== menuItemId),
    }))
  },

  updateQuantity: (menuItemId: number, quantity: number) => {
    if (quantity <= 0) {
      get().removeItem(menuItemId)
      return
    }
    set((state) => ({
      items: state.items.map((i) =>
        i.menuItemId === menuItemId ? { ...i, quantity } : i
      ),
    }))
  },

  setPaymentType: (type) => set({ paymentType: type }),
  setDiscount: (discount) => set({ discount }),
  clear: () => set({ items: [], discount: 0, paymentType: 'cash' }),

  getSubtotal: () => get().items.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0),
  getTax: (taxRate: number) => {
    const subtotal = get().getSubtotal()
    return subtotal * taxRate
  },
  getTotal: (taxRate: number) => {
    const subtotal = get().getSubtotal()
    const tax = subtotal * taxRate
    return subtotal + tax - get().discount
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
