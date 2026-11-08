import Swal from 'sweetalert2'
import { formatCurrency } from './format'

export async function confirmDelete(title: string, text: string) {
  const result = await Swal.fire({
    icon: 'warning',
    title,
    text,
    showCancelButton: true,
    confirmButtonText: 'Delete permanently',
    cancelButtonText: 'Keep record',
    reverseButtons: true,
    focusCancel: true,
    confirmButtonColor: '#c83f4d',
  })
  return result.isConfirmed
}

export async function showError(message: string) {
  await Swal.fire({ icon: 'error', title: 'Unable to complete action', text: message, confirmButtonText: 'Close' })
}

export async function showSuccess(message: string) {
  await Swal.fire({ icon: 'success', title: 'Done', text: message, timer: 1800, showConfirmButton: false })
}

export async function collectPayment(dueMinor: number, target?: HTMLElement) {
  const result = await Swal.fire({
    ...(target ? { target } : {}),
    title: 'Collect customer payment',
    text: `Outstanding balance: ${formatCurrency(dueMinor)}`,
    html: `<label class="swal-form-field" for="swal-payment-amount">Amount received</label>
      <input id="swal-payment-amount" class="swal2-input" type="number" min="0.01" max="${(dueMinor / 100).toFixed(2)}" step="0.01" placeholder="0.00">
      <label class="swal-form-field" for="swal-payment-method">Payment method</label>
      <select id="swal-payment-method" class="swal2-select">
        <option value="cash">Cash</option><option value="bank">Bank transfer</option>
        <option value="bkash">bKash</option><option value="nagad">Nagad</option>
        <option value="rocket">Rocket</option><option value="other">Other</option>
      </select>
      <label class="swal-form-field" for="swal-payment-reference">Reference (optional)</label>
      <input id="swal-payment-reference" class="swal2-input" type="text" maxlength="120" placeholder="Transaction or receipt reference">`,
    showCancelButton: true,
    confirmButtonText: 'Record payment',
    cancelButtonText: 'Cancel',
    focusConfirm: false,
    preConfirm: () => {
      const popup = Swal.getPopup()
      const amountValue = popup?.querySelector<HTMLInputElement>('#swal-payment-amount')?.value ?? ''
      const method = popup?.querySelector<HTMLSelectElement>('#swal-payment-method')?.value ?? ''
      const reference = popup?.querySelector<HTMLInputElement>('#swal-payment-reference')?.value.trim() ?? ''
      const amountMinor = Math.round(Number(amountValue) * 100)
      if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0 || amountMinor > dueMinor) {
        Swal.showValidationMessage('Enter an amount no greater than the outstanding balance.')
        return undefined
      }
      if (!['cash', 'bank', 'bkash', 'nagad', 'rocket', 'other'].includes(method)) {
        Swal.showValidationMessage('Choose a valid payment method.')
        return undefined
      }
      return { amountMinor, method, reference }
    },
  })
  return result.isConfirmed ? result.value as { amountMinor: number; method: string; reference: string } : null
}

export async function promptForEmail(defaultEmail: string) {
  const result = await Swal.fire({
    title: 'Email invoice',
    input: 'email',
    inputLabel: 'Recipient email (leave blank to use the customer email)',
    inputValue: defaultEmail,
    inputPlaceholder: 'customer@example.com',
    showCancelButton: true,
    confirmButtonText: 'Send invoice',
    cancelButtonText: 'Cancel',
    inputValidator: (value) => value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? 'Enter a valid email address.' : null,
  })
  return result.isConfirmed ? result.value as string : null
}
