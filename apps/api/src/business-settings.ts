import { Router } from 'express'
import { z } from 'zod'
import { requireAuth } from './middleware.js'
import { Business, defaultExpenseCategories } from './models.js'
import { recordAudit } from './domain/workflows.js'

const settingsInput = z.object({
  name: z.string().trim().min(2).max(160),
  phone: z.string().trim().max(40),
  email: z.string().trim().email().max(254).or(z.literal('')),
  address: z.string().trim().max(500),
  invoiceFooter: z.string().trim().max(500),
  currency: z.string().trim().regex(/^[A-Za-z]{3}$/).transform((value) => value.toUpperCase()),
  expenseCategories: z.array(z.string().trim().min(1).max(100)).max(50)
    .transform((categories) => [...new Set(categories)]),
})

export const businessSettingsRouter = Router()
businessSettingsRouter.use(requireAuth)

businessSettingsRouter.get('/business/settings', async (req, res, next) => {
  try {
    const business = await Business.findById(req.authUser!.businessId).lean()
    if (!business) {
      res.status(404).json({ message: 'Business workspace not found.' })
      return
    }
    res.json({
      item: {
        name: business.name,
        phone: business.phone ?? '',
        email: business.email ?? '',
        address: business.address ?? '',
        invoiceFooter: business.invoiceFooter ?? '',
        currency: business.currency ?? 'BDT',
        expenseCategories: business.expenseCategories ?? defaultExpenseCategories,
      },
    })
  } catch (error) { next(error) }
})

businessSettingsRouter.patch('/business/settings', async (req, res, next) => {
  try {
    if (req.authUser?.role !== 'owner') {
      res.status(403).json({ message: 'Only the workspace owner can update business settings.' })
      return
    }
    const input = settingsInput.partial().parse(req.body)
    if (Object.keys(input).length === 0) {
      res.status(400).json({ message: 'Provide at least one business setting to update.' })
      return
    }
    const business = await Business.findByIdAndUpdate(
      req.authUser!.businessId,
      { $set: input },
      { returnDocument: 'after', runValidators: true },
    )
    if (!business) {
      res.status(404).json({ message: 'Business workspace not found.' })
      return
    }
    await recordAudit(String(req.authUser!.id), 'updated', 'business', String(business._id), 'Updated business settings')
    res.json({
      item: {
        name: business.name,
        phone: business.phone ?? '',
        email: business.email ?? '',
        address: business.address ?? '',
        invoiceFooter: business.invoiceFooter ?? '',
        currency: business.currency ?? 'BDT',
        expenseCategories: business.expenseCategories ?? defaultExpenseCategories,
      },
    })
  } catch (error) { next(error) }
})
