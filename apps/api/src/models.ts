import mongoose, { Schema } from 'mongoose'
import { currentTenantId } from './tenant-context.js'

const userSchema = new Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    passwordHash: { type: String, required: true, select: false },
    businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true },
    emailVerified: { type: Boolean, required: true, default: false },
    role: { type: String, enum: ['owner', 'admin', 'accountant', 'staff'], default: 'owner' },
  },
  { timestamps: true },
)

const setupClaimSchema = new Schema({
  _id: { type: String, required: true },
  createdAt: { type: Date, default: Date.now, expires: 120 },
})

const businessSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 160 },
    owner: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
)

const emailVerificationSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    tokenHash: { type: String, required: true },
    expiresAt: { type: Date, required: true, expires: 0 },
  },
  { timestamps: true },
)

const customerSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 160 },
    phone: { type: String, trim: true, default: '' },
    email: { type: String, lowercase: true, trim: true, default: '' },
    address: { type: String, trim: true, default: '', maxlength: 500 },
    status: { type: String, enum: ['active', 'inactive'], default: 'active' },
  },
  { timestamps: true },
)

const orderSchema = new Schema(
  {
    orderNumber: { type: String, required: true, trim: true },
    customer: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
    description: { type: String, required: true, trim: true, maxlength: 500 },
    amountMinor: { type: Number, required: true, min: 0 },
    status: {
      type: String,
      enum: ['pending', 'processing', 'printing', 'ready', 'delivered', 'cancelled'],
      default: 'pending',
    },
    orderDate: { type: Date, required: true, default: Date.now },
    dueDate: { type: Date },
  },
  { timestamps: true },
)
orderSchema.index({ businessId: 1, orderNumber: 1 }, { unique: true })
orderSchema.index({ orderDate: -1 })

const invoiceSchema = new Schema(
  {
    invoiceNumber: { type: String, required: true, trim: true },
    customer: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
    order: { type: Schema.Types.ObjectId, ref: 'Order' },
    lines: {
      type: [{
        description: { type: String, required: true, trim: true, maxlength: 250 },
        quantity: { type: Number, required: true, min: 0.001 },
        unitPriceMinor: { type: Number, required: true, min: 0 },
        discountPercent: { type: Number, default: 0, min: 0, max: 100 },
        totalMinor: { type: Number, required: true, min: 0 },
      }],
      required: true,
      validate: [(lines: unknown[]) => lines.length > 0, 'At least one invoice line is required.'],
    },
    notes: { type: String, trim: true, default: '', maxlength: 1000 },
    issueDate: { type: Date, required: true, default: Date.now },
    dueDate: { type: Date },
    totalMinor: { type: Number, required: true, min: 0 },
    paidMinor: { type: Number, required: true, default: 0, min: 0 },
    status: {
      type: String,
      enum: ['draft', 'sent', 'partial', 'paid', 'overdue', 'void'],
      default: 'sent',
    },
  },
  { timestamps: true },
)
invoiceSchema.index({ businessId: 1, invoiceNumber: 1 }, { unique: true })
invoiceSchema.index({ issueDate: -1 })

const paymentSchema = new Schema(
  {
    paymentNumber: { type: String, required: true, trim: true },
    customer: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
    invoice: { type: Schema.Types.ObjectId, ref: 'Invoice' },
    amountMinor: { type: Number, required: true, min: 1 },
    method: { type: String, enum: ['cash', 'bank', 'bkash', 'nagad', 'rocket', 'other'], required: true },
    receivedAt: { type: Date, required: true, default: Date.now },
    reference: { type: String, trim: true, default: '', maxlength: 120 },
    idempotencyKey: { type: String, trim: true, default: undefined, maxlength: 120 },
    requestHash: { type: String, default: '' },
  },
  { timestamps: true },
)
paymentSchema.index({ businessId: 1, paymentNumber: 1 }, { unique: true })
paymentSchema.index({ receivedAt: -1 })
paymentSchema.index(
  { businessId: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } },
)

const expenseSchema = new Schema(
  {
    category: { type: String, required: true, trim: true, maxlength: 100 },
    description: { type: String, required: true, trim: true, maxlength: 500 },
    amountMinor: { type: Number, required: true, min: 1 },
    paymentMethod: { type: String, enum: ['cash', 'bank', 'bkash', 'nagad', 'rocket', 'other'], default: 'cash' },
    reference: { type: String, trim: true, default: '', maxlength: 120 },
    spentAt: { type: Date, required: true, default: Date.now },
    status: { type: String, enum: ['active', 'void'], default: 'active' },
  },
  { timestamps: true },
)
expenseSchema.index({ spentAt: -1 })

const supplierSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 160 },
    phone: { type: String, trim: true, default: '', maxlength: 40 },
    email: { type: String, trim: true, lowercase: true, default: '' },
    address: { type: String, trim: true, default: '', maxlength: 500 },
    status: { type: String, enum: ['active', 'inactive'], default: 'active' },
  },
  { timestamps: true },
)

const productSchema = new Schema(
  {
    sku: { type: String, required: true, trim: true, uppercase: true, maxlength: 60 },
    name: { type: String, required: true, trim: true, maxlength: 160 },
    category: { type: String, required: true, trim: true, maxlength: 100 },
    unit: { type: String, required: true, trim: true, maxlength: 30 },
    stockQuantity: { type: Number, required: true, default: 0, min: 0 },
    reorderLevel: { type: Number, required: true, default: 0, min: 0 },
    costMinor: { type: Number, required: true, default: 0, min: 0 },
    status: { type: String, enum: ['active', 'inactive'], default: 'active' },
  },
  { timestamps: true },
)
productSchema.index({ businessId: 1, sku: 1 }, { unique: true })

const incomeSchema = new Schema(
  {
    category: { type: String, required: true, trim: true, maxlength: 100 },
    description: { type: String, required: true, trim: true, maxlength: 500 },
    amountMinor: { type: Number, required: true, min: 1 },
    paymentMethod: { type: String, enum: ['cash', 'bank', 'bkash', 'nagad', 'rocket', 'other'], default: 'cash' },
    reference: { type: String, trim: true, default: '', maxlength: 120 },
    receivedAt: { type: Date, required: true, default: Date.now },
    status: { type: String, enum: ['active', 'void'], default: 'active' },
  },
  { timestamps: true },
)
incomeSchema.index({ receivedAt: -1 })

const purchaseLineSchema = new Schema(
  {
    product: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    quantity: { type: Number, required: true, min: 0.001 },
    unitCostMinor: { type: Number, required: true, min: 0 },
    totalMinor: { type: Number, required: true, min: 0 },
  },
  { _id: false },
)

const purchaseSchema = new Schema(
  {
    purchaseNumber: { type: String, required: true, trim: true },
    idempotencyKey: { type: String, trim: true, default: undefined, maxlength: 120 },
    requestHash: { type: String, default: '' },
    supplier: { type: Schema.Types.ObjectId, ref: 'Supplier', required: true },
    lines: { type: [purchaseLineSchema], required: true, validate: [(lines: unknown[]) => lines.length > 0, 'At least one product is required.'] },
    totalMinor: { type: Number, required: true, min: 0 },
    paidMinor: { type: Number, required: true, default: 0, min: 0 },
    paymentMethod: { type: String, enum: ['cash', 'bank', 'bkash', 'nagad', 'rocket', 'other'], default: 'cash' },
    purchasedAt: { type: Date, required: true, default: Date.now },
    status: { type: String, enum: ['received', 'partial', 'paid'], default: 'received' },
  },
  { timestamps: true },
)
purchaseSchema.index({ businessId: 1, purchaseNumber: 1 }, { unique: true })
purchaseSchema.index({ purchasedAt: -1 })
purchaseSchema.index(
  { businessId: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } },
)

const ledgerEntrySchema = new Schema(
  {
    entryNumber: { type: String, required: true },
    direction: { type: String, enum: ['in', 'out'], required: true },
    category: { type: String, required: true, maxlength: 100 },
    description: { type: String, required: true, maxlength: 500 },
    amountMinor: { type: Number, required: true, min: 1 },
    paymentMethod: { type: String, enum: ['cash', 'bank', 'bkash', 'nagad', 'rocket', 'other'], required: true },
    reference: { type: String, default: '' },
    sourceType: { type: String, enum: ['payment', 'expense', 'income', 'purchase', 'supplier_payment'], required: true },
    sourceId: { type: Schema.Types.ObjectId, required: true },
    postedAt: { type: Date, required: true },
    voidedAt: { type: Date },
  },
  { timestamps: true },
)
ledgerEntrySchema.index({ businessId: 1, entryNumber: 1 }, { unique: true })
ledgerEntrySchema.index({ sourceType: 1, sourceId: 1 }, { unique: true })
ledgerEntrySchema.index({ postedAt: -1 })

const stockMovementSchema = new Schema(
  {
    product: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    direction: { type: String, enum: ['in', 'out', 'adjustment'], required: true },
    quantity: { type: Number, required: true },
    unitCostMinor: { type: Number, required: true, min: 0, default: 0 },
    sourceType: { type: String, enum: ['purchase', 'adjustment'], required: true },
    sourceId: { type: Schema.Types.ObjectId, required: true },
    note: { type: String, default: '', maxlength: 250 },
    postedAt: { type: Date, required: true, default: Date.now },
  },
  { timestamps: true },
)
stockMovementSchema.index({ sourceType: 1, sourceId: 1, product: 1 }, { unique: true })

const supplierPaymentSchema = new Schema(
  {
    paymentNumber: { type: String, required: true, trim: true },
    supplier: { type: Schema.Types.ObjectId, ref: 'Supplier', required: true },
    purchase: { type: Schema.Types.ObjectId, ref: 'Purchase', required: true },
    amountMinor: { type: Number, required: true, min: 1 },
    method: { type: String, enum: ['cash', 'bank', 'bkash', 'nagad', 'rocket', 'other'], required: true },
    reference: { type: String, trim: true, default: '', maxlength: 120 },
    paidAt: { type: Date, required: true, default: Date.now },
  },
  { timestamps: true },
)
supplierPaymentSchema.index({ businessId: 1, paymentNumber: 1 }, { unique: true })
supplierPaymentSchema.index({ paidAt: -1 })

const auditLogSchema = new Schema(
  {
    actor: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    action: { type: String, required: true, maxlength: 100 },
    entity: { type: String, required: true, maxlength: 80 },
    entityId: { type: String, required: true, maxlength: 80 },
    summary: { type: String, required: true, maxlength: 500 },
  },
  { timestamps: true },
)
auditLogSchema.index({ createdAt: -1 })

const businessDocumentSchema = new Schema(
  {
    entityType: {
      type: String,
      enum: ['order', 'invoice', 'payment', 'expense', 'income', 'supplier', 'product', 'purchase'],
      required: true,
    },
    entityId: { type: Schema.Types.ObjectId, required: true },
    fileName: { type: String, required: true, maxlength: 200 },
    contentType: { type: String, required: true, maxlength: 100 },
    publicId: { type: String, required: true },
    resourceType: { type: String, required: true, enum: ['image', 'raw', 'video'] },
    uploadedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
)
businessDocumentSchema.index({ entityType: 1, entityId: 1, createdAt: -1 })

const counterSchema = new Schema({ _id: { type: String }, value: { type: Number, default: 0 } })

function applyTenantScope(schema: mongoose.Schema) {
  schema.add({ businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true } })
  const scopeQuery = function (this: mongoose.Query<unknown, unknown>) {
    const businessId = currentTenantId()
    this.where({ businessId })
    const update = this.getUpdate()
    if (!update || Array.isArray(update)) return
    const updateDocument = update as Record<string, unknown>
    const setOnInsert = (updateDocument.$setOnInsert ??= {}) as Record<string, unknown>
    setOnInsert.businessId = businessId
  }
  schema.pre('countDocuments', scopeQuery)
  schema.pre('deleteMany', scopeQuery)
  schema.pre('deleteOne', scopeQuery)
  schema.pre('distinct', scopeQuery)
  schema.pre('find', scopeQuery)
  schema.pre('findOne', scopeQuery)
  schema.pre('findOneAndDelete', scopeQuery)
  schema.pre('findOneAndReplace', scopeQuery)
  schema.pre('findOneAndUpdate', scopeQuery)
  schema.pre('replaceOne', scopeQuery)
  schema.pre('updateMany', scopeQuery)
  schema.pre('updateOne', scopeQuery)
  schema.pre('aggregate', function () {
    this.pipeline().unshift({ $match: { businessId: currentTenantId() } })
  })
  schema.pre('validate', function (this: mongoose.Document) {
    const businessId = currentTenantId()
    const existing = this.get('businessId')
    if (existing && mongoose.isValidObjectId(existing) && !new mongoose.Types.ObjectId(String(existing)).equals(businessId)) {
      throw new Error('A record cannot be moved to another business tenant.')
    }
    this.set('businessId', businessId)
  })
}

for (const schema of [
  customerSchema,
  orderSchema,
  invoiceSchema,
  paymentSchema,
  expenseSchema,
  supplierSchema,
  productSchema,
  incomeSchema,
  purchaseSchema,
  ledgerEntrySchema,
  stockMovementSchema,
  supplierPaymentSchema,
  auditLogSchema,
  businessDocumentSchema,
  counterSchema,
]) {
  applyTenantScope(schema)
}

export const User = mongoose.models.User ?? mongoose.model('User', userSchema)
export const SetupClaim = mongoose.models.SetupClaim ?? mongoose.model('SetupClaim', setupClaimSchema)
export const Customer = mongoose.models.Customer ?? mongoose.model('Customer', customerSchema)
export const Order = mongoose.models.Order ?? mongoose.model('Order', orderSchema)
export const Invoice = mongoose.models.Invoice ?? mongoose.model('Invoice', invoiceSchema)
export const Payment = mongoose.models.Payment ?? mongoose.model('Payment', paymentSchema)
export const Expense = mongoose.models.Expense ?? mongoose.model('Expense', expenseSchema)
export const Supplier = mongoose.models.Supplier ?? mongoose.model('Supplier', supplierSchema)
export const Product = mongoose.models.Product ?? mongoose.model('Product', productSchema)
export const Income = mongoose.models.Income ?? mongoose.model('Income', incomeSchema)
export const Purchase = mongoose.models.Purchase ?? mongoose.model('Purchase', purchaseSchema)
export const LedgerEntry = mongoose.models.LedgerEntry ?? mongoose.model('LedgerEntry', ledgerEntrySchema)
export const StockMovement = mongoose.models.StockMovement ?? mongoose.model('StockMovement', stockMovementSchema)
export const SupplierPayment = mongoose.models.SupplierPayment ?? mongoose.model('SupplierPayment', supplierPaymentSchema)
export const AuditLog = mongoose.models.AuditLog ?? mongoose.model('AuditLog', auditLogSchema)
export const BusinessDocument = mongoose.models.BusinessDocument ?? mongoose.model('BusinessDocument', businessDocumentSchema)
export const Business = mongoose.models.Business ?? mongoose.model('Business', businessSchema)
export const EmailVerification = mongoose.models.EmailVerification ?? mongoose.model('EmailVerification', emailVerificationSchema)
export const Counter = mongoose.models.Counter ?? mongoose.model('Counter', counterSchema)
