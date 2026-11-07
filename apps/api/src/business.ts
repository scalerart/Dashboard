import { Router } from 'express'
import mongoose from 'mongoose'
import { z } from 'zod'
import { config } from './config.js'
import { calculateInvoiceTotalMinor, calculateLineGrossMinor, calculateLineTotalMinor, calculateOrderTotalsMinor, weightedAverageCostMinor } from './domain/accounting.js'
import { csvCell } from './domain/csv.js'
import { escapeRegex, normalizePhone } from './customer-validation.js'
import {
  createSearchFilter,
  isMongoDuplicateKeyError,
  nextDocumentNumber,
  paginationSchema,
  paymentMethodSchema,
  recordAudit,
  withTransaction,
} from './domain/workflows.js'
import { requireAuth } from './middleware.js'
import {
  AuditLog,
  Business,
  BusinessDocument,
  Customer,
  Expense,
  Income,
  Invoice,
  LedgerEntry,
  Order,
  Payment,
  Product,
  Purchase,
  StockMovement,
  Supplier,
  SupplierPayment,
} from './models.js'

const objectId = z.string().refine(mongoose.isValidObjectId, 'A valid record ID is required.')
const positiveMinor = z.number().int().safe().positive()
const nonNegativeMinor = z.number().int().safe().nonnegative()
const amountQuantity = z.number().positive().max(1_000_000)
const dateInput = z.coerce.date()

const orderInput = z.object({
  customerId: objectId.optional(),
  customerName: z.string().trim().min(2).max(160).optional(),
  phone: z.string().trim().min(7).max(40).regex(/^[+\d()\s.-]+$/).optional(),
  address: z.string().trim().max(500).default(''),
  description: z.string().trim().min(2).max(500),
  amountMinor: positiveMinor,
  quantity: z.number().positive().max(1_000_000).default(1),
  discountMinor: nonNegativeMinor.default(0),
  advanceMinor: nonNegativeMinor.default(0),
  advanceMethod: paymentMethodSchema.default('cash'),
  orderDate: dateInput.default(() => new Date()),
  deliveryDate: dateInput.optional(),
  dueDate: dateInput.optional(),
}).superRefine((input, context) => {
  if (!input.customerId) {
    if (!input.customerName) context.addIssue({ code: 'custom', path: ['customerName'], message: 'Customer name is required.' })
    if (!input.phone || normalizePhone(input.phone).length < 7) context.addIssue({ code: 'custom', path: ['phone'], message: 'Enter a valid customer mobile number.' })
  }
  if (input.discountMinor >= input.amountMinor) {
    context.addIssue({ code: 'custom', path: ['discountMinor'], message: 'Discount must be less than the total amount.' })
  }
  if (input.advanceMinor > input.amountMinor - input.discountMinor) {
    context.addIssue({ code: 'custom', path: ['advanceMinor'], message: 'Advance cannot exceed the discounted order total.' })
  }
})
const orderStatusInput = z.object({
  status: z.enum(['pending', 'processing', 'printing', 'ready', 'delivered', 'cancelled']),
})

const invoiceInput = z.object({
  customerId: objectId,
  orderId: objectId.optional(),
  issueDate: dateInput.default(() => new Date()),
  dueDate: dateInput.optional(),
  notes: z.string().trim().max(1000).default(''),
  lines: z.array(z.object({
    description: z.string().trim().min(1).max(250),
    quantity: amountQuantity,
    unitPriceMinor: nonNegativeMinor,
    discountPercent: z.number().min(0).max(100).default(0),
  })).min(1).max(100),
})

const paymentInput = z.object({
  customerId: objectId,
  invoiceId: objectId.optional(),
  amountMinor: positiveMinor,
  method: paymentMethodSchema,
  reference: z.string().trim().max(120).default(''),
  receivedAt: dateInput.default(() => new Date()),
})

const moneyInput = z.object({
  category: z.string().trim().min(1).max(100),
  description: z.string().trim().min(2).max(500),
  amountMinor: positiveMinor,
  paymentMethod: paymentMethodSchema.default('cash'),
  reference: z.string().trim().max(120).default(''),
  date: dateInput.default(() => new Date()),
})

const supplierInput = z.object({
  name: z.string().trim().min(2).max(160),
  phone: z.string().trim().max(40).default(''),
  email: z.string().trim().email().max(254).or(z.literal('')).default(''),
  address: z.string().trim().max(500).default(''),
})
const recordStatusInput = z.object({ status: z.enum(['active', 'inactive']) })

const productInput = z.object({
  sku: z.string().trim().min(1).max(60),
  name: z.string().trim().min(2).max(160),
  category: z.string().trim().min(1).max(100),
  unit: z.string().trim().min(1).max(30),
  reorderLevel: z.number().nonnegative().default(0),
  costMinor: nonNegativeMinor.default(0),
})

const purchaseInput = z.object({
  supplierId: objectId,
  purchasedAt: dateInput.default(() => new Date()),
  paidMinor: nonNegativeMinor,
  paymentMethod: paymentMethodSchema.default('cash'),
  lines: z.array(z.object({
    productId: objectId,
    quantity: amountQuantity,
    unitCostMinor: nonNegativeMinor,
  })).min(1).max(100),
})

const stockAdjustmentInput = z.object({
  quantityChange: z.number().refine((value) => Number.isFinite(value) && value !== 0 && Math.abs(value) <= 1_000_000),
  reason: z.string().trim().min(3).max(250),
})

const invoiceStatusInput = z.object({ status: z.enum(['sent', 'void']) })

async function recordCustomerPayment(
  input: {
    customerId: mongoose.Types.ObjectId
    invoiceId?: mongoose.Types.ObjectId
    amountMinor: number
    method: 'cash' | 'bank' | 'bkash' | 'nagad' | 'rocket' | 'other'
    reference: string
    receivedAt: Date
    idempotencyKey?: string
    requestHash?: string
  },
  actorId: string,
  session: mongoose.ClientSession,
) {
  const invoice = input.invoiceId ? await Invoice.findById(input.invoiceId).session(session) : null
  if (input.invoiceId && (
    !invoice || String(invoice.customer) !== String(input.customerId) ||
    ['draft', 'void'].includes(invoice.status)
  )) {
    throw new BusinessError(400, 'Choose a valid, issued invoice belonging to this customer.')
  }
  if (invoice && input.amountMinor > Math.max(0, invoice.totalMinor - invoice.paidMinor)) {
    throw new BusinessError(400, 'Payment exceeds the invoice balance.')
  }
  const [payment] = await Payment.create([{
    paymentNumber: await nextDocumentNumber('PAY', session),
    customer: input.customerId,
    ...(invoice ? { invoice: invoice._id } : {}),
    amountMinor: input.amountMinor,
    method: input.method,
    reference: input.reference,
    receivedAt: input.receivedAt,
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey, requestHash: input.requestHash } : {}),
  }], { session })
  if (invoice) {
    invoice.paidMinor += input.amountMinor
    invoice.status = invoice.paidMinor >= invoice.totalMinor ? 'paid' : 'partial'
    await invoice.save({ session })
  }
  await LedgerEntry.create([{
    entryNumber: await nextDocumentNumber('LED', session),
    direction: 'in',
    category: 'Customer payment',
    description: `Receipt ${payment.paymentNumber}`,
    amountMinor: payment.amountMinor,
    paymentMethod: payment.method,
    reference: payment.reference || payment.paymentNumber,
    sourceType: 'payment',
    sourceId: payment._id,
    postedAt: payment.receivedAt,
  }], { session })
  await recordAudit(actorId, 'received', 'payment', String(payment._id), `Recorded ${payment.paymentNumber}`, session)
  return payment
}

async function ensureOrderInvoice(
  order: InstanceType<typeof Order>,
  actorId: string,
  session: mongoose.ClientSession,
) {
  const invoice = order.invoice
    ? await Invoice.findById(order.invoice).session(session)
    : await Invoice.findOne({ order: order._id }).session(session)
  if (invoice) {
    if (invoice.status !== 'void') {
      if (!order.invoice || String(order.invoice) !== String(invoice._id)) {
        order.invoice = invoice._id
        await order.save({ session })
      }
      return invoice
    }
    if (order.invoice && String(order.invoice) === String(invoice._id)) {
      order.invoice = undefined
      await order.save({ session })
    }
    if (order.status === 'cancelled') throw new BusinessError(409, 'A cancelled order cannot receive a new invoice.')
  }
  if (order.status === 'cancelled') throw new BusinessError(409, 'A cancelled order cannot receive a new invoice.')
  const customer = await Customer.findById(order.customer).session(session)
  if (!customer) throw new BusinessError(404, 'The order customer no longer exists.')
  const grossMinor = order.grossMinor ?? order.amountMinor
  const discountMinor = order.discountMinor ?? 0
  const quantity = order.quantity ?? 1
  const [created] = await Invoice.create([{
    invoiceNumber: await nextDocumentNumber('INV', session),
    customer: customer._id,
    customerName: order.customerName || customer.name,
    customerPhone: order.customerPhone || customer.phone,
    customerAddress: order.customerAddress || customer.address,
    customerEmail: customer.email,
    order: order._id,
    lines: [{
      description: order.description,
      quantity,
      unitPriceMinor: Math.round(grossMinor / quantity),
      discountPercent: 0,
      grossMinor,
      discountMinor,
      totalMinor: order.amountMinor,
    }],
    totalMinor: order.amountMinor,
    paidMinor: 0,
    issueDate: order.orderDate,
    dueDate: order.dueDate,
    notes: `Order ${order.orderNumber}`,
    status: 'sent',
  }], { session })
  order.invoice = created._id
  await order.save({ session })
  await recordAudit(actorId, 'created', 'invoice', String(created._id), `Issued invoice ${created.invoiceNumber} for ${order.orderNumber}`, session)
  return created
}

export const businessRouter = Router()
businessRouter.use(requireAuth)

businessRouter.get('/orders', async (req, res, next) => {
  try {
    const query = paginationSchema.parse(req.query)
    const searchPattern = new RegExp(escapeRegex(query.search), 'i')
    const matchingCustomers = query.search
      ? await Customer.find({ $or: [{ name: searchPattern }, { phone: searchPattern }] }).distinct('_id')
      : []
    const filter = {
      ...(query.search ? { $or: [
        { orderNumber: searchPattern },
        { description: searchPattern },
        { customer: { $in: matchingCustomers } },
      ] } : {}),
      status: { $ne: 'cancelled' },
      ...(query.from || query.to ? { orderDate: dateRange(query.from, query.to) } : {}),
    }
    const [items, total] = await Promise.all([
      Order.find(filter).sort({ orderDate: -1 }).skip((query.page - 1) * query.limit).limit(query.limit).populate('customer', 'name phone address').populate('invoice', 'invoiceNumber totalMinor paidMinor status').lean(),
      Order.countDocuments(filter),
    ])
    res.json({
      items: items.map((item) => {
        const linkedInvoice = item.invoice as unknown as { _id?: unknown; invoiceNumber?: string; totalMinor?: number; paidMinor?: number; status?: string } | null
        const invoice = linkedInvoice?.status === 'void' ? null : linkedInvoice
        const paidMinor = invoice?.paidMinor ?? 0
        const totalMinor = invoice?.totalMinor ?? item.amountMinor
        return {
        id: String(item._id),
        orderNumber: item.orderNumber,
        customerId: String(item.customer?._id ?? ''),
        customerName: item.customerName || (item.customer as unknown as { name?: string } | null)?.name || 'Unknown customer',
        customerPhone: item.customerPhone || (item.customer as unknown as { phone?: string } | null)?.phone || '',
        customerAddress: item.customerAddress || (item.customer as unknown as { address?: string } | null)?.address || '',
        description: item.description,
        amountMinor: item.amountMinor,
        grossMinor: item.grossMinor ?? item.amountMinor,
        discountMinor: item.discountMinor ?? 0,
        quantity: item.quantity ?? 1,
        paidMinor,
        dueMinor: Math.max(0, totalMinor - paidMinor),
        invoiceId: String(invoice?._id ?? ''),
        invoiceNumber: invoice?.invoiceNumber ?? '',
        status: item.status,
        orderDate: item.orderDate,
        dueDate: item.dueDate,
        deliveryDate: item.dueDate,
        }
      }),
      pagination: pagination(query.page, query.limit, total),
    })
  } catch (error) { next(error) }
})

businessRouter.post('/orders', async (req, res, next) => {
  try {
    const input = orderInput.parse(req.body)
    const phoneNormalized = input.phone ? normalizePhone(input.phone) : ''
    const totals = calculateOrderTotalsMinor(input.amountMinor, input.discountMinor, input.advanceMinor)
    const existingKey = req.get('Idempotency-Key')
    if (existingKey && !/^[\w.-]{8,120}$/.test(existingKey)) {
      res.status(400).json({ message: 'Idempotency-Key must be 8–120 letters, digits, dots, underscores or hyphens.' })
      return
    }
    const requestHash = JSON.stringify({ ...input, phoneNormalized })
    if (existingKey) {
      const existing = await Order.findOne({ idempotencyKey: existingKey }).populate('invoice', 'invoiceNumber totalMinor paidMinor').lean()
      if (existing) {
        if (existing.requestHash !== requestHash) {
          res.status(409).json({ message: 'This idempotency key was already used for a different order.' })
          return
        }
        const invoice = existing.invoice as unknown as { _id?: unknown; invoiceNumber?: string; totalMinor?: number; paidMinor?: number } | null
        res.status(200).json({ item: {
          id: String(existing._id),
          orderNumber: existing.orderNumber,
          customerId: String(existing.customer),
          invoiceId: String(invoice?._id ?? ''),
          invoiceNumber: invoice?.invoiceNumber ?? '',
          totalMinor: invoice?.totalMinor ?? existing.amountMinor,
          paidMinor: invoice?.paidMinor ?? 0,
          dueMinor: Math.max(0, (invoice?.totalMinor ?? existing.amountMinor) - (invoice?.paidMinor ?? 0)),
          replayed: true,
        } })
        return
      }
    }
    let order: { order: InstanceType<typeof Order>; invoice: InstanceType<typeof Invoice> }
    try {
      order = await withTransaction(async (session) => {
      let customer
      if (input.customerId) {
        customer = await Customer.findOne({ _id: input.customerId, status: 'active' }).session(session)
        if (!customer) throw new BusinessError(400, 'Select an active customer for this job.')
      } else {
        customer = await Customer.findOne({ phoneNormalized }).session(session)
        if (!customer) {
          const [createdCustomer] = await Customer.create([{
            name: input.customerName!,
            phone: input.phone!,
            phoneNormalized,
            address: input.address,
          }], { session })
          customer = createdCustomer
        }
      }
      const customerName = input.customerName ?? customer.name
      const customerPhone = input.phone ?? customer.phone
      const customerAddress = input.customerId ? customer.address : input.address
      const [created] = await Order.create([{
        orderNumber: await nextDocumentNumber('ORD', session),
        customer: customer._id,
        customerName,
        customerPhone,
        customerAddress,
        description: input.description,
        quantity: input.quantity,
        grossMinor: input.amountMinor,
        discountMinor: input.discountMinor,
        amountMinor: totals.totalMinor,
        ...(existingKey ? { idempotencyKey: existingKey, requestHash } : {}),
        orderDate: input.orderDate,
        dueDate: input.deliveryDate ?? input.dueDate,
      }], { session })
      const invoice = await ensureOrderInvoice(created, String(req.authUser!.id), session)
      if (input.advanceMinor > 0) {
        await recordCustomerPayment({
          customerId: customer._id,
          invoiceId: invoice._id,
          amountMinor: input.advanceMinor,
          method: input.advanceMethod,
          reference: `Advance for order ${created.orderNumber}`,
          receivedAt: input.orderDate,
        }, String(req.authUser!.id), session)
        invoice.paidMinor += input.advanceMinor
        invoice.status = invoice.paidMinor >= invoice.totalMinor ? 'paid' : 'partial'
      }
      await recordAudit(String(req.authUser!.id), 'created', 'order', String(created._id), `Created job ${created.orderNumber}`, session)
      return { order: created, invoice }
      })
    } catch (error) {
      if (existingKey && isMongoDuplicateKeyError(error)) {
        const replay = await Order.findOne({ idempotencyKey: existingKey }).populate('invoice', 'invoiceNumber totalMinor paidMinor').lean()
        if (replay) {
          if (replay.requestHash !== requestHash) {
            res.status(409).json({ message: 'This idempotency key was already used for a different order.' })
            return
          }
          const invoice = replay.invoice as unknown as { _id?: unknown; invoiceNumber?: string; totalMinor?: number; paidMinor?: number } | null
          res.status(200).json({ item: {
            id: String(replay._id),
            orderNumber: replay.orderNumber,
            customerId: String(replay.customer),
            invoiceId: String(invoice?._id ?? ''),
            invoiceNumber: invoice?.invoiceNumber ?? '',
            totalMinor: invoice?.totalMinor ?? replay.amountMinor,
            paidMinor: invoice?.paidMinor ?? 0,
            dueMinor: Math.max(0, (invoice?.totalMinor ?? replay.amountMinor) - (invoice?.paidMinor ?? 0)),
            replayed: true,
          } })
          return
        }
      }
      throw error
    }
    res.status(201).json({ item: {
      id: String(order.order._id),
      orderNumber: order.order.orderNumber,
      customerId: String(order.order.customer),
      invoiceId: String(order.invoice._id),
      invoiceNumber: order.invoice.invoiceNumber,
      totalMinor: order.invoice.totalMinor,
      paidMinor: order.invoice.paidMinor,
      dueMinor: Math.max(0, order.invoice.totalMinor - order.invoice.paidMinor),
    } })
  } catch (error) { next(error) }
})

businessRouter.post('/orders/:id/invoice', async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) throw new BusinessError(400, 'Order ID is invalid.')
    const invoice = await withTransaction(async (session) => {
      const order = await Order.findById(req.params.id).session(session)
      if (!order) throw new BusinessError(404, 'Order not found.')
      return ensureOrderInvoice(order, String(req.authUser!.id), session)
    })
    res.status(200).json({ item: {
      id: String(invoice._id),
      invoiceNumber: invoice.invoiceNumber,
      totalMinor: invoice.totalMinor,
      paidMinor: invoice.paidMinor,
      dueMinor: Math.max(0, invoice.totalMinor - invoice.paidMinor),
    } })
  } catch (error) { next(error) }
})

businessRouter.patch('/orders/:id/status', async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      res.status(400).json({ message: 'Order ID is invalid.' })
      return
    }
    const { status } = orderStatusInput.parse(req.body)
    const order = await withTransaction(async (session) => {
      const updated = await Order.findByIdAndUpdate(req.params.id, { $set: { status } }, { returnDocument: 'after', runValidators: true, session })
      if (updated) await recordAudit(String(req.authUser!.id), 'status_changed', 'order', String(updated._id), `Updated ${updated.orderNumber} to ${status}`, session)
      return updated
    })

    if (!order) {
      res.status(404).json({ message: 'Order not found.' })
      return
    }
    res.json({ item: { id: String(order._id), orderNumber: order.orderNumber, status: order.status } })
  } catch (error) { next(error) }
})

businessRouter.delete('/orders/:id', async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) throw new BusinessError(400, 'Order ID is invalid.')
    await withTransaction(async (session) => {
      const order = await Order.findById(req.params.id).session(session)
      if (!order) throw new BusinessError(404, 'Order not found.')
      const invoices = await Invoice.find({
        $or: [{ order: order._id }, ...(order.invoice ? [{ _id: order.invoice }] : [])],
      }).session(session)
      const invoiceIds = invoices.map((invoice) => invoice._id)
      if (invoices.some((invoice) => invoice.paidMinor > 0) ||
        (invoiceIds.length && await Payment.exists({ invoice: { $in: invoiceIds } }).session(session))) {
          throw new BusinessError(409, 'Delete this order’s payment receipts from Payments first. The order and its invoice can be deleted after their recorded payments are removed.')
      }
      if (invoiceIds.length) {
        await BusinessDocument.deleteMany({ entityType: 'invoice', entityId: { $in: invoiceIds } }).session(session)
        await Invoice.deleteMany({ _id: { $in: invoiceIds } }).session(session)
      }
      await BusinessDocument.deleteMany({ entityType: 'order', entityId: order._id }).session(session)
      await Order.deleteOne({ _id: order._id }).session(session)
      for (const invoice of invoices) {
        await recordAudit(String(req.authUser!.id), 'deleted', 'invoice', String(invoice._id), `Permanently deleted invoice ${invoice.invoiceNumber}`, session)
      }
      await recordAudit(String(req.authUser!.id), 'deleted', 'order', String(order._id), `Permanently deleted order ${order.orderNumber}`, session)
    })
    res.status(204).end()
  } catch (error) { next(error) }
})

businessRouter.get('/invoices', async (req, res, next) => {
  try {
    const query = paginationSchema.parse(req.query)
    const filter = {
      ...createSearchFilter(query.search, ['invoiceNumber', 'notes']),
      ...(query.from || query.to ? { issueDate: dateRange(query.from, query.to) } : {}),
    }
    const [items, total] = await Promise.all([
      Invoice.find(filter).sort({ issueDate: -1 }).skip((query.page - 1) * query.limit).limit(query.limit).populate('customer', 'name email').lean(),
      Invoice.countDocuments(filter),
    ])
    res.json({
      items: items.map((item) => ({
        id: String(item._id), invoiceNumber: item.invoiceNumber,
        customerId: String(item.customer?._id ?? ''),
        customerName: item.customerName || (item.customer as unknown as { name?: string } | null)?.name || 'Unknown customer',
        customerEmail: item.customerEmail || (item.customer as unknown as { email?: string } | null)?.email || '',
        issueDate: item.issueDate, dueDate: item.dueDate, totalMinor: item.totalMinor,
        paidMinor: item.paidMinor, dueMinor: Math.max(0, item.totalMinor - item.paidMinor),
        status: item.status,
      })),
      pagination: pagination(query.page, query.limit, total),
    })
  } catch (error) { next(error) }
})

businessRouter.post('/invoices', async (req, res, next) => {
  try {
    const input = invoiceInput.parse(req.body)
    const customer = await Customer.findOne({ _id: input.customerId, status: 'active' }).lean()
    if (!customer) {
      res.status(400).json({ message: 'Select an active customer for this invoice.' })
      return
    }
    const order = input.orderId ? await Order.findById(input.orderId).lean() : undefined
    if (input.orderId && (!order || String(order.customer) !== String(customer._id))) {
      res.status(400).json({ message: 'The selected job does not belong to this customer.' })
      return
    }
    let lines: (typeof input.lines[number] & { grossMinor: number; discountMinor: number; totalMinor: number })[]
    let totalMinor: number
    try {
      lines = input.lines.map((line) => ({
        ...line,
        grossMinor: calculateLineGrossMinor(line.quantity, line.unitPriceMinor),
        totalMinor: calculateLineTotalMinor(line.quantity, line.unitPriceMinor, line.discountPercent),
        discountMinor: calculateLineGrossMinor(line.quantity, line.unitPriceMinor) -
          calculateLineTotalMinor(line.quantity, line.unitPriceMinor, line.discountPercent),
      }))
      totalMinor = calculateInvoiceTotalMinor(input.lines)
    } catch (error) {
      if (error instanceof RangeError) throw new BusinessError(400, error.message)
      throw error
    }
    if (totalMinor <= 0) {
      res.status(400).json({ message: 'Invoice total must be greater than zero.' })
      return
    }
    const invoice = await withTransaction(async (session) => {
      if (order) {
        const currentOrder = await Order.findById(order._id).session(session)
        if (!currentOrder) throw new BusinessError(404, 'The selected job no longer exists.')
        const existingInvoice = currentOrder.invoice
          ? await Invoice.findById(currentOrder.invoice).session(session)
          : await Invoice.findOne({ order: currentOrder._id }).session(session)
        if (existingInvoice && existingInvoice.status !== 'void') {
          throw new BusinessError(409, 'This order already has an invoice.')
        }
      }
      const [created] = await Invoice.create([{
        invoiceNumber: await nextDocumentNumber('INV', session),
        customer: customer._id,
        customerName: customer.name,
        customerPhone: customer.phone,
        customerAddress: customer.address,
        customerEmail: customer.email,
        ...(order ? { order: order._id } : {}),
        lines, totalMinor, issueDate: input.issueDate, dueDate: input.dueDate,
        notes: input.notes, status: 'sent',
      }], { session })
      if (order) await Order.updateOne({ _id: order._id }, { $set: { invoice: created._id } }, { session })
      await recordAudit(String(req.authUser!.id), 'created', 'invoice', String(created._id), `Issued invoice ${created.invoiceNumber}`, session)
      return created
    })
    res.status(201).json({ item: { id: String(invoice._id), invoiceNumber: invoice.invoiceNumber, totalMinor: invoice.totalMinor, status: invoice.status } })
  } catch (error) { next(error) }
})

businessRouter.patch('/invoices/:id/status', async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      res.status(400).json({ message: 'Invoice ID is invalid.' })
      return
    }
    const { status } = invoiceStatusInput.parse(req.body)
    const invoice = await withTransaction(async (session) => {
      const current = await Invoice.findById(req.params.id).session(session)
      if (!current) return null
      if (current.paidMinor > 0) throw new BusinessError(409, 'An invoice with recorded payments cannot be voided. Correct the payment with a compensating entry first.')
      current.status = status
      await current.save({ session })
      await recordAudit(String(req.authUser!.id), 'status_changed', 'invoice', String(current._id), `${status === 'void' ? 'Voided' : 'Reissued'} ${current.invoiceNumber}`, session)
      return current
    })
    if (!invoice) {
      res.status(404).json({ message: 'Invoice not found.' })
      return
    }
    res.json({ item: { id: String(invoice._id), invoiceNumber: invoice.invoiceNumber, status: invoice.status } })
  } catch (error) { next(error) }
})

businessRouter.delete('/invoices/:id', async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) throw new BusinessError(400, 'Invoice ID is invalid.')
    await withTransaction(async (session) => {
      const invoice = await Invoice.findById(req.params.id).session(session)
      if (!invoice) throw new BusinessError(404, 'Invoice not found.')
      const order = invoice.order ? await Order.findById(invoice.order).session(session) : null
      const invoices = order
        ? await Invoice.find({ $or: [{ order: order._id }, { _id: invoice._id }] }).session(session)
        : [invoice]
      const invoiceIds = [...new Set(invoices.map((item) => String(item._id)))]
      if (invoices.some((item) => item.paidMinor > 0) ||
        await Payment.exists({ invoice: { $in: invoiceIds } }).session(session)) {
        throw new BusinessError(409, 'Delete this invoice’s payment receipts from Payments first. The invoice and its order can be deleted after their recorded payments are removed.')
      }
      await BusinessDocument.deleteMany({
        $or: [
          { entityType: 'invoice', entityId: { $in: invoices.map((item) => item._id) } },
          ...(order ? [{ entityType: 'order', entityId: order._id }] : []),
        ],
      }).session(session)
      if (order) {
        await Order.deleteOne({ _id: order._id }).session(session)
        await recordAudit(String(req.authUser!.id), 'deleted', 'order', String(order._id), `Permanently deleted order ${order.orderNumber} with invoice ${invoice.invoiceNumber}`, session)
      }
      await Invoice.deleteMany({ _id: { $in: invoices.map((item) => item._id) } }).session(session)
      for (const item of invoices) {
        await recordAudit(String(req.authUser!.id), 'deleted', 'invoice', String(item._id), `Permanently deleted invoice ${item.invoiceNumber}`, session)
      }
    })
    res.status(204).end()
  } catch (error) { next(error) }
})

businessRouter.get('/payments', async (req, res, next) => {
  try {
    const query = paginationSchema.parse(req.query)
    const filter = {
      ...createSearchFilter(query.search, ['paymentNumber', 'reference']),
      ...(query.from || query.to ? { receivedAt: dateRange(query.from, query.to) } : {}),
    }
    const [items, total] = await Promise.all([
      Payment.find(filter).sort({ receivedAt: -1 }).skip((query.page - 1) * query.limit).limit(query.limit).populate('customer', 'name').populate('invoice', 'invoiceNumber').lean(),
      Payment.countDocuments(filter),
    ])
    res.json({
      items: items.map((item) => ({
        id: String(item._id), paymentNumber: item.paymentNumber,
        customerName: (item.customer as unknown as { name?: string } | null)?.name ?? 'Unknown customer',
        invoiceNumber: (item.invoice as unknown as { invoiceNumber?: string } | null)?.invoiceNumber ?? '',
        amountMinor: item.amountMinor, method: item.method, reference: item.reference,
        receivedAt: item.receivedAt,
      })),
      pagination: pagination(query.page, query.limit, total),
    })
  } catch (error) { next(error) }
})

businessRouter.delete('/payments/:id', async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) throw new BusinessError(400, 'Payment ID is invalid.')
    await withTransaction(async (session) => {
      const payment = await Payment.findById(req.params.id).session(session)
      if (!payment) throw new BusinessError(404, 'Payment not found.')
      if (payment.invoice) {
        const invoice = await Invoice.findById(payment.invoice).session(session)
        if (invoice) {
          invoice.paidMinor = Math.max(0, invoice.paidMinor - payment.amountMinor)
          if (invoice.status === 'paid' || invoice.status === 'partial') {
            invoice.status = invoice.paidMinor >= invoice.totalMinor
              ? 'paid'
              : invoice.paidMinor > 0
                ? 'partial'
                : invoice.dueDate && invoice.dueDate < new Date() ? 'overdue' : 'sent'
          }
          await invoice.save({ session })
        }
      }
      await BusinessDocument.deleteMany({ entityType: 'payment', entityId: payment._id }).session(session)
      await LedgerEntry.deleteOne({ sourceType: 'payment', sourceId: payment._id }).session(session)
      await Payment.deleteOne({ _id: payment._id }).session(session)
      await recordAudit(
        String(req.authUser!.id),
        'deleted',
        'payment',
        String(payment._id),
        `Permanently deleted payment ${payment.paymentNumber} for ${payment.amountMinor} minor units`,
        session,
      )
    })
    res.status(204).end()
  } catch (error) { next(error) }
})

businessRouter.post('/payments', async (req, res, next) => {
  try {
    const input = paymentInput.parse(req.body)
    const customer = await Customer.findById(input.customerId).lean()
    if (!customer) {
      res.status(400).json({ message: 'The selected customer does not exist.' })
      return
    }
    const requestHash = JSON.stringify({
      ...input,
      ...(req.body.receivedAt === undefined ? { receivedAt: undefined } : {}),
    })
    const existingKey = req.get('Idempotency-Key')
    if (existingKey && !/^[\w.-]{8,120}$/.test(existingKey)) {
      res.status(400).json({ message: 'Idempotency-Key must be 8–120 letters, digits, dots, underscores or hyphens.' })
      return
    }
    if (existingKey) {
      const existing = await Payment.findOne({ idempotencyKey: existingKey }).lean()
      if (existing) {
        if (existing.requestHash !== requestHash) {
          res.status(409).json({ message: 'This idempotency key was already used for a different payment.' })
          return
        }
        res.status(200).json({ item: { id: String(existing._id), paymentNumber: existing.paymentNumber, amountMinor: existing.amountMinor, replayed: true } })
        return
      }
    }
    let result: InstanceType<typeof Payment>
    try {
      result = await withTransaction((session) => recordCustomerPayment({
        customerId: customer._id,
        ...(input.invoiceId ? { invoiceId: new mongoose.Types.ObjectId(input.invoiceId) } : {}),
        amountMinor: input.amountMinor,
        method: input.method,
        reference: input.reference,
        receivedAt: input.receivedAt,
        ...(existingKey ? { idempotencyKey: existingKey, requestHash } : {}),
      }, String(req.authUser!.id), session))
    } catch (error) {
      if (existingKey && isMongoDuplicateKeyError(error)) {
        const replay = await Payment.findOne({ idempotencyKey: existingKey }).lean()
        if (replay) {
          if (replay.requestHash !== requestHash) {
            res.status(409).json({ message: 'This idempotency key was already used for a different payment.' })
            return
          }
          res.status(200).json({ item: { id: String(replay._id), paymentNumber: replay.paymentNumber, amountMinor: replay.amountMinor, replayed: true } })
          return
        }
      }
      throw error
    }
    res.status(201).json({ item: { id: String(result._id), paymentNumber: result.paymentNumber, amountMinor: result.amountMinor } })
  } catch (error) { next(error) }
})

businessRouter.get('/expenses', async (req, res, next) => {
  await listMoney(req, res, next, Expense, 'spentAt')
})
businessRouter.post('/expenses', async (req, res, next) => {
  await createMoney(req, res, next, Expense, 'expense', 'out', 'spentAt')
})
businessRouter.post('/expenses/:id/void', async (req, res, next) => {
  await voidMoney(req, res, next, Expense, 'expense', 'spentAt')
})
businessRouter.delete('/expenses/:id', async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) throw new BusinessError(400, 'Expense ID is invalid.')
    await withTransaction(async (session) => {
      const expense = await Expense.findById(req.params.id).session(session)
      if (!expense) throw new BusinessError(404, 'Expense not found.')
      await BusinessDocument.deleteMany({ entityType: 'expense', entityId: expense._id }).session(session)
      await LedgerEntry.deleteOne({ sourceType: 'expense', sourceId: expense._id }).session(session)
      await Expense.deleteOne({ _id: expense._id }).session(session)
      await recordAudit(String(req.authUser!.id), 'deleted', 'expense', String(expense._id), `Permanently deleted expense: ${expense.description}`, session)
    })
    res.status(204).end()
  } catch (error) { next(error) }
})
businessRouter.get('/income', async (req, res, next) => {
  await listMoney(req, res, next, Income, 'receivedAt')
})
businessRouter.post('/income', async (req, res, next) => {
  await createMoney(req, res, next, Income, 'income', 'in', 'receivedAt')
})
businessRouter.post('/income/:id/void', async (req, res, next) => {
  await voidMoney(req, res, next, Income, 'income', 'receivedAt')
})

businessRouter.get('/suppliers', async (req, res, next) => {
  try {
    const query = paginationSchema.parse(req.query)
    const filter = { ...createSearchFilter(query.search, ['name', 'phone', 'email']) }
    const [items, total] = await Promise.all([
      Supplier.find(filter).sort({ name: 1 }).skip((query.page - 1) * query.limit).limit(query.limit).lean(),
      Supplier.countDocuments(filter),
    ])
    res.json({ items: items.map((item) => ({
      id: String(item._id), name: item.name, phone: item.phone, email: item.email, address: item.address, status: item.status,
    })), pagination: pagination(query.page, query.limit, total) })
  } catch (error) { next(error) }
})

businessRouter.post('/suppliers', async (req, res, next) => {
  try {
    const input = supplierInput.parse(req.body)
    const supplier = await Supplier.create(input)
    await recordAudit(String(req.authUser!.id), 'created', 'supplier', String(supplier._id), `Created supplier ${supplier.name}`)
    res.status(201).json({ item: { id: String(supplier._id), name: supplier.name } })
  } catch (error) { next(error) }
})

businessRouter.patch('/suppliers/:id', async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) { res.status(400).json({ message: 'Supplier ID is invalid.' }); return }
    const input = supplierInput.partial().parse(req.body)
    if (!Object.keys(input).length) { res.status(400).json({ message: 'Provide fields to update.' }); return }
    const supplier = await Supplier.findByIdAndUpdate(req.params.id, { $set: input }, { returnDocument: 'after', runValidators: true })
    if (!supplier) { res.status(404).json({ message: 'Supplier not found.' }); return }
    await recordAudit(String(req.authUser!.id), 'updated', 'supplier', String(supplier._id), `Updated supplier ${supplier.name}`)
    res.json({ item: { id: String(supplier._id), name: supplier.name } })
  } catch (error) { next(error) }
})

businessRouter.patch('/suppliers/:id/status', async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) { res.status(400).json({ message: 'Supplier ID is invalid.' }); return }
    const { status } = recordStatusInput.parse(req.body)
    const supplier = await Supplier.findByIdAndUpdate(req.params.id, { $set: { status } }, { returnDocument: 'after', runValidators: true })
    if (!supplier) { res.status(404).json({ message: 'Supplier not found.' }); return }
    await recordAudit(String(req.authUser!.id), 'status_changed', 'supplier', String(supplier._id), `Updated supplier ${supplier.name} to ${status}`)
    res.json({ item: { id: String(supplier._id), name: supplier.name, status: supplier.status } })
  } catch (error) { next(error) }
})

businessRouter.get('/inventory', async (req, res, next) => {
  try {
    const query = paginationSchema.parse(req.query)
    const filter = {
      ...createSearchFilter(query.search, ['sku', 'name', 'category']),
      ...(req.query.lowStock === 'true' ? { $expr: { $lte: ['$stockQuantity', '$reorderLevel'] } } : {}),
    }
    const [items, total] = await Promise.all([
      Product.find(filter).sort({ name: 1 }).skip((query.page - 1) * query.limit).limit(query.limit).lean(),
      Product.countDocuments(filter),
    ])
    res.json({ items: items.map((item) => ({
      id: String(item._id), sku: item.sku, name: item.name, category: item.category,
      unit: item.unit, stockQuantity: item.stockQuantity, reorderLevel: item.reorderLevel,
      costMinor: item.costMinor, lowStock: item.stockQuantity <= item.reorderLevel, status: item.status,
    })), pagination: pagination(query.page, query.limit, total) })
  } catch (error) { next(error) }
})

businessRouter.post('/inventory', async (req, res, next) => {
  try {
    const input = productInput.parse(req.body)
    const product = await Product.create({ ...input, sku: input.sku.toUpperCase() })
    await recordAudit(String(req.authUser!.id), 'created', 'product', String(product._id), `Created product ${product.sku}`)
    res.status(201).json({ item: { id: String(product._id), sku: product.sku, name: product.name } })
  } catch (error) { next(error) }
})

businessRouter.patch('/inventory/:id', async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) { res.status(400).json({ message: 'Product ID is invalid.' }); return }
    const input = productInput.partial().parse(req.body)
    if (!Object.keys(input).length) { res.status(400).json({ message: 'Provide fields to update.' }); return }
    const product = await Product.findByIdAndUpdate(req.params.id, { $set: input }, { returnDocument: 'after', runValidators: true })
    if (!product) { res.status(404).json({ message: 'Product not found.' }); return }
    await recordAudit(String(req.authUser!.id), 'updated', 'product', String(product._id), `Updated product ${product.sku}`)
    res.json({ item: { id: String(product._id), sku: product.sku, name: product.name } })
  } catch (error) { next(error) }
})

businessRouter.patch('/inventory/:id/status', async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) { res.status(400).json({ message: 'Product ID is invalid.' }); return }
    const { status } = recordStatusInput.parse(req.body)
    const product = await Product.findByIdAndUpdate(req.params.id, { $set: { status } }, { returnDocument: 'after', runValidators: true })
    if (!product) { res.status(404).json({ message: 'Product not found.' }); return }
    await recordAudit(String(req.authUser!.id), 'status_changed', 'product', String(product._id), `Updated product ${product.sku} to ${status}`)
    res.json({ item: { id: String(product._id), sku: product.sku, status: product.status } })
  } catch (error) { next(error) }
})

businessRouter.post('/inventory/:id/adjust', async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) { res.status(400).json({ message: 'Product ID is invalid.' }); return }
    const input = stockAdjustmentInput.parse(req.body)
    const product = await withTransaction(async (session) => {
      const current = await Product.findById(req.params.id).session(session)
      if (!current) return null
      const nextStock = current.stockQuantity + input.quantityChange
      if (nextStock < 0) throw new BusinessError(400, 'Stock cannot be adjusted below zero.')
      current.stockQuantity = nextStock
      await current.save({ session })
      const sourceId = new mongoose.Types.ObjectId()
      await StockMovement.create([{
        product: current._id,
        direction: input.quantityChange > 0 ? 'in' : 'out',
        quantity: Math.abs(input.quantityChange),
        unitCostMinor: current.costMinor,
        sourceType: 'adjustment', sourceId, note: input.reason,
      }], { session })
      await recordAudit(String(req.authUser!.id), 'stock_adjusted', 'product', String(current._id), `Adjusted ${current.sku}: ${input.reason}`, session)
      return current
    })
    if (!product) { res.status(404).json({ message: 'Product not found.' }); return }
    res.json({ item: { id: String(product._id), sku: product.sku, stockQuantity: product.stockQuantity } })
  } catch (error) { next(error) }
})

businessRouter.get('/purchases', async (req, res, next) => {
  try {
    const query = paginationSchema.parse(req.query)
    const filter = {
      ...createSearchFilter(query.search, ['purchaseNumber']),
      ...(query.from || query.to ? { purchasedAt: dateRange(query.from, query.to) } : {}),
    }
    const [items, total] = await Promise.all([
      Purchase.find(filter).sort({ purchasedAt: -1 }).skip((query.page - 1) * query.limit).limit(query.limit).populate('supplier', 'name').lean(),
      Purchase.countDocuments(filter),
    ])
    res.json({ items: items.map((item) => ({
      id: String(item._id), purchaseNumber: item.purchaseNumber,
      supplierName: (item.supplier as unknown as { name?: string } | null)?.name ?? 'Unknown supplier',
      totalMinor: item.totalMinor, paidMinor: item.paidMinor,
      dueMinor: Math.max(0, item.totalMinor - item.paidMinor), status: item.status, purchasedAt: item.purchasedAt,
    })), pagination: pagination(query.page, query.limit, total) })
  } catch (error) { next(error) }
})

businessRouter.post('/purchases', async (req, res, next) => {
  try {
    const input = purchaseInput.parse(req.body)
    const requestHash = JSON.stringify({
      ...input,
      ...(req.body.purchasedAt === undefined ? { purchasedAt: undefined } : {}),
    })
    const idempotencyKey = req.get('Idempotency-Key')
    if (idempotencyKey && !/^[\w.-]{8,120}$/.test(idempotencyKey)) {
      res.status(400).json({ message: 'Idempotency-Key must be 8–120 letters, digits, dots, underscores or hyphens.' })
      return
    }
    if (idempotencyKey) {
      const replay = await Purchase.findOne({ idempotencyKey }).lean()
      if (replay) {
        if (replay.requestHash !== requestHash) {
          res.status(409).json({ message: 'This idempotency key was already used for a different purchase.' })
          return
        }
        res.status(200).json({ item: { id: String(replay._id), purchaseNumber: replay.purchaseNumber, totalMinor: replay.totalMinor, paidMinor: replay.paidMinor, replayed: true } })
        return
      }
    }
    let purchase: InstanceType<typeof Purchase>
    try {
      purchase = await withTransaction(async (session) => {
      const supplier = await Supplier.findOne({ _id: input.supplierId, status: 'active' }).session(session)
      if (!supplier) throw new BusinessError(400, 'Select an active supplier.')
      const products = new Map<string, { product: InstanceType<typeof Product>; quantity: number; unitCostMinor: number }>()
      for (const line of input.lines) {
        const product = await Product.findById(line.productId).session(session)
        if (!product || product.status !== 'active') throw new BusinessError(400, 'One or more selected products are unavailable.')
        const key = String(product._id)
        const current = products.get(key)
        if (current && current.unitCostMinor !== line.unitCostMinor) throw new BusinessError(400, 'Use one unit cost per product in each purchase.')
        if (current) current.quantity += line.quantity
        else products.set(key, { product, quantity: line.quantity, unitCostMinor: line.unitCostMinor })
      }
      let lines: { product: InstanceType<typeof Product>['_id']; quantity: number; unitCostMinor: number; totalMinor: number }[]
      let totalMinor: number
      try {
        lines = [...products.values()].map(({ product, quantity, unitCostMinor }) => ({
          product: product._id,
          quantity,
          unitCostMinor,
          totalMinor: calculateLineTotalMinor(quantity, unitCostMinor),
        }))
        totalMinor = lines.reduce((total, line) => total + line.totalMinor, 0)
        if (!Number.isSafeInteger(totalMinor)) throw new RangeError('Purchase total exceeds the safe integer range.')
      } catch (error) {
        if (error instanceof RangeError) throw new BusinessError(400, error.message)
        throw error
      }
      if (input.paidMinor > totalMinor) throw new BusinessError(400, 'Paid amount cannot exceed purchase total.')
      const [created] = await Purchase.create([{
        purchaseNumber: await nextDocumentNumber('PUR', session),
        supplier: supplier._id, lines, totalMinor, paidMinor: input.paidMinor,
        paymentMethod: input.paymentMethod, purchasedAt: input.purchasedAt,
        ...(idempotencyKey ? { idempotencyKey, requestHash } : {}),
        status: input.paidMinor >= totalMinor ? 'paid' : input.paidMinor > 0 ? 'partial' : 'received',
      }], { session })
      for (const line of lines) {
        const product = products.get(String(line.product))!.product
        const previousQuantity = product.stockQuantity
        product.stockQuantity += line.quantity
        product.costMinor = weightedAverageCostMinor(
          previousQuantity,
          product.costMinor,
          line.quantity,
          line.unitCostMinor,
        )
        await product.save({ session })
        await StockMovement.create([{
          product: product._id, direction: 'in', quantity: line.quantity,
          unitCostMinor: line.unitCostMinor, sourceType: 'purchase',
          sourceId: created._id, note: created.purchaseNumber, postedAt: created.purchasedAt,
        }], { session })
      }
      if (input.paidMinor > 0) {
        await LedgerEntry.create([{
          entryNumber: await nextDocumentNumber('LED', session),
          direction: 'out', category: 'Supplier purchase', description: created.purchaseNumber,
          amountMinor: input.paidMinor, paymentMethod: input.paymentMethod,
          reference: created.purchaseNumber, sourceType: 'purchase',
          sourceId: created._id, postedAt: created.purchasedAt,
        }], { session })
      }
      await recordAudit(String(req.authUser!.id), 'received', 'purchase', String(created._id), `Received ${created.purchaseNumber}`, session)
      return created
      })
    } catch (error) {
      if (idempotencyKey && isMongoDuplicateKeyError(error)) {
        const replay = await Purchase.findOne({ idempotencyKey }).lean()
        if (replay) {
          if (replay.requestHash !== requestHash) {
            res.status(409).json({ message: 'This idempotency key was already used for a different purchase.' })
            return
          }
          res.status(200).json({ item: { id: String(replay._id), purchaseNumber: replay.purchaseNumber, totalMinor: replay.totalMinor, paidMinor: replay.paidMinor, replayed: true } })
          return
        }
      }
      throw error
    }
    res.status(201).json({ item: { id: String(purchase._id), purchaseNumber: purchase.purchaseNumber, totalMinor: purchase.totalMinor, paidMinor: purchase.paidMinor } })
  } catch (error) { next(error) }
})

businessRouter.post('/purchases/:id/payment', async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) { res.status(400).json({ message: 'Purchase ID is invalid.' }); return }
    const input = z.object({
      amountMinor: positiveMinor,
      method: paymentMethodSchema,
      reference: z.string().trim().max(120).default(''),
      paidAt: dateInput.default(() => new Date()),
    }).parse(req.body)
    const result = await withTransaction(async (session) => {
      const purchase = await Purchase.findById(req.params.id).session(session)
      if (!purchase) return null
      const outstanding = Math.max(0, purchase.totalMinor - purchase.paidMinor)
      if (input.amountMinor > outstanding) throw new BusinessError(400, 'Payment exceeds the remaining supplier balance.')
      const supplier = await Supplier.findById(purchase.supplier).session(session)
      if (!supplier) throw new BusinessError(409, 'The supplier linked to this purchase no longer exists.')
      const [payment] = await SupplierPayment.create([{
        paymentNumber: await nextDocumentNumber('SPY', session),
        supplier: supplier._id, purchase: purchase._id,
        amountMinor: input.amountMinor, method: input.method,
        reference: input.reference, paidAt: input.paidAt,
      }], { session })
      purchase.paidMinor += input.amountMinor
      purchase.paymentMethod = input.method
      purchase.status = purchase.paidMinor >= purchase.totalMinor ? 'paid' : 'partial'
      await purchase.save({ session })
      await LedgerEntry.create([{
        entryNumber: await nextDocumentNumber('LED', session),
        direction: 'out', category: 'Supplier payment',
        description: `Supplier receipt ${payment.paymentNumber}`,
        amountMinor: payment.amountMinor, paymentMethod: payment.method,
        reference: payment.reference || payment.paymentNumber,
        sourceType: 'supplier_payment', sourceId: payment._id, postedAt: payment.paidAt,
      }], { session })
      await recordAudit(String(req.authUser!.id), 'paid', 'supplier_payment', String(payment._id), `Recorded ${payment.paymentNumber}`, session)
      return { payment, purchase }
    })
    if (!result) { res.status(404).json({ message: 'Purchase not found.' }); return }
    res.status(201).json({
      item: { id: String(result.payment._id), paymentNumber: result.payment.paymentNumber, amountMinor: result.payment.amountMinor },
      purchase: { id: String(result.purchase._id), paidMinor: result.purchase.paidMinor, status: result.purchase.status },
    })
  } catch (error) { next(error) }
})

businessRouter.get('/accounts/summary', async (req, res, next) => {
  try {
    const [methods, totals] = await Promise.all([
      LedgerEntry.aggregate([
        { $match: { voidedAt: { $exists: false } } },
        { $group: {
          _id: '$paymentMethod',
          inflowMinor: { $sum: { $cond: [{ $eq: ['$direction', 'in'] }, '$amountMinor', 0] } },
          outflowMinor: { $sum: { $cond: [{ $eq: ['$direction', 'out'] }, '$amountMinor', 0] } },
        } },
      ]),
      LedgerEntry.aggregate([
        { $match: { voidedAt: { $exists: false } } },
        { $group: {
          _id: '$direction',
          totalMinor: { $sum: '$amountMinor' },
        } },
      ]),
    ])
    const inflowMinor = totals.find((item) => item._id === 'in')?.totalMinor ?? 0
    const outflowMinor = totals.find((item) => item._id === 'out')?.totalMinor ?? 0
    res.json({
      inflowMinor, outflowMinor, netMovementMinor: inflowMinor - outflowMinor,
      methods: methods.map((item) => ({
        method: item._id, inflowMinor: item.inflowMinor, outflowMinor: item.outflowMinor,
        balanceMinor: item.inflowMinor - item.outflowMinor,
      })),
    })
  } catch (error) { next(error) }
})

businessRouter.get('/reports/summary', async (req, res, next) => {
  try {
    const range = z.object({ from: dateInput, to: dateInput }).parse(req.query)
    if (range.from > range.to) { res.status(400).json({ message: 'Report start date must be before its end date.' }); return }
    const dateRangeFilter = { $gte: range.from, $lte: range.to }
    const [sales, collections, expenses, otherIncome, purchases, orderCount, paymentMethods] = await Promise.all([
      Invoice.aggregate([{ $match: { issueDate: dateRangeFilter, status: { $nin: ['draft', 'void'] } } }, { $group: { _id: null, totalMinor: { $sum: '$totalMinor' } } }]),
      Payment.aggregate([{ $match: { receivedAt: dateRangeFilter } }, { $group: { _id: null, totalMinor: { $sum: '$amountMinor' } } }]),
      Expense.aggregate([{ $match: { spentAt: dateRangeFilter, status: 'active' } }, { $group: { _id: '$category', totalMinor: { $sum: '$amountMinor' }, count: { $sum: 1 } } }, { $sort: { totalMinor: -1 } }]),
      Income.aggregate([{ $match: { receivedAt: dateRangeFilter, status: 'active' } }, { $group: { _id: '$category', totalMinor: { $sum: '$amountMinor' }, count: { $sum: 1 } } }, { $sort: { totalMinor: -1 } }]),
      Purchase.aggregate([{ $match: { purchasedAt: dateRangeFilter } }, { $group: { _id: null, totalMinor: { $sum: '$totalMinor' }, paidMinor: { $sum: '$paidMinor' } } }]),
      Order.countDocuments({ orderDate: dateRangeFilter, status: { $ne: 'cancelled' } }),
      Payment.aggregate([{ $match: { receivedAt: dateRangeFilter } }, { $group: { _id: '$method', totalMinor: { $sum: '$amountMinor' }, count: { $sum: 1 } } }, { $sort: { totalMinor: -1 } }]),
    ])
    res.json({
      range,
      salesMinor: sales[0]?.totalMinor ?? 0,
      collectionsMinor: collections[0]?.totalMinor ?? 0,
      expenses: expenses.map((item) => ({ category: item._id, amountMinor: item.totalMinor, count: item.count })),
      income: otherIncome.map((item) => ({ category: item._id, amountMinor: item.totalMinor, count: item.count })),
      purchases: { totalMinor: purchases[0]?.totalMinor ?? 0, paidMinor: purchases[0]?.paidMinor ?? 0 },
      orders: orderCount,
      paymentMethods: paymentMethods.map((item) => ({ method: item._id, amountMinor: item.totalMinor, count: item.count })),
    })
  } catch (error) { next(error) }
})

businessRouter.get('/reports/summary.csv', async (req, res, next) => {
  try {
    const range = z.object({ from: dateInput, to: dateInput }).parse(req.query)
    if (range.from > range.to) { res.status(400).json({ message: 'Report start date must be before its end date.' }); return }
    const period = { $gte: range.from, $lte: range.to }
    const [business, invoiceRows, paymentRows, expenseRows, incomeRows, purchaseRows] = await Promise.all([
      Business.findById(req.authUser!.businessId).select('currency').lean(),
      Invoice.find({ issueDate: period, status: { $nin: ['draft', 'void'] } }).populate('customer', 'name').lean(),
      Payment.find({ receivedAt: period }).populate('customer', 'name').lean(),
      Expense.find({ spentAt: period, status: 'active' }).lean(),
      Income.find({ receivedAt: period, status: 'active' }).lean(),
      Purchase.find({ purchasedAt: period }).populate('supplier', 'name').lean(),
    ])
    const currency = business?.currency ?? config.CURRENCY
    const rows: (string | number)[][] = [['Type', 'Date', 'Reference', 'Counterparty', 'Category', 'Amount', 'Currency', 'Status']]
    for (const invoice of invoiceRows) rows.push([
      'Invoice', invoice.issueDate.toISOString(), invoice.invoiceNumber,
      (invoice.customer as unknown as { name?: string } | null)?.name ?? '',
      '', invoice.totalMinor / 100, currency, invoice.status,
    ])
    for (const payment of paymentRows) rows.push([
      'Customer payment', payment.receivedAt.toISOString(), payment.paymentNumber,
      (payment.customer as unknown as { name?: string } | null)?.name ?? '',
      payment.method, payment.amountMinor / 100, currency, 'received',
    ])
    for (const expense of expenseRows) rows.push(['Expense', expense.spentAt.toISOString(), expense.reference, '', expense.category, expense.amountMinor / 100, currency, 'active'])
    for (const entry of incomeRows) rows.push(['Other income', entry.receivedAt.toISOString(), entry.reference, '', entry.category, entry.amountMinor / 100, currency, 'active'])
    for (const purchase of purchaseRows) rows.push([
      'Purchase', purchase.purchasedAt.toISOString(), purchase.purchaseNumber,
      (purchase.supplier as unknown as { name?: string } | null)?.name ?? '',
      '', purchase.totalMinor / 100, currency, purchase.status,
    ])
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="maa-business-report-${range.from.toISOString().slice(0, 10)}-${range.to.toISOString().slice(0, 10)}.csv"`)
    res.send(rows.map((row) => row.map(csvCell).join(',')).join('\r\n'))
  } catch (error) { next(error) }
})

businessRouter.get('/reports/audit-log', async (req, res, next) => {
  try {
    const query = paginationSchema.parse(req.query)
    const [items, total] = await Promise.all([
      AuditLog.find(createSearchFilter(query.search, ['action', 'entity', 'summary']))
        .sort({ createdAt: -1 }).skip((query.page - 1) * query.limit).limit(query.limit)
        .populate('actor', 'name email').lean(),
      AuditLog.countDocuments(createSearchFilter(query.search, ['action', 'entity', 'summary'])),
    ])
    res.json({ items: items.map((item) => ({
      id: String(item._id),
      actorName: (item.actor as unknown as { name?: string } | null)?.name ?? 'Workspace user',
      action: item.action, entity: item.entity, entityId: item.entityId,
      summary: item.summary, createdAt: item.createdAt,
    })), pagination: pagination(query.page, query.limit, total) })
  } catch (error) { next(error) }
})

export class BusinessError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'BusinessError'
    this.status = status
  }
}

async function listMoney(
  req: Parameters<Parameters<typeof businessRouter.get>[1]>[0],
  res: Parameters<Parameters<typeof businessRouter.get>[1]>[1],
  next: Parameters<Parameters<typeof businessRouter.get>[1]>[2],
  model: typeof Expense | typeof Income,
  dateField: 'spentAt' | 'receivedAt',
) {
  try {
    const query = paginationSchema.parse(req.query)
    const filter = { status: 'active', ...createSearchFilter(query.search, ['category', 'description', 'reference']), ...(query.from || query.to ? { [dateField]: dateRange(query.from, query.to) } : {}) }
    const [items, total] = await Promise.all([
      model.find(filter).sort({ [dateField]: -1 }).skip((query.page - 1) * query.limit).limit(query.limit).lean(),
      model.countDocuments(filter),
    ])
    res.json({ items: items.map((item) => ({
      id: String(item._id), category: item.category, description: item.description,
      amountMinor: item.amountMinor, paymentMethod: item.paymentMethod,
      reference: item.reference, date: item[dateField],
    })), pagination: pagination(query.page, query.limit, total) })
  } catch (error) { next(error) }
}

async function createMoney(
  req: Parameters<Parameters<typeof businessRouter.post>[1]>[0],
  res: Parameters<Parameters<typeof businessRouter.post>[1]>[1],
  next: Parameters<Parameters<typeof businessRouter.post>[1]>[2],
  model: typeof Expense | typeof Income,
  entity: 'expense' | 'income',
  direction: 'in' | 'out',
  dateField: 'spentAt' | 'receivedAt',
) {
  try {
    const input = moneyInput.parse(req.body)
    const created = await withTransaction(async (session) => {
      const [entry] = await model.create([{
        category: input.category, description: input.description,
        amountMinor: input.amountMinor, paymentMethod: input.paymentMethod,
        reference: input.reference, [dateField]: input.date,
      }], { session })
      await LedgerEntry.create([{
        entryNumber: await nextDocumentNumber('LED', session),
        direction, category: input.category, description: input.description,
        amountMinor: input.amountMinor, paymentMethod: input.paymentMethod,
        reference: input.reference || String(entry._id),
        sourceType: entity, sourceId: entry._id, postedAt: input.date,
      }], { session })
      await recordAudit(String(req.authUser!.id), 'created', entity, String(entry._id), `Recorded ${entity}: ${input.description}`, session)
      return entry
    })
    res.status(201).json({ item: { id: String(created._id), category: created.category, amountMinor: created.amountMinor } })
  } catch (error) { next(error) }
}

async function voidMoney(
  req: Parameters<Parameters<typeof businessRouter.post>[1]>[0],
  res: Parameters<Parameters<typeof businessRouter.post>[1]>[1],
  next: Parameters<Parameters<typeof businessRouter.post>[1]>[2],
  model: typeof Expense | typeof Income,
  entity: 'expense' | 'income',
  dateField: 'spentAt' | 'receivedAt',
) {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) { res.status(400).json({ message: 'Record ID is invalid.' }); return }
    const changed = await withTransaction(async (session) => {
      const entry = await model.findOneAndUpdate(
        { _id: req.params.id, status: 'active' },
        { $set: { status: 'void' } },
        { returnDocument: 'after', session },
      )
      if (!entry) return null
      await LedgerEntry.updateOne({ sourceType: entity, sourceId: entry._id }, { $set: { voidedAt: new Date() } }, { session })
      await recordAudit(String(req.authUser!.id), 'voided', entity, String(entry._id), `Voided ${entity}: ${entry.description}`, session)
      return entry
    })
    if (!changed) { res.status(404).json({ message: 'Active record not found.' }); return }
    res.json({ item: { id: String(changed._id), status: changed.status, date: changed[dateField] } })
  } catch (error) { next(error) }
}

function dateRange(from?: Date, to?: Date) {
  return { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) }
}

function pagination(page: number, limit: number, total: number) {
  return { page, limit, total, pages: Math.ceil(total / limit) }
}
