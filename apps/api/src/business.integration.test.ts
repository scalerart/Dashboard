import 'dotenv/config'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import { createInterface } from 'node:readline'
import type { Server } from 'node:http'
import test from 'node:test'
import mongoose from 'mongoose'
import { AuditLog } from './models.js'

type JsonResult<T> = T

test('business workflows keep payments, inventory, reports, and ledger consistent on an isolated replica-set database', {
  skip: process.env.MONGODB_TEST_URI ? false : 'Set MONGODB_TEST_URI to run isolated MongoDB integration tests.',
}, async () => {
  const testUri = process.env.MONGODB_TEST_URI
  assert.ok(testUri)
  const testUrl = new URL(testUri)
  const databaseName = `maa_offset_test_${randomUUID().replaceAll('-', '').slice(0, 20)}`
  testUrl.pathname = `/${databaseName}`
  process.env.MONGODB_URI = testUrl.toString()
  let server: Server | undefined
  let smtpServer: ReturnType<typeof createServer> | undefined
  let smtpListening = false
  let lastVerificationToken = ''
  let sessionCookie = ''

  async function request(path: string, options: { method?: string; body?: unknown; idempotencyKey?: string } = {}) {
    const address = server?.address()
    if (!address || typeof address === 'string') throw new Error('Integration server is not listening.')
    const headers = new Headers()
    if (sessionCookie) headers.set('Cookie', sessionCookie)
    if (options.body !== undefined) headers.set('Content-Type', 'application/json')
    if (options.idempotencyKey) headers.set('Idempotency-Key', options.idempotencyKey)
    return fetch(`http://127.0.0.1:${address.port}/api${path}`, {
      method: options.method ?? 'GET',
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    })
  }

  async function json<T>(response: Response) {
    return response.json() as Promise<JsonResult<T>>
  }

  try {
    process.env.NODE_ENV = 'test'
    process.env.CLIENT_ORIGIN = 'https://test.example'
    process.env.SMTP_HOST = '127.0.0.1'
    process.env.SMTP_USER = 'integration-user'
    process.env.SMTP_PASSWORD = 'integration-password'
    process.env.SMTP_FROM = 'integration@example.test'
    if (!process.env.JWT_SECRET) process.env.JWT_SECRET = randomUUID() + randomUUID()
    smtpServer = createServer((socket) => {
      const lines = createInterface({ input: socket })
      let authStage = 0
      let readingMessage = false
      let message = ''
      socket.write('220 integration SMTP ready\r\n')
      lines.on('line', (line) => {
        if (readingMessage) {
          if (line === '.') {
            readingMessage = false
            const token = message.match(/\/verify\?token=([A-Za-z0-9_-]+)/)?.[1]
            if (token) lastVerificationToken = token.slice(-43)
            message = ''
            socket.write('250 message accepted\r\n')
          } else {
            message += `${line}\n`
          }
          return
        }
        if (authStage === 1) {
          authStage = 2
          socket.write('334 UGFzc3dvcmQ6\r\n')
        } else if (authStage === 2) {
          authStage = 0
          socket.write('235 authenticated\r\n')
        } else if (line.startsWith('EHLO') || line.startsWith('HELO')) {
          socket.write('250-localhost\r\n250-AUTH LOGIN\r\n250 8BITMIME\r\n')
        } else if (line === 'AUTH LOGIN') {
          authStage = 1
          socket.write('334 VXNlcm5hbWU6\r\n')
        } else if (line.startsWith('MAIL FROM:') || line.startsWith('RCPT TO:')) {
          socket.write('250 accepted\r\n')
        } else if (line === 'DATA') {
          readingMessage = true
          socket.write('354 send message\r\n')
        } else if (line === 'QUIT') {
          socket.end('221 bye\r\n')
        } else {
          socket.write('250 ok\r\n')
        }
      })
    })
    const smtpPort = await new Promise<number>((resolve, reject) => {
      smtpServer!.once('error', reject)
      smtpServer!.listen(0, '127.0.0.1', () => {
        smtpListening = true
        const address = smtpServer!.address()
        if (!address || typeof address === 'string') {
          reject(new Error('Integration SMTP server did not bind to a TCP port.'))
          return
        }
        resolve(address.port)
      })
    })
    process.env.SMTP_PORT = String(smtpPort)
    const { connectDatabase } = await import('./db.js')
    const { prepareTenantDatabase } = await import('./tenant-migration.js')
    const { app } = await import('./app.js')
    const { EmailVerification, User } = await import('./models.js')
    await connectDatabase()
    assert.equal(mongoose.connection.db?.databaseName, databaseName)
    await prepareTenantDatabase()
    server = app.listen(0)
    await new Promise<void>((resolve, reject) => {
      server!.once('listening', resolve)
      server!.once('error', reject)
    })

    const unauthenticated = await request('/accounts/summary')
    assert.equal(unauthenticated.status, 401)

    const ownerEmail = `test-${randomUUID()}@example.test`
    const ownerPassword = `Test-${randomUUID()}-Strong`
    const setup = await request('/auth/setup', {
      method: 'POST',
      body: { name: 'Integration Owner', businessName: 'Integration Business', email: ownerEmail, password: ownerPassword },
    })
    assert.equal(setup.status, 202)
    assert.ok(lastVerificationToken)
    const tokenHash = createHash('sha256').update(lastVerificationToken).digest('hex')
    const ownerRecord = await User.collection.findOne({ email: ownerEmail }, { projection: { _id: 1 } })
    const savedVerification = ownerRecord
      ? await EmailVerification.collection.findOne({ user: ownerRecord._id }, { projection: { tokenHash: 1 } })
      : null
    assert.ok(savedVerification && savedVerification.tokenHash === tokenHash, 'the verification email token must match the persisted one-time token hash')
    const setupVerification = await request('/auth/verify-email', {
      method: 'POST',
      body: { token: lastVerificationToken },
    })
    assert.equal(setupVerification.status, 200, await setupVerification.clone().text())
    sessionCookie = setupVerification.headers.get('set-cookie')?.split(';')[0] ?? ''
    assert.match(sessionCookie, /^maa_session=/)

    const login = await request('/auth/login', {
      method: 'POST',
      body: { email: ownerEmail, password: ownerPassword },
    })
    assert.equal(login.status, 200)
    sessionCookie = login.headers.get('set-cookie')?.split(';')[0] ?? ''
    assert.match(sessionCookie, /^maa_session=/)

    const customerResponse = await request('/customers', {
      method: 'POST',
      body: { name: 'Integration Customer', phone: '', email: '', address: '' },
    })
    assert.equal(customerResponse.status, 201, await customerResponse.clone().text())
    const { item: customer } = await json<{ item: { id: string } }>(customerResponse)
    const ownerCustomers = await request('/customers')
    assert.deepEqual((await json<{ items: { id: string }[] }>(ownerCustomers)).items.map((item) => item.id), [customer.id])

    const secondPassword = `Test-${randomUUID()}-Strong`
    const secondEmail = `second-${randomUUID()}@example.test`
    const registration = await request('/auth/register', {
      method: 'POST',
      body: {
        name: 'Second Owner',
        businessName: 'Second Business',
        email: secondEmail,
        password: secondPassword,
      },
    })
    assert.equal(registration.status, 202)
    assert.ok(lastVerificationToken)
    const unverifiedLogin = await request('/auth/login', {
      method: 'POST',
      body: { email: secondEmail, password: secondPassword },
    })
    assert.equal(unverifiedLogin.status, 403)
    const verification = await request('/auth/verify-email', { method: 'POST', body: { token: lastVerificationToken } })
    assert.equal(verification.status, 200)
    const secondSessionCookie = verification.headers.get('set-cookie')?.split(';')[0] ?? ''
    assert.match(secondSessionCookie, /^maa_session=/)
    const originalCookie = sessionCookie
    sessionCookie = secondSessionCookie
    const isolatedCustomers = await request('/customers')
    assert.equal(isolatedCustomers.status, 200)
    assert.deepEqual((await json<{ items: unknown[] }>(isolatedCustomers)).items, [])
    const secondCustomerResponse = await request('/customers', {
      method: 'POST',
      body: { name: 'Second Tenant Customer', phone: '', email: '', address: '' },
    })
    assert.equal(secondCustomerResponse.status, 201)
    const { item: secondCustomer } = await json<{ item: { id: string } }>(secondCustomerResponse)
    const secondTenantNotifications = await request('/notifications')
    assert.deepEqual((await json<{ items: unknown[] }>(secondTenantNotifications)).items, [])
    const secondTenantInvoiceResponse = await request('/invoices', {
      method: 'POST',
      body: {
        customerId: secondCustomer.id,
        issueDate: '2026-01-15T00:00:00.000Z',
        lines: [{ description: 'Private job', quantity: 1, unitPriceMinor: 1000, discountPercent: 0 }],
      },
    })
    assert.equal(secondTenantInvoiceResponse.status, 201)
    const { item: secondTenantInvoice } = await json<{ item: { invoiceNumber: string } }>(secondTenantInvoiceResponse)
    const crossTenantCustomerUpdate = await request(`/customers/${customer.id}`, {
      method: 'PATCH',
      body: { name: 'Cross-tenant attempt' },
    })
    assert.equal(crossTenantCustomerUpdate.status, 404)
    const sameSkuProduct = await request('/inventory', {
      method: 'POST',
      body: { sku: 'SHARED-SKU', name: 'Same SKU', category: 'Paper', unit: 'sheet', reorderLevel: 0, costMinor: 10 },
    })
    assert.equal(sameSkuProduct.status, 201)
    sessionCookie = originalCookie

    const invoiceResponse = await request('/invoices', {
      method: 'POST',
      body: {
        customerId: customer.id,
        issueDate: '2026-01-15T00:00:00.000Z',
        dueDate: '2026-01-20T00:00:00.000Z',
        lines: [{ description: 'Print job', quantity: 1, unitPriceMinor: 12500, discountPercent: 10 }],
      },
    })
    assert.equal(invoiceResponse.status, 201)
    const { item: invoice } = await json<{ item: { id: string; invoiceNumber: string; totalMinor: number } }>(invoiceResponse)
    assert.equal(invoice.totalMinor, 11250)
    assert.equal(invoice.invoiceNumber, secondTenantInvoice.invoiceNumber)

    const paymentKey = `payment-${randomUUID()}`
    const paymentInput = {
      customerId: customer.id, invoiceId: invoice.id, amountMinor: 5000, method: 'rocket',
      reference: 'integration', receivedAt: '2026-01-16T00:00:00.000Z',
    }
    const paymentResponse = await request('/payments', { method: 'POST', body: paymentInput, idempotencyKey: paymentKey })
    assert.equal(paymentResponse.status, 201)
    const payment = await json<{ item: { id: string } }>(paymentResponse)
    const replayPayment = await request('/payments', { method: 'POST', body: paymentInput, idempotencyKey: paymentKey })
    assert.equal(replayPayment.status, 200)
    const replayPaymentBody = await json<{ item: { id: string; replayed: boolean } }>(replayPayment)
    assert.equal(replayPaymentBody.item.id, payment.item.id)
    assert.equal(replayPaymentBody.item.replayed, true)

    const paymentKeyConflict = await request('/payments', {
      method: 'POST', body: { ...paymentInput, amountMinor: 5001 }, idempotencyKey: paymentKey,
    })
    assert.equal(paymentKeyConflict.status, 409)
    const overpayment = await request('/payments', {
      method: 'POST', body: { ...paymentInput, amountMinor: 7000 }, idempotencyKey: `payment-${randomUUID()}`,
    })
    assert.equal(overpayment.status, 400)

    const supplierResponse = await request('/suppliers', {
      method: 'POST',
      body: { name: 'Integration Supplier', phone: '', email: '', address: '' },
    })
    assert.equal(supplierResponse.status, 201)
    const { item: supplier } = await json<{ item: { id: string } }>(supplierResponse)
    const productResponse = await request('/inventory', {
      method: 'POST',
      body: { sku: 'SHARED-SKU', name: 'Test paper', category: 'Paper', unit: 'sheet', reorderLevel: 1, costMinor: 1000 },
    })
    assert.equal(productResponse.status, 201)
    const { item: product } = await json<{ item: { id: string } }>(productResponse)
    const alertsResponse = await request('/notifications')
    const alerts = await json<{ items: { kind: string }[] }>(alertsResponse)
    assert.deepEqual(alerts.items.map((item) => item.kind).sort(), ['low_stock', 'overdue_invoice'])

    const purchaseInput = {
      supplierId: supplier.id,
      paidMinor: 2000,
      paymentMethod: 'cash',
      lines: [{ productId: product.id, quantity: 5, unitCostMinor: 1200 }],
    }
    const purchaseKey = `purchase-${randomUUID()}`
    const purchaseResponse = await request('/purchases', { method: 'POST', body: purchaseInput, idempotencyKey: purchaseKey })
    assert.equal(purchaseResponse.status, 201)
    const { item: purchase } = await json<{ item: { id: string; totalMinor: number } }>(purchaseResponse)
    assert.equal(purchase.totalMinor, 6000)
    const duplicatePurchase = await request('/purchases', { method: 'POST', body: purchaseInput, idempotencyKey: purchaseKey })
    assert.equal(duplicatePurchase.status, 200)

    const secondPurchase = await request('/purchases', {
      method: 'POST',
      idempotencyKey: `purchase-${randomUUID()}`,
      body: {
        ...purchaseInput,
        purchasedAt: '2026-01-18T00:00:00.000Z',
        paidMinor: 0,
        lines: [{ productId: product.id, quantity: 5, unitCostMinor: 1800 }],
      },
    })
    assert.equal(secondPurchase.status, 201)
    const inventoryResponse = await request('/inventory')
    const inventory = await json<{ items: { id: string; stockQuantity: number; costMinor: number }[] }>(inventoryResponse)
    assert.equal(inventory.items.find((item) => item.id === product.id)?.stockQuantity, 10)
    assert.equal(inventory.items.find((item) => item.id === product.id)?.costMinor, 1500)

    const concurrentKey = `payment-${randomUUID()}`
    const concurrentInput = { customerId: customer.id, amountMinor: 250, method: 'rocket', reference: 'retry-safe' }
    const concurrentResponses = await Promise.all([
      request('/payments', { method: 'POST', body: concurrentInput, idempotencyKey: concurrentKey }),
      request('/payments', { method: 'POST', body: concurrentInput, idempotencyKey: concurrentKey }),
    ])
    assert.deepEqual(concurrentResponses.map((response) => response.status).sort(), [200, 201])

    const expenseResponse = await request('/expenses', {
      method: 'POST',
      body: { category: 'Test expense', description: 'Void test', amountMinor: 500, paymentMethod: 'cash' },
    })
    assert.equal(expenseResponse.status, 201)
    const { item: expense } = await json<{ item: { id: string } }>(expenseResponse)
    const voidExpense = await request(`/expenses/${expense.id}/void`, { method: 'POST', body: {} })
    assert.equal(voidExpense.status, 200)
    const deleteExpense = await request(`/expenses/${expense.id}`, { method: 'DELETE' })
    assert.equal(deleteExpense.status, 204)
    const expensesAfterDelete = await request('/expenses')
    assert.equal((await json<{ items: { id: string }[] }>(expensesAfterDelete)).items.some((item) => item.id === expense.id), false)

    const incomeResponse = await request('/income', {
      method: 'POST',
      body: { category: '=1+1', description: 'CSV escape test', amountMinor: 400, paymentMethod: 'cash' },
    })
    assert.equal(incomeResponse.status, 201)

    const rateLimitResponses = await Promise.all(Array.from({ length: 6 }, () => request('/auth/login', {
      method: 'POST',
      body: { email: `rate-limit-${randomUUID()}@example.test`, password: 'Invalid-Password-123' },
    })))
    assert.ok(rateLimitResponses.some((response) => response.status === 429))

    const from = encodeURIComponent('2000-01-01T00:00:00.000Z')
    const to = encodeURIComponent('2100-12-31T23:59:59.999Z')
    const reportResponse = await request(`/reports/summary?from=${from}&to=${to}`)
    assert.equal(reportResponse.status, 200)
    const report = await json<{ salesMinor: number; collectionsMinor: number; expenses: { amountMinor: number }[] }>(reportResponse)
    assert.equal(report.salesMinor, 11250)
    assert.equal(report.collectionsMinor, 5250)
    assert.equal(report.expenses.length, 0)
    const reportPdf = await request(`/reports/summary.pdf?from=${from}&to=${to}`)
    assert.equal(reportPdf.status, 200, await reportPdf.clone().text())
    assert.match(reportPdf.headers.get('content-type') ?? '', /application\/pdf/)
    assert.equal((await reportPdf.arrayBuffer()).byteLength > 1000, true)

    const csvResponse = await request(`/reports/summary.csv?from=${from}&to=${to}`)
    assert.equal(csvResponse.status, 200)
    assert.match(await csvResponse.text(), /"'=1\+1"/)

    const accountsResponse = await request('/accounts/summary')
    const accounts = await json<{ inflowMinor: number; outflowMinor: number; netMovementMinor: number }>(accountsResponse)
    assert.equal(accounts.inflowMinor, 5650)
    assert.equal(accounts.outflowMinor, 2000)
    assert.equal(accounts.netMovementMinor, 3650)

    const businessSettings = await request('/business/settings')
    assert.equal(businessSettings.status, 200)
    const settings = await json<{ item: { name: string; currency: string } }>(businessSettings)
    assert.equal(settings.item.name, 'Integration Business')
    const updateSettings = await request('/business/settings', {
      method: 'PATCH',
      body: { name: 'Updated Integration Press', phone: '+880 1712-345678', address: 'Dhaka', currency: 'USD' },
    })
    assert.equal(updateSettings.status, 200)
    assert.equal((await json<{ item: { name: string; currency: string } }>(updateSettings)).item.currency, 'USD')

    const orderKey = `order-${randomUUID()}`
    const orderInput = {
      customerName: 'Order Flow Customer',
      phone: '+880 1712-345678',
      address: 'Dhaka',
      description: 'Printed business cards',
      quantity: 5,
      amountMinor: 12500,
      discountMinor: 2500,
      advanceMinor: 5000,
      advanceMethod: 'bkash',
      orderDate: '2026-01-19T00:00:00.000Z',
      deliveryDate: '2026-01-25T00:00:00.000Z',
    }
    const orderResponse = await request('/orders', { method: 'POST', body: orderInput, idempotencyKey: orderKey })
    assert.equal(orderResponse.status, 201, await orderResponse.clone().text())
    const { item: createdOrder } = await json<{
      item: { id: string; customerId: string; invoiceId: string; invoiceNumber: string; totalMinor: number; paidMinor: number; dueMinor: number }
    }>(orderResponse)
    assert.equal(createdOrder.totalMinor, 10000)
    assert.equal(createdOrder.paidMinor, 5000)
    assert.equal(createdOrder.dueMinor, 5000)
    const invoicePdf = await request(`/invoices/${createdOrder.invoiceId}/pdf`)
    assert.equal(invoicePdf.status, 200, await invoicePdf.clone().text())
    assert.match(invoicePdf.headers.get('content-type') ?? '', /application\/pdf/)
    assert.equal((await invoicePdf.arrayBuffer()).byteLength > 1000, true)
    const replayOrder = await request('/orders', { method: 'POST', body: orderInput, idempotencyKey: orderKey })
    assert.equal(replayOrder.status, 200)
    const replayOrderBody = await json<{ item: { id: string; replayed: boolean } }>(replayOrder)
    assert.equal(replayOrderBody.item.id, createdOrder.id)
    assert.equal(replayOrderBody.item.replayed, true)

    const repeatCustomerOrder = await request('/orders', {
      method: 'POST',
      body: {
        ...orderInput,
        customerName: 'A different entered name',
        phone: '01712345678',
        description: 'Flyers',
        amountMinor: 5000,
        discountMinor: 0,
        advanceMinor: 0,
      },
    })
    assert.equal(repeatCustomerOrder.status, 201, await repeatCustomerOrder.clone().text())
    const repeated = await json<{ item: { customerId: string } }>(repeatCustomerOrder)
    assert.equal(repeated.item.customerId, createdOrder.customerId)
    const customerLookup = await request(`/customers/lookup?phone=${encodeURIComponent('01712345678')}`)
    assert.equal(customerLookup.status, 200)
    const matchedCustomer = await json<{ item: { id: string; name: string; phone: string; email: string; address: string; status: string } | null }>(customerLookup)
    assert.deepEqual(matchedCustomer.item, {
      id: createdOrder.customerId,
      name: 'Order Flow Customer',
      phone: '+880 1712-345678',
      email: '',
      address: 'Dhaka',
      status: 'active',
    })
    const matchedCustomers = await request('/customers?search=Order%20Flow%20Customer&status=all')
    const customerList = await json<{ items: { id: string; orderCount: number }[] }>(matchedCustomers)
    assert.equal(customerList.items.length, 1)
    assert.equal(customerList.items[0].orderCount, 2)

    const orderPayment = await request('/payments', {
      method: 'POST',
      body: {
        customerId: createdOrder.customerId,
        invoiceId: createdOrder.invoiceId,
        amountMinor: createdOrder.dueMinor,
        method: 'cash',
        reference: 'Final order collection',
      },
      idempotencyKey: `order-payment-${randomUUID()}`,
    })
    assert.equal(orderPayment.status, 201)
    const statementResponse = await request(`/customers/${createdOrder.customerId}/statement`)
    assert.equal(statementResponse.status, 200)
    const statement = await json<{
      summary: { orderCount: number; invoicedMinor: number; invoicePaidMinor: number; dueMinor: number; paymentsReceivedMinor: number }
    }>(statementResponse)
    assert.equal(statement.summary.orderCount, 2)
    assert.equal(statement.summary.invoicedMinor, 15000)
    assert.equal(statement.summary.invoicePaidMinor, 10000)
    assert.equal(statement.summary.dueMinor, 5000)
    assert.equal(statement.summary.paymentsReceivedMinor, 10000)
    const customerStatementPdf = await request(`/customers/${createdOrder.customerId}/statement/pdf`)
    assert.equal(customerStatementPdf.status, 200, await customerStatementPdf.clone().text())
    assert.match(customerStatementPdf.headers.get('content-type') ?? '', /application\/pdf/)
    assert.equal((await customerStatementPdf.arrayBuffer()).byteLength > 1000, true)
    const deleteCustomerWithOrders = await request(`/customers/${createdOrder.customerId}`, { method: 'DELETE' })
    assert.equal(deleteCustomerWithOrders.status, 409)
    const cancelPaidOrder = await request(`/orders/${createdOrder.id}`, { method: 'DELETE' })
    assert.equal(cancelPaidOrder.status, 409)
    const deletePaidInvoice = await request(`/invoices/${createdOrder.invoiceId}`, { method: 'DELETE' })
    assert.equal(deletePaidInvoice.status, 409)

    const unpaidOrderResponse = await request('/orders', {
      method: 'POST',
      body: {
        ...orderInput,
        description: 'Unpaid removable order',
        phone: '+880 1812-345678',
        amountMinor: 1000,
        discountMinor: 0,
        advanceMinor: 0,
      },
    })
    assert.equal(unpaidOrderResponse.status, 201)
    const { item: unpaidOrder } = await json<{ item: { id: string; customerId: string; invoiceId: string } }>(unpaidOrderResponse)
    const beforePaymentDelete = await request('/accounts/summary')
    const beforePaymentDeleteTotals = await json<{ inflowMinor: number }>(beforePaymentDelete)
    const removablePaymentResponse = await request('/payments', {
      method: 'POST',
      body: {
        customerId: unpaidOrder.customerId,
        invoiceId: unpaidOrder.invoiceId,
        amountMinor: 200,
        method: 'cash',
        reference: 'Payment deletion test',
      },
    })
    assert.equal(removablePaymentResponse.status, 201)
    const { item: removablePayment } = await json<{ item: { id: string } }>(removablePaymentResponse)
    const deletePayment = await request(`/payments/${removablePayment.id}`, { method: 'DELETE' })
    assert.equal(deletePayment.status, 204)
    const afterPaymentDelete = await request('/accounts/summary')
    assert.equal((await json<{ inflowMinor: number }>(afterPaymentDelete)).inflowMinor, beforePaymentDeleteTotals.inflowMinor)
    const paymentAfterDelete = await request('/payments')
    assert.equal((await json<{ items: { id: string }[] }>(paymentAfterDelete)).items.some((item) => item.id === removablePayment.id), false)
    const invoiceAfterPaymentDelete = await request('/invoices')
    const invoiceAfterPaymentDeleteResult = await json<{ items: { id: string; paidMinor: number; dueMinor: number }[] }>(invoiceAfterPaymentDelete)
    assert.equal(
      invoiceAfterPaymentDeleteResult.items.find((item) => item.id === unpaidOrder.invoiceId)?.paidMinor,
      0,
    )
    assert.equal(
      invoiceAfterPaymentDeleteResult.items.find((item) => item.id === unpaidOrder.invoiceId)?.dueMinor,
      1000,
    )
    const deleteUnpaidOrder = await request(`/orders/${unpaidOrder.id}`, { method: 'DELETE' })
    assert.equal(deleteUnpaidOrder.status, 204)
    const ordersAfterCancel = await request('/orders')
    assert.equal((await json<{ items: { id: string }[] }>(ordersAfterCancel)).items.some((item) => item.id === unpaidOrder.id), false)
    const invoicesAfterCancel = await request('/invoices')
    assert.equal((await json<{ items: { id: string; status: string }[] }>(invoicesAfterCancel)).items.some((item) => item.id === unpaidOrder.invoiceId), false)

    const cleanupCustomerResponse = await request('/customers', {
      method: 'POST',
      body: { name: 'Removable Customer', phone: '01799990000', email: '', address: '' },
    })
    assert.equal(cleanupCustomerResponse.status, 201)
    const { item: cleanupCustomer } = await json<{ item: { id: string } }>(cleanupCustomerResponse)
    const removableInvoiceResponse = await request('/invoices', {
      method: 'POST',
      body: { customerId: cleanupCustomer.id, lines: [{ description: 'Unpaid proof', quantity: 1, unitPriceMinor: 1200, discountPercent: 0 }] },
    })
    assert.equal(removableInvoiceResponse.status, 201)
    const { item: removableInvoice } = await json<{ item: { id: string } }>(removableInvoiceResponse)
    const deleteStandaloneInvoice = await request(`/invoices/${removableInvoice.id}`, { method: 'DELETE' })
    assert.equal(deleteStandaloneInvoice.status, 204)
    const standaloneInvoiceAfterDelete = await request('/invoices')
    assert.equal((await json<{ items: { id: string }[] }>(standaloneInvoiceAfterDelete)).items.some((item) => item.id === removableInvoice.id), false)
    const secondRemovableInvoiceResponse = await request('/invoices', {
      method: 'POST',
      body: { customerId: cleanupCustomer.id, lines: [{ description: 'Customer cleanup proof', quantity: 1, unitPriceMinor: 1200, discountPercent: 0 }] },
    })
    assert.equal(secondRemovableInvoiceResponse.status, 201)
    const { item: secondRemovableInvoice } = await json<{ item: { id: string } }>(secondRemovableInvoiceResponse)
    const beforeCustomerPurge = await request('/accounts/summary')
    const beforeCustomerPurgeTotals = await json<{ inflowMinor: number }>(beforeCustomerPurge)
    const customerReceiptResponse = await request('/payments', {
      method: 'POST',
      body: { customerId: cleanupCustomer.id, invoiceId: secondRemovableInvoice.id, amountMinor: 300, method: 'cash', reference: 'Customer purge test' },
    })
    assert.equal(customerReceiptResponse.status, 201)
    const { item: customerReceipt } = await json<{ item: { id: string } }>(customerReceiptResponse)
    const deleteCustomerWithInvoice = await request(`/customers/${cleanupCustomer.id}`, { method: 'DELETE' })
    assert.equal(deleteCustomerWithInvoice.status, 204)
    const invoicesAfterCustomerDelete = await request('/invoices')
    assert.equal((await json<{ items: { id: string }[] }>(invoicesAfterCustomerDelete)).items.some((item) => item.id === secondRemovableInvoice.id), false)
    const paymentsAfterCustomerDelete = await request('/payments')
    assert.equal((await json<{ items: { id: string }[] }>(paymentsAfterCustomerDelete)).items.some((item) => item.id === customerReceipt.id), false)
    const afterCustomerPurge = await request('/accounts/summary')
    assert.equal((await json<{ inflowMinor: number }>(afterCustomerPurge)).inflowMinor, beforeCustomerPurgeTotals.inflowMinor)
    const deletedCustomerStatement = await request(`/customers/${cleanupCustomer.id}/statement`)
    assert.equal(deletedCustomerStatement.status, 404)
    assert.equal(await AuditLog.collection.countDocuments(), 0)
  } finally {
    try {
      if (server) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()))
    } finally {
      try {
        if (smtpServer && smtpListening) {
          await new Promise<void>((resolve, reject) => smtpServer!.close((error) => error ? reject(error) : resolve()))
        }
      } finally {
        if (mongoose.connection.readyState === 1) {
          const currentDbName = mongoose.connection.db?.databaseName ?? ''
          try {
            if (currentDbName === databaseName && currentDbName.startsWith('maa_offset_test_')) {
              await mongoose.connection.dropDatabase()
            }
          } finally {
            await mongoose.disconnect()
          }
        }
      }
    }
  }
})
