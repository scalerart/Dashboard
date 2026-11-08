import mongoose, { type ClientSession } from 'mongoose'
import { z } from 'zod'
import { Counter } from '../models.js'
import { currentTenantId } from '../tenant-context.js'

export const paymentMethodSchema = z.enum(['cash', 'bank', 'bkash', 'nagad', 'rocket', 'other'])

export const paginationSchema = z.object({
  search: z.string().trim().max(120).default(''),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(10),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
})

export async function nextDocumentNumber(prefix: string, session?: ClientSession) {
  const tenantCounterId = `${currentTenantId().toString()}:${prefix}`
  const counter = await Counter.findByIdAndUpdate(
    tenantCounterId,
    { $inc: { value: 1 } },
    { upsert: true, returnDocument: 'after', ...(session ? { session } : {}) },
  )
  return `${prefix}-${String(counter.value).padStart(6, '0')}`
}

export async function recordAudit(
  _actorId: string,
  _action: string,
  _entity: string,
  _entityId: string,
  _summary: string,
  _session?: ClientSession,
): Promise<void> {
  return Promise.resolve()
}

export async function withTransaction<T>(work: (session: ClientSession) => Promise<T>) {
  const session = await mongoose.startSession()
  try {
    let result!: T
    let completed = false
    await session.withTransaction(async () => {
      result = await work(session)
      completed = true
    })
    if (!completed) throw new Error('Database transaction completed without running its work callback.')
    return result
  } finally {
    await session.endSession()
  }
}

export function isMongoDuplicateKeyError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 11000
}

export function validObjectId(value: string) {
  return mongoose.isValidObjectId(value)
}

export const paymentMethods = ['cash', 'bank', 'bkash', 'nagad', 'rocket', 'other'] as const
export type PaymentMethod = (typeof paymentMethods)[number]

export function createSearchFilter(search: string, keys: string[]) {
  if (!search) return {}
  const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(escaped, 'i')
  return { $or: keys.map((key) => ({ [key]: pattern })) }
}

export function periodFilter(from?: Date, to?: Date) {
  if (!from && !to) return {}
  return {
    ...(from ? { $gte: from } : {}),
    ...(to ? { $lte: to } : {}),
  }
}

export type AuthenticatedUser = NonNullable<Express.Request['authUser']>
