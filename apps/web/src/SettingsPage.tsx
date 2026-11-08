import { ArrowDownToLine, CircleAlert, Cloud, Mail, RotateCcw, ShieldCheck } from 'lucide-react'
import { useState, type FormEvent, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { api } from './lib/api'

type BusinessSettings = {
  name: string
  phone: string
  email: string
  address: string
  invoiceFooter: string
  currency: string
  expenseCategories: string[]
}
type BusinessProfile = Omit<BusinessSettings, 'expenseCategories'>
function profileSettings(settings: BusinessSettings): BusinessProfile {
  return {
    name: settings.name,
    phone: settings.phone,
    email: settings.email,
    address: settings.address,
    invoiceFooter: settings.invoiceFooter,
    currency: settings.currency,
  }
}

type IntegrationStatus = {
  emailConfigured: boolean
  documentStorageConfigured: boolean
  backupExportAvailable: boolean
}

export default function SettingsPage({ isOwner, businessId }: { isOwner: boolean; businessId: string }) {
  const business = api.useQuery<{ item: BusinessSettings }>({ queryKey: ['business-settings', businessId], path: '/business/settings' })
  const status = api.useQuery<IntegrationStatus>({ queryKey: ['integration-status'], path: '/integrations/status' })
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [emailTestBusy, setEmailTestBusy] = useState(false)
  const [emailTestMessage, setEmailTestMessage] = useState('')
  const [emailTestError, setEmailTestError] = useState('')

  async function exportBackup() {
    setBusy(true)
    setMessage('')
    setError('')
    try {
      const file = await api.getBlob('/backup/export')
      const url = URL.createObjectURL(file)
      const link = document.createElement('a')
      link.href = url
      link.download = `maa-offset-backup-${new Date().toISOString().slice(0, 10)}.zip`
      link.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
      setMessage('Workspace backup downloaded.')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Backup export failed.')
    } finally {
      setBusy(false)
    }
  }

  async function sendTestEmail() {
    setEmailTestBusy(true)
    setEmailTestMessage('')
    setEmailTestError('')
    try {
      const result = await api.post<{ message: string }>('/integrations/email-test', {})
      setEmailTestMessage(result.message)
    } catch (reason) {
      setEmailTestError(reason instanceof Error ? reason.message : 'SMTP test email failed.')
    } finally {
      setEmailTestBusy(false)
    }
  }

  return <div className="settings-page">
    <div className="page-heading"><div><p className="eyebrow">WORKSPACE</p><h1>Settings</h1><p className="page-subtitle">Manage your business profile, invoice defaults, connected services, and data backup.</p></div></div>
    <section className="panel settings-panel">
      <div className="panel-heading"><div><h2>Business profile & invoice settings</h2><p>These details are shown on invoices and across your workspace.</p></div></div>
      {business.isError ? <div className="settings-load-error" role="alert"><CircleAlert size={16} />{business.error.message}<button className="button button-secondary" onClick={() => void business.refetch()}>Retry</button></div>
        : business.isPending ? <p className="settings-loading">Loading business settings…</p>
          : <BusinessProfileEditor settings={business.data.item} isOwner={isOwner} businessId={businessId} />}
    </section>
    {!business.isPending && business.data?.item && <ExpenseCategorySettings
      categories={business.data.item.expenseCategories}
      isOwner={isOwner}
      businessId={businessId}
    />}
    <section className="panel settings-panel">
      <div className="panel-heading"><div><h2>Connected services</h2><p>Configuration status only; secret values are never displayed here.</p></div><ShieldCheck size={18} className="text-muted-icon" /></div>
      {status.isError ? <div className="settings-load-error" role="alert"><CircleAlert size={16} />{status.error.message}<button className="button button-secondary" onClick={() => void status.refetch()}>Retry</button></div>
        : status.isPending ? <p className="settings-loading">Checking configured services…</p>
          : status.data && <div className="settings-service-list">
            <Service icon={<Mail size={17} />} title="Invoice email" ready={status.data.emailConfigured} />
            <Service icon={<Cloud size={17} />} title="Document storage" ready={status.data.documentStorageConfigured} />
            <Service icon={<ShieldCheck size={17} />} title="Owner data export" ready={status.data.backupExportAvailable} />
          </div>}
      {isOwner && status.data?.emailConfigured && <div className="settings-backup-action">
        <button className="button button-secondary" disabled={emailTestBusy} onClick={() => void sendTestEmail()}>{emailTestBusy ? 'Sending test email…' : 'Send test email'}</button>
        <span>Sent to the workspace owner address</span>
      </div>}
      {emailTestMessage && <p className="settings-success" role="status">{emailTestMessage}</p>}
      {emailTestError && <p className="settings-error" role="alert"><CircleAlert size={14} />{emailTestError}</p>}
      <p className="settings-hint">Overdue invoices and low-stock products appear in the notification menu. SMTP must be configured by the deployment administrator for new account verification and invoice email. Document-storage credentials are also managed in the API environment. Automated or scheduled backups and restore are not configured.</p>
    </section>
    <section className="panel settings-panel backup-panel">
      <div className="panel-heading"><div><h2>Workspace data backup</h2><p>Download a ZIP archive of business records (up to 4 MB on Vercel).</p></div><ArrowDownToLine size={18} className="text-muted-icon" /></div>
      <div className="settings-backup-action"><button className="button button-primary" disabled={busy || status.isPending || (status.data !== undefined && !status.data.backupExportAvailable)} onClick={() => void exportBackup()}><ArrowDownToLine size={15} />{busy ? 'Preparing backup…' : 'Download backup'}</button><span>Owner access required</span></div>
      {message && <p className="settings-success" role="status">{message}</p>}
      {error && <p className="settings-error" role="alert"><CircleAlert size={14} />{error}</p>}
    </section>
  </div>
}

function ExpenseCategorySettings({ categories, isOwner, businessId }: {
  categories: string[]
  isOwner: boolean
  businessId: string
}) {
  const queryClient = useQueryClient()
  const [items, setItems] = useState(categories)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  async function save(nextItems: string[]) {
    setSaving(true)
    setError('')
    setMessage('')
    try {
      const result = await api.patch<{ item: BusinessSettings }>('/business/settings', { expenseCategories: nextItems })
      setItems(result.item.expenseCategories)
      queryClient.setQueryData(['business-settings', businessId], result)
      queryClient.setQueryData(['business-settings'], result)
      setMessage('Expense categories saved.')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to save expense categories.')
    } finally {
      setSaving(false)
    }
  }

  function addCategory(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const category = draft.trim()
    if (!category || items.some((item) => item.toLowerCase() === category.toLowerCase()) || items.length >= 50) return
    const next = [...items, category]
    setDraft('')
    void save(next)
  }

  return <section className="panel settings-panel">
    <div className="panel-heading"><div><h2>Expense categories</h2><p>Choose the categories available when recording an expense.</p></div></div>
    {isOwner && <form className="settings-category-form" onSubmit={(event) => addCategory(event)}>
      <label className="sr-only" htmlFor="expense-category-input">New expense category</label>
      <input id="expense-category-input" value={draft} maxLength={100} onChange={(event) => setDraft(event.target.value)} placeholder="e.g. Electricity" />
      <button className="button button-primary" type="submit" disabled={saving || !draft.trim() || items.length >= 50}>Add category</button>
    </form>}
    <div className="settings-category-list">
      {items.map((category) => <span className="settings-category-chip" key={category}>
        {category}
        {isOwner && <button type="button" aria-label={`Remove ${category}`} disabled={saving} onClick={() => void save(items.filter((item) => item !== category))}>×</button>}
      </span>)}
      {!items.length && <p className="settings-loading">No expense categories configured.</p>}
    </div>
    {error && <p className="settings-error" role="alert">{error}</p>}
    {message && <p className="settings-success" role="status">{message}</p>}
    {!isOwner && <p className="settings-hint">Only the workspace owner can manage expense categories.</p>}
  </section>
}

function BusinessProfileEditor({ settings, isOwner, businessId }: { settings: BusinessSettings; isOwner: boolean; businessId: string }) {
  const queryClient = useQueryClient()
  const [form, setForm] = useState<BusinessProfile>(() => profileSettings(settings))
  const [savedSettings, setSavedSettings] = useState<BusinessProfile>(() => profileSettings(settings))
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const hasChanges = Object.keys(form).some((key) => form[key as keyof BusinessProfile] !== savedSettings[key as keyof BusinessProfile])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSaving(true)
    setMessage('')
    setError('')
    try {
      const result = await api.patch<{ item: BusinessSettings }>('/business/settings', form)
      const profile = profileSettings(result.item)
      setForm(profile)
      setSavedSettings(profile)
      queryClient.setQueryData(['business-settings', businessId], result)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
        queryClient.invalidateQueries({ queryKey: ['report-summary'] }),
        queryClient.invalidateQueries({ queryKey: ['accounts-summary'] }),
      ])
      setMessage('Business settings saved.')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to save business settings.')
    } finally {
      setSaving(false)
    }
  }

  return <form className="customer-form settings-form" onSubmit={(event) => void submit(event)}>
    <label className="form-field"><span className="form-field-label">Business name <span className="form-field-label-required">*</span></span><input autoComplete="organization" required minLength={2} maxLength={160} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
    <label className="form-field"><span className="form-field-label">Mobile / phone</span><input autoComplete="tel" maxLength={40} value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} /></label>
    <label className="form-field"><span className="form-field-label">Email</span><input autoComplete="email" type="email" maxLength={254} value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} /></label>
    <label className="form-field"><span className="form-field-label">Invoice currency</span><select value={form.currency} onChange={(event) => setForm({ ...form, currency: event.target.value })}>{['BDT', 'USD', 'EUR', 'GBP', 'INR', 'SAR', 'AED'].map((currency) => <option key={currency} value={currency}>{currency}</option>)}</select><small className="settings-field-hint">Changes how existing amounts are displayed; it does not convert them.</small></label>
    <label className="form-field form-field-wide"><span className="form-field-label">Business address</span><textarea rows={2} maxLength={500} value={form.address} onChange={(event) => setForm({ ...form, address: event.target.value })} /></label>
    <label className="form-field form-field-wide"><span className="form-field-label">Invoice footer / terms</span><textarea rows={2} maxLength={500} value={form.invoiceFooter} onChange={(event) => setForm({ ...form, invoiceFooter: event.target.value })} placeholder="Thank you for your business." /></label>
    {message && <p className="settings-success form-field-wide" role="status">{message}</p>}
    {error && <p className="settings-error form-field-wide" role="alert"><CircleAlert size={14} />{error}</p>}
    {hasChanges && <p className="settings-hint form-field-wide">You have unsaved changes. Review them before leaving this page.</p>}
    <div className="settings-form-actions form-field-wide">
      {hasChanges && <button className="button button-secondary" type="button" disabled={saving} onClick={() => { setForm(savedSettings); setError(''); setMessage('Changes discarded.') }}><RotateCcw size={14} />Discard changes</button>}
      <button className="button button-primary" type="submit" disabled={!isOwner || saving || !hasChanges}>{saving ? 'Saving…' : 'Save business settings'}</button>
      {!isOwner && <span className="settings-hint">Only the workspace owner can edit business settings.</span>}
    </div>
  </form>
}

function Service({ icon, title, ready }: { icon: ReactNode; title: string; ready: boolean }) {
  return <div className="settings-service"><span className="settings-service-icon">{icon}</span><strong>{title}</strong><span className={`service-status ${ready ? 'service-ready' : 'service-unavailable'}`}>{ready ? 'Configured' : 'Not configured'}</span></div>
}
