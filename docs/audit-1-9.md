# Audit stages 1–9

## Executive summary

Status: **NOT READY**. The repository contains a TypeScript/npm-workspaces architecture and 20 direct Node tests passed on 2026-09-05. It does not yet have installed dependencies, Prisma migrations, a running PostgreSQL instance, a runnable HTTP server, Docker, CI, or external production providers. The domain implementations are largely in-memory reference services, not durable production workflows.

## Evidence and validation

- Clean working tree before this report; branch `main` at `f0a100f`.
- `node v24.19.0` and `git 2.53.0` available.
- `npm`, `npx`, and `docker` unavailable: Prisma, TypeScript typecheck, build, package install, migrations, Docker and CI configuration could not be executed.
- Direct test command ran 20 tests: 20 pass, 0 fail. Node emitted module-type warnings for `packages/shared` tests.
- No Prisma migration directory, Dockerfile, compose file, or GitHub Actions workflow exists.

## Monorepo map

`apps/{web,admin,api}` contain contract/domain-boundary code and direct tests. `packages/{database,pricing,payments,steam,risk,shared}` contain domain/reference services. `packages/database/prisma/schema.prisma` declares PostgreSQL models. Documentation is in `docs/`. No installed dependencies or lockfile were found.

## Matrix

| Area | Status | Evidence | Validation | Blocker | Next action |
|---|---|---|---|---|---|
| Foundation | IMPLEMENTED_NOT_VALIDATED | workspaces, strict tsconfig, docs | direct tests only | npm absent | install and typecheck |
| Database | PARTIAL | PostgreSQL Prisma schema, client helper | visual only | no migration/DB | generate migration and integration tests |
| Pricing | VALIDATED | providers, Decimal, snapshots, 7-day analysis | 10 passing tests | mock data only | persist/use through services |
| Wallet / Ledger | IMPLEMENTED_NOT_VALIDATED | in-memory append-only reference | 3 passing tests | no DB transaction | repository + PostgreSQL tests |
| Orders / Payments | PARTIAL | in-memory flows and mock provider | direct tests | no API/webhook runtime | persistent application services |
| KYC / Trust / Risk | PARTIAL | in-memory risk service | direct tests | missing persistent reviews/limits | schema/services/API integration |
| Steam / Trade Protect | PARTIAL | mock trade state/quarantine/release | direct test | no real Steam/provider verification | approved adapter and persistence |
| Buy/Sell/Upgrade/Downgrade | PARTIAL | commercial intent reference | direct test | not linked to orders/trades/DB | orchestration services |
| Admin | PARTIAL | RBAC/config domain | direct test | no rendered panel | API + UI |
| Web | PARTIAL | safe cart contracts | direct test | no pages/routing/runtime | real frontend |
| API | PARTIAL | auth/ownership/checkout helpers | direct test | no HTTP bootstrap/routes | runnable server and integration tests |
| FX | BLOCKED_EXTERNAL | mock contract only | pricing mock test | legitimate configured provider absent | select/source provider |
| YouPin | BLOCKED_EXTERNAL | explicit unsupported provider | provider test | official permitted API absent | provider agreement/API |
| PIX | BLOCKED_EXTERNAL | mock payment provider | finance test | gateway credentials absent | select gateway + webhook adapter |
| Storage | IMPLEMENTED_NOT_VALIDATED | local private reference | provider test | S3 adapter/credentials absent | S3 integration + audit |
| Docker / CI / Observability / E2E / Deployment | PENDING | no files found | not run | not implemented | implement after runtime/toolchain |

## Security findings

### P0

1. Financial, trade, reservation and idempotency protections remain in-memory; process restart or concurrent workers can violate integrity. PostgreSQL migrations and transactional repositories are required.
2. No executable HTTP API means authentication, authorization, webhook verification, request limits and security headers are not deployed.

### P1

1. No Prisma validation/generation/typecheck/build has run; source validity beyond Node strip-types is unknown.
2. No migrations, test database, Docker or CI.
3. External payment, FX, Steam and market integrations are unavailable/placeholder.

### P2

1. KYC storage is local in-memory reference; no S3 implementation, document-access audit or persisted metadata flow.
2. Admin and customer experiences are contracts, not rendered applications.

### P3

1. Shared package lacks `type: module`, causing Node warnings.

## Integration gaps

Pricing is not orchestrated into persistent Order creation. Payment webhook processing is not exposed by an HTTP handler and does not use persistent idempotency. Risk has no financial/operation repository adapters. Trade release and settlement are not connected. Web and admin have no API transport or UI. Schema has `IdempotencyRecord`, `CommercialOperation`, and `Settlement`, but no generated migrations or repositories consume them.

## Financial, KYC and trade assessment

The web contract rejects authoritative price fields; wallet balance is derived from entries in its in-memory service; reservation and duplicate event checks exist only in `Map`/`Set`; snapshots are immutable in unit tests. KYC references private keys, local storage has MIME/size checks and signed-reference simulation, but persistent storage, RBAC access/audit and document upload flows are incomplete. Trade mock enforces quarantine and risk-allow release, but no external Steam verification exists.

## Secret scan

No apparent committed secret was found. The only matches were commented placeholders in `.env.example` for webhook and Steam credentials. No `@ts-ignore` or `@ts-expect-error` occurrences were found. The repository does contain `any` only in ordinary text search results where applicable; no systematic typecheck was possible.

## Recommended execution order

1. Restore npm toolchain; install dependencies; produce lockfile; run Prisma format/validate/generate and TypeScript build.
2. Create reviewed Prisma migrations; start isolated PostgreSQL; implement repositories and transactions for ledger, reservations, webhooks and trade transitions.
3. Build API runtime, authentication, endpoints, request validation, graceful shutdown and integration tests.
4. Add Docker, CI, logging/redaction, E2E and deployment readiness.
5. Only then configure credentialed FX/PIX/S3 providers; keep YouPin/Steam disabled until an official permitted integration is confirmed.
