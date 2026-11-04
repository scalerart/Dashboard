import { ArrowDownLeft, ArrowUpRight, Banknote, CircleAlert, CreditCard, LoaderCircle, Wallet } from 'lucide-react'
import { api } from './lib/api'
import { formatCurrency } from './lib/format'

type AccountSummary = {
  inflowMinor: number
  outflowMinor: number
  netMovementMinor: number
  methods: { method: string; inflowMinor: number; outflowMinor: number; balanceMinor: number }[]
}

const methodLabels: Record<string, string> = {
  cash: 'Cash',
  bank: 'Bank transfer',
  bkash: 'bKash',
  nagad: 'Nagad',
  rocket: 'Rocket',
  other: 'Other',
}

export default function AccountsPage() {
  const query = api.useQuery<AccountSummary>({
    queryKey: ['accounts-summary'],
    path: '/accounts/summary',
  })

  return <div className="accounts-page">
    <div className="page-heading"><div><p className="eyebrow">FINANCE</p><h1>Cash & bank</h1><p className="page-subtitle">A ledger-derived view of business money movement by payment method.</p></div></div>
    {query.isError ? <section className="error-state" role="alert"><div className="error-state-icon"><CircleAlert size={18} /></div><div><strong>Account balances could not be loaded</strong><p>{query.error.message}</p></div><button className="button button-secondary" onClick={() => void query.refetch()}>Try again</button></section>
      : query.isPending ? <div className="customer-loading"><LoaderCircle size={19} className="spin" /> Loading account ledger…</div>
        : query.data && <>
          <section className="account-summary-grid">
            <article className="metric-card"><div className="metric-icon metric-green"><ArrowDownLeft size={19} /></div><div className="metric-copy"><span>Recorded inflows</span><strong>{formatCurrency(query.data.inflowMinor)}</strong><small>Payments and other income</small></div></article>
            <article className="metric-card"><div className="metric-icon metric-amber"><ArrowUpRight size={19} /></div><div className="metric-copy"><span>Recorded outflows</span><strong>{formatCurrency(query.data.outflowMinor)}</strong><small>Expenses and supplier payments</small></div></article>
            <article className="metric-card"><div className="metric-icon metric-blue"><Banknote size={19} /></div><div className="metric-copy"><span>Net movement</span><strong>{formatCurrency(query.data.netMovementMinor)}</strong><small>Net of recorded movements only</small></div></article>
          </section>
          <section className="panel account-panel">
            <div className="panel-heading"><div><h2>Balances by payment method</h2><p>Calculated from active, posted ledger entries.</p></div><CreditCard size={18} className="text-muted-icon" /></div>
            {query.data.methods.length ? <div className="account-method-list">
              {query.data.methods.map((item) => <div className="account-method" key={item.method}>
                <span className="account-method-icon"><Wallet size={16} /></span>
                <div className="account-method-copy"><strong>{methodLabels[item.method] ?? item.method}</strong><small>In {formatCurrency(item.inflowMinor)} · Out {formatCurrency(item.outflowMinor)}</small></div>
                <strong className={item.balanceMinor < 0 ? 'negative-balance' : 'positive-balance'}>{formatCurrency(item.balanceMinor)}</strong>
              </div>)}
            </div> : <div className="customer-empty"><span><Wallet size={20} /></span><strong>No account movements recorded</strong><p>Collections, expenses, income and supplier payments will appear here as they are entered.</p></div>}
            <p className="account-disclaimer">These are net movements since the system started recording entries. Opening balances, transfers and bank-statement reconciliation are not yet configured; this is not a statement of available cash.</p>
          </section>
        </>}
  </div>
}
