# Vercel + MongoDB Atlas deployment runbook

The repository is configured to deploy the React app and Express API together from the repository root. Vercel serves the Vite SPA and routes `/api/*` to a Node.js serverless function; the API keeps its MongoDB connection warm per function instance.

Deployment is not complete until provider settings and the smoke tests below have been performed. Never deploy a credential pasted into chat. Rotate any password that has been shared and enter fresh credentials only in the appropriate provider secret manager.

## 1. Prepare MongoDB Atlas

1. Create a new Atlas project and a dedicated cluster/database for this application. Use a cluster tier that supports replica-set transactions; invoice/payment/purchase workflows require transactions.
2. Create a database user with a strong unique password and only the access needed for this application's database.
3. Configure Atlas Network Access for Vercel function egress. Prefer Vercel Static IPs or Secure Compute where available and allowlist only those addresses. Do not expose the database to `0.0.0.0/0` as a production shortcut. If the Vercel plan cannot provide usable egress addresses, resolve this network requirement before deployment rather than opening Atlas broadly.
4. Copy the Atlas connection URI into the Vercel server-side environment as `MONGODB_URI`; include the app's database name in the URI. Never use a production URI for local development or integration tests.
5. Enable Atlas automated/continuous backups and retention appropriate to the business. Perform a restore drill into a separate temporary cluster. Atlas restore is cluster-level; this application does not implement tenant ZIP restore.

## 2. Import the repository into Vercel

1. Push the project to a Git provider and import it at Vercel.
2. Set **Root Directory** to the repository root. Do not set it to `apps/web`; the API function lives in the root `api/` folder.
3. Use the root `vercel.json` settings:
   - Install: `npm ci`
   - Build: `npm run build`
   - Output: `apps/web/dist`
   - Serverless API route: `api/[...path].ts`
4. Select Node.js 22.x for the Vercel project. The root `engines` declaration pins the supported Node 22 range.
5. Set the project Function Region near the Atlas cluster (Singapore is a reasonable starting point for Bangladesh-based users when available).

## 3. Add Vercel environment variables

Add these under Vercel **Project Settings → Environment Variables**. Use fresh, unique values; do not put server secrets in any `VITE_*` variable.

| Variable | Value / handling |
| --- | --- |
| `NODE_ENV` | `production` |
| `MONGODB_URI` | Atlas URI for the dedicated production database |
| `JWT_SECRET` | Cryptographically random, private value of at least 32 characters |
| `CLIENT_ORIGIN` | Exact deployed origin, for example `https://your-project.vercel.app`; update if a custom domain is added |
| `TRUST_PROXY_HOPS` | `1` for the Vercel proxy |
| `CURRENCY` | `BDT` unless the business selects another supported currency |
| `ALLOW_REMOTE_DEVELOPMENT_DATABASE` | `false` |
| `DEV_EMAIL_VERIFICATION_LINKS` | `false` |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` | Production email provider settings; required for signup verification and invoice email |
| `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` | Optional until document storage is enabled |
| `VITE_API_BASE_URL` | `/api` (same-origin; may be omitted because this is the frontend default) |
| `VITE_CURRENCY` | Same code as `CURRENCY` |

Set secrets for Preview and Production separately. Never set `DEV_EMAIL_VERIFICATION_LINKS=true` in Vercel: config validation rejects it outside development.

Same-origin `/api` routing keeps the secure, `SameSite=Lax` session cookie on the Vercel site and avoids cross-site-cookie problems. Preview builds use their own Vercel hostname and the same-origin API.

## 4. Database initialization and existing installations

- For a brand-new, empty Atlas database, the first API invocation verifies there is no unmigrated tenant data and creates the required indexes before serving the request.
- For an existing installation, stop the old API, take and verify an Atlas snapshot, then run `npm run build --workspace @maa/api` and `npm run migrate:tenants --workspace @maa/api` once with `MONGODB_URI` and `JWT_SECRET` set privately in `apps/api/.env`. This command mutates legacy records and synchronizes indexes. Confirm the database URI is the intended environment before running it. Do not run migration during Vercel builds or point it at an unverified production database.
- The Vercel API refuses to serve if it detects tenantless legacy records or unmigrated counters; it returns 503 rather than silently exposing or misassigning data. Review Vercel function logs and complete the migration out-of-band.

## 5. Launch checks

1. Deploy Preview against a separate disposable Atlas database and a test SMTP inbox/provider.
2. Run `MONGODB_TEST_URI` integration tests against a disposable, transaction-capable replica set. The test suite creates and drops only a uniquely named `maa_offset_integration_test_*` database. Never point it at production.
3. Exercise first-owner setup and public signup; confirm verification emails arrive, verify links, sign in/out, and confirm two businesses cannot read or change each other's records.
4. Exercise invoice/payment idempotency, purchase receiving, due calculations, reports/CSV, PDF email, Cloudinary upload/download, backup export, and `/api/health`.
5. Review Atlas database access, backup retention and restore drill, Vercel function logs, rate limits, email deliverability, and billing limits before promoting Preview to Production.
6. For a legacy-data migration, do not promote the deployment until the migration, tenant isolation checks, and verified snapshot restore are complete.

## Vercel-specific constraints

- Vercel Functions limit request and response bodies to 4.5 MB. The application rejects document uploads above 4 MB and workspace ZIP backups above 4 MB to stay below that platform limit. For larger documents/backups, a signed direct-to-Cloudinary/object-storage workflow is not implemented; use Atlas backups for full database recovery.
- SMTP is required for email-verified signup and invoice email. Terminal verification links are development-only.
- Authentication rate limits use the shared Atlas database; the database role must be able to create the TTL index on `api_rate_limit_buckets`.
- Scheduled application-level backups, tenant-scoped ZIP restore, scheduled reports, account reconciliation/opening balances, and validated profit reporting are not implemented.

## Accounting cutover

No business workbook or verified opening balances were available. Do not invent cash, bank, inventory, customer-due, supplier-due, tax, or profit values. Choose and document a cutover date; reconcile physical inventory and receivables/payables against source documents with the business's accountant before enabling opening-balance or profit reporting. Account totals currently mean recorded net movement, not available cash.

## Current status

The code and Vercel routing are prepared, but this workspace has no Vercel or Atlas deployment access, no disposable Atlas test database, no SMTP configuration, no verified business source records, and no completed backup restore drill. Production deployment and live provider checks remain outstanding.
