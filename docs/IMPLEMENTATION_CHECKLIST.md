# Implementation checklist

Updated: 2026-11-06

## Phase 1 — Architecture

- [x] Define web/API workspace boundaries, environment configuration, primary entities, and API routes.
- [x] Add per-business tenant ownership and query scoping for business data, with guarded legacy migration.
- [x] Document integer-minor-unit accounting, ledger-derived cash movement, and report boundaries.
- [ ] Reconcile all accounting workflows against the business workbook before enabling journal, opening balances, tax, inventory valuation, or profit reporting.

## Phase 2 — UI design and application shell

- [x] Responsive deep-navy sidebar, workspace header, dashboard cards, charts, activity panels, and mobile navigation.
- [x] Shared light/dark theme preference and core visual tokens.
- [x] Owner sign-in and first-run account setup with email verification.
- [x] Public business registration with hashed email-verification tokens and business-specific workspaces.
- [x] Add an opt-in local-only terminal verification link for demos without SMTP; production configuration rejects the option.
- [x] Block remote MongoDB access from local development by default to prevent accidental production database migrations.
- [x] Persist authentication rate-limit counters in MongoDB so application instances share the limit.
- [x] Customer directory with search, status filtering, pagination, create/edit, archive/restore, PDF statements, invoice-linked collections, and guarded permanent deletion.
- [x] Order form with mobile-based customer matching and live due calculation; invoice and advance receipt are generated automatically.
- [x] Owner settings for business identity, invoice details, and workspace currency.
- [x] Shared responsive pages for orders, invoices, payments, expenses, other income, inventory, suppliers, and purchases.
- [x] Accounts, reports/PDF/CSV export, and settings/backup screens.
- [x] Add an in-app help centre with workflow guides and quick navigation.
- [x] WhatsApp automation excluded per requirement.
- [ ] Recheck all authenticated module screens at mobile, tablet, and desktop sizes with a non-production test account.

## Phase 3 — Backend foundation

- [x] Express API, MongoDB connection, health check, Mongoose models, validation, and protected routes.
- [x] Password hashing, cookie sessions, rate limits, disabled audit-event persistence, and explicit API errors.
- [x] Scope authenticated database queries, aggregates, idempotency records, counters, documents, and backups to the signed-in business.
- [x] Customer create, update, list/search/filter/paginate, and reversible archive/restore.
- [x] Order creation/status lifecycle, invoice issue/status/PDF/email, collections, due checks, and protected permanent deletes for orders, invoices, payments, expenses, and eligible customers.
- [x] Create order, customer match, invoice, and advance payment atomically; add audited cancellation that preserves paid accounting history.
- [x] Expense/other-income entry and void; expense deletion with ledger reconciliation; supplier and product entry; inventory adjustment.
- [x] Purchase receiving, weighted-average product cost, stock movements, and supplier settlement.
- [x] Match the workbook's Rocket payment method alongside cash, bank, bKash, and Nagad.
- [x] Add idempotency protection for customer payments and purchase receiving, including concurrent unique-key retries.
- [x] Provide edit/deactivate workflows for suppliers and products in the UI; stock changes remain auditable adjustments.
- [x] Add an isolated-database API integration suite for owner setup, invoice/payment idempotency, due caps, purchase stock/cost, void/reversal, report/PDF exports, permanent delete constraints/cascades, CSV safety, and account summaries.
- [ ] Run the cross-tenant/accounting integration suite against a disposable replica set.

## Phase 4 — Frontend integration

- [x] Connect authentication, dashboard, customers, and all listed business modules to MongoDB-backed API routes.
- [x] Connect invoice/customer/report PDF, invoice email, report CSV, account movement summary, integration status, and owner backup export.
- [x] Connect live tenant-scoped overdue-invoice and low-stock alerts to the application notification menu.
- [x] Add loading, empty, retry/error, validation, and mutation feedback states.
- [ ] Run authenticated end-to-end tests for signup/verification and create/list/action workflows in a disposable browser environment.

## Phase 5 — Accounting integration

- [x] Store money as integer minor units and test invoice line totals and non-negative outstanding amounts.
- [x] Guard invoice and purchase line totals and weighted-average cost against unsafe integer overflow.
- [x] Record customer collections, expenses, other income, supplier payments, and adjustments in the ledger.
- [x] Derive cash/bank-by-method net movement from posted ledger entries and label that it excludes opening balances/transfers.
- [ ] Reconcile invoices, payments, dues, expenses, income, purchases, cash, bank, and inventory against approved historical records; matching formulas and workbook-level order flow have been reviewed.
- [x] Add transactional integration assertions for duplicate/idempotent writes, due caps, void/reversal, and stock/cost updates.
- [x] Execute the suite against a transaction-capable disposable test database.
- [ ] Add opening balances, account transfers/reconciliation, cost-of-sales, and validated profit reporting only after policy approval.

## Phase 6 — Automation

- [x] Generate invoice PDFs and send them through Nodemailer when SMTP is configured.
- [x] Upload supported documents through the Cloudinary API when configured.
- [x] Export owner-only ZIP backups with a manifest and selected business collections.
- [x] Show email, document-storage, and backup readiness without exposing credentials.
- [x] Attach Cloudinary document uploads to orders, invoices, payments, expenses, income, suppliers, products, and purchases.
- [x] Store uploaded files as authenticated Cloudinary assets and issue short-lived signed download URLs.
- [x] Show tenant-scoped in-app alerts for overdue invoices and products below configured reorder levels.
- [ ] Add durable scheduled backups and a verified, owner-controlled restore workflow using persistent backup storage.
- [ ] Add scheduled email reports.

## Phase 7 — Testing and deployment

- [x] API domain and tenant-context unit tests pass (15 passed); integration tests skip unless `MONGODB_TEST_URI` is configured.
- [x] API and web production builds/type checks pass.
- [x] API and web lint pass.
- [x] API health endpoint reports MongoDB readiness and returns 503 when disconnected.
- [x] Add Vercel serverless routing and Render single-origin SPA/API serving, bounded uploads/exports, an explicit tenant-migration command, and document the Render/Atlas deployment sequence.
- [ ] Run production-like authenticated browser checks against a non-production test account.
- [ ] Configure production SMTP before enabling email-verified signup; confirm backup/restore procedures, MongoDB access controls, HTTPS, monitoring, and deployment secrets.
- [ ] Deploy to the user's hosting provider; deployment access and production environment details are not available in this workspace.

## Current next step

Provide verified source records before accounting reconciliation; run tenant-isolation and accounting integration tests against a disposable replica set; configure production SMTP, Atlas network controls/backups, and Render secrets; then complete authenticated browser tests and deployment. Take a verified snapshot before the first tenant-migration deployment. Large direct-to-Cloudinary uploads, workspace-level restore, scheduled reports, and opening-balance reconciliation are not implemented. Do not treat net ledger movement as available cash or profit.
