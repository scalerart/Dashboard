import { ArrowDownToLine, CircleAlert, Cloud, Mail, ShieldCheck } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { api } from './lib/api'

type IntegrationStatus = {
  emailConfigured: boolean
  documentStorageConfigured: boolean
  backupExportAvailable: boolean
}

export default function SettingsPage() {
  const status = api.useQuery<IntegrationStatus>({ queryKey: ['integration-status'], path: '/integrations/status' })
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

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

  return <div className="settings-page">
    <div className="page-heading"><div><p className="eyebrow">WORKSPACE</p><h1>Settings</h1><p className="page-subtitle">Review service readiness and export a copy of your business records.</p></div></div>
    <section className="panel settings-panel">
      <div className="panel-heading"><div><h2>Connected services</h2><p>Configuration status only; secret values are never displayed here.</p></div><ShieldCheck size={18} className="text-muted-icon" /></div>
      {status.isError ? <div className="settings-load-error" role="alert"><CircleAlert size={16} />{status.error.message}<button className="button button-secondary" onClick={() => void status.refetch()}>Retry</button></div>
        : status.isPending ? <p className="settings-loading">Checking configured services…</p>
          : status.data && <div className="settings-service-list">
            <Service icon={<Mail size={17} />} title="Invoice email" ready={status.data.emailConfigured} />
            <Service icon={<Cloud size={17} />} title="Document storage" ready={status.data.documentStorageConfigured} />
            <Service icon={<ShieldCheck size={17} />} title="Owner data export" ready={status.data.backupExportAvailable} />
          </div>}
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

function Service({ icon, title, ready }: { icon: ReactNode; title: string; ready: boolean }) {
  return <div className="settings-service"><span className="settings-service-icon">{icon}</span><strong>{title}</strong><span className={`service-status ${ready ? 'service-ready' : 'service-unavailable'}`}>{ready ? 'Configured' : 'Not configured'}</span></div>
}
