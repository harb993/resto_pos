import React, { useEffect } from 'react'
import { useAuthStore, useUIStore } from './state/stores'
import LoginScreen from './screens/LoginScreen'
import POSScreen from './screens/cashier/POSScreen'
import OrderHistoryScreen from './screens/cashier/OrderHistoryScreen'
import DashboardScreen from './screens/owner/DashboardScreen'
import MenuManagementScreen from './screens/owner/MenuManagementScreen'
import InventoryScreen from './screens/owner/InventoryScreen'
import AnalyticsScreen from './screens/owner/AnalyticsScreen'
import UsersScreen from './screens/owner/UsersScreen'
import SettingsScreen from './screens/owner/SettingsScreen'

function App() {
  const user = useAuthStore((s) => s.user)
  const setUser = useAuthStore((s) => s.setUser)
  const activeScreen = useUIStore((s) => s.activeScreen)
  const setActiveScreen = useUIStore((s) => s.setActiveScreen)
  const lowStockAlerts = useUIStore((s) => s.lowStockAlerts)
  const setLowStockAlerts = useUIStore((s) => s.setLowStockAlerts)

  // Listen for low-stock push events
  useEffect(() => {
    if (window.api?.onLowStockAlert) {
      const unsub = window.api.onLowStockAlert((data) => {
        setLowStockAlerts(data)
      })
      return unsub
    }
  }, [])

  // Not logged in → show login
  if (!user) return <LoginScreen />

  const isOwner = user.role === 'owner'

  const handleLogout = async () => {
    await window.api.logout()
    setUser(null)
    setActiveScreen('pos')
  }

  const navItems = [
    { id: 'pos', label: 'POS', icon: '🖥️', roles: ['cashier', 'owner'] },
    { id: 'orders', label: 'Orders', icon: '📋', roles: ['cashier', 'owner'] },
    { id: 'dashboard', label: 'Dashboard', icon: '📊', roles: ['owner'] },
    { id: 'menu', label: 'Menu', icon: '🍗', roles: ['owner'] },
    { id: 'inventory', label: 'Inventory', icon: '📦', roles: ['owner'] },
    { id: 'analytics', label: 'Analytics', icon: '📈', roles: ['owner'] },
    { id: 'users', label: 'Users', icon: '👥', roles: ['owner'] },
    { id: 'settings', label: 'Settings', icon: '⚙️', roles: ['owner'] },
  ]

  const screens: Record<string, React.ReactNode> = {
    pos: <POSScreen />,
    orders: <OrderHistoryScreen />,
    dashboard: <DashboardScreen />,
    menu: <MenuManagementScreen />,
    inventory: <InventoryScreen />,
    analytics: <AnalyticsScreen />,
    users: <UsersScreen />,
    settings: <SettingsScreen />,
  }

  return (
    <div className="app-layout">
      {/* Sidebar */}
      <aside className="sidebar">
        <div className="sidebar-header">
          <div className="sidebar-logo">R</div>
          <span className="sidebar-title">Resto POS</span>
        </div>

        <nav className="sidebar-nav">
          {navItems
            .filter((n) => n.roles.includes(user.role))
            .map((n) => (
              <button
                key={n.id}
                className={`nav-item ${activeScreen === n.id ? 'active' : ''}`}
                onClick={() => setActiveScreen(n.id)}
              >
                <span className="nav-icon">{n.icon}</span>
                <span>{n.label}</span>
                {n.id === 'inventory' && lowStockAlerts.length > 0 && (
                  <span className="badge badge-danger" style={{ marginLeft: 'auto', fontSize: 10 }}>
                    {lowStockAlerts.length}
                  </span>
                )}
              </button>
            ))}
        </nav>

        <div className="sidebar-footer">
          <div className="user-info">
            <div className="user-avatar">{user.fullName.charAt(0).toUpperCase()}</div>
            <div>
              <div className="user-name">{user.fullName}</div>
              <div className="user-role">{user.role}</div>
            </div>
          </div>
          <button className="btn btn-ghost btn-sm" style={{ width: '100%' }} onClick={handleLogout}>
            🚪 Log Out
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="main-content">
        {screens[activeScreen] || <POSScreen />}
      </main>
    </div>
  )
}

export default App
