# Architecture

## Application shape

- `apps/web`: React + TypeScript + Vite, Tailwind CSS v4, Radix UI primitives, TanStack Query, Zustand, React Hook Form + Zod, Recharts, Lucide, and SweetAlert2.
- `apps/api`: Express + TypeScript API, Mongoose models, MongoDB persistence, Zod request validation, and bcrypt/JWT-backed session authentication.
- The Vite development server proxies `/api` to the API. Authentication uses an `HttpOnly`, `SameSite=Lax` session cookie; the browser does not persist bearer tokens.
- Environment-specific credentials belong in ignored `.env` files locally and the deployment platform’s secret manager in production.

## Domain model

| Collection | Purpose | Important relationships / constraints |
| --- | --- | --- |
| `businesses` | Isolated business workspaces | One business per owner signup; owner-editable name, contact details, invoice footer, and currency |
| `users` | Workspace owner and staff identities | Unique, normalized email; business reference; password hash is never returned |
| `customers` | Customer directory | Referenced by orders, invoices, and payments; a normalized mobile number identifies repeat customers |
| `orders` | Printing jobs and work tracking | Unique order number; references customer and invoice; snapshots customer details; status lifecycle |
| `invoices` | Customer billing and receivables | Unique invoice number; references customer/job; created with an order; line totals and balances in minor units |
| `payments` | Customer collections | Unique receipt number; references customer and optionally invoice |
| `expenses`, `income` | Operating costs and other income | Categorized entry, posting date, payment method, and ledger movement |
| `suppliers` | Supplier directory | Referenced by purchases and settlements |
| `products` | Print-material inventory | SKU, stock quantity, reorder level, and weighted-average unit cost |
| `purchases` | Stock receiving and supplier due | References supplier; purchase lines update product quantities/cost |
| `supplierPayments` | Supplier settlements | References purchase and payment method |
| `stockMovements` | Inventory history | Records purchase receipts and manual adjustments |
| `ledgerEntries` | Cash/bank movement | Direction, amount, payment method, source record, and void timestamp |

Every business record has a `businessId`. Authenticated requests establish an async tenant context; Mongoose query and aggregate middleware fail closed without that context and constrain reads/writes. Unique business numbers, inventory SKUs, idempotency keys, counters, documents, and raw-collection backup exports are tenant-aware. Cross-tenant record IDs therefore behave as not found.

Authenticated API workflows cover creation and listing/search/pagination for business records, order lifecycle changes, invoice status/PDF/email actions, inventory adjustments, supplier settlement, void actions, and guarded permanent deletion. Creating an order matches or creates its customer by normalized mobile number and transactionally creates its invoice and any advance receipt/ledger entry. Later collections update that invoice and the ledger. Payments can be deleted individually; their receipt metadata and ledger entry are removed atomically, and any linked invoice paid amount/status is recalculated. Once its payments are removed, an order or invoice can be permanently deleted together with linked records. Deleting an expense removes its ledger movement in the same transaction. A customer with any order cannot be deleted; deleting a customer without orders also removes its invoices, payments, and related ledger entries atomically. Audit events are not persisted. Customer UI supports edits, reversible archival, per-customer order/invoice/payment statements, PDF statements, and invoice-linked due collection.

The authenticated notifications endpoint derives overdue invoice and low-stock alerts from the current tenant's records; it does not persist alert history or send notifications externally.

## Accounting boundaries

- Currency values are stored as integer minor units (`amountMinor`); the current calculations assume two fractional digits. Keep `CURRENCY` in the API environment and `VITE_CURRENCY` in the web environment aligned (default `BDT`).
- Invoice totals are calculated from validated lines and explicit discounts; domain tests cover invoice totals and due clamping.
- Dashboard sales exclude draft and void invoices. Collections use payment posting date. Outstanding is calculated as `max(0, total - paid)`.
- Account balances are cumulative net movements by payment method since the ledger started. They do not include opening balances, transfers, or bank reconciliation and must not be presented as available cash.
- Purchases increase stock and update weighted-average cost. Profit/cost-of-sales reporting remains disabled until workbook policy and opening inventory are reconciled.
- The provided workbook tracks memo totals, discounts, an initial advance, later receipts, and remaining due; the order workflow uses `net total = gross total - discount` and `due = net total - advance - later collections`. Order values and payments are stored as integer minor units, and invoices snapshot the order/customer details. Legacy workbook import, historical duplicate-customer reconciliation, and historical balance reconciliation are not implemented.
- Business profile settings control invoice name/contact/address/footer and workspace currency. Secret integrations and SMTP/Cloudinary credentials remain deployment-managed.
- Financial writes and account verification use MongoDB transactions. The deployment must support transactions (replica set/Atlas); the isolated integration suite includes cross-tenant cases but requires a disposable test deployment to run.
- CSV reports export invoice, collection, expense, income, and purchase records for a selected period, with spreadsheet formula-leading text escaped.
- Invoice PDFs use an embedded Noto Sans Bengali font and a teal/navy layout with line items, discounts, advance and later receipts, outstanding due, and payment history. Customer statement and date-filtered business report PDFs are also generated server-side.
- Permanent deletion is transactional and confirmed in the UI. Payment deletion reverses its invoice balance and ledger movement; an order or invoice with remaining payments must have those receipts removed first. Deleting an expense or an orderless customer also removes linked ledger entries so cash/bank and report aggregates remain consistent with the remaining records.
- MongoDB connectivity errors return a retryable `503` message rather than the generic server-error response; transaction workflows accept successful operations that intentionally return no value.

## Security and operations

- First-run setup creates the initial owner/business. Subsequent public signup creates a separate business, then requires a hashed, one-hour email-verification token before login. Signup requires SMTP; verification resend responses avoid disclosing whether an email is registered.
- An explicit `DEV_EMAIL_VERIFICATION_LINKS=true` setting can print verification links to the API terminal only when `NODE_ENV=development`; config validation rejects this mode in test and production environments. Use only with a disposable development database.
- Development blocks remote MongoDB URIs by default, so accidentally starting the API with a production URI cannot migrate/index that database. Remote access requires a separate `ALLOW_REMOTE_DEVELOPMENT_DATABASE=true` opt-in that is also rejected outside development.
- Passwords use bcrypt hashing. Authentication and public signup routes use a tenant-independent MongoDB-backed rate-limit store shared across serverless instances; API responses do not include hashes.
- Inputs are parsed with Zod; errors return actionable 4xx responses and unexpected server errors return a generic message.
- Helmet is enabled, CORS is restricted to `CLIENT_ORIGIN`, and JSON request bodies are size-limited.
- Invoice PDF/email, Cloudinary upload, and tenant-scoped owner ZIP export are implemented; SMTP and Cloudinary readiness are shown without exposing secrets. SMTP is required for public email verification; Cloudinary remains optional. Business-record attachments are stored as authenticated Cloudinary assets and returned with short-lived signed download URLs; backup scheduling/restoration is not implemented.
- Normal API startup creates missing indexes only on a fresh tenant-ready database and refuses to serve if it detects unmigrated legacy records. For an existing installation, run the explicit `migrate:tenants` command once after a verified snapshot; it assigns legacy records only when ownership is unambiguous and synchronizes tenant-aware indexes.
- WhatsApp automation is explicitly out of scope. Production deployment is not available from this workspace.
