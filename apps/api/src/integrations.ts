import { ZipArchive, type ArchiverError } from 'archiver'
import { v2 as cloudinary } from 'cloudinary'
import { Router } from 'express'
import multer from 'multer'
import mongoose from 'mongoose'
import PDFDocument from 'pdfkit'
import { Readable } from 'node:stream'
import { basename, extname } from 'node:path'
import { z } from 'zod'
import { config } from './config.js'
import { recordAudit, withTransaction } from './domain/workflows.js'
import { requireAuth } from './middleware.js'
import { AuditLog, Business, BusinessDocument, Counter, Customer, Expense, Income, Invoice, LedgerEntry, Order, Payment, Product, Purchase, StockMovement, Supplier, SupplierPayment } from './models.js'
import { BusinessError } from './business.js'
import { mailTransport } from './mail.js'

export const integrationsRouter = Router()
integrationsRouter.use(requireAuth)

integrationsRouter.get('/integrations/status', (req, res) => {
  res.json({
    emailConfigured: Boolean(config.SMTP_HOST && config.SMTP_USER && config.SMTP_PASSWORD && config.SMTP_FROM),
    documentStorageConfigured: cloudinaryConfigured(),
    backupExportAvailable: req.authUser?.role === 'owner',
  })
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
    const invoice = await Invoice.findById(req.params.id).populate('customer', 'name email phone address').lean()
    if (!invoice) throw new BusinessError(404, 'Invoice not found.')
    const business = await Business.findById(req.authUser!.businessId).select('name').lean()
    if (!business) throw new BusinessError(404, 'Business workspace not found.')
    const customer = invoice.customer as unknown as { name?: string; email?: string; phone?: string; address?: string } | null
    const document = buildInvoicePdf({
      businessName: business.name,
      invoiceNumber: invoice.invoiceNumber,
      issueDate: invoice.issueDate,
      dueDate: invoice.dueDate,
      totalMinor: invoice.totalMinor,
      paidMinor: invoice.paidMinor,
      notes: invoice.notes,
      customerName: customer?.name ?? 'Customer',
      customerAddress: customer?.address ?? '',
      customerEmail: customer?.email ?? '',
      customerPhone: customer?.phone ?? '',
      lines: invoice.lines,
    })
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `inline; filename="${invoice.invoiceNumber}.pdf"`)
    document.pipe(res)
    document.end()
  } catch (error) { next(error) }
})

integrationsRouter.post('/invoices/:id/email', async (req, res, next) => {
  try {
    if (!/^[a-f\d]{24}$/i.test(req.params.id)) throw new BusinessError(400, 'Invoice ID is invalid.')
    const input = z.object({ email: z.string().email().max(254).optional(), message: z.string().trim().max(1000).default('') }).parse(req.body)
    const invoice = await Invoice.findById(req.params.id).populate('customer', 'name email').lean()
    if (!invoice) throw new BusinessError(404, 'Invoice not found.')
    const business = await Business.findById(req.authUser!.businessId).select('name').lean()
    if (!business) throw new BusinessError(404, 'Business workspace not found.')
    const customer = invoice.customer as unknown as { name?: string; email?: string } | null
    const recipient = input.email ?? customer?.email
    if (!recipient) throw new BusinessError(400, 'Add a customer email address or enter a recipient.')
    const pdf = await invoicePdfBuffer({
      businessName: business.name,
      invoiceNumber: invoice.invoiceNumber, issueDate: invoice.issueDate, dueDate: invoice.dueDate,
      totalMinor: invoice.totalMinor, paidMinor: invoice.paidMinor, notes: invoice.notes,
      customerName: customer?.name ?? 'Customer', customerAddress: '', customerEmail: customer?.email ?? '',
      customerPhone: '', lines: invoice.lines,
    })
    await mailTransport().sendMail({
      from: config.SMTP_FROM,
      to: recipient,
      subject: `Invoice ${invoice.invoiceNumber} — ${business.name}`,
      text: input.message || `Dear ${customer?.name ?? 'customer'}, please find invoice ${invoice.invoiceNumber} attached.`,
      attachments: [{ filename: `${invoice.invoiceNumber}.pdf`, content: pdf, contentType: 'application/pdf' }],
    })
    await recordAudit(String(req.authUser!.id), 'emailed', 'invoice', String(invoice._id), `Emailed ${invoice.invoiceNumber}`)
    res.json({ message: 'Invoice email sent.' })
  } catch (error) { next(error) }
})

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
      ['audit-log', AuditLog], ['document-counters', Counter],
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
        reject(new BusinessError(413, 'Workspace backup exceeds Vercel’s 4 MB download limit. Use Atlas backups for full recovery.'))
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
  lines: readonly { description: string; quantity: number; unitPriceMinor: number; discountPercent: number; totalMinor: number }[]
}

function buildInvoicePdf(input: PdfInput) {
  const document = new PDFDocument({ size: 'A4', margin: 48, info: { Title: `Invoice ${input.invoiceNumber}`, Author: input.businessName } })
  document.fillColor('#116b47').fontSize(18).font('Helvetica-Bold').text(input.businessName)
  document.fillColor('#667085').fontSize(9).font('Helvetica').text('Business invoice', { continued: false })
  document.moveDown(1.5)
  document.fillColor('#172235').fontSize(22).font('Helvetica-Bold').text('INVOICE')
  document.font('Helvetica').fontSize(10).text(input.invoiceNumber)
  document.moveDown()
  document.font('Helvetica-Bold').text('Bill to')
  document.font('Helvetica').text(input.customerName)
  if (input.customerAddress) document.text(input.customerAddress)
  if (input.customerPhone) document.text(input.customerPhone)
  if (input.customerEmail) document.text(input.customerEmail)
  document.moveDown()
  document.text(`Issue date: ${input.issueDate.toISOString().slice(0, 10)}`)
  if (input.dueDate) document.text(`Due date: ${input.dueDate.toISOString().slice(0, 10)}`)
  document.moveDown()
  const x = [48, 300, 360, 425, 500]
  const tableY = document.y
  document.rect(48, tableY, 500, 24).fill('#eef5f1')
  document.fillColor('#172235').font('Helvetica-Bold').fontSize(9)
  document.text('Description', x[0] + 7, tableY + 8, { width: 240 })
  document.text('Qty', x[1], tableY + 8, { width: 50, align: 'right' })
  document.text('Rate', x[2], tableY + 8, { width: 60, align: 'right' })
  document.text('Discount', x[3], tableY + 8, { width: 60, align: 'right' })
  document.text('Amount', x[4], tableY + 8, { width: 48, align: 'right' })
  document.y = tableY + 30
  for (const line of input.lines) {
    if (document.y > 700) document.addPage()
    const rowY = document.y
    document.font('Helvetica').fontSize(9).fillColor('#344054')
    document.text(line.description, x[0] + 7, rowY, { width: 238 })
    document.text(String(line.quantity), x[1], rowY, { width: 50, align: 'right' })
    document.text(currency(line.unitPriceMinor), x[2], rowY, { width: 60, align: 'right' })
    document.text(`${line.discountPercent}%`, x[3], rowY, { width: 60, align: 'right' })
    document.text(currency(line.totalMinor), x[4], rowY, { width: 48, align: 'right' })
    document.moveDown(1.6)
    document.strokeColor('#e5e9ef').moveTo(48, document.y).lineTo(548, document.y).stroke()
    document.moveDown(.5)
  }
  document.moveDown()
  document.font('Helvetica-Bold').fontSize(10).fillColor('#172235').text(`Total: ${currency(input.totalMinor)}`, { align: 'right' })
  document.font('Helvetica').text(`Paid: ${currency(input.paidMinor)}`, { align: 'right' })
  document.font('Helvetica-Bold').fillColor('#116b47').text(`Amount due: ${currency(Math.max(0, input.totalMinor - input.paidMinor))}`, { align: 'right' })
  if (input.notes) document.moveDown().font('Helvetica').fillColor('#667085').fontSize(9).text(input.notes)
  document.moveDown(2).font('Helvetica').fillColor('#667085').fontSize(9).text('Thank you for your business.')
  return document
}

function invoicePdfBuffer(input: PdfInput) {
  return new Promise<Buffer>((resolve, reject) => {
    const document = buildInvoicePdf(input)
    const chunks: Buffer[] = []
    document.on('data', (chunk: Buffer) => chunks.push(chunk))
    document.on('end', () => resolve(Buffer.concat(chunks)))
    document.on('error', reject)
    document.end()
  })
}

function currency(amountMinor: number) {
  return new Intl.NumberFormat('en-BD', { style: 'currency', currency: config.CURRENCY, maximumFractionDigits: 2 }).format(amountMinor / 100)
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
