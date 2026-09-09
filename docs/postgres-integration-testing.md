# PostgreSQL integration testing

## Contract

Financial PostgreSQL integration tests use only `GUMAX_TEST_DATABASE_URL`. They must never fall back to `DATABASE_URL`; a missing test URL is a test setup error. The target must be a dedicated disposable database, never production, staging, or a shared developer database. Before migration or test execution, log only its host, port, and database name—never credentials—and confirm the name is the intended disposable target.

## Current toolchain status

The repository is an npm workspaces monorepo (`npm@10.9.2` remains declared in the root manifest). `@gumax/database` declares `@prisma/client` `6.2.1` and `prisma` `6.2.1`. On 2026-09-07, a root `package-lock.json` was materialized and `npm ci` completed using external npm `11.17.0` with Node `24.19.0`; this differs from, but does not modify, the declared package-manager version. Prisma CLI `6.2.1`, generated `@prisma/client` `6.2.1`, `prisma validate`, and the workspace typecheck are now confirmed. The available `pnpm` fallback must not be used: it would change the npm lockfile contract.

The first real `migrate deploy` attempt against the disposable PostgreSQL target failed safely with PostgreSQL `42P01` because the first historical migration was incremental and `IdempotencyRecord` did not yet exist in an empty database. `20260905000000_initial_baseline` now creates the schema represented by `da2020b^` (with only equivalent Prisma 6.2.1 enum syntax normalization), before the ledger-idempotency and Hold incrementals. A fresh-database migration-chain revalidation remains pending.

## Prerequisites

1. Prefer npm `10.9.2`, which is declared by the repository. The currently validated external npm is `11.17.0`; do not alter `packageManager` until the project deliberately approves that version change. Use the committed root lockfile and `npm ci` for reproducible installs.
2. Start a disposable PostgreSQL service. Docker is the preferred future local/CI strategy; a dedicated local PostgreSQL instance is acceptable. Do not use an external database unless it is explicitly provisioned only for these tests.
3. Set `GUMAX_TEST_DATABASE_URL` to that disposable database URL. Keep it out of source control.

## Commands after the prerequisites exist

Run these commands from the repository root using the project's local tools:

```powershell
npm ci
npm run db:generate
npm run db:validate

if ([string]::IsNullOrEmpty($env:GUMAX_TEST_DATABASE_URL)) {
  throw "GUMAX_TEST_DATABASE_URL is required for PostgreSQL integration tests"
}
$env:DATABASE_URL = $env:GUMAX_TEST_DATABASE_URL
npm --workspace @gumax/database exec prisma migrate deploy
node --test packages/database/test/integration/capture-transaction-postgres.test.ts
```

The explicit assignment to `DATABASE_URL` is only for Prisma CLI, whose schema datasource requires that name; it is performed only after the `GUMAX_TEST_DATABASE_URL` gate succeeds. The future integration harness itself must read `GUMAX_TEST_DATABASE_URL` directly and reject an unset value rather than using `DATABASE_URL`.

## Cleanup and scope

Prefer a uniquely named disposable database per local/CI run and drop it after testing. If a shared test service is used, the harness may remove only records created with its own unique test IDs. No test may reset an unverified target. The first capture smoke validates migrations, a real Prisma client, and one real transaction; rollback, incomplete-claim failure, and same-key concurrency remain separate tests.
