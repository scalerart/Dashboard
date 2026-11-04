import assert from 'node:assert/strict'
import test from 'node:test'
import { isMongoDuplicateKeyError } from './workflows.js'

test('duplicate-key detection recognizes MongoDB unique-index errors', () => {
  assert.equal(isMongoDuplicateKeyError({ code: 11000 }), true)
  assert.equal(isMongoDuplicateKeyError(new Error('duplicate key')), false)
  assert.equal(isMongoDuplicateKeyError(null), false)
})
