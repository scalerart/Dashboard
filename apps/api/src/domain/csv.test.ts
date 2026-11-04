import assert from 'node:assert/strict'
import test from 'node:test'
import { csvCell } from './csv.js'

test('CSV cells preserve quoted values and escape embedded quotes', () => {
  assert.equal(csvCell('Press, "A"'), '"Press, ""A"""')
  assert.equal(csvCell(125.5), '"125.5"')
})

test('CSV cells neutralize spreadsheet formula prefixes', () => {
  assert.equal(csvCell('=HYPERLINK("https://example.com")'), `"'=HYPERLINK(""https://example.com"")"`)
  assert.equal(csvCell('  @SUM(A1:A2)'), '"\'  @SUM(A1:A2)"')
})
