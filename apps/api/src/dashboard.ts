import { Router } from 'express'
import { z } from 'zod'
import { Customer, Expense, Income, Invoice, Order, Payment, Purchase } from './models.js'
import { monthKey } from './domain/accounting.js'
import { requireAuth } from './middleware.js'

const rangeSchema = z.object({
  from: z.coerce.date(),
  to: z.coerce.date(),
})

const eligibleInvoice = { status: { $nin: ['draft', 'void'] } }

export const dashboardRouter = Router()
dashboardRouter.use(requireAuth)

dashboardRouter.get('/summary', async (req, res, next) => {
  try {
    const { from, to } = rangeSchema.parse(req.query)
    if (from >= to) {
      res.status(400).json({ message: 'The date range is invalid.' })
      return
    }
    const fromDate = new Date(from)
    fromDate.setHours(0, 0, 0, 0)
    const toDate = new Date(to)
    toDate.setHours(23, 59, 59, 999)

    const [sales, collections, expenses, outstanding, customerCount, orderCount, recentOrders, recentPayments, topCustomers, expenseBreakdown, monthlyNetProfitMinor, yearlyNetProfitMinor] =
      await Promise.all([
        Invoice.aggregate([
          { $match: { ...eligibleInvoice, issueDate: { $gte: fromDate, $lte: toDate } } },
          { $group: { _id: null, totalMinor: { $sum: '$totalMinor' } } },
        ]),
        Payment.aggregate([
          { $match: { receivedAt: { $gte: fromDate, $lte: toDate } } },
          { $group: { _id: null, totalMinor: { $sum: '$amountMinor' } } },
        ]),
        Expense.aggregate([
          { $match: { spentAt: { $gte: fromDate, $lte: toDate }, status: 'active' } },
          { $group: { _id: null, totalMinor: { $sum: '$amountMinor' } } },
        ]),
        Invoice.aggregate([
          { $match: eligibleInvoice },
          { $group: { _id: null, totalMinor: { $sum: { $max: [0, { $subtract: ['$totalMinor', '$paidMinor'] }] } } } },
        ]),
        Customer.countDocuments({ status: 'active' }),
        Order.countDocuments({ orderDate: { $gte: fromDate, $lte: toDate }, status: { $ne: 'cancelled' } }),
        Order.find({ orderDate: { $gte: fromDate, $lte: toDate } })
          .sort({ orderDate: -1 })
          .limit(5)
          .populate('customer', 'name')
          .lean(),
        Payment.find({ receivedAt: { $gte: fromDate, $lte: toDate } })
          .sort({ receivedAt: -1 })
          .limit(5)
          .populate('customer', 'name')
          .lean(),
        Invoice.aggregate([
          { $match: { ...eligibleInvoice, issueDate: { $gte: fromDate, $lte: toDate } } },
          { $group: { _id: '$customer', salesMinor: { $sum: '$totalMinor' } } },
          { $sort: { salesMinor: -1 } },
          { $limit: 5 },
          { $lookup: { from: 'customers', localField: '_id', foreignField: '_id', as: 'customer' } },
          { $unwind: '$customer' },
          { $project: { _id: 0, id: '$_id', name: '$customer.name', salesMinor: 1 } },
        ]),
        Expense.aggregate([
          { $match: { spentAt: { $gte: fromDate, $lte: toDate }, status: 'active' } },
          { $group: { _id: '$category', amountMinor: { $sum: '$amountMinor' } } },
          { $sort: { amountMinor: -1 } },
        ]),
        netProfitForPeriod(new Date(toDate.getFullYear(), toDate.getMonth(), 1), toDate),
        netProfitForPeriod(new Date(toDate.getFullYear(), 0, 1), toDate),
      ])

    const chartFrom = new Date(toDate.getFullYear(), toDate.getMonth() - 5, 1)
    const [monthlySales, monthlyCollections, monthlyExpenses] = await Promise.all([
      Invoice.aggregate([
        { $match: { ...eligibleInvoice, issueDate: { $gte: chartFrom, $lte: toDate } } },
        { $group: { _id: { year: { $year: '$issueDate' }, month: { $month: '$issueDate' } }, totalMinor: { $sum: '$totalMinor' } } },
      ]),
      Payment.aggregate([
        { $match: { receivedAt: { $gte: chartFrom, $lte: toDate } } },
        { $group: { _id: { year: { $year: '$receivedAt' }, month: { $month: '$receivedAt' } }, totalMinor: { $sum: '$amountMinor' } } },
      ]),
      Expense.aggregate([
        { $match: { spentAt: { $gte: chartFrom, $lte: toDate }, status: 'active' } },
        { $group: { _id: { year: { $year: '$spentAt' }, month: { $month: '$spentAt' } }, totalMinor: { $sum: '$amountMinor' } } },
      ]),
    ])

    const monthTotals = (rows: { _id: { year: number; month: number }; totalMinor: number }[]) =>
      new Map(rows.map((row) => [`${row._id.year}-${String(row._id.month).padStart(2, '0')}`, row.totalMinor]))
    const salesByMonth = monthTotals(monthlySales)
    const collectionsByMonth = monthTotals(monthlyCollections)
    const expensesByMonth = monthTotals(monthlyExpenses)
    const months = Array.from({ length: 6 }, (_, index) => {
      const month = new Date(chartFrom.getFullYear(), chartFrom.getMonth() + index, 1)
      const key = monthKey(month)
      return {
        key,
        label: new Intl.DateTimeFormat('en', { month: 'short' }).format(month),
        salesMinor: salesByMonth.get(key) ?? 0,
        collectionsMinor: collectionsByMonth.get(key) ?? 0,
        expensesMinor: expensesByMonth.get(key) ?? 0,
      }
    })

    res.json({
      range: { from: fromDate.toISOString(), to: toDate.toISOString() },
      metrics: {
        salesMinor: sales[0]?.totalMinor ?? 0,
        collectionsMinor: collections[0]?.totalMinor ?? 0,
        outstandingMinor: outstanding[0]?.totalMinor ?? 0,
        expensesMinor: expenses[0]?.totalMinor ?? 0,
        monthlyNetProfitMinor,
        yearlyNetProfitMinor,
        activeCustomers: customerCount,
        orders: orderCount,
      },
      trends: months,
      expenseBreakdown: expenseBreakdown.map((item) => ({
        category: String(item._id),
        amountMinor: item.amountMinor,
      })),
      recentOrders: recentOrders.map((order) => {
        const customer = order.customer as unknown as { name?: string } | null
        return {
          id: String(order._id),
          orderNumber: order.orderNumber,
          customerName: customer?.name ?? 'Unknown customer',
          amountMinor: order.amountMinor,
          status: order.status,
          orderDate: order.orderDate,
        }
      }),
      recentPayments: recentPayments.map((payment) => {
        const customer = payment.customer as unknown as { name?: string } | null
        return {
          id: String(payment._id),
          paymentNumber: payment.paymentNumber,
          customerName: customer?.name ?? 'Unknown customer',
          amountMinor: payment.amountMinor,
          method: payment.method,
          receivedAt: payment.receivedAt,
        }
      }),
      topCustomers,
    })

  } catch (error) {
    next(error)
  }
})

async function netProfitForPeriod(from: Date, to: Date) {
  const dateRange = { $gte: from, $lte: to }
  const [sales, otherIncome, expenses, purchases] = await Promise.all([
    Invoice.aggregate([
      { $match: { ...eligibleInvoice, issueDate: dateRange } },
      { $group: { _id: null, totalMinor: { $sum: '$totalMinor' } } },
    ]),
    Income.aggregate([
      { $match: { receivedAt: dateRange, status: 'active' } },
      { $group: { _id: null, totalMinor: { $sum: '$amountMinor' } } },
    ]),
    Expense.aggregate([
      { $match: { spentAt: dateRange, status: 'active' } },
      { $group: { _id: null, totalMinor: { $sum: '$amountMinor' } } },
    ]),
    Purchase.aggregate([
      { $match: { purchasedAt: dateRange } },
      { $group: { _id: null, totalMinor: { $sum: '$totalMinor' } } },
    ]),
  ])
  return (sales[0]?.totalMinor ?? 0) +
    (otherIncome[0]?.totalMinor ?? 0) -
    (expenses[0]?.totalMinor ?? 0) -
    (purchases[0]?.totalMinor ?? 0)
}
