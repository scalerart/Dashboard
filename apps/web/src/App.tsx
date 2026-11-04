import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { useQueryClient } from '@tanstack/react-query'
import {
  ArrowDownRight,
  Banknote,
  Bell,
  BriefcaseBusiness,
  ChartNoAxesCombined,
  CircleHelp,
  CreditCard,
  FileText,
  LayoutDashboard,
  LogOut,
  Menu,
  Moon,
  Package,
  Settings,
  ShoppingBag,
  Sun,
  Users,
  Wallet,
  X,
  ChevronDown,
} from 'lucide-react'
import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react'
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { api } from './lib/api'
import BrandMark from './BrandMark'
import { useThemeStore } from './stores/theme'
import type { User } from './types'
import './App.css'

const DashboardPage = lazy(() => import('./DashboardPage'))
const CustomersPage = lazy(() => import('./CustomersPage'))
const OperationsPage = lazy(() => import('./OperationsPage'))
const ReportsPage = lazy(() => import('./ReportsPage'))
const AccountsPage = lazy(() => import('./AccountsPage'))
const SettingsPage = lazy(() => import('./SettingsPage'))
const LazyLoginPage = lazy(() => import('./LoginPage'))
const currentYear = new Date().getFullYear()

const navItems = [
  { label: 'Dashboard', path: '/', icon: LayoutDashboard },
  { label: 'Customers', path: '/customers', icon: Users },
  { label: 'Orders & jobs', path: '/orders', icon: ShoppingBag, module: 'orders' as const },
  { label: 'Invoices', path: '/invoices', icon: FileText, module: 'invoices' as const },
  { label: 'Payments', path: '/payments', icon: CreditCard, module: 'payments' as const },
  { label: 'Expenses', path: '/expenses', icon: Wallet, module: 'expenses' as const },
  { label: 'Income', path: '/income', icon: ArrowDownRight, module: 'income' as const },
  { label: 'Inventory', path: '/inventory', icon: Package, module: 'inventory' as const },
  { label: 'Purchases', path: '/purchases', icon: ShoppingBag, module: 'purchases' as const },
  { label: 'Suppliers', path: '/suppliers', icon: BriefcaseBusiness, module: 'suppliers' as const },
  { label: 'Cash & bank', path: '/accounts', icon: Banknote },
  { label: 'Reports', path: '/reports', icon: ChartNoAxesCombined },
]

function AuthGate({ children }: { children: (user: User) => ReactNode }) {
  const { data, isPending, isError } = api.useQuery<{ user: User }>({
    queryKey: ['session'],
    path: '/auth/me',
    retry: false,
  })

  if (isPending) return <div className="page-loading"><span className="spinner" /> Securing your workspace…</div>
  if (isError || !data?.user) return <Navigate to="/login" replace />
  return children(data.user)
}

function AppLayout({ user }: { user: User }) {
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [signingOut, setSigningOut] = useState(false)
  const [accountMessage, setAccountMessage] = useState('')
  const closeNavRef = useRef<HTMLButtonElement>(null)
  const menuButtonRef = useRef<HTMLButtonElement>(null)
  const navigate = useNavigate()
  const location = useLocation()
  const queryClient = useQueryClient()
  const theme = useThemeStore((state) => state.theme)
  const toggleTheme = useThemeStore((state) => state.toggleTheme)
  const notifications = api.useQuery<{
    items: { id: string; kind: 'overdue_invoice' | 'low_stock'; title: string; detail: string; href: string; occurredAt: string }[]
    total: number
  }>({ queryKey: ['notifications', user.businessId], path: '/notifications', refetchInterval: 60_000 })

  useEffect(() => {
    if (!mobileNavOpen) return
    const previousOverflow = document.body.style.overflow
    const menuButton = menuButtonRef.current
    document.body.style.overflow = 'hidden'
    closeNavRef.current?.focus()
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMobileNavOpen(false)
        return
      }
      if (event.key !== 'Tab') return
      const focusable = Array.from(
        document.querySelectorAll<HTMLElement>(
          '#app-navigation button:not(:disabled), #app-navigation a[href], #app-navigation [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => element.getClientRects().length > 0)
      const first = focusable[0]
      const last = focusable.at(-1)
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last?.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first?.focus()
      }
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', closeOnEscape)
      menuButton?.focus()
    }
  }, [mobileNavOpen])

  async function signOut() {
    setSigningOut(true)
    setAccountMessage('')
    try {
      await api.post('/auth/logout', {})
      queryClient.removeQueries({ queryKey: ['session'] })
      navigate('/login', { replace: true })
    } catch (error) {
      setAccountMessage(error instanceof Error ? error.message : 'Unable to sign out. Please try again.')
    } finally {
      setSigningOut(false)
    }
  }

  const activeItem = navItems.find((item) => item.path === location.pathname)
  const currentPage = location.pathname === '/settings' ? 'Settings' : activeItem?.label ?? 'Dashboard'

  return (
    <div className="app-shell">
      {mobileNavOpen && <button aria-label="Close navigation" className="mobile-backdrop" onClick={() => setMobileNavOpen(false)} />}
      <aside id="app-navigation" className={`sidebar ${mobileNavOpen ? 'sidebar-open' : ''}`} role={mobileNavOpen ? 'dialog' : undefined} aria-modal={mobileNavOpen || undefined} aria-label={mobileNavOpen ? 'Main navigation' : undefined}>
        <div className="sidebar-brand">
          <BrandMark />
          <button ref={closeNavRef} className="icon-button sidebar-close" aria-label="Close navigation" onClick={() => setMobileNavOpen(false)}><X size={18} /></button>
        </div>
        <div className="workspace-switcher">
          <span className="workspace-avatar">{user.businessName.slice(0, 1).toUpperCase()}</span>
          <span><strong>{user.businessName}</strong><small>Business workspace</small></span>
          <ChevronDown size={15} />
        </div>
        <nav className="side-nav" aria-label="Main navigation">
          <p className="nav-caption">WORKSPACE</p>
          {navItems.map(({ label, path, icon: Icon }) => {
            const active = label === currentPage
            return <button
              className={`nav-item ${active ? 'nav-item-active' : ''}`}
              key={label}
              type="button"
              aria-current={active ? 'page' : undefined}
              onClick={() => {
                navigate(path)
                setMobileNavOpen(false)
              }}
            >
              <Icon size={17} strokeWidth={1.8} />
              <span>{label}</span>
              {active && <span className="nav-active-dot" />}
            </button>
          })}
          <p className="nav-caption nav-caption-spaced">PREFERENCES</p>
          <button className="nav-item nav-button" type="button" onClick={toggleTheme}>
            {theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
            <span>{theme === 'dark' ? 'Light appearance' : 'Dark appearance'}</span>
          </button>
          <button className={`nav-item nav-button ${location.pathname === '/settings' ? 'nav-item-active' : ''}`} type="button" aria-current={location.pathname === '/settings' ? 'page' : undefined} onClick={() => { navigate('/settings'); setMobileNavOpen(false) }}><Settings size={17} /><span>Settings</span>{location.pathname === '/settings' && <span className="nav-active-dot" />}</button>
        </nav>
        <div className="sidebar-help">
          <span className="help-icon"><CircleHelp size={17} /></span>
          <div><strong>Need a hand?</strong><small>Help centre is coming soon</small></div>
        </div>
        <div className="sidebar-profile">
          <span className="profile-avatar">{user.name.slice(0, 1).toUpperCase()}</span>
          <span className="profile-copy"><strong>{user.name}</strong><small>{user.role}</small></span>
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button className="icon-button profile-menu-trigger" aria-label="Open account menu"><ChevronDown size={16} /></button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content className="dropdown-content" align="end" sideOffset={8}>
                <DropdownMenu.Label className="dropdown-label">{user.email}</DropdownMenu.Label>
                <DropdownMenu.Separator className="dropdown-separator" />
                <DropdownMenu.Item className="dropdown-item" disabled={signingOut} onSelect={() => void signOut()}>
                  <LogOut size={15} /> Sign out
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>
      </aside>
      <div className="main-column">
        <header className="topbar">
          <button ref={menuButtonRef} className="icon-button mobile-menu" aria-label="Open navigation" aria-expanded={mobileNavOpen} aria-controls="app-navigation" onClick={() => setMobileNavOpen(true)}><Menu size={20} /></button>
          <div className="breadcrumb"><span>Workspace</span><span className="breadcrumb-slash">/</span><strong>{currentPage}</strong></div>
          <div className="topbar-actions">
            {accountMessage && <span className="account-message" role="alert">{accountMessage}</span>}
            <button className="icon-button topbar-theme" aria-label="Toggle color theme" onClick={toggleTheme}>
              {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
            </button>
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <button className="icon-button notification-button" aria-label={`Notifications${notifications.data?.total ? `, ${notifications.data.total} alerts` : ''}`} aria-busy={notifications.isPending}>
                  <Bell size={18} />
                  {notifications.data?.total ? <span className="notification-count">{notifications.data.total > 9 ? '9+' : notifications.data.total}</span> : null}
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content className="dropdown-content notification-content" align="end" sideOffset={8}>
                  <DropdownMenu.Label className="dropdown-label">Business alerts</DropdownMenu.Label>
                  <DropdownMenu.Separator className="dropdown-separator" />
                  {notifications.isPending ? <div className="notification-empty">Checking for alerts…</div>
                    : notifications.isError ? <div className="notification-empty notification-error" role="alert">
                      {notifications.error.message}
                      <button className="notification-retry" onClick={() => void notifications.refetch()}>Retry</button>
                    </div>
                      : notifications.data?.items.length
                        ? notifications.data.items.map((item) => (
                          <DropdownMenu.Item
                            key={item.id}
                            className="dropdown-item notification-item"
                            onSelect={() => navigate(item.href)}
                          >
                            <span className={`notification-kind notification-kind-${item.kind}`}><Bell size={14} /></span>
                            <span className="notification-copy"><strong>{item.title}</strong><small>{item.detail}</small></span>
                          </DropdownMenu.Item>
                        ))
                        : <div className="notification-empty">You’re all caught up.</div>}
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
            <div className="topbar-user"><span className="profile-avatar profile-avatar-small">{user.name.slice(0, 1).toUpperCase()}</span><span>{user.name}</span></div>
          </div>
        </header>
        <main className="page-content">
          <Suspense fallback={<ModuleLoading />}>
            {location.pathname === '/customers' ? <CustomersPage />
              : activeItem?.module ? <OperationsPage module={activeItem.module} />
                : location.pathname === '/accounts' ? <AccountsPage />
                  : location.pathname === '/reports' ? <ReportsPage />
                    : location.pathname === '/settings' ? <SettingsPage />
                  : <DashboardPage user={user} />}
          </Suspense>
        </main>
        <footer className="app-footer"><span>MAA Offset Press</span><span>Business workspace · {currentYear}</span></footer>
      </div>
    </div>
  )
}

function ModuleLoading() {
  return <div className="page-loading module-loading"><span className="spinner" /> Loading workspace…</div>
}

function App() {
  const theme = useThemeStore((state) => state.theme)
  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  return <Routes>
    <Route path="/login" element={<Suspense fallback={<ModuleLoading />}><LazyLoginPage /></Suspense>} />
    <Route path="/verify" element={<Suspense fallback={<ModuleLoading />}><LazyLoginPage /></Suspense>} />
    <Route path="/*" element={<AuthGate>{(user) => <AppLayout user={user} />}</AuthGate>} />
  </Routes>
}

export default App
