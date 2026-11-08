import { useQueryClient } from '@tanstack/react-query'
import { CircleAlert, LoaderCircle, Search, ShieldCheck, Trash2, UserRoundCheck, UserRoundX } from 'lucide-react'
import { useEffect, useState } from 'react'
import Swal from 'sweetalert2'
import { api } from './lib/api'

type PlatformUser = {
  id: string
  name: string
  email: string
  businessName: string
  role: string
  status: 'active' | 'inactive'
  emailVerified: boolean
  createdAt: string
}
type UserList = {
  items: PlatformUser[]
  pagination: { page: number; limit: number; total: number; pages: number }
}

export default function PlatformUsersPage({ currentUserId }: { currentUserId: string }) {
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [actionError, setActionError] = useState('')
  const query = api.useQuery<UserList>({
    queryKey: ['platform-users', search, page],
    path: '/platform/users',
    params: { search, page: String(page), limit: '50' },
  })

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSearch(draft.trim())
      setPage(1)
    }, 250)
    return () => window.clearTimeout(timer)
  }, [draft])

  async function changeStatus(user: PlatformUser) {
    setActionError('')
    const status = user.status === 'active' ? 'inactive' : 'active'
    const result = await Swal.fire({
      icon: 'warning',
      title: `${status === 'active' ? 'Reactivate' : 'Deactivate'} ${user.name}?`,
      text: status === 'inactive'
        ? 'They will be signed out and will not be able to access their business until reactivated.'
        : 'They will be able to sign in again.',
      showCancelButton: true,
      confirmButtonText: status === 'active' ? 'Reactivate account' : 'Deactivate account',
      cancelButtonText: 'Cancel',
    })
    if (!result.isConfirmed) return
    try {
      await api.patch(`/platform/users/${user.id}/status`, { status })
      await queryClient.invalidateQueries({ queryKey: ['platform-users'] })
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : 'Unable to update this user.')
    }
  }

  async function deleteUser(user: PlatformUser) {
    setActionError('')
    const result = await Swal.fire({
      icon: 'warning',
      title: `Permanently delete ${user.name}?`,
      text: 'Their account and pending verification will be removed. Business records are retained; a workspace with no other active owner will be archived.',
      showCancelButton: true,
      confirmButtonText: 'Delete user',
      cancelButtonText: 'Keep user',
      reverseButtons: true,
      focusCancel: true,
      confirmButtonColor: '#c83f4d',
    })
    if (!result.isConfirmed) return
    try {
      await api.delete(`/platform/users/${user.id}`)
      await queryClient.invalidateQueries({ queryKey: ['platform-users'] })
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : 'Unable to delete this user.')
    }
  }

  const users = query.data?.items ?? []
  const pagination = query.data?.pagination
  return <div className="platform-users-page">
    <div className="page-heading">
      <div><p className="eyebrow">PLATFORM ADMINISTRATION</p><h1>Business users</h1><p className="page-subtitle">Manage accounts across all business workspaces.</p></div>
      <span className="platform-admin-badge"><ShieldCheck size={15} /> Platform admin</span>
    </div>
    <section className="panel settings-panel">
      <div className="customer-toolbar">
        <label className="customer-search">
          <Search size={16} />
          <span className="sr-only">Search users</span>
          <input value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Search name or email" />
        </label>
        <span className="customer-total">{pagination?.total.toLocaleString() ?? '—'} users</span>
      </div>
      {actionError && <div className="customer-alert" role="alert"><CircleAlert size={15} />{actionError}</div>}
      {query.isError ? <div className="settings-load-error" role="alert"><CircleAlert size={16} />{query.error.message}<button className="button button-secondary" onClick={() => void query.refetch()}>Retry</button></div>
        : query.isPending ? <div className="customer-loading"><LoaderCircle size={19} className="spin" /> Loading platform users…</div>
          : users.length ? <>
            <div className="customer-table-scroll">
              <table className="customer-table">
                <thead><tr><th>User</th><th>Business</th><th>Role</th><th>Email</th><th>Status</th><th className="customer-action-heading">Actions</th></tr></thead>
                <tbody>{users.map((user) => {
                  const isSelf = user.id === currentUserId
                  return <tr key={user.id}>
                    <td><div className="customer-contact"><strong>{user.name}</strong><small>{user.email}</small></div></td>
                    <td>{user.businessName}</td>
                    <td>{user.role}</td>
                    <td><span className={`customer-status customer-status-${user.emailVerified ? 'active' : 'inactive'}`}>{user.emailVerified ? 'Verified' : 'Unverified'}</span></td>
                    <td><span className={`customer-status customer-status-${user.status}`}>{user.status}</span></td>
                    <td><div className="customer-row-actions">
                      <button className="button button-secondary operation-action" disabled={isSelf} onClick={() => void changeStatus(user)}>
                        {user.status === 'active' ? <UserRoundX size={14} /> : <UserRoundCheck size={14} />}
                        {user.status === 'active' ? 'Deactivate' : 'Activate'}
                      </button>
                      <button className="icon-button customer-delete" aria-label={`Delete ${user.name}`} title={isSelf ? 'You cannot delete your own account' : 'Delete user'} disabled={isSelf} onClick={() => void deleteUser(user)}><Trash2 size={15} /></button>
                    </div></td>
                  </tr>
                })}</tbody>
              </table>
            </div>
            {pagination && pagination.pages > 1 && <div className="customer-pagination">
              <span>Page <strong>{pagination.page}</strong> of <strong>{pagination.pages}</strong></span>
              <div>
                <button className="icon-button" aria-label="Previous page" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>‹</button>
                <button className="icon-button" aria-label="Next page" disabled={page >= pagination.pages} onClick={() => setPage((value) => value + 1)}>›</button>
              </div>
            </div>}
          </> : <div className="customer-empty"><span><ShieldCheck size={20} /></span><strong>No users found</strong><p>{search ? 'Try another name or email.' : 'No business accounts are registered yet.'}</p></div>}
    </section>
  </div>
}
