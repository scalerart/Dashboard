import assert from 'node:assert/strict'
import test from 'node:test'
import mongoose from 'mongoose'
import { currentTenantId, runWithTenant } from './tenant-context.js'

test('tenant access fails closed outside an authenticated context', () => {
  assert.throws(() => currentTenantId(), /business tenant context is required/)
})

test('tenant context survives asynchronous work and remains isolated between requests', async () => {
  const first = new mongoose.Types.ObjectId().toString()
  const second = new mongoose.Types.ObjectId().toString()
  const values = await Promise.all([
    runWithTenant(first, async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      return currentTenantId().toString()
    }),
    runWithTenant(second, async () => {
      await new Promise((resolve) => setTimeout(resolve, 1))
      return currentTenantId().toString()
    }),
  ])
  assert.deepEqual(values, [first, second])
})
