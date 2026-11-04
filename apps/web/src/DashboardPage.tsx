import {
  ArrowDownRight,
  ArrowUpRight,
  CalendarDays,
  ChevronDown,
  CreditCard,
  Package,
  ShoppingBag,
  Users,
  Wallet,
  X,
} from 'lucide-react'
import { lazy, Suspense, useMemo, useState } from 'react'
import { ApiError, api } from './lib/api'
import { formatCurrency } from './lib/format'
import type { DashboardData, User } from './types'

const TrendChart = lazy(() => import('./TrendChart'))
const greeting = (() => {
  const hour = new Date().getHours()
  if (hour < 12) return 'morning'
  if (hour < 17) return 'afternoon'
  return 'evening'
})()

function getDateRange(monthCount: number) {
  const end = new Date()
  const start = new Date(end.getFullYear(), end.getMonth() - monthCount + 1, 1)
  return { from: start.toISOString(), to: end.toISOString() }
}

export default function DashboardPage({ user }: { user: User }) {
  const [months, setMonths] = useState(6)
  const range = useMemo(() => getDateRange(months), [months])
  const { data, isPending, isError, error, refetch, isFetching } = api.useQuery<DashboardData>({
    queryKey: ['dashboard', range.from, range.to],
    path: '/dashboard/summary',
    params: range,
  })

  return (
    <div className="dashboard-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">OVERVIEW</p>
          <h1>Good {greeting}, {user.name.split(' ')[0]}</h1>
          <p className="page-subtitle">A live view of your business performance and activity.</p>
        </div>
        <div className="heading-actions">
          <label className="period-select">
            <CalendarDays size={16} />
            <span className="sr-only">Summary period</span>
            <select value={months} onChange={(event) => setMonths(Number(event.target.value))}>
              <option value={1}>This month</option>
              <option value={3}>Last 3 months</option>
              <option value={6}>Last 6 months</option>
            </select>
            <ChevronDown size={14} />
          </label>
          <button className="button button-secondary refresh-button" onClick={() => void refetch()} disabled={isFetching}>
            <span className={isFetching ? 'refresh-icon refresh-spinning' : 'refresh-icon'}>↻</span>
            Refresh
          </button>
        </div>
      </div>

      {isError ? (
        <section className="error-state" role="alert">
          <div className="error-state-icon"><X size={18} /></div>
          <div><strong>Dashboard data could not be loaded</strong><p>{error instanceof ApiError ? error.message : 'Check your connection and try again.'}</p></div>
          <button className="button button-secondary" onClick={() => void refetch()}>Try again</button>
        </section>
      ) : isPending ? <DashboardSkeleton /> : data ? (
        <>
          <section className="metric-grid" aria-label="Business metrics">
            <MetricCard title="Total sales" value={formatCurrency(data.metrics.salesMinor)} detail="Invoices issued in selected period" icon={ShoppingBag} tone="green" />
            <MetricCard title="Total collection" value={formatCurrency(data.metrics.collectionsMinor)} detail="Payments received in selected period" icon={CreditCard} tone="blue" />
            <MetricCard title="Outstanding" value={formatCurrency(data.metrics.outstandingMinor)} detail="Balance remaining on invoices" icon={ArrowDownRight} tone="amber" />
            <MetricCard title="Total expenses" value={formatCurrency(data.metrics.expensesMinor)} detail="Expenses recorded in selected period" icon={Wallet} tone="violet" />
            <MetricCard title="Active customers" value={data.metrics.activeCustomers.toLocaleString()} detail="Customers in your database" icon={Users} tone="cyan" />
            <MetricCard title="Orders & jobs" value={data.metrics.orders.toLocaleString()} detail="Orders created in selected period" icon={Package} tone="rose" />
          </section>

          <section className="dashboard-grid">
            <article className="panel trend-panel">
              <div className="panel-heading">
                <div><h2>Business performance</h2><p>Monthly sales, collections and expenses</p></div>
                <span className="panel-period"><CalendarDays size={14} /> Last 6 months</span>
              </div>
              <div className="chart-legend">
                <span><i className="legend-dot sales-dot" />Sales</span>
                <span><i className="legend-dot collection-dot" />Collection</span>
                <span><i className="legend-dot expense-dot" />Expenses</span>
              </div>
              <div className="chart-wrap">
                {data.trends.some((month) => month.salesMinor || month.collectionsMinor || month.expensesMinor)
                  ? <Suspense fallback={<div className="chart-loading"><span className="spinner" /></div>}><TrendChart trends={data.trends} /></Suspense>
                  : <ChartEmpty />}
              </div>
            </article>
            <article className="panel customer-panel">
              <div className="panel-heading">
                <div><h2>Top customers</h2><p>By invoiced sales in this period</p></div>
                <span className="subtle-count">{data.topCustomers.length} customers</span>
              </div>
              {data.topCustomers.length ? <div className="top-customer-list">
                {data.topCustomers.map((customer, index) => {
                  const peak = data.topCustomers[0]?.salesMinor ?? 1
                  return <div className="top-customer" key={customer.id}>
                    <span className={`customer-initial initial-${index % 4}`}>{customer.name.slice(0, 1).toUpperCase()}</span>
                    <div className="customer-detail"><div><strong>{customer.name}</strong><span>{formatCurrency(customer.salesMinor)}</span></div><div className="customer-bar"><i style={{ width: `${Math.max(4, customer.salesMinor / peak * 100)}%` }} /></div></div>
                  </div>
                })}
              </div> : <InlineEmpty icon={Users} title="No customer sales yet" text="Customer rankings appear when invoices are recorded." />}
            </article>
          </section>

          <section className="activity-grid">
            <ActivityTable title="Recent orders & jobs" subtitle="Latest work created in this period" icon={ShoppingBag} emptyTitle="No orders yet" emptyText="Orders will appear here as your team records new work." rows={data.recentOrders.map((order) => ({
              id: order.orderNumber,
              name: order.customerName,
              detail: order.orderNumber,
              amount: formatCurrency(order.amountMinor),
              status: order.status,
              date: formatDate(order.orderDate),
            }))} />
            <ActivityTable title="Recent payments" subtitle="Latest collections recorded" icon={CreditCard} emptyTitle="No payments yet" emptyText="Payments will appear here when collections are recorded." rows={data.recentPayments.map((payment) => ({
              id: payment.paymentNumber,
              name: payment.customerName,
              detail: `${payment.method} · ${payment.paymentNumber}`,
              amount: formatCurrency(payment.amountMinor),
              status: 'received',
              date: formatDate(payment.receivedAt),
            }))} />
          </section>
        </>
      ) : null}
    </div>
  )
}

function MetricCard({ title, value, detail, icon: Icon, tone }: {
  title: string
  value: string
  detail: string
  icon: typeof ShoppingBag
  tone: string
}) {
  return <article className="metric-card">
    <div className={`metric-icon metric-${tone}`}><Icon size={19} strokeWidth={2} /></div>
    <div className="metric-copy"><span>{title}</span><strong>{value}</strong><small>{detail}</small></div>
    <ArrowUpRight className="metric-corner" size={16} aria-hidden="true" />
  </article>
}

function ActivityTable({ title, subtitle, icon: Icon, rows, emptyTitle, emptyText }: {
  title: string
  subtitle: string
  icon: typeof ShoppingBag
  rows: { id: string; name: string; detail: string; amount: string; status: string; date: string }[]
  emptyTitle: string
  emptyText: string
}) {
  return <article className="panel activity-panel">
    <div className="panel-heading"><div className="activity-title"><span className="activity-title-icon"><Icon size={16} /></span><span><h2>{title}</h2><p>{subtitle}</p></span></div><button className="text-button" type="button" disabled title="Order and payment management is coming in a subsequent phase">View all <ArrowUpRight size={14} /></button></div>
    {rows.length ? <div className="activity-list">
      {rows.map((row) => <div className="activity-row" key={row.id}>
        <div className="activity-main"><span className="activity-avatar">{row.name.slice(0, 1).toUpperCase()}</span><span className="activity-row-copy"><strong>{row.name}</strong><small>{row.detail}</small></span></div>
        <div className="activity-value"><strong>{row.amount}</strong><span className={`status-badge status-${row.status.toLowerCase()}`}>{row.status}</span></div>
        <time>{row.date}</time>
      </div>)}
    </div> : <InlineEmpty icon={Icon} title={emptyTitle} text={emptyText} />}
  </article>
}

function InlineEmpty({ icon: Icon, title, text }: { icon: typeof Users; title: string; text: string }) {
  return <div className="inline-empty"><span><Icon size={18} /></span><strong>{title}</strong><p>{text}</p></div>
}

function ChartEmpty() {
  return <div className="chart-empty"><span className="chart-empty-art"><ArrowUpRight size={21} /></span><strong>No financial activity for this period</strong><p>Your chart will update automatically when sales, payments or expenses are recorded.</p></div>
}

function DashboardSkeleton() {
  return <div className="loading-dashboard" aria-label="Loading dashboard data">
    <div className="metric-grid">{Array.from({ length: 6 }, (_, index) => <div className="skeleton metric-skeleton" key={index} />)}</div>
    <div className="dashboard-grid"><div className="skeleton chart-skeleton" /><div className="skeleton side-skeleton" /></div>
    <div className="activity-grid"><div className="skeleton activity-skeleton" /><div className="skeleton activity-skeleton" /></div>
  </div>
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('en-BD', { day: 'numeric', month: 'short' }).format(new Date(value))
}
