import assert from 'node:assert/strict'
import test from 'node:test'
import { customerInputSchema, customerQuerySchema, escapeRegex, normalizePhone } from './customer-validation.js'

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

test('phone normalization matches Bangladeshi local and international mobile formats', () => {
  assert.equal(normalizePhone('+880 1712-345678'), '01712345678')
  assert.equal(normalizePhone('008801712345678'), '01712345678')
  assert.equal(normalizePhone('1712345678'), '01712345678')
})

test('customer pagination is bounded', () => {
  assert.equal(customerQuerySchema.parse({ page: '2', limit: '25' }).page, 2)
  assert.equal(customerQuerySchema.safeParse({ limit: '500' }).success, false)
})
