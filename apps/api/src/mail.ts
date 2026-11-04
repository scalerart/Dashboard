import nodemailer from 'nodemailer'
import { config } from './config.js'

export class MailConfigurationError extends Error {
  readonly status = 503

  constructor() {
    super('Email is not configured. Add SMTP host, user, password, and sender address to the API environment.')
    this.name = 'MailConfigurationError'
  }
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
    auth: { user: config.SMTP_USER, pass: config.SMTP_PASSWORD },
  })
}
