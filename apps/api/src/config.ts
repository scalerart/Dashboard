import 'dotenv/config'
import { z } from 'zod'

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).default(0),
  MONGODB_URI: z.string().min(1),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_EXPIRES_IN: z.string().default('8h'),
  CLIENT_ORIGIN: z.string().url().default(process.env.RENDER_EXTERNAL_URL ?? 'http://localhost:5173'),
  CURRENCY: z.string().regex(/^[A-Z]{3}$/).default('BDT'),
  CLOUDINARY_CLOUD_NAME: z.string().default(''),
  CLOUDINARY_API_KEY: z.string().default(''),
  CLOUDINARY_API_SECRET: z.string().default(''),
  SMTP_HOST: z.string().default(''),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_USER: z.string().default(''),
  SMTP_PASSWORD: z.string().default('').transform((value) => value || process.env.SMTP_APP_PASSWORD || ''),
  SMTP_FROM: z.string().default(''),
  PLATFORM_ADMIN_EMAILS: z.string().default('').transform((value) =>
    [...new Set(value.split(',').map((email) => email.trim().toLowerCase()).filter(Boolean))],
  ),
  DEV_EMAIL_VERIFICATION_LINKS: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  ALLOW_REMOTE_DEVELOPMENT_DATABASE: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
}).superRefine((values, context) => {
  if (values.DEV_EMAIL_VERIFICATION_LINKS && values.NODE_ENV !== 'development') {
    context.addIssue({
      code: 'custom',
      path: ['DEV_EMAIL_VERIFICATION_LINKS'],
      message: 'Development verification links can only be enabled when NODE_ENV=development.',
    })
  }
  if (values.ALLOW_REMOTE_DEVELOPMENT_DATABASE && values.NODE_ENV !== 'development') {
    context.addIssue({
      code: 'custom',
      path: ['ALLOW_REMOTE_DEVELOPMENT_DATABASE'],
      message: 'Remote development databases can only be enabled when NODE_ENV=development.',
    })
  }
})

export const config = schema.parse(process.env)
