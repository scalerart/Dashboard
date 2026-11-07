import { Router } from 'express'
import mongoose from 'mongoose'
import { requireAuth } from './middleware.js'
import { BusinessError } from './business.js'
import { BusinessDocument, Customer, Invoice, LedgerEntry, Order, Payment } from './models.js'
import {
  customerInputSchema,
  customerLookupSchema,
  customerQuerySchema,
  customerStatusSchema,
  escapeRegex,
  normalizePhone,
} from './customer-validation.js'
import { recordAudit, withTransaction } from './domain/workflows.js'

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
    const orderCounts = items.length
      ? await Order.aggregate([
          { $match: { customer: { $in: items.map((item) => item._id) } } },
          { $group: { _id: '$customer', count: { $sum: 1 } } },
        ])
      : []
    const orderCountByCustomer = new Map(orderCounts.map((item) => [String(item._id), item.count]))
    res.json({
      items: items.map((item) => ({
        id: String(item._id),
        name: item.name,
        phone: item.phone,
        email: item.email,
        address: item.address,
        orderCount: orderCountByCustomer.get(String(item._id)) ?? 0,
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

customersRouter.get('/lookup', async (req, res, next) => {
  try {
    const { phone } = customerLookupSchema.parse(req.query)
    const customer = await Customer.findOne({ phoneNormalized: normalizePhone(phone) }).lean()
    res.json({
      item: customer
        ? {
            id: String(customer._id),
            name: customer.name,
            phone: customer.phone,
            email: customer.email,
            address: customer.address,
            status: customer.status,
          }
        : null,
    })
  } catch (error) {
    next(error)
  }
})

customersRouter.post('/', async (req, res, next) => {
  try {
    const input = customerInputSchema.parse(req.body)
    const phoneNormalized = normalizePhone(input.phone)
    if (phoneNormalized && await Customer.exists({ phoneNormalized })) {
      res.status(409).json({ message: 'A customer with this mobile number already exists.' })
      return
    }
    const customer = await Customer.create({ ...input, ...(phoneNormalized ? { phoneNormalized } : {}) })
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

customersRouter.get('/:id/statement', async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      res.status(400).json({ message: 'Customer ID is invalid.' })
      return
    }
    const customer = await Customer.findById(req.params.id).lean()
    if (!customer) {
      res.status(404).json({ message: 'Customer not found.' })
      return
    }
    const [orders, invoices, payments] = await Promise.all([
      Order.find({ customer: customer._id }).sort({ orderDate: -1 }).lean(),
      Invoice.find({ customer: customer._id }).sort({ issueDate: -1 }).populate('order', 'orderNumber').lean(),
      Payment.find({ customer: customer._id }).sort({ receivedAt: -1 }).populate('invoice', 'invoiceNumber').lean(),
    ])
    const activeInvoices = invoices.filter((invoice) => invoice.status !== 'void')
    const activeOrders = orders.filter((order) => order.status !== 'cancelled')
    const invoiceByOrder = new Map(
      activeInvoices
        .filter((invoice) => invoice.order)
        .map((invoice) => {
          const order = invoice.order as unknown as { _id?: unknown } | null
          return [String(order?._id ?? invoice.order), invoice] as const
        }),
    )
    const unbilledOrders = activeOrders.filter((order) => !invoiceByOrder.has(String(order._id)))
    const invoiceTotalMinor = activeInvoices.reduce((total, invoice) => total + invoice.totalMinor, 0)
    const invoicePaidMinor = activeInvoices.reduce((total, invoice) => total + invoice.paidMinor, 0)
    const unbilledTotalMinor = unbilledOrders.reduce((total, order) => total + order.amountMinor, 0)
    res.json({
      customer: {
        id: String(customer._id),
        name: customer.name,
        phone: customer.phone,
        email: customer.email,
        address: customer.address,
        status: customer.status,
      },
      summary: {
        orderCount: activeOrders.length,
        invoicedMinor: invoiceTotalMinor + unbilledTotalMinor,
        invoicePaidMinor,
        dueMinor: activeInvoices.reduce((total, invoice) => total + Math.max(0, invoice.totalMinor - invoice.paidMinor), 0) + unbilledTotalMinor,
        paymentsReceivedMinor: payments.reduce((total, payment) => total + payment.amountMinor, 0),
      },
      orders: orders.map((order) => {
        const invoice = invoiceByOrder.get(String(order._id))
        return {
          id: String(order._id),
          orderNumber: order.orderNumber,
          description: order.description,
          quantity: order.quantity ?? 1,
          amountMinor: order.amountMinor,
          paidMinor: invoice?.paidMinor ?? 0,
          dueMinor: invoice
            ? Math.max(0, invoice.totalMinor - invoice.paidMinor)
            : order.status === 'cancelled' ? 0 : order.amountMinor,
          invoiceId: String(invoice?._id ?? ''),
          status: order.status,
          orderDate: order.orderDate,
          deliveryDate: order.dueDate,
        }
      }),
      invoices: invoices.map((invoice) => ({
        id: String(invoice._id),
        invoiceNumber: invoice.invoiceNumber,
        orderNumber: (invoice.order as unknown as { orderNumber?: string } | null)?.orderNumber ?? '',
        totalMinor: invoice.totalMinor,
        paidMinor: invoice.paidMinor,
        dueMinor: invoice.status === 'void' ? 0 : Math.max(0, invoice.totalMinor - invoice.paidMinor),
        status: invoice.status,
        issueDate: invoice.issueDate,
        dueDate: invoice.dueDate,
      })),
      payments: payments.map((payment) => ({
        id: String(payment._id),
        paymentNumber: payment.paymentNumber,
        invoiceNumber: (payment.invoice as unknown as { invoiceNumber?: string } | null)?.invoiceNumber ?? '',
        amountMinor: payment.amountMinor,
        method: payment.method,
        reference: payment.reference,
        receivedAt: payment.receivedAt,
      })),
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
    if (input.phone !== undefined) {
      const phoneNormalized = normalizePhone(input.phone)
      if (phoneNormalized && await Customer.exists({ phoneNormalized, _id: { $ne: req.params.id } })) {
        res.status(409).json({ message: 'A customer with this mobile number already exists.' })
        return
      }
      if (phoneNormalized) Object.assign(input, { phoneNormalized })
    }
    const update = {
      $set: input,
      ...(input.phone !== undefined && !normalizePhone(input.phone) ? { $unset: { phoneNormalized: 1 } } : {}),
    }
    const customer = await Customer.findByIdAndUpdate(
      req.params.id,
      update,
      { returnDocument: 'after', runValidators: true },
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
      { returnDocument: 'after', runValidators: true },
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

customersRouter.delete('/:id', async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      res.status(400).json({ message: 'Customer ID is invalid.' })
      return
    }
    await withTransaction(async (session) => {
      const customer = await Customer.findById(req.params.id).session(session)
      if (!customer) throw new BusinessError(404, 'Customer not found.')
      if (await Order.exists({ customer: customer._id }).session(session)) {
        throw new BusinessError(409, 'This customer has orders and cannot be deleted. Keep the customer record to preserve its order history.')
      }
      const invoices = await Invoice.find({ customer: customer._id }).select('_id').session(session)
      const invoiceIds = invoices.map((invoice) => invoice._id)
      const payments = await Payment.find({ customer: customer._id }).select('_id').session(session)
      const paymentIds = payments.map((payment) => payment._id)
      const documentFilters = [
        ...(invoiceIds.length ? [{ entityType: 'invoice', entityId: { $in: invoiceIds } }] : []),
        ...(paymentIds.length ? [{ entityType: 'payment', entityId: { $in: paymentIds } }] : []),
      ]
      if (documentFilters.length) await BusinessDocument.deleteMany({ $or: documentFilters }).session(session)
      if (invoiceIds.length) {
        await Invoice.deleteMany({ _id: { $in: invoiceIds } }).session(session)
      }
      if (paymentIds.length) {
        await LedgerEntry.deleteMany({ sourceType: 'payment', sourceId: { $in: paymentIds } }).session(session)
        await Payment.deleteMany({ _id: { $in: paymentIds } }).session(session)
      }
      await Customer.deleteOne({ _id: customer._id }).session(session)
      await recordAudit(String(req.authUser!.id), 'deleted', 'customer', String(customer._id), `Permanently deleted customer ${customer.name}`, session)
    })
    res.status(204).end()
  } catch (error) {
    next(error)
  }
})
