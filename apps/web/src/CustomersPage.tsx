import { zodResolver } from '@hookform/resolvers/zod'
import * as Dialog from '@radix-ui/react-dialog'
import { Archive, ArrowDownToLine, Banknote, ChevronLeft, ChevronRight, CircleAlert, FileText, LoaderCircle, Pencil, Plus, RotateCcw, Search, Trash2, Users, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useForm } from 'react-hook-form'
import { useQueryClient } from '@tanstack/react-query'
import { z } from 'zod'
import { ApiError, api } from './lib/api'
import { formatCurrency } from './lib/format'
import { collectPayment, confirmDelete, showError, showSuccess } from './lib/alerts'

const customerSchema = z.object({
  name: z.string().trim().min(2, 'Enter at least 2 characters').max(160),
  phone: z.string().trim().max(40),
  email: z.string().trim().email('Enter a valid email address').or(z.literal('')),
  address: z.string().trim().max(500),
})
type CustomerInput = z.infer<typeof customerSchema>

type Customer = CustomerInput & {
  id: string
  orderCount: number
  status: 'active' | 'inactive'
  createdAt: string
}
type CustomerResult = {
  items: Customer[]
  pagination: { page: number; limit: number; total: number; pages: number }
}
type CustomerStatement = {
  summary: { orderCount: number; invoicedMinor: number; invoicePaidMinor: number; dueMinor: number; paymentsReceivedMinor: number }
  orders: { id: string; orderNumber: string; description: string; quantity: number; amountMinor: number; paidMinor: number; dueMinor: number; invoiceId: string; status: string; orderDate: string; deliveryDate?: string }[]
  invoices: { id: string; invoiceNumber: string; orderNumber: string; totalMinor: number; paidMinor: number; dueMinor: number; status: string; issueDate: string; dueDate?: string }[]
  payments: { id: string; paymentNumber: string; invoiceNumber: string; amountMinor: number; method: string; reference: string; receivedAt: string }[]
}

export default function CustomersPage() {
  const [searchDraft, setSearchDraft] = useState('')
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<'active' | 'inactive' | 'all'>('active')
  const [page, setPage] = useState(1)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<Customer | undefined>()
  const [statementCustomer, setStatementCustomer] = useState<Customer | null>(null)
  const [actionError, setActionError] = useState('')
  const queryClient = useQueryClient()
  const params = { search, status, page: String(page), limit: '10' }
  const query = api.useQuery<CustomerResult>({
    queryKey: ['customers', params],
    path: '/customers',
    params,
  })

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSearch(searchDraft.trim())
      setPage(1)
    }, 250)
    return () => window.clearTimeout(timer)
  }, [searchDraft])

  async function toggleStatus(customer: Customer) {
    setActionError('')
    try {
      await api.patch(`/customers/${customer.id}/status`, {
        status: customer.status === 'active' ? 'inactive' : 'active',
      })
      await queryClient.invalidateQueries({ queryKey: ['customers'] })
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Unable to update customer status.')
    }
  }

  async function deleteCustomer(customer: Customer) {
    if (!await confirmDelete(
      `Delete ${customer.name}?`,
      'All of this customer’s invoices, payment receipts, and related ledger entries will also be permanently deleted. Customers with orders are protected.',
    )) return
    try {
      await api.delete(`/customers/${customer.id}`)
      await queryClient.invalidateQueries({ queryKey: ['customers'] })
      await showSuccess('Customer and eligible related records were permanently deleted.')
    } catch (error) {
      await showError(error instanceof Error ? error.message : 'Unable to delete this customer.')
    }
  }

  function openCreate() {
    setEditing(undefined)
    setDialogOpen(true)
  }

  function openEdit(customer: Customer) {
    setEditing(customer)
    setDialogOpen(true)
  }

  const total = query.data?.pagination.total ?? 0
  const pages = query.data?.pagination.pages ?? 0
  const firstItem = total ? (page - 1) * 10 + 1 : 0
  const lastItem = Math.min(page * 10, total)

  return (
    <div className="customers-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">RELATIONSHIPS</p>
          <h1>Customers</h1>
          <p className="page-subtitle">Manage the people and businesses you work with.</p>
        </div>
        <button className="button button-primary" onClick={openCreate}><Plus size={15} /> Add customer</button>
      </div>

      <section className="panel customers-panel">
        <div className="customer-toolbar">
          <label className="customer-search">
            <Search size={16} />
            <span className="sr-only">Search customers</span>
            <input value={searchDraft} onChange={(event) => setSearchDraft(event.target.value)} placeholder="Search name, email or phone" />
            {searchDraft && <button type="button" aria-label="Clear search" onClick={() => setSearchDraft('')}><X size={14} /></button>}
          </label>
          <label className="customer-filter">
            <span className="sr-only">Filter customer status</span>
            <select value={status} onChange={(event) => { setStatus(event.target.value as typeof status); setPage(1) }}>
              <option value="active">Active customers</option>
              <option value="inactive">Inactive customers</option>
              <option value="all">All statuses</option>
            </select>
          </label>
          <span className="customer-total">{total.toLocaleString()} {total === 1 ? 'customer' : 'customers'}</span>
        </div>

        {actionError && <div className="customer-alert" role="alert"><CircleAlert size={15} />{actionError}</div>}
        {query.isError ? (
          <div className="customer-error" role="alert">
            <CircleAlert size={18} />
            <strong>Customers could not be loaded</strong>
            <p>{query.error instanceof ApiError ? query.error.message : 'Check your connection and try again.'}</p>
            <button className="button button-secondary" onClick={() => void query.refetch()}>Try again</button>
          </div>
        ) : query.isPending ? (
          <div className="customer-loading"><LoaderCircle size={19} className="spin" /> Loading customers…</div>
        ) : query.data && query.data.items.length === 0 ? (
          <div className="customer-empty">
            <span><Users size={20} /></span>
            <strong>{search || status !== 'active' ? 'No matching customers' : 'Your customer list is ready'}</strong>
            <p>{search || status !== 'active' ? 'Try another search or status filter.' : 'Add your first customer to start building your business directory.'}</p>
            {!search && status === 'active' && <button className="button button-primary" onClick={openCreate}><Plus size={15} /> Add customer</button>}
          </div>
        ) : query.data ? (
          <>
            <div className="customer-table-scroll">
              <table className="customer-table">
                <thead><tr><th>Customer</th><th>Contact</th><th>Address</th><th>Orders</th><th>Status</th><th className="customer-action-heading">Actions</th></tr></thead>
                <tbody>
                  {query.data.items.map((customer) => (
                    <tr key={customer.id}>
                      <td><div className="customer-name-cell"><span className="customer-initial">{customer.name.slice(0, 1).toUpperCase()}</span><span><strong>{customer.name}</strong><small>Added {new Intl.DateTimeFormat('en-BD', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(customer.createdAt))}</small></span></div></td>
                      <td><div className="customer-contact"><span>{customer.phone || '—'}</span><small>{customer.email || 'No email'}</small></div></td>
                      <td className="customer-address">{customer.address || '—'}</td>
                      <td>{customer.orderCount.toLocaleString()}</td>
                      <td><span className={`customer-status customer-status-${customer.status}`}>{customer.status}</span></td>
                      <td><div className="customer-row-actions">
                        <button className="icon-button customer-edit" aria-label={`View ${customer.name} statement`} title="View customer statement" onClick={() => setStatementCustomer(customer)}><FileText size={15} /></button>
                        <button className="icon-button customer-edit" aria-label={`Edit ${customer.name}`} title="Edit customer" onClick={() => openEdit(customer)}><Pencil size={15} /></button>
                        <button className="icon-button customer-archive" aria-label={`${customer.status === 'active' ? 'Archive' : 'Restore'} ${customer.name}`} title={customer.status === 'active' ? 'Archive customer' : 'Restore customer'} onClick={() => void toggleStatus(customer)}>
                          {customer.status === 'active' ? <Archive size={15} /> : <RotateCcw size={15} />}
                        </button>
                        <button className="icon-button customer-delete" aria-label={`Delete ${customer.name}`} title="Permanently delete customer" onClick={() => void deleteCustomer(customer)}><Trash2 size={15} /></button>
                      </div></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="customer-pagination">
              <span>Showing <strong>{firstItem}–{lastItem}</strong> of <strong>{total}</strong> customers</span>
              <div>
                <button className="icon-button" aria-label="Previous page" disabled={page <= 1} onClick={() => setPage((current) => current - 1)}><ChevronLeft size={17} /></button>
                <span>Page {page}{pages ? ` of ${pages}` : ''}</span>
                <button className="icon-button" aria-label="Next page" disabled={page >= pages} onClick={() => setPage((current) => current + 1)}><ChevronRight size={17} /></button>
              </div>
            </div>
          </>
        ) : null}
      </section>

      <CustomerDialog
        key={editing?.id ?? 'new'}
        customer={editing}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onSaved={() => queryClient.invalidateQueries({ queryKey: ['customers'] })}
      />
      {statementCustomer && <CustomerStatementDialog customer={statementCustomer} onOpenChange={(open) => { if (!open) setStatementCustomer(null) }} />}
    </div>
  )
}

function CustomerStatementDialog({ customer, onOpenChange }: { customer: Customer; onOpenChange: (open: boolean) => void }) {
  const queryClient = useQueryClient()
  const query = api.useQuery<CustomerStatement>({
    queryKey: ['customer-statement', customer.id],
    path: `/customers/${customer.id}/statement`,
  })

  async function collectInvoiceDue(invoice: CustomerStatement['invoices'][number]) {
    const payment = await collectPayment(invoice.dueMinor)
    if (!payment) return
    await postCustomerPayment(invoice.id, payment, `Collection for ${invoice.invoiceNumber}`)
  }

  async function collectOrderDue(order: CustomerStatement['orders'][number]) {
    const payment = await collectPayment(order.dueMinor)
    if (!payment) return
    try {
      const invoice = order.invoiceId
        ? { item: { id: order.invoiceId } }
        : await api.post<{ item: { id: string } }>(`/orders/${order.id}/invoice`, {})
      await postCustomerPayment(invoice.item.id, payment, `Collection for ${order.orderNumber}`)
    } catch (error) {
      await showError(error instanceof Error ? error.message : 'Unable to record this payment.')
    }
  }

  async function postCustomerPayment(invoiceId: string, payment: { amountMinor: number; method: string; reference: string }, defaultReference: string) {
    try {
      await api.post('/payments', {
        customerId: customer.id,
        invoiceId,
        amountMinor: payment.amountMinor,
        method: payment.method,
        reference: payment.reference || defaultReference,
        receivedAt: new Date().toISOString(),
      }, { 'Idempotency-Key': crypto.randomUUID() })
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['customer-statement', customer.id] }),
        queryClient.invalidateQueries({ queryKey: ['orders'] }),
        queryClient.invalidateQueries({ queryKey: ['invoices'] }),
        queryClient.invalidateQueries({ queryKey: ['payments'] }),
        queryClient.invalidateQueries({ queryKey: ['accounts-summary'] }),
        queryClient.invalidateQueries({ queryKey: ['report-summary'] }),
        queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
      ])
      await showSuccess('Payment recorded and account balance updated.')
    } catch (error) {
      await showError(error instanceof Error ? error.message : 'Unable to record this payment.')
    }
  }

  async function downloadStatement() {
    try {
      const file = await api.getBlob(`/customers/${customer.id}/statement/pdf`)
      const url = URL.createObjectURL(file)
      const link = document.createElement('a')
      link.href = url
      link.download = `customer-statement-${customer.id}.pdf`
      link.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
    } catch (error) {
      await showError(error instanceof Error ? error.message : 'Unable to download this customer statement.')
    }
  }

  return <Dialog.Root open onOpenChange={onOpenChange}>
    <Dialog.Portal>
      <Dialog.Overlay className="dialog-overlay" />
      <Dialog.Content className="customer-dialog customer-statement-dialog">
        <div className="dialog-heading">
          <div><Dialog.Title>{customer.name} — account statement</Dialog.Title><Dialog.Description>Orders, invoices, collections and outstanding invoice balance.</Dialog.Description></div>
          <div className="customer-row-actions">
            <button className="button button-secondary" disabled={query.isPending || query.isError} onClick={() => void downloadStatement()}><ArrowDownToLine size={14} /> PDF statement</button>
            <Dialog.Close asChild><button className="icon-button" aria-label="Close statement"><X size={18} /></button></Dialog.Close>
          </div>
        </div>
        {query.isError ? <div className="customer-error" role="alert"><CircleAlert size={18} /><strong>Statement could not be loaded</strong><p>{query.error.message}</p><button className="button button-secondary" onClick={() => void query.refetch()}>Try again</button></div>
          : query.isPending ? <div className="customer-loading"><LoaderCircle size={19} className="spin" /> Loading account statement…</div>
            : <>
              <div className="statement-summary">
                <SummaryItem label="Active orders" value={query.data?.summary.orderCount.toLocaleString() ?? '0'} />
                <SummaryItem label="Invoiced" value={formatCurrency(query.data?.summary.invoicedMinor ?? 0)} />
                <SummaryItem label="Paid on invoices" value={formatCurrency(query.data?.summary.invoicePaidMinor ?? 0)} />
                <SummaryItem label="Balance due" value={formatCurrency(query.data?.summary.dueMinor ?? 0)} />
                <SummaryItem label="All payments received" value={formatCurrency(query.data?.summary.paymentsReceivedMinor ?? 0)} />
              </div>
              <section className="statement-section">
                <h3>Orders</h3>
                {query.data?.orders.length ? <div className="customer-table-scroll"><table className="customer-table"><thead><tr>{['Order #', 'Task', 'Qty', 'Total', 'Paid', 'Due', 'Status', 'Date', 'Actions'].map((header) => <th key={header}>{header}</th>)}</tr></thead><tbody>
                  {query.data.orders.map((order) => <tr key={order.id}>
                    <td>{order.orderNumber}</td><td>{order.description}</td><td>{order.quantity.toLocaleString()}</td><td>{formatCurrency(order.amountMinor)}</td><td>{formatCurrency(order.paidMinor)}</td><td>{formatCurrency(order.dueMinor)}</td><td>{order.status}</td><td>{statementDate(order.orderDate)}</td>
                    <td>{order.dueMinor > 0 && order.status !== 'cancelled' && <button className="button button-secondary operation-action" onClick={() => void collectOrderDue(order)}><Banknote size={14} /> Collect due</button>}</td>
                  </tr>)}
                </tbody></table></div> : <p className="settings-loading">No orders recorded.</p>}
              </section>
              <section className="statement-section">
                <h3>Invoices</h3>
                {query.data?.invoices.length ? <div className="customer-table-scroll"><table className="customer-table"><thead><tr>{['Invoice #', 'Order #', 'Total', 'Paid', 'Due', 'Status', 'Actions'].map((header) => <th key={header}>{header}</th>)}</tr></thead><tbody>
                  {query.data.invoices.map((invoice) => <tr key={invoice.id}>
                    <td>{invoice.invoiceNumber}</td><td>{invoice.orderNumber || '—'}</td><td>{formatCurrency(invoice.totalMinor)}</td><td>{formatCurrency(invoice.paidMinor)}</td><td>{formatCurrency(invoice.dueMinor)}</td><td>{invoice.status}</td>
                    <td>{invoice.dueMinor > 0 && invoice.status !== 'void' && !invoice.orderNumber && <button className="button button-secondary operation-action" onClick={() => void collectInvoiceDue(invoice)}><Banknote size={14} /> Collect due</button>}</td>
                  </tr>)}
                </tbody></table></div> : <p className="settings-loading">No invoices issued.</p>}
              </section>
              <StatementTable title="Payments" empty="No payments recorded." headers={['Receipt #', 'Invoice #', 'Method', 'Reference', 'Amount', 'Date']} rows={(query.data?.payments ?? []).map((payment) => [
                payment.paymentNumber, payment.invoiceNumber || '—', payment.method, payment.reference || '—', formatCurrency(payment.amountMinor), statementDate(payment.receivedAt),
              ])} />
            </>}
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
}

function SummaryItem({ label, value }: { label: string; value: string }) {
  return <div><span>{label}</span><strong>{value}</strong></div>
}

function StatementTable({ title, empty, headers, rows }: { title: string; empty: string; headers: string[]; rows: string[][] }) {
  return <section className="statement-section">
    <h3>{title}</h3>
    {rows.length ? <div className="customer-table-scroll"><table className="customer-table"><thead><tr>{headers.map((header) => <th key={header}>{header}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={`${title}-${index}`}>{row.map((cell, cellIndex) => <td key={`${cellIndex}-${cell}`}>{cell}</td>)}</tr>)}</tbody></table></div>
      : <p className="settings-loading">{empty}</p>}
  </section>
}

function statementDate(value: string) {
  return new Intl.DateTimeFormat('en-BD', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(value))
}

function CustomerDialog({ customer, open, onOpenChange, onSaved }: {
  customer?: Customer
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved: () => void
}) {
  const [message, setMessage] = useState('')
  const [saving, setSaving] = useState(false)
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<CustomerInput>({
    resolver: zodResolver(customerSchema),
    defaultValues: {
      name: customer?.name ?? '',
      phone: customer?.phone ?? '',
      email: customer?.email ?? '',
      address: customer?.address ?? '',
    },
  })

  const submit = handleSubmit(async (values) => {
    setSaving(true)
    setMessage('')
    try {
      if (customer) await api.patch(`/customers/${customer.id}`, values)
      else await api.post('/customers', values)
      onSaved()
      onOpenChange(false)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to save customer.')
    } finally {
      setSaving(false)
    }
  })

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="customer-dialog">
          <div className="dialog-heading">
            <div><Dialog.Title>{customer ? 'Edit customer' : 'Add customer'}</Dialog.Title><Dialog.Description>Customer details are used on orders, invoices and payment records.</Dialog.Description></div>
            <Dialog.Close asChild><button className="icon-button" aria-label="Close dialog"><X size={18} /></button></Dialog.Close>
          </div>
          <form onSubmit={submit} className="customer-form">
            <label className="form-field form-field-wide"><span className="form-field-label">Customer / business name <span className="form-field-label-required">*</span></span>
              <input autoFocus {...register('name')} placeholder="e.g. MAA Graphics" />
              {errors.name && <small className="field-error">{errors.name.message}</small>}
            </label>
            <label className="form-field"><span className="form-field-label">Phone number</span>
              <input {...register('phone')} placeholder="+880 1XXX-XXXXXX" />
              {errors.phone && <small className="field-error">{errors.phone.message}</small>}
            </label>
            <label className="form-field"><span className="form-field-label">Email address</span>
              <input type="email" {...register('email')} placeholder="contact@company.com" />
              {errors.email && <small className="field-error">{errors.email.message}</small>}
            </label>
            <label className="form-field form-field-wide"><span className="form-field-label">Address</span>
              <textarea rows={3} {...register('address')} placeholder="Street, city, postal code" />
              {errors.address && <small className="field-error">{errors.address.message}</small>}
            </label>
            {message && <p className="form-message form-field-wide" role="alert">{message}</p>}
            <div className="dialog-footer form-field-wide">
              <Dialog.Close asChild><button className="button button-secondary" type="button">Cancel</button></Dialog.Close>
              <button className="button button-primary" type="submit" disabled={saving}>{saving ? 'Saving…' : customer ? 'Save changes' : 'Create customer'}</button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
