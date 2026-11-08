import nodemailer from 'nodemailer'
import { config } from './config.js'

export class MailConfigurationError extends Error {
  readonly status = 503

  constructor() {
    super('Email is not configured. Add SMTP host, user, password, and sender address to the API environment.')
    this.name = 'MailConfigurationError'
  }
}

export class MailDeliveryError extends Error {
  readonly status = 503

  constructor(message: string) {
    super(message)
    this.name = 'MailDeliveryError'
  }
}

export function mailDeliveryError(error: unknown) {
  const code = errorProperty(error, 'code')
  const responseCode = errorProperty(error, 'responseCode')
  const message = errorProperty(error, 'message')?.toLowerCase() ?? ''

  if (code === 'EAUTH') {
    return new MailDeliveryError(
      'SMTP login was rejected. Check SMTP_USER and SMTP_PASSWORD in the API environment; Gmail requires an App Password, not your normal account password.',
    )
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return new MailDeliveryError('The SMTP host could not be resolved. Check SMTP_HOST in the API environment.')
  }
  if (code === 'ECONNECTION' || code === 'ETIMEDOUT' || code === 'ECONNREFUSED' || code === 'ESOCKET' && message.includes('timeout')) {
    return new MailDeliveryError(
      'The API could not connect to the SMTP server. Check SMTP_HOST and SMTP_PORT, and confirm the hosting provider allows outbound SMTP connections.',
    )
  }
  if (code === 'EENVELOPE') {
    return new MailDeliveryError('The SMTP server rejected the sender or recipient. Check SMTP_FROM and the customer email address.')
  }
  if (message.includes('certificate') || message.includes('tls') || message.includes('ssl')) {
    return new MailDeliveryError('The SMTP TLS connection failed. Use port 465 for implicit TLS or port 587 for STARTTLS, as required by your provider.')
  }
  if (responseCode && Number(responseCode) >= 500) {
    return new MailDeliveryError(
      `The SMTP provider rejected the message (response ${responseCode}). Check that SMTP_FROM is authorized and that the recipient address is accepted.`,
    )
  }
  return new MailDeliveryError(
    `SMTP could not deliver the message${code ? ` (${code})` : ''}. Check the API SMTP settings and provider logs.`,
  )
}

function errorProperty(error: unknown, key: string) {
  if (typeof error !== 'object' || error === null) return undefined
  const value = Reflect.get(error, key) as unknown
  return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined
}

export function developmentVerificationLinksEnabled() {
  return config.NODE_ENV === 'development' && config.DEV_EMAIL_VERIFICATION_LINKS
}

export function assertVerificationDeliveryConfigured() {
  if (!developmentVerificationLinksEnabled() && !(config.SMTP_HOST && config.SMTP_USER && config.SMTP_PASSWORD && config.SMTP_FROM)) {
    throw new MailConfigurationError()
  }
}

export async function sendVerificationMessage(input: { email: string; name: string; url: string }) {
  if (developmentVerificationLinksEnabled()) {
    console.info(`[development-only email verification] ${input.email}: ${input.url}`)
    return
  }
  await mailTransport().sendMail({
    from: config.SMTP_FROM,
    to: input.email,
    subject: 'Verify your MAA business account',
    text: `Hello ${input.name}, verify your account within one hour: ${input.url}`,
  })
}

export function mailTransport() {
  if (!(config.SMTP_HOST && config.SMTP_USER && config.SMTP_PASSWORD && config.SMTP_FROM)) {
    throw new MailConfigurationError()
  }
  return nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_PORT === 465,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
    auth: { user: config.SMTP_USER, pass: config.SMTP_PASSWORD },
  })
}
