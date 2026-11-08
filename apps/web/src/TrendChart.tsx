import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { formatCurrency } from './lib/format'
import type { DashboardData } from './types'

export default function TrendChart({ trends }: { trends: DashboardData['trends'] }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={trends} margin={{ top: 12, right: 12, bottom: 0, left: 0 }}>
        <defs>
          <linearGradient id="salesFill" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="#1daf72" stopOpacity={0.19} /><stop offset="100%" stopColor="#1daf72" stopOpacity={0} /></linearGradient>
          <linearGradient id="collectionFill" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="#5a8dee" stopOpacity={0.15} /><stop offset="100%" stopColor="#5a8dee" stopOpacity={0} /></linearGradient>
        </defs>
        <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
        <XAxis dataKey="label" axisLine={false} tickLine={false} tick={{ fill: 'var(--text-muted)', fontSize: 11 }} dy={9} />
        <YAxis axisLine={false} tickLine={false} width={56} tick={{ fill: 'var(--text-muted)', fontSize: 10 }} tickFormatter={(value: number) => shortCurrency(value / 100)} />
        <Tooltip content={<ChartTooltip />} />
        <Area type="monotone" dataKey="salesMinor" name="Sales" stroke="#1daf72" strokeWidth={2.5} fill="url(#salesFill)" />
        <Area type="monotone" dataKey="collectionsMinor" name="Collection" stroke="#5a8dee" strokeWidth={2} fill="url(#collectionFill)" />
        <Area type="monotone" dataKey="expensesMinor" name="Expenses" stroke="#f59b49" strokeWidth={2} fill="transparent" />
      </AreaChart>
    </ResponsiveContainer>
  )
}

function ChartTooltip({ active, payload, label }: { active?: boolean; payload?: { name: string; value: number; color: string }[]; label?: string }) {
  if (!active || !payload?.length) return null
  return <div className="chart-tooltip"><strong>{label}</strong>{payload.map((item) => <span key={item.name}><i style={{ background: item.color }} />{item.name}<b>{formatCurrency(item.value)}</b></span>)}</div>
}

function shortCurrency(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`
  if (value >= 1_000) return `${(value / 1_000).toFixed(0)}k`
  return `${Math.round(value)}`
}
