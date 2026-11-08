import { ZipArchive, type ArchiverError } from 'archiver'
import { v2 as cloudinary } from 'cloudinary'
import { Router } from 'express'
import multer from 'multer'
import mongoose from 'mongoose'
import PDFDocument from 'pdfkit'
import { Readable } from 'node:stream'
import { existsSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { config } from './config.js'
import { recordAudit, withTransaction } from './domain/workflows.js'
import { requireAuth } from './middleware.js'
import { Business, BusinessDocument, Counter, Customer, Expense, Income, Invoice, LedgerEntry, Order, Payment, Product, Purchase, StockMovement, Supplier, SupplierPayment } from './models.js'
import { BusinessError } from './business.js'
import { mailDeliveryError, mailTransport } from './mail.js'

export const integrationsRouter = Router()
integrationsRouter.use(requireAuth)

integrationsRouter.get('/integrations/status', (req, res) => {
  res.json({
    emailConfigured: Boolean(config.SMTP_HOST && config.SMTP_USER && config.SMTP_PASSWORD && config.SMTP_FROM),
    documentStorageConfigured: cloudinaryConfigured(),
    backupExportAvailable: req.authUser?.role === 'owner',
  })
})

integrationsRouter.post('/integrations/email-test', async (req, res, next) => {
  try {
    if (req.authUser?.role !== 'owner') {
      throw new BusinessError(403, 'Only the workspace owner can send a test email.')
    }
    try {
      await mailTransport().sendMail({
        from: config.SMTP_FROM,
        to: req.authUser.email,
        subject: 'MAA business email delivery test',
        text: 'This test confirms that the configured SMTP service can deliver email for your business workspace.',
      })
    } catch (error) {
      console.error('SMTP test email delivery failed.', mailErrorLogDetails(error))
      throw mailDeliveryError(error)
    }
    res.json({ message: `A test email was sent to ${req.authUser.email}.` })
  } catch (error) { next(error) }
})

integrationsRouter.get('/notifications', async (_req, res, next) => {
  try {
    const now = new Date()
    const [overdueInvoices, lowStockProducts] = await Promise.all([
      Invoice.find({
        status: { $nin: ['void', 'paid'] },
        dueDate: { $lt: now },
        $expr: { $lt: ['$paidMinor', '$totalMinor'] },
      })
        .sort({ dueDate: 1 })
        .limit(5)
        .populate('customer', 'name')
        .lean(),
      Product.find({ status: 'active', reorderLevel: { $gt: 0 }, $expr: { $lte: ['$stockQuantity', '$reorderLevel'] } })
        .sort({ stockQuantity: 1, name: 1 })
        .limit(5)
        .lean(),
    ])
    const items = [
      ...overdueInvoices.map((invoice) => ({
        id: `invoice:${String(invoice._id)}`,
        kind: 'overdue_invoice' as const,
        title: `Invoice ${invoice.invoiceNumber} is overdue`,
        detail: `${(invoice.customer as unknown as { name?: string } | null)?.name ?? 'Customer'} · Due ${invoice.dueDate!.toISOString().slice(0, 10)}`,
        href: '/invoices',
        occurredAt: invoice.dueDate!.toISOString(),
      })),
      ...lowStockProducts.map((product) => ({
        id: `product:${String(product._id)}`,
        kind: 'low_stock' as const,
        title: `${product.name} is low on stock`,
        detail: `${product.stockQuantity} ${product.unit} remaining · Reorder at ${product.reorderLevel}`,
        href: '/inventory',
        occurredAt: product.updatedAt.toISOString(),
      })),
    ]
    res.json({ items, total: items.length })
  } catch (error) {
    next(error)
  }
})

const storage = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, callback) => {
    const allowed = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
    if (!allowed.has(file.mimetype)) {
      callback(new BusinessError(400, 'Only JPG, PNG, WebP images and PDF documents are supported.'))
      return
    }
    callback(null, true)
  },
})

const documentEntityType = z.enum(['order', 'invoice', 'payment', 'expense', 'income', 'supplier', 'product', 'purchase'])
const documentEntityId = z.string().refine((value) => /^[a-f\d]{24}$/i.test(value), 'A valid record ID is required.')

integrationsRouter.get('/documents', async (req, res, next) => {
  try {
    const query = z.object({ entityType: documentEntityType, entityId: documentEntityId }).parse(req.query)
    const documents = await BusinessDocument.find(query).sort({ createdAt: -1 }).lean()
    res.json({ items: documents.map((item) => ({
      id: String(item._id), fileName: item.fileName, contentType: item.contentType,
      url: documentDownloadUrl(item), createdAt: item.createdAt,
    })) })
  } catch (error) { next(error) }
})

integrationsRouter.get('/invoices/:id/pdf', async (req, res, next) => {
  try {
    if (!/^[a-f\d]{24}$/i.test(req.params.id)) throw new BusinessError(400, 'Invoice ID is invalid.')
    const invoice = await Invoice.findById(req.params.id).populate('customer', 'name email phone address').populate('order', 'orderNumber status dueDate').lean()
    if (!invoice) throw new BusinessError(404, 'Invoice not found.')
    const [business, payments] = await Promise.all([
      Business.findById(req.authUser!.businessId).lean(),
      Payment.find({ invoice: invoice._id }).sort({ receivedAt: 1 }).lean(),
    ])
    if (!business) throw new BusinessError(404, 'Business workspace not found.')
    const customer = invoice.customer as unknown as { name?: string; email?: string; phone?: string; address?: string } | null
    const order = invoice.order as unknown as { orderNumber?: string; status?: string; dueDate?: Date } | null
    const document = buildInvoicePdf({
      businessName: business.name,
      businessPhone: business.phone ?? '',
      businessEmail: business.email ?? '',
      businessAddress: business.address ?? '',
      invoiceFooter: business.invoiceFooter ?? '',
      currencyCode: business.currency ?? config.CURRENCY,
      invoiceNumber: invoice.invoiceNumber,
      issueDate: invoice.issueDate,
      dueDate: invoice.dueDate,
      totalMinor: invoice.totalMinor,
      paidMinor: invoice.paidMinor,
      notes: invoice.notes,
      customerName: invoice.customerName || customer?.name || 'Customer',
      customerAddress: invoice.customerAddress || customer?.address || '',
      customerEmail: invoice.customerEmail || customer?.email || '',
      customerPhone: invoice.customerPhone || customer?.phone || '',
      orderNumber: order?.orderNumber ?? '',
      orderStatus: order?.status ?? '',
      deliveryDate: order?.dueDate,
      payments: payments.map((payment) => ({
        paymentNumber: payment.paymentNumber,
        amountMinor: payment.amountMinor,
        method: payment.method,
        reference: payment.reference,
        receivedAt: payment.receivedAt,
      })),
      lines: invoice.lines,
    })
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `attachment; filename="${invoice.invoiceNumber}.pdf"`)
    document.pipe(res)
    document.end()
  } catch (error) { next(error) }
})

integrationsRouter.get('/customers/:id/statement/pdf', async (req, res, next) => {
  try {
    if (!/^[a-f\d]{24}$/i.test(req.params.id)) throw new BusinessError(400, 'Customer ID is invalid.')
    const customer = await Customer.findById(req.params.id).lean()
    if (!customer) throw new BusinessError(404, 'Customer not found.')
    const [business, orders, invoices, payments] = await Promise.all([
      Business.findById(req.authUser!.businessId).lean(),
      Order.find({ customer: customer._id, status: { $ne: 'cancelled' } }).sort({ orderDate: 1 }).lean(),
      Invoice.find({ customer: customer._id, status: { $ne: 'void' } }).sort({ issueDate: 1 }).lean(),
      Payment.find({ customer: customer._id }).sort({ receivedAt: 1 }).lean(),
    ])
    if (!business) throw new BusinessError(404, 'Business workspace not found.')
    const buffer = await customerStatementPdfBuffer({ business, customer, orders, invoices, payments })
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `attachment; filename="customer-statement-${String(customer._id)}.pdf"`)
    res.send(buffer)
  } catch (error) { next(error) }
})

integrationsRouter.get('/reports/summary.pdf', async (req, res, next) => {
  try {
    const range = z.object({ from: z.coerce.date(), to: z.coerce.date() }).parse(req.query)
    if (range.from > range.to) throw new BusinessError(400, 'Report start date must be before its end date.')
    const dateRange = { $gte: range.from, $lte: range.to }
    const [business, sales, collections, expenses, income, purchases, orderCount, paymentMethods] = await Promise.all([
      Business.findById(req.authUser!.businessId).lean(),
      Invoice.aggregate([{ $match: { issueDate: dateRange, status: { $nin: ['draft', 'void'] } } }, { $group: { _id: null, totalMinor: { $sum: '$totalMinor' } } }]),
      Payment.aggregate([{ $match: { receivedAt: dateRange } }, { $group: { _id: null, totalMinor: { $sum: '$amountMinor' } } }]),
      Expense.aggregate([{ $match: { spentAt: dateRange, status: 'active' } }, { $group: { _id: '$category', totalMinor: { $sum: '$amountMinor' }, count: { $sum: 1 } } }, { $sort: { totalMinor: -1 } }]),
      Income.aggregate([{ $match: { receivedAt: dateRange, status: 'active' } }, { $group: { _id: '$category', totalMinor: { $sum: '$amountMinor' }, count: { $sum: 1 } } }, { $sort: { totalMinor: -1 } }]),
      Purchase.aggregate([{ $match: { purchasedAt: dateRange } }, { $group: { _id: null, totalMinor: { $sum: '$totalMinor' }, paidMinor: { $sum: '$paidMinor' } } }]),
      Order.countDocuments({ orderDate: dateRange, status: { $ne: 'cancelled' } }),
      Payment.aggregate([{ $match: { receivedAt: dateRange } }, { $group: { _id: '$method', totalMinor: { $sum: '$amountMinor' }, count: { $sum: 1 } } }, { $sort: { totalMinor: -1 } }]),
    ])
    if (!business) throw new BusinessError(404, 'Business workspace not found.')
    const buffer = await reportPdfBuffer({
      business,
      from: range.from,
      to: range.to,
      salesMinor: sales[0]?.totalMinor ?? 0,
      collectionsMinor: collections[0]?.totalMinor ?? 0,
      expenses: expenses.map((item) => ({ category: item._id, amountMinor: item.totalMinor, count: item.count })),
      income: income.map((item) => ({ category: item._id, amountMinor: item.totalMinor, count: item.count })),
      purchases: { totalMinor: purchases[0]?.totalMinor ?? 0, paidMinor: purchases[0]?.paidMinor ?? 0 },
      orders: orderCount,
      paymentMethods: paymentMethods.map((item) => ({ method: item._id, amountMinor: item.totalMinor, count: item.count })),
    })
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `attachment; filename="maa-business-report-${range.from.toISOString().slice(0, 10)}-${range.to.toISOString().slice(0, 10)}.pdf"`)
    res.send(buffer)
  } catch (error) { next(error) }
})

integrationsRouter.post('/invoices/:id/email', async (req, res, next) => {
  try {
    if (!/^[a-f\d]{24}$/i.test(req.params.id)) throw new BusinessError(400, 'Invoice ID is invalid.')
    const input = z.object({ email: z.string().email().max(254).optional(), message: z.string().trim().max(1000).default('') }).parse(req.body)
    const invoice = await Invoice.findById(req.params.id).populate('customer', 'name email').populate('order', 'orderNumber status dueDate').lean()
    if (!invoice) throw new BusinessError(404, 'Invoice not found.')
    const [business, payments] = await Promise.all([
      Business.findById(req.authUser!.businessId).lean(),
      Payment.find({ invoice: invoice._id }).sort({ receivedAt: 1 }).lean(),
    ])
    if (!business) throw new BusinessError(404, 'Business workspace not found.')
    const customer = invoice.customer as unknown as { name?: string; email?: string } | null
    const order = invoice.order as unknown as { orderNumber?: string; status?: string; dueDate?: Date } | null
    const recipient = input.email ?? (invoice.customerEmail || customer?.email)
    if (!recipient) throw new BusinessError(400, 'Add a customer email address or enter a recipient.')
    const pdf = await invoicePdfBuffer({
      businessName: business.name,
      businessPhone: business.phone ?? '',
      businessEmail: business.email ?? '',
      businessAddress: business.address ?? '',
      invoiceFooter: business.invoiceFooter ?? '',
      currencyCode: business.currency ?? config.CURRENCY,
      invoiceNumber: invoice.invoiceNumber, issueDate: invoice.issueDate, dueDate: invoice.dueDate,
      totalMinor: invoice.totalMinor, paidMinor: invoice.paidMinor, notes: invoice.notes,
      customerName: invoice.customerName || customer?.name || 'Customer',
      customerAddress: invoice.customerAddress || '',
      customerEmail: invoice.customerEmail || customer?.email || '',
      customerPhone: invoice.customerPhone || '',
      orderNumber: order?.orderNumber ?? '',
      orderStatus: order?.status ?? '',
      deliveryDate: order?.dueDate,
      payments: payments.map((payment) => ({
        paymentNumber: payment.paymentNumber,
        amountMinor: payment.amountMinor,
        method: payment.method,
        reference: payment.reference,
        receivedAt: payment.receivedAt,
      })),
      lines: invoice.lines,
    })
    try {
      await mailTransport().sendMail({
        from: config.SMTP_FROM,
        to: recipient,
        subject: `Invoice ${invoice.invoiceNumber} — ${business.name}`,
        text: input.message || `Dear ${invoice.customerName || customer?.name || 'customer'}, please find invoice ${invoice.invoiceNumber} attached.`,
        attachments: [{ filename: `${invoice.invoiceNumber}.pdf`, content: pdf, contentType: 'application/pdf' }],
      })
    } catch (error) {
      console.error(`Invoice email delivery failed for ${invoice.invoiceNumber}.`, mailErrorLogDetails(error))
      throw mailDeliveryError(error)
    }
    await recordAudit(String(req.authUser!.id), 'emailed', 'invoice', String(invoice._id), `Emailed ${invoice.invoiceNumber}`)
    res.json({ message: 'Invoice email sent.' })
  } catch (error) { next(error) }
})

function mailErrorLogDetails(error: unknown) {
  if (typeof error !== 'object' || error === null) return { errorType: typeof error }
  const details: Record<string, string | number> = {}
  for (const key of ['code', 'responseCode', 'command'] as const) {
    const value = Reflect.get(error, key) as unknown
    if (typeof value === 'string' || typeof value === 'number') details[key] = value
  }
  return details
}

integrationsRouter.post('/documents/upload', storage.single('file'), async (req, res, next) => {
  try {
    const file = req.file
    if (!file) throw new BusinessError(400, 'Choose a file to upload.')
    const input = z.object({ entityType: documentEntityType, entityId: documentEntityId }).parse(req.body)
    const exists = await documentEntityExists(input.entityType, input.entityId)
    if (!exists) throw new BusinessError(404, 'The business record for this document could not be found.')
    if (!cloudinaryConfigured()) throw new BusinessError(503, 'Document storage is not configured. Add Cloudinary settings to the API environment.')
    cloudinary.config({
      cloud_name: config.CLOUDINARY_CLOUD_NAME,
      api_key: config.CLOUDINARY_API_KEY,
      api_secret: config.CLOUDINARY_API_SECRET,
      secure: true,
    })
    const resourceType = file.mimetype === 'application/pdf' ? 'raw' : 'image'
    const result = await new Promise<{ secure_url: string; public_id: string }>((resolve, reject) => {
      const upload = cloudinary.uploader.upload_stream(
        { folder: 'maa-offset-press/documents', resource_type: resourceType, type: 'authenticated', access_mode: 'authenticated', use_filename: false, unique_filename: true },
        (error, uploaded) => {
          if (error) reject(error)
          else if (!uploaded) reject(new Error('Cloudinary returned no uploaded file.'))
          else resolve({ secure_url: uploaded.secure_url, public_id: uploaded.public_id })
        },
      )
      Readable.from(file.buffer).pipe(upload)
    })
    try {
      const document = await withTransaction(async (session) => {
        const [created] = await BusinessDocument.create([{
          ...input,
          fileName: basename(file.originalname.replaceAll('\\', '/')).replace(/[\r\n"]/g, '').slice(0, 200) || 'business-document',
          contentType: file.mimetype,
          publicId: result.public_id,
          resourceType,
          uploadedBy: req.authUser!.id,
        }], { session })
        await recordAudit(String(req.authUser!.id), 'uploaded', input.entityType, String(input.entityId), `Uploaded ${created.fileName}`, session)
        return created
      })
      res.status(201).json({ item: { id: String(document._id), url: documentDownloadUrl(document), fileName: document.fileName } })
    } catch (error) {
      await cloudinary.uploader.destroy(result.public_id, { resource_type: resourceType })
      throw error
    }
  } catch (error) { next(error) }
})

integrationsRouter.get('/backup/export', async (req, res, next) => {
  if (req.authUser?.role !== 'owner') {
    res.status(403).json({ message: 'Only the workspace owner can export a data backup.' })
    return
  }
  try {
    const models = [
      ['customers', Customer], ['orders', Order], ['invoices', Invoice],
      ['payments', Payment], ['expenses', Expense], ['income', Income],
      ['suppliers', Supplier], ['products', Product], ['purchases', Purchase],
      ['ledger', LedgerEntry], ['stock-movements', StockMovement], ['supplier-payments', SupplierPayment],
      ['document-counters', Counter],
      ['business-documents', BusinessDocument],
    ] as const
    const archive = new ZipArchive({ zlib: { level: 6 } })
    const backupPromise = collectBackupArchive(archive)
    archive.on('warning', (error: ArchiverError) => {
      if (error.code !== 'ENOENT') archive.emit('error', error)
    })
    archive.append(JSON.stringify({
      product: 'MAA Offset Press',
      exportedAt: new Date().toISOString(),
      formatVersion: 1,
      collections: models.map(([name]) => name),
    }, null, 2), { name: 'manifest.json' })
    for (const [name, model] of models) {
      archive.append(Readable.from(collectionJson(model.collection, req.authUser.businessId)), { name: `${name}.json` })
    }
    const [backup] = await Promise.all([
      backupPromise,
      archive.finalize().then(() => backupPromise),
    ])
    await recordAudit(String(req.authUser.id), 'exported', 'backup', 'workspace', 'Exported workspace data')
    res.setHeader('Content-Type', 'application/zip')
    res.setHeader('Content-Disposition', `attachment; filename="maa-offset-backup-${new Date().toISOString().slice(0, 10)}.zip"`)
    res.send(backup)
  } catch (error) { next(error) }
})

function collectBackupArchive(archive: ZipArchive) {
  const maximumBytes = 4 * 1024 * 1024
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []
    let byteLength = 0
    let settled = false
    archive.on('data', (chunk: Buffer) => {
      if (settled) return
      byteLength += chunk.length
      if (byteLength > maximumBytes) {
        settled = true
        archive.abort()
        reject(new BusinessError(413, 'Workspace backup exceeds the 4 MB download limit. Export smaller workspaces or use Atlas backups for full recovery.'))
        return
      }
      chunks.push(chunk)
    })
    archive.once('end', () => {
      if (settled) return
      settled = true
      resolve(Buffer.concat(chunks, byteLength))
    })
    archive.once('error', (error: Error) => {
      if (settled) return
      settled = true
      reject(error)
    })
  })
}

type PdfInput = {
  businessName: string
  businessPhone: string
  businessEmail: string
  businessAddress: string
  invoiceFooter: string
  currencyCode: string
  invoiceNumber: string
  issueDate: Date
  dueDate?: Date
  totalMinor: number
  paidMinor: number
  notes?: string
  customerName: string
  customerAddress: string
  customerEmail: string
  customerPhone: string
  orderNumber: string
  orderStatus: string
  deliveryDate?: Date
  payments: readonly {
    paymentNumber: string
    amountMinor: number
    method: string
    reference: string
    receivedAt: Date
  }[]
  lines: readonly {
    description: string
    quantity: number
    unitPriceMinor: number
    discountPercent: number
    grossMinor?: number
    discountMinor?: number
    totalMinor: number
  }[]
}

function buildInvoicePdf(input: PdfInput) {
  const document = new PDFDocument({ size: 'A4', margin: 40, info: { Title: `Invoice ${input.invoiceNumber}`, Author: input.businessName } })
  registerBengaliFont(document)
  const left = 40
  const right = 555
  document.rect(left, 40, right - left, 5).fill('#238f85')
  drawLocalizedText(document, input.businessName, left + 6, 60, { width: 300, fontSize: 20, color: '#152235' })
  document.font(pdfFontFor(input.businessName)).fontSize(20)
  let businessY = 60 + document.heightOfString(input.businessName, { width: 300 }) + 5
  const businessLines = [input.businessAddress, input.businessPhone, input.businessEmail].filter(Boolean)
  for (const line of businessLines.length ? businessLines : ['Business invoice']) {
    document.font(pdfFontFor(line)).fontSize(8)
    const lineHeight = Math.max(12, document.heightOfString(line, { width: 300 }) + 3)
    drawLocalizedText(document, line, left + 6, businessY, { width: 300, fontSize: 8, color: '#667085' })
    businessY += lineHeight
  }
  document.font('Helvetica-Bold').fontSize(23).fillColor('#238f85').text('INVOICE', 385, 58, { width: 160, align: 'right' })
  document.font('Helvetica-Bold').fontSize(8).fillColor('#667085').text('INVOICE NO.', 375, 90, { width: 75, align: 'right' })
  document.font('Helvetica-Bold').fontSize(12).fillColor('#152235').text(input.invoiceNumber, 457, 87, { width: 88, align: 'right' })
  document.font('Helvetica-Bold').fontSize(8).fillColor('#667085').text('DATE', 375, 109, { width: 75, align: 'right' })
  document.font('Helvetica-Bold').fontSize(10).fillColor('#152235').text(pdfDate(input.issueDate), 457, 107, { width: 88, align: 'right' })
  const paymentStatus = input.paidMinor >= input.totalMinor ? 'PAID' : input.paidMinor ? 'PARTIALLY PAID' : 'PAYMENT DUE'
  const paymentStatusColor = input.paidMinor >= input.totalMinor ? '#16836f' : input.paidMinor ? '#b97914' : '#c83f4d'
  document.roundedRect(442, 126, 103, 17, 8).fill(paymentStatusColor)
  document.font('Helvetica-Bold').fontSize(7).fillColor('#ffffff').text(paymentStatus, 447, 131, { width: 93, align: 'center' })

  const infoY = Math.max(154, businessY + 8)
  document.roundedRect(left, infoY, right - left, 21, 4).fill('#152235')
  document.font('Helvetica-Bold').fontSize(9).fillColor('#ffffff').text('BILL TO / CUSTOMER DETAILS', left + 10, infoY + 7)
  const customerTextWidth = 280
  const customerLines = [
    ['Name', input.customerName],
    ...(input.customerAddress ? [['Address', input.customerAddress]] : []),
    ...(input.customerPhone ? [['Mobile', input.customerPhone]] : []),
    ...(input.customerEmail ? [['Email', input.customerEmail]] : []),
  ]
  const customerLineHeights = customerLines.map(([, value]) => {
    document.font(pdfFontFor(value!)).fontSize(9)
    return Math.max(20, document.heightOfString(value!, { width: customerTextWidth }) + 8)
  })
  const customerCardHeight = Math.max(100, 19 + customerLineHeights.reduce((sum, height) => sum + height, 0))
  document.roundedRect(left, infoY + 21, right - left, customerCardHeight, 4).fill('#f5f8fa')
  let customerY = infoY + 30
  customerLines.forEach(([label, value], index) => {
    const y = customerY
    document.font('Helvetica-Bold').fontSize(8).fillColor('#667085').text(`${label}:`, left + 10, y, { width: 55 })
    drawLocalizedText(document, value!, left + 68, y, { width: customerTextWidth, fontSize: 9, color: '#26364a' })
    customerY += customerLineHeights[index]
  })
  document.font('Helvetica-Bold').fontSize(8).fillColor('#667085')
  document.text('DELIVERY', 390, infoY + 32, { width: 62, align: 'right' })
  document.text('STATUS', 390, infoY + 51, { width: 62, align: 'right' })
  document.text('PAYMENT', 390, infoY + 70, { width: 62, align: 'right' })
  document.font('Helvetica').fontSize(9).fillColor('#152235')
  document.text(input.deliveryDate ? pdfDate(input.deliveryDate) : '—', 458, infoY + 31, { width: 88, align: 'right' })
  drawLocalizedText(document, input.orderStatus || (input.paidMinor >= input.totalMinor ? 'Paid' : input.paidMinor ? 'Partial' : 'Unpaid'), 458, infoY + 50, { width: 88, fontSize: 9, color: '#152235', align: 'right' })
  document.font('Helvetica').fontSize(9).fillColor('#152235').text(input.paidMinor >= input.totalMinor ? 'Paid' : input.paidMinor ? 'Partial' : 'Due', 458, infoY + 69, { width: 88, align: 'right' })

  const tableTop = infoY + 21 + customerCardHeight + 18
  const columns = [left, 302, 354, 415, 479, right]
  const drawTableHeader = (y: number) => {
    document.rect(left, y, right - left, 24).fill('#238f85')
    document.font('Helvetica-Bold').fontSize(8).fillColor('#ffffff')
    document.text('SL', columns[0] + 8, y + 8, { width: 25 })
    document.text('DESCRIPTION', columns[1] + 5, y + 8, { width: 115 })
    document.text('QTY', columns[2], y + 8, { width: 48, align: 'right' })
    document.text('UNIT PRICE', columns[3], y + 8, { width: 58, align: 'right' })
    document.text('AMOUNT', columns[4], y + 8, { width: 68, align: 'right' })
    document.y = y + 29
  }
  drawTableHeader(tableTop)
  for (const [index, line] of input.lines.entries()) {
    document.font(pdfFontFor(line.description)).fontSize(9)
    const descriptionHeight = document.heightOfString(line.description, { width: 165 })
    const rowHeight = Math.max(28, descriptionHeight + 12)
    if (document.y + rowHeight > 700) {
      document.addPage()
      drawTableHeader(40)
    }
    const rowY = document.y
    document.font('Helvetica').fontSize(9).fillColor('#26364a')
    document.text(String(index + 1), columns[0] + 8, rowY + 4, { width: 25 })
    drawLocalizedText(document, line.description, columns[1] + 5, rowY + 4, { width: 165, fontSize: 9, color: '#26364a' })
    document.font('Helvetica').text(String(line.quantity), columns[2], rowY + 4, { width: 48, align: 'right' })
    document.text(currency(line.unitPriceMinor, input.currencyCode), columns[3], rowY + 4, { width: 58, align: 'right' })
    document.text(currency(line.totalMinor, input.currencyCode), columns[4], rowY + 4, { width: 68, align: 'right' })
    document.strokeColor('#dce4e9').moveTo(left, rowY + rowHeight).lineTo(right, rowY + rowHeight).stroke()
    document.y = rowY + rowHeight
  }
  const grossMinor = input.lines.reduce((sum, line) => sum + (line.grossMinor ?? Math.round(line.quantity * line.unitPriceMinor)), 0)
  const discountMinor = input.lines.reduce((sum, line) => sum + (line.discountMinor ?? Math.max(0, (line.grossMinor ?? Math.round(line.quantity * line.unitPriceMinor)) - line.totalMinor)), 0)
  const advanceMinor = input.payments.filter((payment) => /advance/i.test(payment.reference)).reduce((sum, payment) => sum + payment.amountMinor, 0)
  const laterPaymentsMinor = Math.max(0, input.paidMinor - advanceMinor)
  let summaryY = document.y + 16
  if (summaryY > 690) {
    document.addPage()
    summaryY = 52
  }
  document.font('Helvetica').fontSize(8).fillColor('#667085').text('IN WORDS', left + 8, summaryY + 4)
  document.font('Helvetica-Bold').fontSize(9).fillColor('#238f85').text(amountInWords(input.totalMinor, input.currencyCode), left + 8, summaryY + 20, { width: 235 })
  const summaryX = 330
  const summaryWidth = 215
  const summaryRows = [
    ['SUB TOTAL', currency(grossMinor, input.currencyCode), '#344054'],
    ['DISCOUNT', currency(discountMinor, input.currencyCode), '#344054'],
    ['NET TOTAL', currency(input.totalMinor, input.currencyCode), '#152235'],
    ['ADVANCE', currency(advanceMinor, input.currencyCode), '#238f85'],
    ['LATER PAYMENTS', currency(laterPaymentsMinor, input.currencyCode), '#238f85'],
    ['DUE', currency(Math.max(0, input.totalMinor - input.paidMinor), input.currencyCode), '#cf4650'],
  ]
  summaryRows.forEach(([label, amount, color], index) => {
    const y = summaryY + index * 19
    if (index === summaryRows.length - 1) document.rect(summaryX, y - 2, summaryWidth, 18).fill('#fbe9e9')
    document.font('Helvetica-Bold').fontSize(8).fillColor('#667085').text(label, summaryX + 5, y + 2, { width: 110 })
    document.font('Helvetica-Bold').fontSize(9).fillColor(color!).text(amount!, summaryX + 112, y + 1, { width: 97, align: 'right' })
    if (index === 0 || index === 1 || index === 2) document.strokeColor('#cbd5dc').moveTo(summaryX, y + 17).lineTo(summaryX + summaryWidth, y + 17).stroke()
  })
  let nextY = summaryY + summaryRows.length * 19 + 21
  if (input.payments.length) {
    if (nextY > 690) {
      document.addPage()
      nextY = 42
    }
    document.rect(left, nextY, right - left, 20).fill('#152235')
    document.font('Helvetica-Bold').fontSize(8).fillColor('#ffffff').text('PAYMENT HISTORY / ACCOUNT RECEIPTS', left + 10, nextY + 6)
    nextY += 26
    for (const payment of input.payments) {
      if (nextY > 745) {
        document.addPage()
        nextY = 42
      }
      document.font('Helvetica').fontSize(8).fillColor('#344054')
      document.text(pdfDate(payment.receivedAt), left + 4, nextY, { width: 70 })
      document.text(payment.paymentNumber, left + 80, nextY, { width: 88 })
      document.text(payment.method.toUpperCase(), left + 175, nextY, { width: 70 })
      document.text(payment.reference || '—', left + 245, nextY, { width: 145 })
      document.text(currency(payment.amountMinor, input.currencyCode), left + 395, nextY, { width: 115, align: 'right' })
      nextY += 17
    }
  }
  nextY += 10
  if (input.notes) {
    drawLocalizedText(document, input.notes, left, nextY, { width: right - left, fontSize: 8, color: '#667085' })
    nextY = document.y + 8
  }
  if (input.invoiceFooter) {
    drawLocalizedText(document, input.invoiceFooter, left, nextY, { width: right - left, fontSize: 8, color: '#667085' })
    nextY = document.y + 8
  }
  if (nextY < 780) document.font('Helvetica').fillColor('#238f85').fontSize(9).text('Thank you for your business.', left, nextY, { width: right - left, align: 'center' })
  return document
}

export function invoicePdfBuffer(input: PdfInput) {
  return new Promise<Buffer>((resolve, reject) => {
    const document = buildInvoicePdf(input)
    const chunks: Buffer[] = []
    document.on('data', (chunk: Buffer) => chunks.push(chunk))
    document.on('end', () => resolve(Buffer.concat(chunks)))
    document.on('error', reject)
    document.end()
  })
}

function currency(amountMinor: number, currencyCode = config.CURRENCY) {
  return new Intl.NumberFormat('en-BD', { style: 'currency', currency: currencyCode, maximumFractionDigits: 2 }).format(amountMinor / 100)
}

function registerBengaliFont(document: InstanceType<typeof PDFDocument>) {
  const packageRoot = fileURLToPath(new URL('../../../node_modules/@fontsource/noto-sans-bengali/files/', import.meta.url))
  const bengaliPath = join(packageRoot, 'noto-sans-bengali-bengali-400-normal.woff')
  if (!existsSync(bengaliPath)) throw new Error('The embedded Bengali PDF font is missing.')
  document.registerFont('Bengali', bengaliPath)
}

function pdfFontFor(value: string) {
  return /[\u0980-\u09ff]/u.test(value) ? 'Bengali' : 'Helvetica'
}

function drawLocalizedText(
  document: InstanceType<typeof PDFDocument>,
  value: string,
  x: number,
  y: number,
  options: { width: number; fontSize: number; color: string; align?: 'left' | 'right' | 'center' },
) {
  const runs = value.match(/[\u0980-\u09ff]+|[^\u0980-\u09ff]+/gu) ?? [value]
  runs.forEach((run, index) => {
    document.font(pdfFontFor(run)).fontSize(options.fontSize).fillColor(options.color).text(run, {
      ...(index === 0 ? { x, y, width: options.width, align: options.align } : {}),
      continued: index < runs.length - 1,
    })
  })
}

function pdfDate(value: Date) {
  return new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(value)
}

function amountInWords(amountMinor: number, currencyCode: string) {
  const units: Record<string, string> = { BDT: 'Taka', USD: 'Dollars', EUR: 'Euros', GBP: 'Pounds', INR: 'Rupees' }
  const major = Math.floor(amountMinor / 100)
  const minor = amountMinor % 100
  const unit = units[currencyCode] ?? currencyCode
  return `${numberInWords(major)} ${unit}${minor ? ` and ${numberInWords(minor)} ${minor === 1 ? 'paisa' : 'paise'}` : ''} Only`
}

function numberInWords(value: number): string {
  const ones = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen']
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety']
  if (value < 20) return ones[value] ?? String(value)
  if (value < 100) return `${tens[Math.floor(value / 10)]}${value % 10 ? ` ${ones[value % 10]}` : ''}`
  if (value < 1000) return `${ones[Math.floor(value / 100)]} Hundred${value % 100 ? ` ${numberInWords(value % 100)}` : ''}`
  for (const [size, label] of [[1_000_000_000, 'Billion'], [1_000_000, 'Million'], [1000, 'Thousand']] as const) {
    if (value >= size) return `${numberInWords(Math.floor(value / size))} ${label}${value % size ? ` ${numberInWords(value % size)}` : ''}`
  }
  return String(value)
}

type PdfBusiness = { name: string; phone?: string; email?: string; address?: string; currency?: string; invoiceFooter?: string }
type StatementOrder = {
  _id: unknown
  orderNumber: string
  description: string
  quantity?: number
  grossMinor?: number
  discountMinor?: number
  amountMinor: number
  status: string
  orderDate: Date
}
type StatementInvoice = {
  _id: unknown
  invoiceNumber: string
  order?: unknown
  totalMinor: number
  paidMinor: number
  status: string
  issueDate: Date
}
type StatementPayment = {
  paymentNumber: string
  invoice?: unknown
  amountMinor: number
  method: string
  reference: string
  receivedAt: Date
}

async function customerStatementPdfBuffer(input: {
  business: PdfBusiness
  customer: { name: string; phone?: string; email?: string; address?: string; _id: unknown }
  orders: StatementOrder[]
  invoices: StatementInvoice[]
  payments: StatementPayment[]
}) {
  const currencyCode = input.business.currency ?? config.CURRENCY
  const activeInvoices = input.invoices.filter((invoice) => invoice.status !== 'void')
  const invoiceByOrder = new Map(
    activeInvoices.filter((invoice) => invoice.order).map((invoice) => [String(invoice.order), invoice]),
  )
  const activeOrders = input.orders.filter((order) => order.status !== 'cancelled')
  const unbilledOrders = activeOrders.filter((order) => !invoiceByOrder.has(String(order._id)))
  const invoicedMinor = activeInvoices.reduce((sum, invoice) => sum + invoice.totalMinor, 0) +
    unbilledOrders.reduce((sum, order) => sum + order.amountMinor, 0)
  const paidMinor = activeInvoices.reduce((sum, invoice) => sum + invoice.paidMinor, 0)
  const dueMinor = activeInvoices.reduce((sum, invoice) => sum + Math.max(0, invoice.totalMinor - invoice.paidMinor), 0) +
    unbilledOrders.reduce((sum, order) => sum + order.amountMinor, 0)
  const orderNumbers = new Map(input.orders.map((order) => [String(order._id), order.orderNumber]))
  return createPdfBuffer(
    (document) => {
      drawPdfHeader(document, input.business, 'CUSTOMER ACCOUNT STATEMENT', `Prepared ${pdfDate(new Date())}`)
      document.rect(40, 120, 515, 69).fill('#f5f8fa')
      drawLocalizedText(document, input.customer.name, 52, 131, { width: 310, fontSize: 13, color: '#152235' })
      const contact = [input.customer.phone, input.customer.email, input.customer.address].filter(Boolean).join(' · ')
      drawLocalizedText(document, contact || 'Customer account', 52, 154, { width: 490, fontSize: 9, color: '#667085' })
      drawPdfMetrics(document, [
        ['ORDERS', String(activeOrders.length)],
        ['INVOICED', currency(invoicedMinor, currencyCode)],
        ['RECEIVED', currency(paidMinor, currencyCode)],
        ['BALANCE DUE', currency(dueMinor, currencyCode)],
      ], 207)
      let y = 302
      y = drawPdfTable(document, 'ORDER HISTORY', [
        { label: 'ORDER #', width: 75 },
        { label: 'DESCRIPTION', width: 218 },
        { label: 'QTY', width: 42, align: 'right' },
        { label: 'NET TOTAL', width: 93, align: 'right' },
        { label: 'DATE', width: 87, align: 'right' },
      ], input.orders.map((order) => [
        order.orderNumber,
        order.description,
        String(order.quantity ?? 1),
        currency(order.amountMinor, currencyCode),
        pdfDate(order.orderDate),
      ]), y)
      y += 14
      y = drawPdfTable(document, 'INVOICE & OUTSTANDING BALANCES', [
        { label: 'INVOICE #', width: 98 },
        { label: 'ORDER #', width: 78 },
        { label: 'DATE', width: 78 },
        { label: 'TOTAL', width: 87, align: 'right' },
        { label: 'PAID', width: 78, align: 'right' },
        { label: 'DUE', width: 96, align: 'right' },
      ], input.invoices.filter((invoice) => invoice.status !== 'void').map((invoice) => [
        invoice.invoiceNumber,
        orderNumbers.get(String(invoice.order)) ?? '—',
        pdfDate(invoice.issueDate),
        currency(invoice.totalMinor, currencyCode),
        currency(invoice.paidMinor, currencyCode),
        currency(Math.max(0, invoice.totalMinor - invoice.paidMinor), currencyCode),
      ]), y)
      y += 14
      drawPdfTable(document, 'PAYMENT HISTORY', [
        { label: 'DATE', width: 82 },
        { label: 'RECEIPT #', width: 100 },
        { label: 'METHOD', width: 72 },
        { label: 'REFERENCE', width: 165 },
        { label: 'AMOUNT', width: 92, align: 'right' },
      ], input.payments.map((payment) => [
        pdfDate(payment.receivedAt),
        payment.paymentNumber,
        payment.method.toUpperCase(),
        payment.reference || '—',
        currency(payment.amountMinor, currencyCode),
      ]), y)
      if (input.business.invoiceFooter) {
        document.moveDown().font('Helvetica').fontSize(8).fillColor('#667085')
          .text(input.business.invoiceFooter, 40, document.y, { width: 515, align: 'center' })
      }
    },
    { title: `Customer statement ${input.customer.name}`, author: input.business.name },
  )
}

async function reportPdfBuffer(input: {
  business: PdfBusiness
  from: Date
  to: Date
  salesMinor: number
  collectionsMinor: number
  expenses: { category: string; amountMinor: number; count: number }[]
  income: { category: string; amountMinor: number; count: number }[]
  purchases: { totalMinor: number; paidMinor: number }
  orders: number
  paymentMethods: { method: string; amountMinor: number; count: number }[]
}) {
  const currencyCode = input.business.currency ?? config.CURRENCY
  const expensesMinor = input.expenses.reduce((sum, entry) => sum + entry.amountMinor, 0)
  const incomeMinor = input.income.reduce((sum, entry) => sum + entry.amountMinor, 0)
  const netCashFlowMinor = input.collectionsMinor + incomeMinor - expensesMinor - input.purchases.paidMinor
  return createPdfBuffer(
    (document) => {
      drawPdfHeader(document, input.business, 'BUSINESS ACTIVITY REPORT', `${pdfDate(input.from)} – ${pdfDate(input.to)}`)
      drawPdfMetrics(document, [
        ['INVOICED SALES', currency(input.salesMinor, currencyCode)],
        ['COLLECTIONS', currency(input.collectionsMinor, currencyCode)],
        ['EXPENSES', currency(expensesMinor, currencyCode)],
        ['NET CASH FLOW', currency(netCashFlowMinor, currencyCode), netCashFlowMinor < 0 ? '#c83f4d' : '#16836f'],
      ], 128)
      document.roundedRect(40, 211, 515, 30, 4).fill('#f3f7f8')
      document.font('Helvetica-Bold').fontSize(8).fillColor('#344054')
        .text(`ORDERS  ${input.orders}     OTHER INCOME  ${currency(incomeMinor, currencyCode)}     SUPPLIER PAYMENTS  ${currency(input.purchases.paidMinor, currencyCode)}`, 50, 222, { width: 495 })
      let y = 255
      y = drawPdfTable(document, 'EXPENSES BY CATEGORY', [
        { label: 'CATEGORY', width: 290 },
        { label: 'ENTRIES', width: 75, align: 'right' },
        { label: 'TOTAL', width: 150, align: 'right' },
      ], input.expenses.map((entry) => [entry.category, String(entry.count), currency(entry.amountMinor, currencyCode)]), y)
      y += 16
      y = drawPdfTable(document, 'OTHER INCOME', [
        { label: 'CATEGORY', width: 290 },
        { label: 'ENTRIES', width: 75, align: 'right' },
        { label: 'TOTAL', width: 150, align: 'right' },
      ], input.income.map((entry) => [entry.category, String(entry.count), currency(entry.amountMinor, currencyCode)]), y)
      y += 16
      y = drawPdfTable(document, 'COLLECTIONS BY PAYMENT METHOD', [
        { label: 'METHOD', width: 290 },
        { label: 'PAYMENTS', width: 75, align: 'right' },
        { label: 'TOTAL', width: 150, align: 'right' },
      ], input.paymentMethods.map((entry) => [entry.method.toUpperCase(), String(entry.count), currency(entry.amountMinor, currencyCode)]), y)
      y += 16
      drawPdfTable(document, 'SUPPLIER SETTLEMENT', [
        { label: 'MEASURE', width: 365 },
        { label: 'AMOUNT', width: 150, align: 'right' },
      ], [
        ['Total purchases', currency(input.purchases.totalMinor, currencyCode)],
        ['Paid to suppliers', currency(input.purchases.paidMinor, currencyCode)],
        ['Recorded payable', currency(Math.max(0, input.purchases.totalMinor - input.purchases.paidMinor), currencyCode)],
      ], y)
    },
    { title: 'Business activity report', author: input.business.name },
  )
}

function createPdfBuffer(
  render: (document: InstanceType<typeof PDFDocument>) => void,
  info: { title: string; author: string },
) {
  return new Promise<Buffer>((resolve, reject) => {
    const document = new PDFDocument({ size: 'A4', margin: 40, info: { Title: info.title, Author: info.author } })
    registerBengaliFont(document)
    const chunks: Buffer[] = []
    document.on('data', (chunk: Buffer) => chunks.push(chunk))
    document.on('end', () => resolve(Buffer.concat(chunks)))
    document.on('error', reject)
    render(document)
    document.end()
  })
}

function drawPdfHeader(document: InstanceType<typeof PDFDocument>, business: PdfBusiness, title: string, subtitle: string) {
  document.rect(0, 0, 595, 108).fill('#152235')
  document.rect(0, 0, 595, 6).fill('#238f85')
  drawLocalizedText(document, business.name, 46, 27, { width: 320, fontSize: 18, color: '#ffffff' })
  const contact = [business.address, business.phone, business.email].filter(Boolean).join(' · ')
  drawLocalizedText(document, contact || 'Business workspace', 46, 57, { width: 320, fontSize: 8, color: '#d0d8e2' })
  document.font('Helvetica-Bold').fontSize(11).fillColor('#ffffff').text(title, 365, 31, { width: 180, align: 'right' })
  document.font('Helvetica').fontSize(8).fillColor('#d0d8e2').text(subtitle, 365, 52, { width: 180, align: 'right' })
}

function drawPdfMetrics(document: InstanceType<typeof PDFDocument>, metrics: [string, string, string?][], y: number) {
  const gap = 8
  const width = (515 - gap * (metrics.length - 1)) / metrics.length
  metrics.forEach(([label, value], index) => {
    const x = 40 + index * (width + gap)
    document.roundedRect(x, y, width, 71, 5).fill('#f3f7f8')
    document.font('Helvetica-Bold').fontSize(7).fillColor('#667085').text(label, x + 8, y + 10, { width: width - 16 })
    const valueColor = metrics[index][2] ?? (index === metrics.length - 1 && /DUE|BALANCE/.test(label) ? '#c83f4d' : '#152235')
    document.font('Helvetica-Bold').fontSize(10).fillColor(valueColor)
      .text(value, x + 8, y + 32, { width: width - 16 })
  })
}

function drawPdfTable(
  document: InstanceType<typeof PDFDocument>,
  title: string,
  columns: { label: string; width: number; align?: 'left' | 'right' }[],
  rows: string[][],
  startY: number,
) {
  const left = 40
  const right = 555
  let y = startY
  const drawHeader = (withTitle: boolean) => {
    if (withTitle) {
      document.rect(left, y, right - left, 20).fill('#152235')
      document.font('Helvetica-Bold').fontSize(8).fillColor('#ffffff').text(title, left + 9, y + 6)
      y += 20
    }
    document.rect(left, y, right - left, 20).fill('#e8f2f0')
    let x = left
    columns.forEach((column) => {
      document.font('Helvetica-Bold').fontSize(7).fillColor('#238f85')
        .text(column.label, x + 5, y + 6, { width: column.width - 10, align: column.align ?? 'left' })
      x += column.width
    })
    y += 20
  }
  drawHeader(true)
  if (!rows.length) {
    document.font('Helvetica').fontSize(8).fillColor('#667085').text('No records for this period.', left + 5, y + 8)
    return y + 28
  }
  for (const [rowIndex, row] of rows.entries()) {
    const heights = row.map((cell, index) => {
      document.font(pdfFontFor(cell)).fontSize(8)
      return document.heightOfString(cell, { width: columns[index].width - 10 })
    })
    const height = Math.max(22, ...heights.map((value) => value + 8))
    if (y + height > 765) {
      document.addPage()
      y = 40
      drawHeader(false)
    }
    if (rowIndex % 2 === 1) document.rect(left, y, right - left, height).fill('#f8fafb')
    let x = left
    row.forEach((cell, index) => {
      drawLocalizedText(document, cell, x + 5, y + 5, {
        width: columns[index].width - 10,
        fontSize: 8,
        color: '#344054',
        align: columns[index].align,
      })
      x += columns[index].width
    })
    document.strokeColor('#e5eaee').moveTo(left, y + height).lineTo(right, y + height).stroke()
    y += height
  }
  document.y = y
  return y
}

function cloudinaryConfigured() {
  return Boolean(config.CLOUDINARY_CLOUD_NAME && config.CLOUDINARY_API_KEY && config.CLOUDINARY_API_SECRET)
}

function documentDownloadUrl(document: { publicId: string; resourceType: 'image' | 'raw' | 'video'; fileName: string }) {
  const format = extname(document.fileName).slice(1).toLowerCase()
  return cloudinary.utils.private_download_url(document.publicId, format, {
    resource_type: document.resourceType,
    type: 'authenticated',
    expires_at: Math.floor(Date.now() / 1000) + 300,
  })
}

async function* collectionJson(collection: ReturnType<typeof mongoose.connection.collection>, businessId: string) {
  yield '[\n'
  let first = true
  const cursor = collection.find(
    { businessId: new mongoose.Types.ObjectId(businessId) },
    { projection: { passwordHash: 0, token: 0, secret: 0 } },
  )
  for await (const document of cursor) {
    yield `${first ? '' : ',\n'}${JSON.stringify(document)}`
    first = false
  }
  yield '\n]\n'
}

async function documentEntityExists(entityType: z.infer<typeof documentEntityType>, entityId: string) {
  switch (entityType) {
    case 'order': return Boolean(await Order.exists({ _id: entityId }))
    case 'invoice': return Boolean(await Invoice.exists({ _id: entityId }))
    case 'payment': return Boolean(await Payment.exists({ _id: entityId }))
    case 'expense': return Boolean(await Expense.exists({ _id: entityId }))
    case 'income': return Boolean(await Income.exists({ _id: entityId }))
    case 'supplier': return Boolean(await Supplier.exists({ _id: entityId }))
    case 'product': return Boolean(await Product.exists({ _id: entityId }))
    case 'purchase': return Boolean(await Purchase.exists({ _id: entityId }))
  }
}
