import { ArrowDownToLine, BarChart3, CircleAlert, FileDown, LoaderCircle } from 'lucide-react';
import { useMemo, useState } from 'react';
import { api } from './lib/api';
import { formatCurrency } from './lib/format';

type Report = {
  range: { from: string; to: string };
  salesMinor: number;
  collectionsMinor: number;
  expenses: { category: string; amountMinor: number; count: number }[];
  income: { category: string; amountMinor: number; count: number }[];
  purchases: { totalMinor: number; paidMinor: number };
  orders: number;
  paymentMethods: { method: string; amountMinor: number; count: number }[];
};
const methodLabels: Record<string, string> = {
  cash: 'Cash',
  bank: 'Bank transfer',
  bkash: 'bKash',
  nagad: 'Nagad',
  rocket: 'Rocket',
  other: 'Other',
};

function currentMonth() {
  const now = new Date();
  return {
    from: new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10),
    to: now.toISOString().slice(0, 10),
  };
}

export default function ReportsPage() {
  const [period, setPeriod] = useState(currentMonth);
  const [exportError, setExportError] = useState('');
  const params = useMemo(
    () => ({
      from: new Date(`${period.from}T00:00:00`).toISOString(),
      to: new Date(`${period.to}T23:59:59.999`).toISOString(),
    }),
    [period]
  );
  const query = api.useQuery<Report>({
    queryKey: ['report-summary', params],
    path: '/reports/summary',
    params,
  });

  async function exportCsv() {
    setExportError('');
    try {
      const file = await api.getBlob(`/reports/summary.csv?${new URLSearchParams(params)}`);
      const url = URL.createObjectURL(file);
      const link = document.createElement('a');
      link.href = url;
      link.download = `maa-business-report-${period.from}-${period.to}.csv`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (error) {
      setExportError(error instanceof Error ? error.message : 'Report export failed.');
    }
  }

  async function exportPdf() {
    setExportError('');
    try {
      const file = await api.getBlob(`/reports/summary.pdf?${new URLSearchParams(params)}`);
      const url = URL.createObjectURL(file);
      const link = document.createElement('a');
      link.href = url;
      link.download = `maa-business-report-${period.from}-${period.to}.pdf`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (error) {
      setExportError(error instanceof Error ? error.message : 'PDF report export failed.');
    }
  }

  return (
    <div className="reports-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">INSIGHTS</p>
          <h1>Reports & analytics</h1>
          <p className="page-subtitle">
            Business activity summarized from your invoices, collections, expenses and purchases.
          </p>
        </div>
        <div className="heading-actions">
          <button
            className="button button-secondary"
            disabled={query.isPending || query.isError}
            onClick={() => void exportPdf()}
          >
            <FileDown size={15} /> Export PDF
          </button>
          <button
            className="button button-primary"
            disabled={query.isPending || query.isError}
            onClick={() => void exportCsv()}
          >
            <ArrowDownToLine size={15} /> Export CSV
          </button>
        </div>
      </div>
      <section className="panel report-filter">
        <label>
          From{' '}
          <input
            required
            type="date"
            value={period.from}
            max={period.to}
            onChange={(event) => {
              if (event.target.value)
                setPeriod((current) => ({ ...current, from: event.target.value }));
            }}
          />
        </label>
        <label>
          To{' '}
          <input
            required
            type="date"
            value={period.to}
            min={period.from}
            onChange={(event) => {
              if (event.target.value)
                setPeriod((current) => ({ ...current, to: event.target.value }));
            }}
          />
        </label>
        <span>All amounts in {import.meta.env.VITE_CURRENCY ?? 'BDT'}</span>
      </section>
      {exportError && (
        <div className="customer-alert" role="alert">
          <CircleAlert size={15} />
          {exportError}
        </div>
      )}
      {query.isError ? (
        <section className="error-state" role="alert">
          <div className="error-state-icon">
            <CircleAlert size={18} />
          </div>
          <div>
            <strong>Report could not be loaded</strong>
            <p>{query.error.message}</p>
          </div>
          <button className="button button-secondary" onClick={() => void query.refetch()}>
            Try again
          </button>
        </section>
      ) : query.isPending ? (
        <div className="customer-loading">
          <LoaderCircle size={19} className="spin" /> Calculating report…
        </div>
      ) : (
        query.data && (
          <>
            <section className="metric-grid report-metrics">
              <MetricCard title="Invoiced sales" amount={query.data.salesMinor} tone="green" />
              <MetricCard
                title="Collections received"
                amount={query.data.collectionsMinor}
                tone="blue"
              />
              <MetricCard title="Orders created" amount={query.data.orders} tone="cyan" count />
              <MetricCard
                title="Purchases received"
                amount={query.data.purchases.totalMinor}
                tone="amber"
              />
            </section>
            <section className="report-grid">
              <Breakdown
                title="Expenses by category"
                description="Posted expense records"
                empty="No expenses in the selected period."
                rows={query.data.expenses}
              />
              <Breakdown
                title="Other income"
                description="Income excluding invoice collections"
                empty="No other income in the selected period."
                rows={query.data.income}
              />
              <div className="panel report-breakdown">
                <div className="panel-heading">
                  <div>
                    <h2>Collections by method</h2>
                    <p>Payment records in the selected period</p>
                  </div>
                  <BarChart3 size={17} className="text-muted-icon" />
                </div>
                {query.data.paymentMethods.length ? (
                  <div className="report-breakdown-list">
                    {query.data.paymentMethods.map((item) => (
                      <div className="report-breakdown-row" key={item.method}>
                        <span>
                          <strong>{methodLabels[item.method] ?? item.method}</strong>
                          <small>{item.count} payments</small>
                        </span>
                        <b>{formatCurrency(item.amountMinor)}</b>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="report-empty">No collections in the selected period.</div>
                )}
              </div>
              <div className="panel report-breakdown">
                <div className="panel-heading">
                  <div>
                    <h2>Purchase settlement</h2>
                    <p>Supplier purchasing activity</p>
                  </div>
                  <BarChart3 size={17} className="text-muted-icon" />
                </div>
                <div className="report-settlement">
                  <span>
                    <small>Total purchases</small>
                    <strong>{formatCurrency(query.data.purchases.totalMinor)}</strong>
                  </span>
                  <span>
                    <small>Paid to suppliers</small>
                    <strong>{formatCurrency(query.data.purchases.paidMinor)}</strong>
                  </span>
                  <span>
                    <small>Recorded payable</small>
                    <strong>
                      {formatCurrency(
                        Math.max(
                          0,
                          query.data.purchases.totalMinor - query.data.purchases.paidMinor
                        )
                      )}
                    </strong>
                  </span>
                </div>
              </div>
            </section>
          </>
        )
      )}
    </div>
  );
}

function MetricCard({
  title,
  amount,
  tone,
  count = false,
}: {
  title: string;
  amount: number;
  tone: string;
  count?: boolean;
}) {
  return (
    <article className="metric-card">
      <div className={`metric-icon metric-${tone}`}>
        <BarChart3 size={18} />
      </div>
      <div className="metric-copy">
        <span>{title}</span>
        <strong>{count ? amount.toLocaleString() : formatCurrency(amount)}</strong>
        <small>Selected reporting period</small>
      </div>
    </article>
  );
}

function Breakdown({
  title,
  description,
  empty,
  rows,
}: {
  title: string;
  description: string;
  empty: string;
  rows: { category: string; amountMinor: number; count: number }[];
}) {
  return (
    <div className="panel report-breakdown">
      <div className="panel-heading">
        <div>
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
      </div>
      {rows.length ? (
        <div className="report-breakdown-list">
          {rows.map((row) => (
            <div className="report-breakdown-row" key={row.category}>
              <span>
                <strong>{row.category}</strong>
                <small>{row.count} entries</small>
              </span>
              <b>{formatCurrency(row.amountMinor)}</b>
            </div>
          ))}
        </div>
      ) : (
        <div className="report-empty">{empty}</div>
      )}
    </div>
  );
}
