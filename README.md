# MAA Offset Press Business Management

A full-stack business management workspace for MAA Offset Press. This repository is a TypeScript monorepo with a React/Vite dashboard and an Express/MongoDB API.

## Current implementation

- Responsive application shell, keyboard-operable mobile navigation, persisted light/dark theme, owner sign-in/first-run setup, and opt-in email verification links for local demos.
- A live dashboard backed by MongoDB aggregates for sales, collections, outstanding invoices, monthly/year-to-date estimated net profit, expense categories, active customers, orders, recent activity, customer rankings, and monthly trends.
- Customer directory with validated create/edit, search, status filters, pagination, reversible archive/restore actions, customer statements, PDF account reports, and per-invoice due collection.
- Orders/jobs, invoices with PDF/email actions, customer payments, expenses, other income, inventory adjustments, editable supplier/product records, purchases, and supplier settlements backed by API workflows.
- Order entry captures customer name/address/mobile, task, quantity, total, discount, advance, and delivery date. It matches customers by normalized mobile number, calculates the remaining due, and creates the invoice and advance receipt together.
- Orders expose invoice PDF, due collection from the order or customer account, and permanent deletion. Deleting an order also removes its linked receipts, ledger movements, invoice, and attachments in one transaction.
- SweetAlert2 confirmations protect permanent deletion of customers without orders, orders, invoices, payments, expenses, income, eligible inventory, suppliers, and purchases. Related financial and stock records are deleted or reversed together; records with dependent history are protected with an actionable error.
- Invoice PDFs use a polished teal/navy design with Bengali text, itemized totals, advances, later collections, amount due, and payment history. Date-filtered business reports use a redesigned financial summary and detailed tables; customer statements are available as PDFs too.
- The “Need a hand?” sidebar opens in-app workflow guides for orders, customer statements, invoices, reports, and safe deletion.
- Owner settings manage the business name, contact/address details, invoice footer, and workspace currency; those details are used on generated invoices and throughout the dashboard.
- Owners can maintain expense categories in Settings. An allowlisted platform administrator can search and manage user accounts across workspaces.
- Ledger-derived cash/bank movement, date-filtered reports with PDF/CSV export, integration readiness, and owner-only data backup export.
- Cookie-based authentication, password hashing, input validation, API rate limiting, and protected dashboard endpoints.
- MongoDB-backed authentication rate limits shared across application instances.
- Public business registration with email verification, one isolated tenant per business, and owner-specific business names.
- Tenant-scoped in-app alerts for overdue invoices and low inventory, linked directly to the relevant work areas.
- Tenant-scoped MongoDB queries, aggregations, unique business document numbers, inventory SKUs, idempotency keys, and backups.
- Accounting values are represented as integer minor currency units in the API to avoid floating-point arithmetic.
- No WhatsApp integration is included.

The application does not seed financial data. Dashboard net profit is an estimate based on invoiced sales plus other income less recorded expenses and full purchase totals; inventory purchases are not matched to job-level cost of sales. Opening balances, inter-account transfers/reconciliation, accounting-validated profit reports, and backup restore/scheduling are not implemented. Account totals represent recorded net movement—not verified available cash. Production signup requires working SMTP credentials; local demos may use development-only terminal verification links. WhatsApp messaging is not enabled. See the implementation checklist for outstanding validation and deployment work.

## Requirements

- Node.js 22.12 or newer in the Node 22 release line
- npm 10 or newer
- MongoDB (a local replica set or MongoDB Atlas for the planned transactional workflows)

## Local development

1. Install dependencies from the repository root:

   ```sh
   npm install
   ```

2. Copy `apps/api/.env.example` to `apps/api/.env`, then set `MONGODB_URI` to a disposable development database and a private random `JWT_SECRET` of at least 32 characters. Development refuses remote MongoDB URIs unless `ALLOW_REMOTE_DEVELOPMENT_DATABASE=true` is explicitly set for a dedicated disposable Atlas database. Keep `.env` files out of version control. For local signup demos without an SMTP sandbox, set `DEV_EMAIL_VERIFICATION_LINKS=true`; the one-hour verification URL is printed only to the API terminal. Both opt-ins are rejected unless `NODE_ENV=development`. For actual email testing, configure SMTP instead.
   To enable platform administration, set `PLATFORM_ADMIN_EMAILS` to a comma-separated allowlist of verified account email addresses. Never expose this setting to the frontend.
3. Optionally set `CURRENCY` in `apps/api/.env` and `VITE_CURRENCY` in `apps/web/.env` to the same three-letter currency code (default BDT). The accounting implementation assumes a two-decimal currency.
4. Start both applications:

   ```sh
   npm run dev
   ```

   The frontend runs at `http://localhost:5173`; the API runs at `http://localhost:4000`.
5. On first visit, create the initial owner account and verify it using the API terminal link (development-only mode) or the email delivered by SMTP. After setup, anyone can register a separate business workspace; each owner must verify their email before signing in.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Run the API and frontend together |
| `npm run build` | Type-check and build both workspaces |
| `npm run lint` | Lint both workspaces |
| `npm test` | Run API domain tests |
| `npm run test:integration` | Run authenticated financial workflows against an isolated test database |

Integration tests require `MONGODB_TEST_URI` pointing to a disposable, transaction-capable MongoDB test deployment—not production. They generate a uniquely named `maa_offset_test_*` database and drop only that database when complete; they never use `MONGODB_URI` or the business database.

## API

- `GET /api/health` — process health check
- `GET /api/auth/setup-status` — whether the initial owner account is needed
- `POST /api/auth/setup` — create the first owner account only; email verification is required before sign-in
- `POST /api/auth/register`, `POST /api/auth/verify-email`, `POST /api/auth/resend-verification` — create an isolated business and verify its owner email
- `POST /api/auth/login` / `POST /api/auth/logout` / `GET /api/auth/me`
- `GET /api/dashboard/summary?from=<ISO date>&to=<ISO date>` — authenticated, database-backed dashboard data
- `GET /api/customers?search=<text>&status=active|inactive|all&page=1&limit=10`, `GET /api/customers/:id/statement`, `GET /api/customers/:id/statement/pdf` — customer directory and account reports
- `POST /api/customers`, `PATCH /api/customers/:id`, `PATCH /api/customers/:id/status`, `DELETE /api/customers/:id` — customer CRUD and archival; deletion is blocked when orders exist
- `/api/orders`, `/api/invoices`, `/api/payments`, `/api/expenses`, `/api/income`, `/api/inventory`, `/api/suppliers`, `/api/purchases` — authenticated business workflows
- `GET /api/notifications` — tenant-scoped overdue invoice and low-stock alerts
- `GET /api/accounts/summary`, `GET /api/reports/summary`, `GET /api/reports/summary.csv`, `GET /api/reports/summary.pdf` — account movement and period reporting
- `GET /api/invoices/:id/pdf`, `POST /api/invoices/:id/email`, `GET /api/backup/export` — document, email, and owner-only backup actions
- `GET /api/platform/users`, `PATCH /api/platform/users/:id/status`, `DELETE /api/platform/users/:id` — allowlisted platform user administration

See [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) for the architecture and accounting boundaries, and [docs/IMPLEMENTATION_CHECKLIST.md](./docs/IMPLEMENTATION_CHECKLIST.md) for phase status.
For the Render + MongoDB Atlas production path, see the [deployment runbook](./docs/DEPLOYMENT.md).

## Deployment

Deploy one Render Web Service from the repository root. Express serves the built React app and MongoDB-backed API from the same origin; the app validates the production web build at startup and derives its default allowed origin from Render's `RENDER_EXTERNAL_URL`. Existing installations must run the explicit tenant migration after a verified snapshot; startup fails closed if unmigrated legacy data is found. Configure Render environment variables and Atlas transaction/network access using the [deployment runbook](./docs/DEPLOYMENT.md). This workspace has not been deployed to Render or Atlas.
