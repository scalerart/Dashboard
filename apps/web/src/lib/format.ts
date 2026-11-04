const currency = import.meta.env.VITE_CURRENCY ?? 'BDT'

export function formatCurrency(amountMinor: number) {
  return new Intl.NumberFormat('en-BD', {
    style: 'currency',
    currency,
    maximumFractionDigits: 2,
  }).format(amountMinor / 100)
}
