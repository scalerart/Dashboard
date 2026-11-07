import mongoose from 'mongoose'
import { normalizePhone } from './customer-validation.js'
import {
  Business,
  BusinessDocument,
  Counter,
  Customer,
  EmailVerification,
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
  SetupClaim,
  User,
} from './models.js'

const tenantModels = [
  Customer,
  Order,
  Invoice,
  Payment,
  Expense,
  Supplier,
  Product,
  Income,
  Purchase,
  LedgerEntry,
  StockMovement,
  SupplierPayment,
  BusinessDocument,
  Counter,
]
const unassignedTenantFilter = {
  $or: [{ businessId: { $exists: false } }, { businessId: null }],
}

async function backfillCustomerPhones() {
  const customers = await Customer.collection.find(
    {},
    { projection: { _id: 1, businessId: 1, phone: 1, phoneNormalized: 1 } },
  ).sort({ createdAt: 1, _id: 1 }).toArray()
  const claimed = new Set<string>()
  for (const customer of customers) {
    const phoneNormalized = normalizePhone(String(customer.phone ?? ''))
    const key = `${String(customer.businessId)}:${phoneNormalized}`
    if (!phoneNormalized || claimed.has(key)) {
      if (customer.phoneNormalized !== undefined) {
        await Customer.collection.updateOne({ _id: customer._id }, { $unset: { phoneNormalized: 1 } })
      }
      continue
    }
    claimed.add(key)
    if (customer.phoneNormalized !== phoneNormalized) {
      await Customer.collection.updateOne({ _id: customer._id }, { $set: { phoneNormalized } })
    }
  }
}

export async function prepareTenantDatabase() {
  const legacyUsers = await User.collection.find(
    unassignedTenantFilter,
    { projection: { _id: 1, name: 1 } },
  ).toArray()
  for (const user of legacyUsers) {
    const businessId = new mongoose.Types.ObjectId(String(user._id))
    const now = new Date()
    await Business.collection.updateOne(
      { _id: businessId },
      { $setOnInsert: { name: 'MAA Offset Press', owner: user._id, createdAt: now, updatedAt: now } },
      { upsert: true },
    )
    await User.collection.updateOne(
      { _id: user._id },
      { $set: { businessId, emailVerified: true } },
    )
  }
  await User.collection.updateMany(
    { emailVerified: { $exists: false } },
    { $set: { emailVerified: true } },
  )

  const businessIds = await User.distinct('businessId')
  let legacyRecordCount = 0
  for (const model of tenantModels) {
    legacyRecordCount += await model.collection.countDocuments(unassignedTenantFilter)
  }
  if (legacyRecordCount > 0) {
    const uniqueBusinessIds = [...new Set(businessIds.map(String))]
    if (uniqueBusinessIds.length !== 1) {
      throw new Error('Legacy business records cannot be assigned safely: exactly one existing owner tenant is required.')
    }
    const [businessId] = uniqueBusinessIds
    for (const model of tenantModels) {
      await model.collection.updateMany(
        unassignedTenantFilter,
        { $set: { businessId: new mongoose.Types.ObjectId(businessId) } },
      )
    }
  }

  await backfillCustomerPhones()

  const counterCollection = mongoose.connection.collection<Record<string, unknown> & {
    _id: string
    businessId: mongoose.Types.ObjectId
    value: number
  }>(Counter.collection.collectionName)
  const legacyCounters = await counterCollection.find({ _id: { $not: /^\w+:/ } }).toArray()
  for (const counter of legacyCounters) {
    const businessId = String(counter.businessId)
    if (!mongoose.isValidObjectId(businessId)) {
      throw new Error('A legacy document counter has no valid business tenant.')
    }
    const newId = `${businessId}:${String(counter._id)}`
    await counterCollection.updateOne(
      { _id: newId },
      { $max: { value: Number(counter.value ?? 0) }, $setOnInsert: { businessId: new mongoose.Types.ObjectId(businessId) } },
      { upsert: true },
    )
    await counterCollection.deleteOne({ _id: counter._id })
  }

  for (const model of [Business, User, SetupClaim, EmailVerification, ...tenantModels]) {
    await model.syncIndexes()
  }
  await mongoose.connection.collection('api_rate_limit_buckets').createIndex(
    { expiresAt: 1 },
    { expireAfterSeconds: 0 },
  )
}

export async function initializeFreshTenantDatabase() {
  const legacyUsers = await User.collection.countDocuments({
    $or: [
      { businessId: { $exists: false } },
      { businessId: null },
      { emailVerified: { $exists: false } },
    ],
  })
  let legacyRecords = 0
  for (const model of tenantModels) {
    legacyRecords += await model.collection.countDocuments(unassignedTenantFilter)
  }
  const legacyCounters = await Counter.collection.countDocuments({ _id: { $not: /^\w+:/ } })
  if (legacyUsers > 0 || legacyRecords > 0 || legacyCounters > 0) {
    throw new Error('Legacy tenant migration is required before the serverless API can start.')
  }

  const db = mongoose.connection.db
  if (!db) throw new Error('MongoDB must be connected before initializing tenant indexes.')
  const customerCollectionExists = await db.listCollections(
    { name: Customer.collection.collectionName },
    { nameOnly: true },
  ).hasNext()
  const phoneIndex = customerCollectionExists
    ? (await Customer.collection.indexes()).find((index) => index.name === 'businessId_1_phoneNormalized_1')
    : undefined
  if (!phoneIndex?.unique) {
    await backfillCustomerPhones()
    await Customer.syncIndexes()
  }

  await Promise.all(
    [Business, User, SetupClaim, EmailVerification, ...tenantModels]
      .map((model) => model.createIndexes()),
  )
  await mongoose.connection.collection('api_rate_limit_buckets').createIndex(
    { expiresAt: 1 },
    { expireAfterSeconds: 0 },
  )
}
