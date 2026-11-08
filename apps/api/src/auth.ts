import { compare, hash } from 'bcryptjs'
import { createHash, randomBytes } from 'node:crypto'
import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import jwt from 'jsonwebtoken'
import mongoose from 'mongoose'
import { z } from 'zod'
import { config } from './config.js'
import { withTransaction } from './domain/workflows.js'
import { Business, EmailVerification, SetupClaim, User } from './models.js'
import { requireAuth } from './middleware.js'
import {
  assertVerificationDeliveryConfigured,
  developmentVerificationLinksEnabled,
  sendVerificationMessage,
} from './mail.js'
import { MongoRateLimitStore } from './rate-limit-store.js'

export type AuthUser = {
  id: string
  name: string
  email: string
  role: string
  businessId: string
  businessName: string
  platformAdmin: boolean
}

const credentialsSchema = z.object({
  email: z.string().trim().email().max(254).transform((email) => email.toLowerCase()),
  password: z.string().min(10).max(72).refine(
    (password) => Buffer.byteLength(password, 'utf8') <= 72,
    'Password must not exceed 72 UTF-8 bytes.',
  ),
})

const setupSchema = credentialsSchema.extend({
  name: z.string().trim().min(2).max(120),
  businessName: z.string().trim().min(2).max(160),
})
const registerSchema = setupSchema
const verificationSchema = z.object({ token: z.string().min(32).max(128) })
const resendSchema = z.object({ email: credentialsSchema.shape.email })

function publicUser(
  user: { _id: unknown; name: string; email: string; role: string; businessId: unknown },
  businessName: string,
): AuthUser {
  return {
    id: String(user._id),
    name: user.name,
    email: user.email,
    role: user.role,
    businessId: String(user.businessId),
    businessName,
    platformAdmin: config.PLATFORM_ADMIN_EMAILS.includes(user.email.toLowerCase()),
  }
}

function hashVerificationToken(token: string) {
  return createHash('sha256').update(token).digest('hex')
}

async function sendVerificationEmail(input: { userId: string; email: string; name: string }) {
  const token = randomBytes(32).toString('base64url')
  await EmailVerification.findOneAndUpdate(
    { user: input.userId },
    { $set: { tokenHash: hashVerificationToken(token), expiresAt: new Date(Date.now() + 60 * 60 * 1000) } },
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
  )
  const verifyUrl = new URL('/verify', config.CLIENT_ORIGIN)
  verifyUrl.searchParams.set('token', token)
  await sendVerificationMessage({ email: input.email, name: input.name, url: verifyUrl.toString() })
}

async function createBusinessOwner(input: z.infer<typeof setupSchema>) {
  const userId = new mongoose.Types.ObjectId()
  const businessId = new mongoose.Types.ObjectId()
  return withTransaction(async (session) => {
    await Business.create([{ _id: businessId, name: input.businessName, owner: userId, currency: config.CURRENCY }], { session })
    await User.create([{
      _id: userId,
      businessId,
      name: input.name,
      email: input.email,
      passwordHash: await hash(input.password, 12),
      emailVerified: false,
      role: 'owner',
    }], { session })
    return userId
  })
}

function sessionCookie() {
  return {
    httpOnly: true,
    secure: config.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
    maxAge: 8 * 60 * 60 * 1000,
  }
}

export const authRouter = Router()
const authAttemptLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  store: new MongoRateLimitStore(),
  standardHeaders: 'draft-8',
  legacyHeaders: false,
})

authRouter.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.authUser })
})

authRouter.get('/setup-status', async (_req, res, next) => {
  try {
    res.json({ setupRequired: (await User.countDocuments()) === 0 })
  } catch (error) {
    next(error)
  }
})

authRouter.post('/register', authAttemptLimiter, async (req, res, next) => {
  try {
    const input = registerSchema.parse(req.body)
    if ((await User.countDocuments()) === 0) {
      res.status(409).json({ message: 'Complete initial workspace setup before creating another business account.' })
      return
    }
    assertVerificationDeliveryConfigured()
    const userId = await createBusinessOwner(input)
    try {
      await sendVerificationEmail({ userId: String(userId), email: input.email, name: input.name })
    } catch (error) {
      console.error('Business account created, but verification email delivery failed.', error)
      res.status(503).json({
        message: 'Your account was created, but the verification email could not be delivered. Configure SMTP or retry sending the verification email.',
      })
      return
    }
    res.status(202).json({
      message: developmentVerificationLinksEnabled()
        ? 'Account created. Copy the verification link from the API terminal to verify the address before signing in.'
        : 'Account created. Check your email to verify the address before signing in.',
    })
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      res.status(409).json({ message: 'An account with that email address already exists.' })
      return
    }
    next(error)
  }
})

authRouter.post('/verify-email', authAttemptLimiter, async (req, res, next) => {
  try {
    const { token } = verificationSchema.parse(req.body)
    const tokenHash = hashVerificationToken(token)
    const user = await withTransaction(async (session) => {
      const verification = await EmailVerification.findOneAndDelete({
        tokenHash,
        expiresAt: { $gt: new Date() },
      }).session(session)
      if (!verification) return null
      return User.findByIdAndUpdate(
        verification.user,
        { $set: { emailVerified: true } },
        { returnDocument: 'after', session },
      )
    })
    if (!user) {
      res.status(400).json({ message: 'This verification link is invalid or expired. Request a new link.' })
      return
    }
    const business = await Business.findById(user.businessId).select('name').lean()
    if (!business) throw new Error('The business workspace for this account could not be found.')
    const tokenValue = jwt.sign({ sub: String(user._id) }, config.JWT_SECRET, {
      expiresIn: config.JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'],
    })
    res.cookie('maa_session', tokenValue, sessionCookie())
    res.json({ user: publicUser(user, business.name) })
  } catch (error) {
    next(error)
  }
})

authRouter.post('/resend-verification', authAttemptLimiter, async (req, res, next) => {
  try {
    const { email } = resendSchema.parse(req.body)
    assertVerificationDeliveryConfigured()
    const user = await User.findOne({ email, emailVerified: false }).select('name email')
    if (user) await sendVerificationEmail({ userId: String(user._id), email: user.email, name: user.name })
    res.json({ message: 'If that account needs verification, a new link has been sent.' })
  } catch (error) {
    next(error)
  }
})

authRouter.post('/setup', authAttemptLimiter, async (req, res, next) => {
  let claimed = false
  try {
    const input = setupSchema.parse(req.body)
    await SetupClaim.create({ _id: 'initial-owner' })
    claimed = true
    if ((await User.countDocuments()) > 0) {
      await SetupClaim.deleteOne({ _id: 'initial-owner' })
      claimed = false
      res.status(409).json({ message: 'Initial account setup is already complete.' })
      return
    }

    assertVerificationDeliveryConfigured()
    const userId = await createBusinessOwner(input)
    try {
      await sendVerificationEmail({ userId: String(userId), email: input.email, name: input.name })
    } catch (error) {
      console.error('Initial business account created, but verification email delivery failed.', error)
      try {
        await SetupClaim.deleteOne({ _id: 'initial-owner' })
        claimed = false
      } catch {
        console.error('Unable to release the initial account setup claim.')
      }
      res.status(503).json({
        message: 'Your account was created, but the verification email could not be delivered. Configure SMTP or retry sending the verification email.',
      })
      return
    }
    try {
      await SetupClaim.deleteOne({ _id: 'initial-owner' })
      claimed = false
    } catch {
      console.error('Unable to release the initial account setup claim.')
    }
    res.status(202).json({
      message: developmentVerificationLinksEnabled()
        ? 'Account created. Copy the verification link from the API terminal to verify the address before signing in.'
        : 'Account created. Check your email to verify the address before signing in.',
    })
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      if (claimed) {
        try {
          await SetupClaim.deleteOne({ _id: 'initial-owner' })
        } catch {
          console.error('Unable to release the initial account setup claim.')
        }
      }
      res.status(409).json({
        message: claimed ? 'An account with that email address already exists.' : 'Initial account setup is already in progress or complete.',
      })
      return
    }
    if (claimed) {
      try {
        await SetupClaim.deleteOne({ _id: 'initial-owner' })
      } catch {
        console.error('Unable to release the initial account setup claim.')
      }
    }
    next(error)
  }
})

authRouter.post('/login', authAttemptLimiter, async (req, res, next) => {
  try {
    const input = credentialsSchema.parse(req.body)
    const user = await User.findOne({ email: input.email }).select('+passwordHash')
    if (!user || !(await compare(input.password, user.passwordHash))) {
      res.status(401).json({ message: 'Email or password is incorrect.' })
      return
    }
    if (user.status === 'inactive') {
      res.status(403).json({ message: 'This account has been deactivated. Contact your platform administrator.' })
      return
    }
    if (!user.emailVerified) {
      res.status(403).json({ message: 'Verify your email address before signing in.' })
      return
    }
    const business = await Business.findById(user.businessId).select('name').lean()
    if (!business) throw new Error('The business workspace for this account could not be found.')

    const token = jwt.sign({ sub: String(user._id) }, config.JWT_SECRET, {
      expiresIn: config.JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'],
    })
    res.cookie('maa_session', token, sessionCookie())
    res.json({ user: publicUser(user, business.name) })
  } catch (error) {
    next(error)
  }
})

authRouter.post('/logout', (_req, res) => {
  res.clearCookie('maa_session', { path: '/' })
  res.status(204).end()
})

function isDuplicateKeyError(error: unknown): error is { code: number } {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 11000
}
