import assert from 'node:assert/strict'
import test from 'node:test'
import { calculateInvoiceTotalMinor, calculateLineGrossMinor, calculateLineTotalMinor, calculateOrderTotalsMinor, outstandingMinor, weightedAverageCostMinor } from './accounting.js'

test('invoice total uses integer minor currency units and line discounts', () => {
  assert.equal(
    calculateInvoiceTotalMinor([
      { quantity: 3, unitPriceMinor: 12550, discountPercent: 10 },
      { quantity: 1, unitPriceMinor: 20000 },
    ]),
    53885,
  )
})

test('invoice line calculations reject unsafe totals and invalid amounts', () => {
  assert.throws(() => calculateLineTotalMinor(1_000_000, Number.MAX_SAFE_INTEGER), RangeError)
  assert.throws(() => calculateLineGrossMinor(1_000_000, Number.MAX_SAFE_INTEGER), RangeError)
  assert.throws(() => calculateLineTotalMinor(1, -1), RangeError)
  assert.throws(() => calculateInvoiceTotalMinor([
    { quantity: 1, unitPriceMinor: Number.MAX_SAFE_INTEGER },
    { quantity: 1, unitPriceMinor: 1 },
  ]), RangeError)
})

test('outstanding amount never becomes negative after overpayment', () => {
  assert.equal(outstandingMinor(10000, 3500), 6500)
  assert.equal(outstandingMinor(10000, 12000), 0)
})

test('order totals deduct discount and advance exactly in minor currency units', () => {
  assert.deepEqual(calculateOrderTotalsMinor(12500, 2500, 5000), { totalMinor: 10000, dueMinor: 5000 })
  assert.throws(() => calculateOrderTotalsMinor(10000, 10000, 0), RangeError)
  assert.throws(() => calculateOrderTotalsMinor(10000, 500, 9501), RangeError)
})

test('weighted-average inventory cost combines existing stock and receipts', () => {
  assert.equal(weightedAverageCostMinor(10, 1000, 5, 1600), 1200)
  assert.equal(weightedAverageCostMinor(0, 0, 2.5, 725), 725)
  assert.equal(weightedAverageCostMinor(0, 900, 0, 500), 0)
})

test('weighted-average inventory cost rejects invalid or unsafe values', () => {
  assert.throws(() => weightedAverageCostMinor(-1, 100, 1, 100), RangeError)
  assert.throws(() => weightedAverageCostMinor(1_000_000, Number.MAX_SAFE_INTEGER, 1, 1), RangeError)
})
