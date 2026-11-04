# MAA Offset Press Business Management

A full-stack business management workspace for MAA Offset Press. This repository is a TypeScript monorepo with a React/Vite dashboard and an Express/MongoDB API.

## Current implementation

- Responsive application shell, keyboard-operable mobile navigation, persisted light/dark theme, owner sign-in/first-run setup, and opt-in email verification links for local demos.
- A live dashboard backed by MongoDB aggregates for sales, collections, outstanding invoices, expenses, active customers, orders, recent activity, customer rankings, and monthly trends.
- Customer directory with validated create/edit, search, status filters, pagination, and reversible archive/restore actions.
- Orders/jobs, invoices with PDF/email actions, customer payments, expenses, other income, inventory adjustments, editable supplier/product records, purchases, and supplier settlements backed by API workflows.
- Ledger-derived cash/bank movement, date-filtered reports with CSV export, integration readiness, and owner-only data backup export.
- Cookie-based authentication, password hashing, input validation, API rate limiting, and protected dashboard endpoints.
- MongoDB-backed authentication rate limits shared across Vercel serverless instances.
- Public business registration with email verification, one isolated tenant per business, and owner-specific business names.
- Tenant-scoped in-app alerts for overdue invoices and low inventory, linked directly to the relevant work areas.
- Tenant-scoped MongoDB queries, aggregations, unique business document numbers, inventory SKUs, idempotency keys, and backups.
- Accounting values are represented as integer minor currency units in the API to avoid floating-point arithmetic.
- No WhatsApp integration is included.

The application does not seed financial data. It does not yet support opening balance entry, inter-account transfers/reconciliation, profit/cost-of-sales reports, or backup restore/scheduling. Account totals represent recorded net movement—not verified available cash. Production signup requires working SMTP credentials; local demos may use development-only terminal verification links. See the implementation checklist for outstanding validation and deployment work.

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

Integration tests require `MONGODB_TEST_URI` pointing to a disposable, transaction-capable MongoDB test deployment—not production. They generate a uniquely named `maa_offset_integration_test_*` database and drop only that database when complete; they never use `MONGODB_URI` or the business database.

## API

- `GET /api/health` — process health check
- `GET /api/auth/setup-status` — whether the initial owner account is needed
- `POST /api/auth/setup` — create the first owner account only; email verification is required before sign-in
- `POST /api/auth/register`, `POST /api/auth/verify-email`, `POST /api/auth/resend-verification` — create an isolated business and verify its owner email
- `POST /api/auth/login` / `POST /api/auth/logout` / `GET /api/auth/me`
- `GET /api/dashboard/summary?from=<ISO date>&to=<ISO date>` — authenticated, database-backed dashboard data
- `GET /api/customers?search=<text>&status=active|inactive|all&page=1&limit=10` — authenticated customer directory
- `POST /api/customers`, `PATCH /api/customers/:id`, `PATCH /api/customers/:id/status` — customer CRUD and archival
- `/api/orders`, `/api/invoices`, `/api/payments`, `/api/expenses`, `/api/income`, `/api/inventory`, `/api/suppliers`, `/api/purchases` — authenticated business workflows
- `GET /api/notifications` — tenant-scoped overdue invoice and low-stock alerts
- `GET /api/accounts/summary`, `GET /api/reports/summary`, `GET /api/reports/summary.csv` — account movement and period reporting
- `GET /api/invoices/:id/pdf`, `POST /api/invoices/:id/email`, `GET /api/backup/export` — document, email, and owner-only backup actions

See [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) for the architecture and accounting boundaries, and [docs/IMPLEMENTATION_CHECKLIST.md](./docs/IMPLEMENTATION_CHECKLIST.md) for phase status.
For the Vercel + MongoDB Atlas production path, see the [deployment runbook](./docs/DEPLOYMENT.md).

## Deployment

Deploy the React frontend and Express API together from the repository root to Vercel. The API runs as a serverless function at `/api/*`; it initializes a cached MongoDB connection and ensures indexes for a fresh tenant-ready database. Existing installations must run the explicit tenant migration after a verified snapshot; serverless startup fails closed if unmigrated legacy data is found. Configure Vercel environment variables and Atlas transaction/network access using the [deployment runbook](./docs/DEPLOYMENT.md). This workspace has not been deployed to the user's Vercel or Atlas accounts.
