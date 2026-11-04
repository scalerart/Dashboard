import { Router } from 'express'
import mongoose from 'mongoose'
import { requireAuth } from './middleware.js'
import { Customer } from './models.js'
import {
  customerInputSchema,
  customerQuerySchema,
  customerStatusSchema,
  escapeRegex,
} from './customer-validation.js'
import { recordAudit } from './domain/workflows.js'

export const customersRouter = Router()
customersRouter.use(requireAuth)

customersRouter.get('/', async (req, res, next) => {
  try {
    const query = customerQuerySchema.parse(req.query)
    const filter: Record<string, unknown> = {}
    if (query.status !== 'all') filter.status = query.status
    if (query.search) {
      const search = new RegExp(escapeRegex(query.search), 'i')
      filter.$or = [{ name: search }, { email: search }, { phone: search }]
    }

    const [items, total] = await Promise.all([
      Customer.find(filter)
        .sort({ name: 1, _id: 1 })
        .skip((query.page - 1) * query.limit)
        .limit(query.limit)
        .lean(),
      Customer.countDocuments(filter),
    ])
    res.json({
      items: items.map((item) => ({
        id: String(item._id),
        name: item.name,
        phone: item.phone,
        email: item.email,
        address: item.address,
        status: item.status,
        createdAt: item.createdAt,
      })),
      pagination: {
        page: query.page,
        limit: query.limit,
        total,
        pages: Math.ceil(total / query.limit),
      },
    })
  } catch (error) {
    next(error)
  }
})

customersRouter.post('/', async (req, res, next) => {
  try {
    const input = customerInputSchema.parse(req.body)
    const customer = await Customer.create(input)
    await recordAudit(String(req.authUser!.id), 'created', 'customer', String(customer._id), `Created customer ${customer.name}`)
    res.status(201).json({
      item: {
        id: String(customer._id),
        name: customer.name,
        phone: customer.phone,
        email: customer.email,
        address: customer.address,
        status: customer.status,
        createdAt: customer.createdAt,
      },
    })
  } catch (error) {
    next(error)
  }
})

customersRouter.patch('/:id', async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      res.status(400).json({ message: 'Customer ID is invalid.' })
      return
    }
    const input = customerInputSchema.partial().parse(req.body)
    if (Object.keys(input).length === 0) {
      res.status(400).json({ message: 'Provide at least one customer field to update.' })
      return
    }
    const customer = await Customer.findByIdAndUpdate(
      req.params.id,
      { $set: input },
      { new: true, runValidators: true },
    ).lean()
    if (!customer) {
      res.status(404).json({ message: 'Customer not found.' })
      return
    }
    await recordAudit(String(req.authUser!.id), 'updated', 'customer', String(customer._id), `Updated customer ${customer.name}`)
    res.json({
      item: {
        id: String(customer._id),
        name: customer.name,
        phone: customer.phone,
        email: customer.email,
        address: customer.address,
        status: customer.status,
        createdAt: customer.createdAt,
      },
    })
  } catch (error) {
    next(error)
  }
})

customersRouter.patch('/:id/status', async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      res.status(400).json({ message: 'Customer ID is invalid.' })
      return
    }
    const { status } = customerStatusSchema.parse(req.body)
    const customer = await Customer.findByIdAndUpdate(
      req.params.id,
      { $set: { status } },
      { new: true, runValidators: true },
    ).lean()
    if (!customer) {
      res.status(404).json({ message: 'Customer not found.' })
      return
    }
    await recordAudit(String(req.authUser!.id), status === 'inactive' ? 'archived' : 'restored', 'customer', String(customer._id), `${status === 'inactive' ? 'Archived' : 'Restored'} customer ${customer.name}`)
    res.json({
      item: {
        id: String(customer._id),
        name: customer.name,
        phone: customer.phone,
        email: customer.email,
        address: customer.address,
        status: customer.status,
        createdAt: customer.createdAt,
      },
    })
  } catch (error) {
    next(error)
  }
})
