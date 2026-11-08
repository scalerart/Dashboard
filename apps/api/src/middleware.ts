import type { NextFunction, Request, Response } from 'express'
import jwt from 'jsonwebtoken'
import { config } from './config.js'
import type { AuthUser } from './auth.js'
import { Business, User } from './models.js'
import { runWithTenant } from './tenant-context.js'

declare global {
  namespace Express {
    interface Request {
      authUser?: AuthUser
    }
  }
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = req.cookies?.maa_session as string | undefined
  if (!token) {
    res.status(401).json({ message: 'Authentication required.' })
    return
  }

  try {
    const decoded = jwt.verify(token, config.JWT_SECRET)
    if (typeof decoded === 'string' || typeof decoded.sub !== 'string') {
      res.status(401).json({ message: 'Session is invalid or expired.' })
      return
    }

    const user = await User.findById(decoded.sub)
    if (!user) {
      res.status(401).json({ message: 'Session is invalid or expired.' })
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
    if (!business) {
      res.status(401).json({ message: 'The business workspace for this account is unavailable.' })
      return
    }
    req.authUser = {
      id: String(user._id),
      name: user.name,
      email: user.email,
      role: user.role,
      businessId: String(user.businessId),
      businessName: business.name,
      platformAdmin: config.PLATFORM_ADMIN_EMAILS.includes(user.email.toLowerCase()),
    }
    runWithTenant(String(user.businessId), next)
  } catch (error) {
    if (error instanceof jwt.JsonWebTokenError || error instanceof jwt.TokenExpiredError) {
      res.status(401).json({ message: 'Session is invalid or expired.' })
      return
    }
    next(error)
  }
}
