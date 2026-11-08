import assert from 'node:assert/strict'
import test from 'node:test'
import mongoose from 'mongoose'
import { isMongoDuplicateKeyError, recordAudit, withTransaction } from './workflows.js'

test('duplicate-key detection recognizes MongoDB unique-index errors', () => {
  assert.equal(isMongoDuplicateKeyError({ code: 11000 }), true)
  assert.equal(isMongoDuplicateKeyError(new Error('duplicate key')), false)
  assert.equal(isMongoDuplicateKeyError(null), false)
})

test('recordAudit does not persist audit events', async () => {
  await assert.doesNotReject(() => recordAudit('actor', 'created', 'order', 'entity', 'summary'))
})

test('withTransaction accepts successful callbacks with and without a result', async () => {
  const originalStartSession = Object.getOwnPropertyDescriptor(mongoose, 'startSession')
  const session = {
    withTransaction: async (work: () => Promise<unknown>) => work(),
    endSession: async () => {},
  }
  Object.defineProperty(mongoose, 'startSession', {
    configurable: true,
    value: async () => session,
  })

  try {
    assert.equal(await withTransaction(async () => undefined), undefined)
    assert.equal(await withTransaction(async () => 'saved'), 'saved')
  } finally {
    if (originalStartSession) Object.defineProperty(mongoose, 'startSession', originalStartSession)
    else Reflect.deleteProperty(mongoose, 'startSession')
  }
})
