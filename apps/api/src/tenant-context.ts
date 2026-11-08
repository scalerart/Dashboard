import { AsyncLocalStorage } from 'node:async_hooks'
import mongoose from 'mongoose'

const tenantStorage = new AsyncLocalStorage<string>()

export function runWithTenant<T>(businessId: string, callback: () => T): T {
  return tenantStorage.run(businessId, callback)
}

export function currentTenantId() {
  const businessId = tenantStorage.getStore()
  if (!businessId || !mongoose.isValidObjectId(businessId)) {
    throw new Error('A valid business tenant context is required for this operation.')
  }
  return new mongoose.Types.ObjectId(businessId)
}
