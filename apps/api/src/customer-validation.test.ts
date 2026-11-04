import assert from 'node:assert/strict'
import test from 'node:test'
import { customerInputSchema, customerQuerySchema, escapeRegex } from './customer-validation.js'

test('customer input trims fields and permits optional contact details', () => {
  assert.deepEqual(customerInputSchema.parse({ name: '  MAA Press  ' }), {
    name: 'MAA Press',
    phone: '',
    email: '',
    address: '',
  })
})

test('customer search treats regex characters as literal text', () => {
  assert.equal(escapeRegex('a+b[1]'), 'a\\+b\\[1\\]')
})

test('customer pagination is bounded', () => {
  assert.equal(customerQuerySchema.parse({ page: '2', limit: '25' }).page, 2)
  assert.equal(customerQuerySchema.safeParse({ limit: '500' }).success, false)
})
