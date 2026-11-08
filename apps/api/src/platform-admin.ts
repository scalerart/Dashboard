import { Router } from 'express'
import mongoose from 'mongoose'
import { z } from 'zod'
import { Business, EmailVerification, User } from './models.js'
import { requireAuth } from './middleware.js'

export const platformAdminRouter = Router()
platformAdminRouter.use(requireAuth)

const userQuery = z.object({
  search: z.string().trim().max(120).default(''),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})
const statusInput = z.object({ status: z.enum(['active', 'inactive']) })

platformAdminRouter.get('/users', async (req, res, next) => {
  try {
    if (!req.authUser!.platformAdmin) {
      res.status(403).json({ message: 'Platform administrator access is required.' })
      return
    }
    const query = userQuery.parse(req.query)
    const filter = query.search
      ? { $or: [
        { name: new RegExp(escapeRegex(query.search), 'i') },
        { email: new RegExp(escapeRegex(query.search), 'i') },
      ] }
      : {}
    const [users, total] = await Promise.all([
      User.collection.find(filter, {
        projection: { name: 1, email: 1, businessId: 1, role: 1, status: 1, emailVerified: 1, createdAt: 1 },
      }).sort({ createdAt: -1 }).skip((query.page - 1) * query.limit).limit(query.limit).toArray(),
      User.collection.countDocuments(filter),
    ])
    const businessIds = users.flatMap((user) => user.businessId ? [user.businessId] : [])
    const businesses = await Business.collection.find(
      { _id: { $in: businessIds } },
      { projection: { name: 1 } },
    ).toArray()
    const names = new Map(businesses.map((business) => [String(business._id), String(business.name ?? 'Unknown business')]))
    res.json({
      items: users.map((user) => ({
        id: String(user._id),
        name: String(user.name ?? ''),
        email: String(user.email ?? ''),
        businessName: names.get(String(user.businessId)) ?? 'Unknown business',
        role: String(user.role ?? 'owner'),
        status: user.status === 'inactive' ? 'inactive' : 'active',
        emailVerified: Boolean(user.emailVerified),
        createdAt: user.createdAt,
      })),
      pagination: { page: query.page, limit: query.limit, total, pages: Math.ceil(total / query.limit) },
    })
  } catch (error) {
    next(error)
  }
})

platformAdminRouter.patch('/users/:id/status', async (req, res, next) => {
  try {
    if (!req.authUser!.platformAdmin) {
      res.status(403).json({ message: 'Platform administrator access is required.' })
      return
    }
    if (!mongoose.isValidObjectId(req.params.id)) {
      res.status(400).json({ message: 'User ID is invalid.' })
      return
    }
    if (req.params.id === req.authUser!.id) {
      res.status(409).json({ message: 'You cannot deactivate your own administrator account.' })
      return
    }
    const { status } = statusInput.parse(req.body)
    const result = await User.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(req.params.id) },
      { $set: { status, updatedAt: new Date() } },
    )
    if (!result.matchedCount) {
      res.status(404).json({ message: 'User not found.' })
      return
    }
    console.info(`Platform administrator ${req.authUser!.email} set user ${req.params.id} to ${status}.`)
    res.json({ item: { id: req.params.id, status } })
  } catch (error) {
    next(error)
  }
})

platformAdminRouter.delete('/users/:id', async (req, res, next) => {
  try {
    if (!req.authUser!.platformAdmin) {
      res.status(403).json({ message: 'Platform administrator access is required.' })
      return
    }
    if (!mongoose.isValidObjectId(req.params.id)) {
      res.status(400).json({ message: 'User ID is invalid.' })
      return
    }
    if (req.params.id === req.authUser!.id) {
      res.status(409).json({ message: 'You cannot delete your own administrator account.' })
      return
    }
    const userId = new mongoose.Types.ObjectId(req.params.id)
    const session = await mongoose.startSession()
    try {
      let found = false
      await session.withTransaction(async () => {
        const user = await User.collection.findOne(
          { _id: userId },
          { session, projection: { businessId: 1, role: 1 } },
        )
        if (!user) return
        found = true
        const ownedBusiness = await Business.collection.findOne(
          { owner: userId },
          { session, projection: { _id: 1 } },
        )
        if (ownedBusiness) {
          const replacementOwner = await User.collection.findOne(
            { businessId: ownedBusiness._id, _id: { $ne: userId }, role: 'owner', status: 'active' },
            { session, projection: { _id: 1 } },
          )
          await Business.collection.updateOne(
            { _id: ownedBusiness._id },
            replacementOwner
              ? { $set: { owner: replacementOwner._id, status: 'active', updatedAt: new Date() } }
              : { $unset: { owner: '' }, $set: { status: 'archived', updatedAt: new Date() } },
            { session },
          )
        }
        await EmailVerification.collection.deleteMany({ user: userId }, { session })
        await User.collection.deleteOne({ _id: userId }, { session })
      })
      if (!found) {
        res.status(404).json({ message: 'User not found.' })
        return
      }
    } finally {
      await session.endSession()
    }
    console.info(`Platform administrator ${req.authUser!.email} deleted user ${req.params.id}.`)
    res.status(204).end()
  } catch (error) {
    next(error)
  }
})

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
