import { zodResolver } from '@hookform/resolvers/zod'
import { CircleHelp, X } from 'lucide-react'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { z } from 'zod'
import BrandMark from './BrandMark'
import { ApiError, api } from './lib/api'
import type { User } from './types'

const authSchema = z.object({
  name: z.string().trim().min(2, 'Enter your name').max(120).optional(),
  businessName: z.string().trim().min(2, 'Enter your business name').max(160).optional(),
  email: z.string().email('Enter a valid email address'),
  password: z.string().min(10, 'Use at least 10 characters').max(72, 'Use no more than 72 characters'),
})
type AuthFields = z.infer<typeof authSchema>

export default function LoginPage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const queryClient = useQueryClient()
  const setupQuery = api.useQuery<{ setupRequired: boolean }>({
    queryKey: ['setup-status'],
    path: '/auth/setup-status',
    retry: false,
  })
  const [message, setMessage] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [isRegistering, setIsRegistering] = useState(false)
  const [verificationEmail, setVerificationEmail] = useState('')
  const verificationToken = searchParams.get('token')
  const isSetup = setupQuery.data?.setupRequired === true
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<AuthFields>({
    resolver: zodResolver(authSchema),
    defaultValues: { name: '', businessName: '', email: '', password: '' },
    shouldUnregister: true,
  })

  const onSubmit = handleSubmit(async (values) => {
    setSubmitting(true)
    setMessage('')
    try {
      const registering = isSetup || isRegistering
      const result = await api.post<{ user?: User; message?: string }>(
        isSetup ? '/auth/setup' : isRegistering ? '/auth/register' : '/auth/login',
        values,
      )
      if (registering) {
        setVerificationEmail(values.email)
        if (isSetup) queryClient.setQueryData(['setup-status'], { setupRequired: false })
        setMessage(result.message ?? 'Check your email to verify your account.')
        return
      }
      if (!result.user) throw new Error('The server did not return an authenticated account.')
      queryClient.setQueryData(['session'], result)
      queryClient.setQueryData(['setup-status'], { setupRequired: false })
      navigate('/', { replace: true })
    } catch (error) {
      if (
        error instanceof ApiError &&
        error.status === 503 &&
        error.message.startsWith('Your account was created')
      ) {
        setVerificationEmail(values.email)
        if (isSetup) queryClient.setQueryData(['setup-status'], { setupRequired: false })
      }
      setMessage(error instanceof Error ? error.message : 'Unable to sign in.')
    } finally {
      setSubmitting(false)
    }
  })

  const verifyEmail = async () => {
    if (!verificationToken) return
    setSubmitting(true)
    setMessage('')
    try {
      const result = await api.post<{ user: User }>('/auth/verify-email', { token: verificationToken })
      queryClient.setQueryData(['session'], result)
      queryClient.setQueryData(['setup-status'], { setupRequired: false })
      navigate('/', { replace: true })
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to verify this email address.')
    } finally {
      setSubmitting(false)
    }
  }

  const resendVerification = async () => {
    setSubmitting(true)
    setMessage('')
    try {
      const result = await api.post<{ message: string }>('/auth/resend-verification', { email: verificationEmail })
      setMessage(result.message)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to resend the verification email.')
    } finally {
      setSubmitting(false)
    }
  }

  if (setupQuery.isPending) {
    return <div className="page-loading"><span className="spinner" /> Connecting to your workspace…</div>
  }
  if (setupQuery.isError) {
    return (
      <main className="auth-page auth-status-page">
        <section className="auth-panel">
          <BrandMark />
          <div className="error-state-icon"><X size={18} /></div>
          <h1>Workspace unavailable</h1>
          <p className="auth-intro">{setupQuery.error instanceof ApiError ? setupQuery.error.message : 'Could not verify workspace setup. Check the API and database connection, then try again.'}</p>
          <button className="button button-primary auth-submit" onClick={() => void setupQuery.refetch()}>Try again</button>
        </section>
      </main>
    )
  }

  if (verificationToken) {
    return (
      <main className="auth-page auth-status-page">
        <section className="auth-panel">
          <BrandMark />
          <p className="eyebrow">EMAIL VERIFICATION</p>
          <h1>Verify your account</h1>
          <p className="auth-intro">Confirm your email address to activate your business workspace.</p>
          {message && <p className="form-message" role="alert">{message}</p>}
          <button className="button button-primary auth-submit" disabled={submitting} onClick={() => void verifyEmail()}>
            {submitting ? 'Verifying…' : 'Verify email address'}
          </button>
        </section>
      </main>
    )
  }

  return (
    <main className="auth-page">
      <section className="auth-panel">
        <BrandMark />
        <p className="eyebrow">MAA OFFSET PRESS · BUSINESS MANAGEMENT</p>
        <h1>{isSetup ? 'Set up your workspace' : isRegistering ? 'Create your business account' : 'Welcome back'}</h1>
        <p className="auth-intro">
          {isSetup
            ? 'Create the owner account and workspace for your business.'
            : isRegistering
              ? 'Start a private workspace for your business. Verify your email before signing in.'
            : 'Sign in to see what is happening across your business.'}
        </p>
        <form className="auth-form" onSubmit={onSubmit}>
          {(isSetup || isRegistering) && <>
            <label>
              Your name
              <input autoComplete="name" {...register('name')} placeholder="Your name" />
              {errors.name && <span className="field-error">{errors.name.message}</span>}
            </label>
            <label>
              Business name
              <input autoComplete="organization" {...register('businessName')} placeholder="Your business" />
              {errors.businessName && <span className="field-error">{errors.businessName.message}</span>}
            </label>
          </>}
          <label>
            Email address
            <input autoComplete="email" type="email" {...register('email')} placeholder="you@company.com" />
            {errors.email && <span className="field-error">{errors.email.message}</span>}
          </label>
          <label>
            Password
            <input
              autoComplete={isSetup || isRegistering ? 'new-password' : 'current-password'}
              maxLength={72}
              type="password"
              {...register('password')}
              placeholder={isSetup ? 'At least 10 characters' : 'Your password'}
            />
            {errors.password && <span className="field-error">{errors.password.message}</span>}
          </label>
          {message && <p className="form-message" role="alert">{message}</p>}
          <button className="button button-primary auth-submit" disabled={submitting} type="submit">
            {submitting ? 'Please wait…' : isSetup ? 'Create workspace' : isRegistering ? 'Create business account' : 'Sign in'}
          </button>
        </form>
        {verificationEmail && (
          <button className="button button-secondary auth-submit" disabled={submitting} onClick={() => void resendVerification()}>
            Resend verification email
          </button>
        )}
        {!isSetup && (
          <button className="auth-mode-toggle" onClick={() => { setIsRegistering(!isRegistering); setMessage(''); setVerificationEmail('') }}>
            {isRegistering ? 'Already have an account? Sign in' : 'Create a new business account'}
          </button>
        )}
        <p className="auth-note"><CircleHelp size={15} /> Your account is protected with a secure session.</p>
      </section>
      <aside className="auth-aside">
        <div className="auth-aside-orb orb-one" />
        <div className="auth-aside-orb orb-two" />
        <div className="auth-aside-content">
          <span className="auth-aside-label">A clearer view of your business</span>
          <h2>Make every business decision with confidence.</h2>
          <p>Sales, collections, jobs and expenses in one considered workspace.</p>
          <div className="auth-aside-foot"><span /><span /><span /></div>
        </div>
      </aside>
    </main>
  )
}
