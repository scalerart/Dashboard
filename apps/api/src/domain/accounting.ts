export type InvoiceLineInput = {
  quantity: number
  unitPriceMinor: number
  discountPercent?: number
}

export function calculateLineTotalMinor(quantity: number, unitPriceMinor: number, discountPercent = 0) {
  if (!Number.isFinite(quantity) || quantity <= 0 ||
      !Number.isSafeInteger(unitPriceMinor) || unitPriceMinor < 0 ||
      !Number.isFinite(discountPercent) || discountPercent < 0 || discountPercent > 100) {
    throw new RangeError('Line quantity, price, or discount is outside the supported range.')
  }
  const lineTotal = Math.round(quantity * unitPriceMinor * (1 - discountPercent / 100))
  if (!Number.isSafeInteger(lineTotal)) {
    throw new RangeError('Line total exceeds the safe integer range.')
  }
  return lineTotal
}

export function calculateInvoiceTotalMinor(lines: InvoiceLineInput[]) {
  let total = 0
  for (const line of lines) {
    total += calculateLineTotalMinor(line.quantity, line.unitPriceMinor, line.discountPercent ?? 0)
    if (!Number.isSafeInteger(total)) throw new RangeError('Invoice total exceeds the safe integer range.')
  }
  return total
}

export function outstandingMinor(totalMinor: number, paidMinor: number) {
  return Math.max(0, totalMinor - paidMinor)
}

export function weightedAverageCostMinor(
  currentQuantity: number,
  currentUnitCostMinor: number,
  receivedQuantity: number,
  receivedUnitCostMinor: number,
) {
  const inputs = [currentQuantity, currentUnitCostMinor, receivedQuantity, receivedUnitCostMinor]
  if (inputs.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new RangeError('Inventory quantities and unit costs must be finite and non-negative.')
  }
  const totalQuantity = currentQuantity + receivedQuantity
  if (!Number.isFinite(totalQuantity)) {
    throw new RangeError('Total inventory quantity exceeds the supported range.')
  }
  if (totalQuantity === 0) return 0
  const totalValueMinor = currentQuantity * currentUnitCostMinor + receivedQuantity * receivedUnitCostMinor
  if (!Number.isSafeInteger(Math.round(totalValueMinor))) {
    throw new RangeError('Weighted inventory value exceeds the safe integer range.')
  }
  return Math.round(totalValueMinor / totalQuantity)
}

export function monthKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}
