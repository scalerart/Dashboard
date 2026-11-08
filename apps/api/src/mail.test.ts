import assert from 'node:assert/strict'
import test from 'node:test'
import { mailDeliveryError } from './mail.js'

test('SMTP authentication failures explain credential and Gmail app-password checks', () => {
  const error = mailDeliveryError({ code: 'EAUTH' })
  assert.equal(error.status, 503)
  assert.match(error.message, /SMTP_USER and SMTP_PASSWORD/)
  assert.match(error.message, /Gmail requires an App Password/)
})

test('SMTP connection failures explain host and outbound connection checks', () => {
  const error = mailDeliveryError({ code: 'ETIMEDOUT' })
  assert.match(error.message, /SMTP_HOST and SMTP_PORT/)
  assert.match(error.message, /outbound SMTP/)
})

test('SMTP envelope failures explain sender and recipient checks', () => {
  const error = mailDeliveryError({ code: 'EENVELOPE' })
  assert.match(error.message, /SMTP_FROM and the customer email/)
})

test('SMTP provider rejection exposes only its response code, not server details', () => {
  const error = mailDeliveryError({
    responseCode: 550,
    response: 'private server response text',
  })
  assert.match(error.message, /response 550/)
  assert.doesNotMatch(error.message, /private server response text/)
})
