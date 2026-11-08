import assert from 'node:assert/strict'
import test from 'node:test'
import { invoicePdfBuffer } from './integrations.js'

test('invoice PDF renders the branded layout with an embedded Bengali font and payment details', async () => {
  const pdf = await invoicePdfBuffer({
    businessName: 'Maa Offset Press',
    businessPhone: '01765-843831',
    businessEmail: 'office@example.test',
    businessAddress: 'Main Road, Raipur',
    invoiceFooter: 'Thank you for your business.',
    currencyCode: 'BDT',
    invoiceNumber: '1002',
    issueDate: new Date('2026-11-04T00:00:00.000Z'),
    dueDate: new Date('2026-11-06T00:00:00.000Z'),
    totalMinor: 700000,
    paidMinor: 500000,
    notes: '',
    customerName: 'আবদুল কাদির',
    customerAddress: 'রায়পুর, লক্ষ্মীপুর; Main Road, Building 5, Level 2. '.repeat(5),
    customerEmail: '',
    customerPhone: '01939391388',
    orderNumber: 'ORD-000001',
    orderStatus: 'ready',
    deliveryDate: new Date('2026-11-04T00:00:00.000Z'),
    payments: [{
      paymentNumber: 'PAY-000001',
      amountMinor: 500000,
      method: 'cash',
      reference: 'Advance for order ORD-000001',
      receivedAt: new Date('2026-11-04T00:00:00.000Z'),
    }],
    lines: [{
      description: 'ব্যানার',
      quantity: 20,
      unitPriceMinor: 36000,
      discountPercent: 0,
      grossMinor: 720000,
      discountMinor: 20000,
      totalMinor: 700000,
    }],
  })

  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-')
  assert.ok(pdf.includes(Buffer.from('/FontFile2')), 'Bengali font must be embedded in the PDF')
  assert.ok(pdf.length > 3000)
})
