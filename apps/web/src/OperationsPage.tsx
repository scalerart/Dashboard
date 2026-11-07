import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import {
  Archive,
  ArrowDownToLine,
  CircleAlert,
  FileText,
  LoaderCircle,
  Mail,
  Paperclip,
  Pencil,
  Plus,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import Swal from 'sweetalert2';
import { z } from 'zod';
import { collectPayment, promptForEmail, showError } from './lib/alerts';
import { ApiError, api } from './lib/api';
import { formatCurrency } from './lib/format';

export type ModuleKey =
  | 'orders'
  | 'invoices'
  | 'payments'
  | 'expenses'
  | 'income'
  | 'inventory'
  | 'suppliers'
  | 'purchases';

type SelectOption = { value: string; label: string };
type FieldConfig = {
  key: string;
  label: string;
  type: 'text' | 'textarea' | 'money' | 'date' | 'number' | 'select';
  required?: boolean;
  options?: SelectOption[];
  optionSource?: 'customers' | 'suppliers' | 'products' | 'invoices';
  placeholder?: string;
};
type Column = { key: string; label: string; type?: 'money' | 'date' | 'status' };
type ModuleConfig = {
  title: string;
  description: string;
  endpoint: string;
  fields: FieldConfig[];
  columns: Column[];
};
const today = new Date().toISOString().slice(0, 10);

const methodOptions = [
  { value: 'cash', label: 'Cash' },
  { value: 'bank', label: 'Bank transfer' },
  { value: 'bkash', label: 'bKash' },
  { value: 'nagad', label: 'Nagad' },
  { value: 'rocket', label: 'Rocket' },
  { value: 'other', label: 'Other' },
];
const dateField = (key: string, label: string, required = true): FieldConfig => ({
  key,
  label,
  type: 'date',
  required,
});
const moneyField = (key: string, label: string): FieldConfig => ({
  key,
  label,
  type: 'money',
  required: true,
});
const selectField = (
  key: string,
  label: string,
  optionSource: FieldConfig['optionSource']
): FieldConfig => ({ key, label, type: 'select', required: true, optionSource });

const configs: Record<ModuleKey, ModuleConfig> = {
  orders: {
    title: 'Orders & jobs',
    description: 'Track customer work from job entry through printing and delivery.',
    endpoint: '/orders',
    fields: [
      selectField('customerId', 'Customer', 'customers'),
      { key: 'description', label: 'Job description', type: 'textarea', required: true },
      moneyField('amount', 'Quoted amount'),
      dateField('orderDate', 'Order date'),
      dateField('dueDate', 'Due date', false),
    ],
    columns: [
      { key: 'orderNumber', label: 'Order #' },
      { key: 'customerName', label: 'Customer' },
      { key: 'customerPhone', label: 'Mobile' },
      { key: 'description', label: 'Task' },
      { key: 'quantity', label: 'Qty' },
      { key: 'grossMinor', label: 'Total', type: 'money' },
      { key: 'discountMinor', label: 'Discount', type: 'money' },
      { key: 'amountMinor', label: 'Net total', type: 'money' },
      { key: 'paidMinor', label: 'Paid', type: 'money' },
      { key: 'dueMinor', label: 'Due', type: 'money' },
      { key: 'invoiceNumber', label: 'Invoice #' },
      { key: 'status', label: 'Status', type: 'status' },
      { key: 'deliveryDate', label: 'Delivery', type: 'date' },
      { key: 'orderDate', label: 'Date', type: 'date' },
    ],
  },
  invoices: {
    title: 'Invoices',
    description: 'Issue customer invoices, review balances, and download or email PDF copies.',
    endpoint: '/invoices',
    fields: [
      selectField('customerId', 'Customer', 'customers'),
      { key: 'description', label: 'Description', type: 'text', required: true },
      moneyField('amount', 'Invoice total'),
      dateField('issueDate', 'Issue date'),
      dateField('dueDate', 'Due date', false),
    ],
    columns: [
      { key: 'invoiceNumber', label: 'Invoice #' },
      { key: 'customerName', label: 'Customer' },
      { key: 'totalMinor', label: 'Total', type: 'money' },
      { key: 'paidMinor', label: 'Paid', type: 'money' },
      { key: 'dueMinor', label: 'Due', type: 'money' },
      { key: 'status', label: 'Status', type: 'status' },
      { key: 'issueDate', label: 'Date', type: 'date' },
    ],
  },
  payments: {
    title: 'Payments',
    description:
      'Record customer collections and automatically reconcile invoice balances and account movement.',
    endpoint: '/payments',
    fields: [
      selectField('customerId', 'Customer', 'customers'),
      { key: 'invoiceId', label: 'Invoice (optional)', type: 'select', optionSource: 'invoices' },
      moneyField('amount', 'Amount received'),
      {
        key: 'method',
        label: 'Payment method',
        type: 'select',
        required: true,
        options: methodOptions,
      },
      { key: 'reference', label: 'Reference', type: 'text' },
      dateField('receivedAt', 'Received date'),
    ],
    columns: [
      { key: 'paymentNumber', label: 'Receipt #' },
      { key: 'customerName', label: 'Customer' },
      { key: 'invoiceNumber', label: 'Invoice' },
      { key: 'amountMinor', label: 'Amount', type: 'money' },
      { key: 'method', label: 'Method' },
      { key: 'receivedAt', label: 'Date', type: 'date' },
    ],
  },
  expenses: {
    title: 'Expenses',
    description: 'Record business expenditure and its cash or bank payment method.',
    endpoint: '/expenses',
    fields: [
      { key: 'category', label: 'Category', type: 'text', required: true },
      { key: 'description', label: 'Description', type: 'textarea', required: true },
      moneyField('amount', 'Amount paid'),
      {
        key: 'paymentMethod',
        label: 'Paid from',
        type: 'select',
        required: true,
        options: methodOptions,
      },
      { key: 'reference', label: 'Reference', type: 'text' },
      dateField('date', 'Expense date'),
    ],
    columns: [
      { key: 'category', label: 'Category' },
      { key: 'description', label: 'Description' },
      { key: 'amountMinor', label: 'Amount', type: 'money' },
      { key: 'paymentMethod', label: 'Paid from' },
      { key: 'date', label: 'Date', type: 'date' },
    ],
  },
  income: {
    title: 'Other income',
    description:
      'Record income outside invoice collections and reconcile it to the selected account.',
    endpoint: '/income',
    fields: [
      { key: 'category', label: 'Category', type: 'text', required: true },
      { key: 'description', label: 'Description', type: 'textarea', required: true },
      moneyField('amount', 'Amount received'),
      {
        key: 'paymentMethod',
        label: 'Received to',
        type: 'select',
        required: true,
        options: methodOptions,
      },
      { key: 'reference', label: 'Reference', type: 'text' },
      dateField('date', 'Received date'),
    ],
    columns: [
      { key: 'category', label: 'Category' },
      { key: 'description', label: 'Description' },
      { key: 'amountMinor', label: 'Amount', type: 'money' },
      { key: 'paymentMethod', label: 'Received to' },
      { key: 'date', label: 'Date', type: 'date' },
    ],
  },
  suppliers: {
    title: 'Suppliers',
    description: 'Maintain supplier contact information for purchasing and settlement.',
    endpoint: '/suppliers',
    fields: [
      { key: 'name', label: 'Supplier name', type: 'text', required: true },
      { key: 'phone', label: 'Phone', type: 'text' },
      { key: 'email', label: 'Email', type: 'text' },
      { key: 'address', label: 'Address', type: 'textarea' },
    ],
    columns: [
      { key: 'name', label: 'Supplier' },
      { key: 'phone', label: 'Phone' },
      { key: 'email', label: 'Email' },
      { key: 'address', label: 'Address' },
      { key: 'status', label: 'Status', type: 'status' },
    ],
  },
  inventory: {
    title: 'Inventory',
    description:
      'Track print materials, reorder thresholds, weighted-average unit cost and stock adjustments.',
    endpoint: '/inventory',
    fields: [
      { key: 'sku', label: 'SKU', type: 'text', required: true },
      { key: 'name', label: 'Product name', type: 'text', required: true },
      { key: 'category', label: 'Category', type: 'text', required: true },
      { key: 'unit', label: 'Unit', type: 'text', required: true, placeholder: 'Sheet, kg, roll' },
      { key: 'reorderLevel', label: 'Reorder threshold', type: 'number' },
      moneyField('cost', 'Unit cost'),
    ],
    columns: [
      { key: 'sku', label: 'SKU' },
      { key: 'name', label: 'Product' },
      { key: 'category', label: 'Category' },
      { key: 'stockQuantity', label: 'Stock' },
      { key: 'unit', label: 'Unit' },
      { key: 'reorderLevel', label: 'Reorder at' },
      { key: 'costMinor', label: 'Unit cost', type: 'money' },
      { key: 'status', label: 'Status', type: 'status' },
    ],
  },
  purchases: {
    title: 'Purchases',
    description: 'Receive products into stock, track supplier balances, and record payments.',
    endpoint: '/purchases',
    fields: [
      selectField('supplierId', 'Supplier', 'suppliers'),
      selectField('productId', 'Product', 'products'),
      { key: 'quantity', label: 'Quantity received', type: 'number', required: true },
      moneyField('unitCost', 'Unit cost'),
      moneyField('paid', 'Paid now'),
      {
        key: 'paymentMethod',
        label: 'Payment method',
        type: 'select',
        required: true,
        options: methodOptions,
      },
      dateField('purchasedAt', 'Purchase date'),
    ],
    columns: [
      { key: 'purchaseNumber', label: 'Purchase #' },
      { key: 'supplierName', label: 'Supplier' },
      { key: 'totalMinor', label: 'Total', type: 'money' },
      { key: 'paidMinor', label: 'Paid', type: 'money' },
      { key: 'dueMinor', label: 'Due', type: 'money' },
      { key: 'status', label: 'Status', type: 'status' },
      { key: 'purchasedAt', label: 'Date', type: 'date' },
    ],
  },
};

type ListResult = {
  items: Record<string, unknown>[];
  pagination?: { page: number; limit: number; total: number; pages: number };
};
type DataResult<T> = { items: T[] };
type AttachedDocument = {
  id: string;
  fileName: string;
  contentType: string;
  url: string;
  createdAt: string;
};

export default function OperationsPage({ module }: { module: ModuleKey }) {
  const config = configs[module];
  const queryClient = useQueryClient();
  const [searchText, setSearchText] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState(false);
  const [actionError, setActionError] = useState('');
  const [actionMessage, setActionMessage] = useState('');
  const [attachedDocuments, setAttachedDocuments] = useState<AttachedDocument[]>([]);
  const [editingRow, setEditingRow] = useState<Record<string, unknown> | null>(null);
  const params = { search, page: String(page), limit: '10' };
  const list = api.useQuery<ListResult>({
    queryKey: [module, params],
    path: config.endpoint,
    params,
  });
  const rows = list.data?.items ?? [];
  const totalRecords = list.data?.pagination?.total ?? rows.length;
  const totalPages = Math.max(1, list.data?.pagination?.pages ?? 1);
  const customers = api.useQuery<DataResult<{ id: string; name: string; status: string }>>({
    queryKey: ['customer-options'],
    path: '/customers',
    params: { status: 'active', limit: '100' },
  });
  const suppliers = api.useQuery<DataResult<{ id: string; name: string; status: string }>>({
    queryKey: ['supplier-options'],
    path: '/suppliers',
    params: { limit: '100' },
  });
  const products = api.useQuery<
    DataResult<{ id: string; sku: string; name: string; status: string }>
  >({
    queryKey: ['product-options'],
    path: '/inventory',
    params: { limit: '100' },
  });
  const invoices = api.useQuery<
    DataResult<{ id: string; invoiceNumber: string; customerName: string; dueMinor: number }>
  >({
    queryKey: ['invoice-options'],
    path: '/invoices',
    params: { limit: '100' },
  });

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSearch(searchText.trim());
      setPage(1);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [searchText]);

  async function refresh() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: [module] }),
      queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
      queryClient.invalidateQueries({ queryKey: ['accounts-summary'] }),
      queryClient.invalidateQueries({ queryKey: ['report-summary'] }),
      queryClient.invalidateQueries({ queryKey: ['customer-options'] }),
      queryClient.invalidateQueries({ queryKey: ['supplier-options'] }),
      queryClient.invalidateQueries({ queryKey: ['product-options'] }),
      queryClient.invalidateQueries({ queryKey: ['invoice-options'] }),
    ]);
  }

  async function runAction(row: Record<string, unknown>, action: string) {
    setActionError('');
    setActionMessage('');
    setAttachedDocuments([]);
    try {
      if (action === 'upload-document') {
        const file = await chooseDocumentFile();
        if (!file) return;
        if (file.size > 4 * 1024 * 1024)
          throw new Error(
            'Choose a file smaller than 4 MB. Vercel limits function request payloads to 4.5 MB.'
          );
        const body = new FormData();
        body.append('file', file);
        body.append('entityType', documentEntityType(module));
        body.append('entityId', String(row.id));
        const result = await api.upload<{ item: { url: string; fileName: string } }>(
          '/documents/upload',
          body
        );
        setActionMessage(`${result.item.fileName} attached.`);
        setAttachedDocuments([
          {
            id: result.item.url,
            fileName: result.item.fileName,
            contentType: file.type,
            url: result.item.url,
            createdAt: new Date().toISOString(),
          },
        ]);
      } else if (action === 'show-documents') {
        const params = new URLSearchParams({
          entityType: documentEntityType(module),
          entityId: String(row.id),
        });
        const result = await api.get<{ items: AttachedDocument[] }>(`/documents?${params}`);
        setAttachedDocuments(result.items);
        setActionMessage(
          result.items.length
            ? `${result.items.length} attached file${result.items.length === 1 ? '' : 's'}.`
            : 'No files attached to this record.'
        );
      } else if (action === 'pdf') {
        const url = URL.createObjectURL(await api.getBlob(`/invoices/${String(row.id)}/pdf`));
        const link = document.createElement('a');
        link.href = url;
        link.download = `${String(row.invoiceNumber)}.pdf`;
        link.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      } else if (action === 'email') {
        const recipient = await promptForEmail(String(row.customerEmail ?? ''));
        if (recipient === null) return;
        await api.post(
          `/invoices/${String(row.id)}/email`,
          recipient.trim() ? { email: recipient.trim() } : {}
        );
        setActionMessage('Invoice email sent.');
      } else if (action === 'void') {
        const confirmed = await Swal.fire({
          icon: 'warning',
          title: 'Void this record?',
          text: 'Its original ledger entry will be retained for audit.',
          showCancelButton: true,
          confirmButtonText: 'Void record',
          cancelButtonText: 'Keep record',
          reverseButtons: true,
        });
        if (!confirmed.isConfirmed) return;
        if (module === 'invoices')
          await api.patch(`/invoices/${String(row.id)}/status`, { status: 'void' });
        else await api.post(`/${module}/${String(row.id)}/void`, {});
        await refresh();
      } else if (action === 'next-status' && module === 'orders') {
        const status = nextOrderStatus(String(row.status));
        if (status) {
          await api.patch(`/orders/${String(row.id)}/status`, { status });
          await refresh();
        }
      } else if (action === 'collect-payment' && module === 'orders') {
        const dueMinor = Number(row.dueMinor);
        const payment = await collectPayment(dueMinor);
        if (!payment) return;
        const invoice = row.invoiceId
          ? { item: { id: String(row.invoiceId) } }
          : await api.post<{ item: { id: string } }>(`/orders/${String(row.id)}/invoice`, {});
        await api.post(
          '/payments',
          {
            customerId: row.customerId,
            invoiceId: invoice.item.id,
            amountMinor: payment.amountMinor,
            method: payment.method,
            reference: payment.reference || `Collection for ${String(row.orderNumber)}`,
            receivedAt: new Date().toISOString(),
          },
          { 'Idempotency-Key': crypto.randomUUID() }
        );
        setActionMessage(`Payment recorded for ${String(row.orderNumber)}.`);
        await refresh();
      } else if (action === 'create-invoice' && module === 'orders') {
        const result = await api.post<{ item: { invoiceNumber: string } }>(
          `/orders/${String(row.id)}/invoice`,
          {}
        );
        setActionMessage(`Invoice ${result.item.invoiceNumber} created.`);
        await refresh();
      } else if (action === 'invoice-pdf' && module === 'orders') {
        const invoice = row.invoiceId
          ? { item: { id: String(row.invoiceId) } }
          : await api.post<{ item: { id: string } }>(`/orders/${String(row.id)}/invoice`, {});
        const url = URL.createObjectURL(await api.getBlob(`/invoices/${invoice.item.id}/pdf`));
        const link = document.createElement('a');
        link.href = url;
        link.download = `${String(row.invoiceNumber || row.orderNumber)}-invoice.pdf`;
        link.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      } else if (action === 'delete-order' && module === 'orders') {
        const confirmed = await Swal.fire({
          icon: 'warning',
          title: `Permanently delete ${String(row.orderNumber)}?`,
          text: 'The linked invoice and uploaded file records will also be deleted. If payments exist, delete their receipts from Payments first; this will increase the invoice and order balance.',
          showCancelButton: true,
          confirmButtonText: 'Delete permanently',
          cancelButtonText: 'Keep order',
          reverseButtons: true,
          focusCancel: true,
          confirmButtonColor: '#c83f4d',
        });
        if (!confirmed.isConfirmed) return;
        await api.delete(`/orders/${String(row.id)}`);
        setActionMessage(`Order ${String(row.orderNumber)} was permanently deleted.`);
        await refresh();
      } else if (action === 'delete-invoice' && module === 'invoices') {
        const confirmed = await Swal.fire({
          icon: 'warning',
          title: `Permanently delete ${String(row.invoiceNumber)}?`,
          text: 'Its linked order and uploaded file records will also be deleted. If payments exist, delete their receipts from Payments first; this will increase the invoice balance.',
          showCancelButton: true,
          confirmButtonText: 'Delete permanently',
          cancelButtonText: 'Keep invoice',
          reverseButtons: true,
          focusCancel: true,
          confirmButtonColor: '#c83f4d',
        });
        if (!confirmed.isConfirmed) return;
        await api.delete(`/invoices/${String(row.id)}`);
        setActionMessage(`Invoice ${String(row.invoiceNumber)} was permanently deleted.`);
        await refresh();
      } else if (action === 'delete-expense' && module === 'expenses') {
        const confirmed = await Swal.fire({
          icon: 'warning',
          title: 'Permanently delete this expense?',
          text: 'The expense and its cash/bank ledger entry will be removed, changing historical totals.',
          showCancelButton: true,
          confirmButtonText: 'Delete permanently',
          cancelButtonText: 'Keep expense',
          reverseButtons: true,
          focusCancel: true,
          confirmButtonColor: '#c83f4d',
        });
        if (!confirmed.isConfirmed) return;
        await api.delete(`/expenses/${String(row.id)}`);
        setActionMessage('Expense was permanently deleted.');
        await refresh();
      } else if (action === 'delete-payment' && module === 'payments') {
        const confirmed = await Swal.fire({
          icon: 'warning',
          title: `Permanently delete receipt ${String(row.paymentNumber)}?`,
          text: 'The payment and its ledger entry will be removed. Any linked invoice balance and order due will increase by this amount.',
          showCancelButton: true,
          confirmButtonText: 'Delete receipt',
          cancelButtonText: 'Keep receipt',
          reverseButtons: true,
          focusCancel: true,
          confirmButtonColor: '#c83f4d',
        });
        if (!confirmed.isConfirmed) return;
        await api.delete(`/payments/${String(row.id)}`);
        setActionMessage(
          `Receipt ${String(row.paymentNumber)} was permanently deleted and its invoice balance was recalculated.`
        );
        await refresh();
      } else if (action === 'pay-supplier') {
        const payment = await collectPayment(Number(row.dueMinor));
        if (!payment) return;
        await api.post(`/purchases/${String(row.id)}/payment`, {
          ...payment,
          paidAt: new Date().toISOString(),
        });
        await refresh();
      } else if (action === 'adjust-stock') {
        const quantityResult = await Swal.fire({
          title: 'Adjust stock',
          text: `Current stock: ${String(row.stockQuantity)} ${String(row.unit)}. Use a positive number to add stock or a negative number to remove it.`,
          input: 'number',
          inputAttributes: { step: 'any' },
          showCancelButton: true,
          confirmButtonText: 'Continue',
          inputValidator: (value) =>
            !value || !Number.isFinite(Number(value)) || Number(value) === 0
              ? 'Enter a non-zero stock adjustment.'
              : null,
        });
        if (!quantityResult.isConfirmed) return;
        const reasonResult = await Swal.fire({
          title: 'Adjustment reason',
          input: 'text',
          inputAttributes: { maxlength: '250' },
          showCancelButton: true,
          confirmButtonText: 'Save adjustment',
          inputValidator: (value) =>
            !value?.trim() || value.trim().length < 3
              ? 'Enter a reason with at least 3 characters.'
              : null,
        });
        if (!reasonResult.isConfirmed) return;
        await api.post(`/inventory/${String(row.id)}/adjust`, {
          quantityChange: Number(quantityResult.value),
          reason: String(reasonResult.value).trim(),
        });
        await refresh();
      } else if (action === 'toggle-status' && ['suppliers', 'inventory'].includes(module)) {
        const status = row.status === 'active' ? 'inactive' : 'active';
        const subject = module === 'suppliers' ? 'supplier' : 'product';
        const confirmed = await Swal.fire({
          icon: 'question',
          title: `${status === 'inactive' ? 'Deactivate' : 'Reactivate'} this ${subject}?`,
          text: 'Existing records will be retained.',
          showCancelButton: true,
          confirmButtonText: status === 'inactive' ? 'Deactivate' : 'Reactivate',
          cancelButtonText: 'Cancel',
        });
        if (!confirmed.isConfirmed) return;
        await api.patch(`/${module}/${String(row.id)}/status`, { status });
        await refresh();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The requested action failed.';
      setActionError(message);
      await showError(message);
    }
  }

  return (
    <div className="operations-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">BUSINESS OPERATIONS</p>
          <h1>{config.title}</h1>
          <p className="page-subtitle">{config.description}</p>
        </div>
        <button
          className="button button-primary"
          onClick={() => {
            setEditingRow(null);
            setOpen(true);
          }}
        >
          <Plus size={15} /> {createLabel(module)}
        </button>
      </div>
      <section className="panel customers-panel">
        <div className="customer-toolbar">
          <label className="customer-search">
            <Search size={16} />
            <span className="sr-only">Search {config.title.toLowerCase()}</span>
            <input
              value={searchText}
              onChange={(event) => setSearchText(event.target.value)}
              placeholder={`Search ${config.title.toLowerCase()}…`}
            />
            {searchText && (
              <button aria-label="Clear search" onClick={() => setSearchText('')}>
                <X size={14} />
              </button>
            )}
          </label>
          <span className="customer-total">{totalRecords.toLocaleString()} records</span>
        </div>
        {actionError && (
          <div className="customer-alert" role="alert">
            <CircleAlert size={15} />
            {actionError}
          </div>
        )}
        {actionMessage && (
          <div className="customer-success" role="status">
            {actionMessage}
            {attachedDocuments.length > 0 && (
              <span className="attached-document-links">
                {attachedDocuments.map((file) => (
                  <a key={file.id} href={file.url} target="_blank" rel="noreferrer">
                    {file.fileName}
                  </a>
                ))}
              </span>
            )}
          </div>
        )}
        {list.isError ? (
          <div className="customer-error" role="alert">
            <CircleAlert size={18} />
            <strong>{config.title} could not be loaded</strong>
            <p>
              {list.error instanceof ApiError
                ? list.error.message
                : 'Check your connection and try again.'}
            </p>
            <button className="button button-secondary" onClick={() => void list.refetch()}>
              Try again
            </button>
          </div>
        ) : list.isPending ? (
          <div className="customer-loading">
            <LoaderCircle size={19} className="spin" /> Loading {config.title.toLowerCase()}…
          </div>
        ) : rows.length ? (
          <>
            <div className="customer-table-scroll">
              <table className="customer-table operations-table">
                <thead>
                  <tr>
                    {config.columns.map((column) => (
                      <th key={column.key}>{column.label}</th>
                    ))}
                    <th className="customer-action-heading">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={String(row.id)}>
                      {config.columns.map((column) => (
                        <td key={column.key}>
                          <Cell value={row[column.key]} type={column.type} />
                        </td>
                      ))}
                      <td>
                        <RowActions
                          module={module}
                          row={row}
                          onEdit={() => {
                            setEditingRow(row);
                            setOpen(true);
                          }}
                          onAction={(action) => void runAction(row, action)}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="customer-pagination">
              <span>
                Showing{' '}
                <strong>
                  {(page - 1) * 10 + 1}–{Math.min(page * 10, totalRecords)}
                </strong>{' '}
                of <strong>{totalRecords}</strong>
              </span>
              <div>
                <button
                  className="icon-button"
                  disabled={page <= 1}
                  aria-label="Previous page"
                  onClick={() => setPage((value) => value - 1)}
                >
                  ‹
                </button>
                <span>
                  Page {page} of {totalPages}
                </span>
                <button
                  className="icon-button"
                  disabled={page >= totalPages}
                  aria-label="Next page"
                  onClick={() => setPage((value) => value + 1)}
                >
                  ›
                </button>
              </div>
            </div>
          </>
        ) : (
          <div className="customer-empty">
            <span>
              <FileText size={20} />
            </span>
            <strong>
              {search ? 'No matching records' : `No ${config.title.toLowerCase()} yet`}
            </strong>
            <p>
              {search
                ? 'Try another search.'
                : `Add your first ${createLabel(module).toLowerCase()} to start tracking this part of your business.`}
            </p>
            {!search && (
              <button className="button button-primary" onClick={() => setOpen(true)}>
                <Plus size={15} /> {createLabel(module)}
              </button>
            )}
          </div>
        )}
      </section>
      {module === 'orders' ? (
        open && <OrderDialog onOpenChange={setOpen} onSaved={() => void refresh()} />
      ) : (
        <RecordDialog
          key={`${module}-${String(editingRow?.id ?? 'new')}`}
          module={module}
          config={config}
          open={open}
          record={editingRow ?? undefined}
          onOpenChange={setOpen}
          onSaved={() => void refresh()}
          customers={customers.data?.items ?? []}
          suppliers={suppliers.data?.items ?? []}
          products={products.data?.items ?? []}
          invoices={invoices.data?.items ?? []}
        />
      )}
    </div>
  );
}

function Cell({ value, type }: { value: unknown; type?: Column['type'] }) {
  if (value === undefined || value === null || value === '')
    return <span className="customer-address">—</span>;
  if (type === 'money')
    return <strong className="table-money">{formatCurrency(Number(value))}</strong>;
  if (type === 'date')
    return (
      <time>
        {new Intl.DateTimeFormat('en-BD', {
          day: 'numeric',
          month: 'short',
          year: 'numeric',
        }).format(new Date(String(value)))}
      </time>
    );
  if (type === 'status')
    return (
      <span className={`customer-status customer-status-${statusTone(String(value))}`}>
        {String(value)}
      </span>
    );
  if (typeof value === 'number') return <span>{value.toLocaleString()}</span>;
  return <span className="table-cell-text">{String(value)}</span>;
}

function RowActions({
  module,
  row,
  onEdit,
  onAction,
}: {
  module: ModuleKey;
  row: Record<string, unknown>;
  onEdit: () => void;
  onAction: (action: string) => void;
}) {
  return (
    <div className="customer-row-actions">
      <button
        className="icon-button customer-edit"
        aria-label="Attach a document"
        title="Attach a document"
        onClick={() => onAction('upload-document')}
      >
        <Paperclip size={15} />
      </button>
      <button
        className="button button-secondary operation-action"
        onClick={() => onAction('show-documents')}
      >
        Files
      </button>
      {module === 'invoices' && (
        <>
          <button
            className="icon-button customer-edit"
            aria-label="Download invoice PDF"
            title="Open invoice PDF"
            onClick={() => onAction('pdf')}
          >
            <ArrowDownToLine size={15} />
          </button>
          <button
            className="icon-button customer-edit"
            aria-label="Email invoice PDF"
            title="Email invoice PDF"
            onClick={() => onAction('email')}
          >
            <Mail size={15} />
          </button>
        </>
      )}
      {module === 'orders' && !row.invoiceId && (
        <button
          className="button button-secondary operation-action"
          onClick={() => onAction('create-invoice')}
        >
          Create invoice
        </button>
      )}
      {module === 'orders' && Boolean(row.invoiceId) && (
        <button
          className="icon-button customer-edit"
          aria-label="Open invoice PDF"
          title="Open invoice PDF"
          onClick={() => onAction('invoice-pdf')}
        >
          <ArrowDownToLine size={15} />
        </button>
      )}
      {module === 'orders' && Number(row.dueMinor) > 0 && (
        <button
          className="button button-secondary operation-action"
          onClick={() => onAction('collect-payment')}
        >
          Collect due
        </button>
      )}
      {module === 'orders' && !['delivered', 'cancelled'].includes(String(row.status)) && (
        <button
          className="button button-secondary operation-action"
          onClick={() => onAction('next-status')}
        >
          {nextOrderStatus(String(row.status))}
        </button>
      )}
      {module === 'orders' && row.status !== 'cancelled' && (
        <button
          className="icon-button customer-delete"
          aria-label="Delete order permanently"
          title="Delete order permanently (remove receipts first)"
          onClick={() => onAction('delete-order')}
        >
          <Trash2 size={15} />
        </button>
      )}
      {module === 'inventory' && (
        <button
          className="button button-secondary operation-action"
          onClick={() => onAction('adjust-stock')}
        >
          Adjust stock
        </button>
      )}
      {['suppliers', 'inventory'].includes(module) && (
        <>
          <button
            className="icon-button customer-edit"
            aria-label={`Edit ${module === 'suppliers' ? 'supplier' : 'product'}`}
            title="Edit"
            onClick={onEdit}
          >
            <Pencil size={15} />
          </button>
          <button
            className="button button-secondary operation-action"
            onClick={() => onAction('toggle-status')}
          >
            {row.status === 'active' ? 'Deactivate' : 'Reactivate'}
          </button>
        </>
      )}
      {module === 'purchases' && Number(row.dueMinor) > 0 && (
        <button
          className="button button-secondary operation-action"
          onClick={() => onAction('pay-supplier')}
        >
          Pay due
        </button>
      )}
      {module === 'invoices' && (
        <button
          className="icon-button customer-delete"
          aria-label="Delete invoice permanently"
          title="Delete invoice permanently (remove receipts first)"
          onClick={() => onAction('delete-invoice')}
        >
          <Trash2 size={15} />
        </button>
      )}
      {module === 'payments' && (
        <button
          className="icon-button customer-delete"
          aria-label="Delete payment permanently"
          title="Delete payment and recalculate invoice due"
          onClick={() => onAction('delete-payment')}
        >
          <Trash2 size={15} />
        </button>
      )}
      {module === 'expenses' && (
        <button
          className="icon-button customer-delete"
          aria-label="Delete expense permanently"
          title="Delete expense permanently"
          onClick={() => onAction('delete-expense')}
        >
          <Trash2 size={15} />
        </button>
      )}
      {['invoices', 'expenses', 'income'].includes(module) && row.status !== 'void' && (
        <button
          className="icon-button customer-archive"
          aria-label="Void record"
          title="Void record"
          onClick={() => onAction('void')}
        >
          <Archive size={15} />
        </button>
      )}
    </div>
  );
}

function documentEntityType(module: ModuleKey) {
  return module === 'inventory'
    ? 'product'
    : module === 'orders'
      ? 'order'
      : module === 'invoices'
        ? 'invoice'
        : module === 'payments'
          ? 'payment'
          : module === 'expenses'
            ? 'expense'
            : module === 'income'
              ? 'income'
              : module === 'suppliers'
                ? 'supplier'
                : 'purchase';
}

function chooseDocumentFile() {
  return new Promise<File | null>((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.jpg,.jpeg,.png,.webp,.pdf';
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.oncancel = () => resolve(null);
    input.click();
  });
}

const orderFormSchema = z
  .object({
    customerName: z.string().trim().min(2, 'Customer name is required.').max(160),
    phone: z
      .string()
      .trim()
      .min(7, 'Enter a valid mobile number.')
      .max(40)
      .regex(/^[+\d()\s.-]+$/, 'Use a valid mobile number.'),
    address: z.string().trim().max(500),
    description: z.string().trim().min(2, 'Task description is required.').max(500),
    quantity: z
      .string()
      .refine(
        (value) =>
          Number.isFinite(Number(value)) && Number(value) > 0 && Number(value) <= 1_000_000,
        'Enter a valid quantity.'
      ),
    amount: z
      .string()
      .refine(
        (value) => Number.isFinite(Number(value)) && Number(value) > 0,
        'Total amount must be greater than zero.'
      ),
    discount: z
      .string()
      .refine(
        (value) => value === '' || (Number.isFinite(Number(value)) && Number(value) >= 0),
        'Enter a valid discount.'
      ),
    advance: z
      .string()
      .refine(
        (value) => value === '' || (Number.isFinite(Number(value)) && Number(value) >= 0),
        'Enter a valid advance.'
      ),
    advanceMethod: z.enum(['cash', 'bank', 'bkash', 'nagad', 'rocket', 'other']),
    deliveryDate: z.string(),
  })
  .superRefine((values, context) => {
    const totalMinor = Math.round(Number(values.amount || 0) * 100);
    const discountMinor = Math.round(Number(values.discount || 0) * 100);
    const advanceMinor = Math.round(Number(values.advance || 0) * 100);
    if (discountMinor >= totalMinor) {
      context.addIssue({
        code: 'custom',
        path: ['discount'],
        message: 'Discount must be less than the total amount.',
      });
    }
    if (advanceMinor > totalMinor - discountMinor) {
      context.addIssue({
        code: 'custom',
        path: ['advance'],
        message: 'Advance cannot exceed the discounted total.',
      });
    }
  });

type OrderForm = z.infer<typeof orderFormSchema>;

function phoneLookupKey(value: string) {
  const digits = value.replace(/\D/g, '');
  if (/^00880\d{10}$/.test(digits)) return `0${digits.slice(5)}`;
  if (/^880\d{10}$/.test(digits)) return `0${digits.slice(3)}`;
  if (/^\d{10}$/.test(digits)) return `0${digits}`;
  return digits;
}

function OrderDialog({
  onOpenChange,
  onSaved,
}: {
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const idempotencyRef = useRef<{ fingerprint: string; key: string } | null>(null);
  const [orderDate] = useState(() => new Date().toISOString());
  const {
    register,
    handleSubmit,
    control,
    setValue,
    formState: { errors },
  } = useForm<OrderForm>({
    resolver: zodResolver(orderFormSchema),
    defaultValues: {
      customerName: '',
      phone: '',
      address: '',
      description: '',
      quantity: '1',
      amount: '',
      discount: '0',
      advance: '0',
      advanceMethod: 'cash',
      deliveryDate: '',
    },
  });

  const [phone, amount, discount, advance] = useWatch({
    control,
    name: ['phone', 'amount', 'discount', 'advance'],
  });
  const [lookupPhone, setLookupPhone] = useState('');
  useEffect(() => {
    const timer = window.setTimeout(() => setLookupPhone(phone.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [phone]);
  const lookupPhoneDigits = lookupPhone.replace(/\D/g, '');
  const customerLookup = api.useQuery<{
    item: { id: string; name: string; phone: string; address: string; email: string; status: string } | null;
  }>({
    queryKey: ['customer-lookup', lookupPhone],
    path: '/customers/lookup',
    params: { phone: lookupPhone },
    enabled: lookupPhoneDigits.length >= 7,
    retry: false,
  });
  useEffect(() => {
    const customer = customerLookup.data?.item;
    if (!customer || phoneLookupKey(phone) !== phoneLookupKey(customer.phone)) return;
    setValue('customerName', customer.name, { shouldValidate: true });
    setValue('address', customer.address, { shouldValidate: true });
  }, [customerLookup.data, phone, setValue]);

  const due = Math.max(
    0,
    Math.round(Number(amount || 0) * 100) -
      Math.round(Number(discount || 0) * 100) -
      Math.round(Number(advance || 0) * 100)
  );

  async function submit(values: OrderForm) {
    setSaving(true);
    setMessage('');
    const money = (value: string) => Math.round(Number(value || 0) * 100);
    const payload = {
      customerName: values.customerName,
      phone: values.phone,
      address: values.address,
      description: values.description,
      quantity: Number(values.quantity),
      amountMinor: money(values.amount),
      discountMinor: money(values.discount),
      advanceMinor: money(values.advance),
      advanceMethod: values.advanceMethod,
      orderDate,
      ...(values.deliveryDate ? { deliveryDate: values.deliveryDate } : {}),
    };
    try {
      const fingerprint = JSON.stringify(payload);
      if (idempotencyRef.current?.fingerprint !== fingerprint) {
        idempotencyRef.current = { fingerprint, key: crypto.randomUUID() };
      }
      const idempotencyKey = idempotencyRef.current?.key;
      if (!idempotencyKey)
        throw new Error('Could not prepare a safe order submission. Please try again.');
      await api.post('/orders', payload, { 'Idempotency-Key': idempotencyKey });
      idempotencyRef.current = null;
      onSaved();
      onOpenChange(false);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to create the order.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="record-dialog-layer record-dialog-visible">
      <button
        className="dialog-overlay"
        aria-label="Close dialog"
        onClick={() => onOpenChange(false)}
      />
      <section
        className="customer-dialog order-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="order-dialog-title"
      >
        <div className="dialog-heading">
          <div>
            <h2 id="order-dialog-title">New order</h2>
            <p>
              Customer records are matched by mobile number. An invoice is created automatically.
            </p>
          </div>
          <button
            className="icon-button"
            aria-label="Close dialog"
            onClick={() => onOpenChange(false)}
          >
            <X size={18} />
          </button>
        </div>
        <form
          className="customer-form"
          onSubmit={(event) => {
            void handleSubmit(submit)(event);
          }}
        >
          <label className="form-field">
            <span className="form-field-label">
              Customer name <span className="form-field-label-required">*</span>
            </span>
            <input autoComplete="name" {...register('customerName')} placeholder='John Doe' />
            {errors.customerName && (
              <small className="field-error">{errors.customerName.message}</small>
            )}
          </label>
          <label className="form-field">
            <span className="form-field-label">
              Mobile number <span className="form-field-label-required">*</span>
            </span>
            <input
              autoComplete="tel"
              inputMode="tel"
              placeholder="+880 1XXX-XXXXXX"
              {...register('phone')}
            />
            {errors.phone && <small className="field-error">{errors.phone.message}</small>}
            {customerLookup.isError && lookupPhoneDigits.length >= 7 && (
              <small className="field-error" role="alert">
                Saved customer lookup failed: {customerLookup.error.message}
              </small>
            )}
          </label>
          <label className="form-field form-field-wide">
            <span className="form-field-label">Address</span>
            <textarea rows={2} autoComplete="street-address" {...register('address')} />
            {errors.address && <small className="field-error">{errors.address.message}</small>}
          </label>
          <label className="form-field form-field-wide">
            <span className="form-field-label">
              Task description <span className="form-field-label-required">*</span>
            </span>
            <textarea rows={3} {...register('description')} />
            {errors.description && (
              <small className="field-error">{errors.description.message}</small>
            )}
          </label>
          <label className="form-field">
            <span className="form-field-label">Quantity</span>
            <input type="number" min="0.001" step="0.001" {...register('quantity')} />
            {errors.quantity && <small className="field-error">{errors.quantity.message}</small>}
          </label>
          <label className="form-field">
            <span className="form-field-label">
              Total amount <span className="form-field-label-required">*</span>
            </span>
            <input
              type="number"
              min="0.01"
              step="0.01"
              inputMode="decimal"
              {...register('amount')}
            />
            {errors.amount && <small className="field-error">{errors.amount.message}</small>}
          </label>
          <label className="form-field">
            <span className="form-field-label">Discount</span>
            <input
              type="number"
              min="0"
              step="0.01"
              inputMode="decimal"
              {...register('discount')}
            />
            {errors.discount && <small className="field-error">{errors.discount.message}</small>}
          </label>
          <label className="form-field">
            <span className="form-field-label">
              Advance <span className="form-field-label-required">*</span>
            </span>
            <input type="number" min="0" step="0.01" inputMode="decimal" {...register('advance')} />
            {errors.advance && <small className="field-error">{errors.advance.message}</small>}
          </label>
          <label className="form-field">
            <span className="form-field-label">Advance payment method</span>
            <select {...register('advanceMethod')}>
              {methodOptions.map((option) => (
                <option value={option.value} key={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="form-field">
            <span className="form-field-label">Delivery date</span>
            <input type="date" {...register('deliveryDate')} />
            {errors.deliveryDate && (
              <small className="field-error">{errors.deliveryDate.message}</small>
            )}
          </label>
          <div className="order-due-preview form-field-wide">
            <span>Due amount</span>
            <strong>{formatCurrency(due)}</strong>
            <small>Automatically calculated: total − discount − advance</small>
          </div>
          {message && (
            <p className="form-message form-field-wide" role="alert">
              {message}
            </p>
          )}
          <div className="dialog-footer form-field-wide">
            <button
              className="button button-secondary"
              type="button"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </button>
            <button className="button button-primary" type="submit" disabled={saving}>
              {saving ? 'Saving order…' : 'Create order & invoice'}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

function RecordDialog({
  module,
  config,
  open,
  record,
  onOpenChange,
  onSaved,
  customers,
  suppliers,
  products,
  invoices,
}: {
  module: ModuleKey;
  config: ModuleConfig;
  open: boolean;
  record?: Record<string, unknown>;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
  customers: { id: string; name: string; status: string }[];
  suppliers: { id: string; name: string; status: string }[];
  products: { id: string; sku: string; name: string; status: string }[];
  invoices: { id: string; invoiceNumber: string; customerName: string; dueMinor: number }[];
}) {
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const idempotencyRef = useRef<{ fingerprint: string; key: string } | null>(null);
  const fields = useMemo(() => config.fields, [config.fields]);
  const schema = useMemo(
    () =>
      z.object(
        Object.fromEntries(
          fields.map((field) => [
            field.key,
            field.type === 'money' || field.type === 'number'
              ? z
                  .string()
                  .refine(
                    (value) =>
                      value === ''
                        ? !field.required
                        : Number.isFinite(Number(value)) && Number(value) >= 0,
                    `${field.label} must be a valid non-negative number.`
                  )
              : field.required
                ? z.string().trim().min(1, `${field.label} is required.`)
                : z.string(),
          ])
        )
      ),
    [fields]
  );
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<Record<string, string>>({
    resolver: zodResolver(schema),
    defaultValues: Object.fromEntries(
      fields.map((field) => [field.key, initialFieldValue(module, field, record)])
    ),
  });

  async function submit(values: Record<string, string>) {
    setSaving(true);
    setMessage('');
    try {
      const payload = buildPayload(module, values);
      if (record) await api.patch(`${config.endpoint}/${String(record.id)}`, payload);
      else {
        const headers: Record<string, string> = {};
        if (module === 'payments' || module === 'purchases') {
          const fingerprint = JSON.stringify(payload);
          if (idempotencyRef.current?.fingerprint !== fingerprint) {
            idempotencyRef.current = { fingerprint, key: crypto.randomUUID() };
          }
          headers['Idempotency-Key'] = idempotencyRef.current.key;
        }
        await api.post(config.endpoint, payload, headers);
      }
      idempotencyRef.current = null;
      onSaved();
      onOpenChange(false);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to save this record.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className={`record-dialog-layer ${open ? 'record-dialog-visible' : ''}`}
      aria-hidden={!open}
    >
      {open && (
        <button
          className="dialog-overlay"
          aria-label="Close dialog"
          onClick={() => onOpenChange(false)}
        />
      )}
      {open && (
        <section
          className="customer-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="record-dialog-title"
        >
          <div className="dialog-heading">
            <div>
              <h2 id="record-dialog-title">
                {record ? `Edit ${singularLabel(module).toLowerCase()}` : createLabel(module)}
              </h2>
              <p>{config.description}</p>
            </div>
            <button
              className="icon-button"
              aria-label="Close dialog"
              onClick={() => onOpenChange(false)}
            >
              <X size={18} />
            </button>
          </div>
          <form
            className="customer-form"
            onSubmit={(event) => {
              void handleSubmit(submit)(event);
            }}
          >
            {fields.map((field) => {
              const fieldError = errors[field.key]?.message;
              const optionItems =
                field.options ??
                (field.optionSource === 'customers'
                  ? customers
                      .filter((item) => item.status === 'active')
                      .map((item) => ({ value: item.id, label: item.name }))
                  : field.optionSource === 'suppliers'
                    ? suppliers
                        .filter((item) => item.status === 'active')
                        .map((item) => ({ value: item.id, label: item.name }))
                    : field.optionSource === 'products'
                      ? products
                          .filter((item) => item.status === 'active')
                          .map((item) => ({ value: item.id, label: `${item.sku} · ${item.name}` }))
                      : field.optionSource === 'invoices'
                        ? invoices
                            .filter((item) => item.dueMinor > 0)
                            .map((item) => ({
                              value: item.id,
                              label: `${item.invoiceNumber} · ${item.customerName} · ${formatCurrency(item.dueMinor)}`,
                            }))
                        : []);
              return (
                <label className="form-field" key={field.key}>
                  <span className="form-field-label">
                    {field.label}
                    {field.required && <span className="form-field-label-required">*</span>}
                  </span>
                  {field.type === 'select' ? (
                    <select {...register(field.key)}>
                      <option value="">{field.required ? 'Choose…' : 'None'}</option>
                      {optionItems.map((option) => (
                        <option value={option.value} key={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  ) : field.type === 'textarea' ? (
                    <textarea rows={3} {...register(field.key)} placeholder={field.placeholder} />
                  ) : (
                    <input
                      type={field.type === 'money' ? 'number' : field.type}
                      min={field.type === 'money' || field.type === 'number' ? '0' : undefined}
                      step={
                        field.type === 'money'
                          ? '0.01'
                          : field.type === 'number'
                            ? '0.001'
                            : undefined
                      }
                      placeholder={
                        field.placeholder ?? (field.type === 'money' ? '0.00' : undefined)
                      }
                      {...register(field.key)}
                    />
                  )}
                  {fieldError && <small className="field-error">{String(fieldError)}</small>}
                </label>
              );
            })}
            {message && (
              <p className="form-message form-field-wide" role="alert">
                {message}
              </p>
            )}
            <div className="dialog-footer form-field-wide">
              <button
                className="button button-secondary"
                type="button"
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </button>
              <button className="button button-primary" type="submit" disabled={saving}>
                {saving
                  ? 'Saving…'
                  : record
                    ? `Save ${singularLabel(module).toLowerCase()}`
                    : `Create ${singularLabel(module).toLowerCase()}`}
              </button>
            </div>
          </form>
        </section>
      )}
    </div>
  );
}

function initialFieldValue(
  module: ModuleKey,
  field: FieldConfig,
  record?: Record<string, unknown>
) {
  if (!record)
    return field.type === 'date'
      ? today
      : field.type === 'select'
        ? (field.options?.[0]?.value ?? '')
        : '';
  const value =
    module === 'inventory' && field.key === 'cost'
      ? Number(record.costMinor ?? 0) / 100
      : record[field.key];
  if (value === undefined || value === null) return '';
  if (field.type === 'date') return new Date(String(value)).toISOString().slice(0, 10);
  return String(value);
}

function buildPayload(module: ModuleKey, values: Record<string, string>) {
  const money = (value: string) => Math.round(Number(value || 0) * 100);
  if (module === 'orders')
    return {
      customerId: values.customerId,
      description: values.description,
      amountMinor: money(values.amount),
      orderDate: values.orderDate,
      ...(values.dueDate ? { dueDate: values.dueDate } : {}),
    };
  if (module === 'invoices')
    return {
      customerId: values.customerId,
      issueDate: values.issueDate,
      ...(values.dueDate ? { dueDate: values.dueDate } : {}),
      lines: [
        {
          description: values.description,
          quantity: 1,
          unitPriceMinor: money(values.amount),
          discountPercent: 0,
        },
      ],
    };
  if (module === 'payments')
    return {
      customerId: values.customerId,
      ...(values.invoiceId ? { invoiceId: values.invoiceId } : {}),
      amountMinor: money(values.amount),
      method: values.method,
      reference: values.reference ?? '',
      receivedAt: values.receivedAt,
    };
  if (module === 'expenses' || module === 'income')
    return {
      category: values.category,
      description: values.description,
      amountMinor: money(values.amount),
      paymentMethod: values.paymentMethod,
      reference: values.reference ?? '',
      date: values.date,
    };
  if (module === 'suppliers')
    return {
      name: values.name,
      phone: values.phone ?? '',
      email: values.email ?? '',
      address: values.address ?? '',
    };
  if (module === 'inventory')
    return {
      sku: values.sku,
      name: values.name,
      category: values.category,
      unit: values.unit,
      reorderLevel: Number(values.reorderLevel || 0),
      costMinor: money(values.cost),
    };
  if (module === 'purchases')
    return {
      supplierId: values.supplierId,
      purchasedAt: values.purchasedAt,
      paidMinor: money(values.paid),
      paymentMethod: values.paymentMethod,
      lines: [
        {
          productId: values.productId,
          quantity: Number(values.quantity),
          unitCostMinor: money(values.unitCost),
        },
      ],
    };
  return values;
}

function statusTone(value: string) {
  if (['active', 'paid', 'delivered', 'ready', 'received'].includes(value)) return 'active';
  if (['void', 'cancelled', 'inactive'].includes(value)) return 'inactive';
  return 'pending';
}

function nextOrderStatus(status: string) {
  const next: Record<string, string> = {
    pending: 'processing',
    processing: 'printing',
    printing: 'ready',
    ready: 'delivered',
  };
  return next[status];
}

function createLabel(module: ModuleKey) {
  return module === 'orders' ? 'New order' : `Add ${singularLabel(module).toLowerCase()}`;
}

function singularLabel(module: ModuleKey) {
  const labels: Record<ModuleKey, string> = {
    orders: 'Order',
    invoices: 'Invoice',
    payments: 'Payment',
    expenses: 'Expense',
    income: 'Income',
    inventory: 'Product',
    suppliers: 'Supplier',
    purchases: 'Purchase',
  };
  return labels[module];
}
