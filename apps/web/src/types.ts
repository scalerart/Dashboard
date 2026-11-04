export type User = {
  id: string
  name: string
  email: string
  role: string
  businessId: string
  businessName: string
}

export type DashboardData = {
  range: { from: string; to: string }
  metrics: {
    salesMinor: number
    collectionsMinor: number
    outstandingMinor: number
    expensesMinor: number
    activeCustomers: number
    orders: number
  }
  trends: {
    key: string
    label: string
    salesMinor: number
    collectionsMinor: number
    expensesMinor: number
  }[]
  recentOrders: {
    id: string
    orderNumber: string
    customerName: string
    amountMinor: number
    status: string
    orderDate: string
  }[]
  recentPayments: {
    id: string
    paymentNumber: string
    customerName: string
    amountMinor: number
    method: string
    receivedAt: string
  }[]
  topCustomers: { id: string; name: string; salesMinor: number }[]
}
