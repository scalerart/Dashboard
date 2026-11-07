let currency = import.meta.env.VITE_CURRENCY ?? 'BDT'

export function setCurrency(value: string) {
  currency = value
}

export function getCurrency() {
  return currency
}

export function formatCurrency(amountMinor: number) {
  return new Intl.NumberFormat('en-BD', {
    style: 'currency',
    currency,
    maximumFractionDigits: 2,
  }).format(amountMinor / 100)
}
