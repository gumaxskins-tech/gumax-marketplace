# Architecture — Gumax Marketplace 2.0

The codebase is an npm-workspaces monorepo. Applications are isolated delivery surfaces and packages own domain contracts; business rules never depend directly on transport, HTTP, a payment gateway, Steam, or a market-data provider.

## Boundaries

- `apps/web`: public marketplace UI.
- `apps/admin`: privileged operational UI.
- `apps/api`: authenticated API composition root.
- `packages/database`: Prisma schema and generated-client boundary.
- `packages/pricing`: pricing orchestration and provider-neutral contracts.
- `packages/payments`, `steam`, `risk`: adapter/domain boundaries for later stages.
- `packages/shared`: stable primitives with no framework or database dependency.

## Architectural decisions

1. **Versioned, append-only commercial configuration.** `PricingRuleVersion` stores JSON configuration and an effective period. Financial operations link to `PricingSnapshot`, so future changes cannot reprice history.
2. **Decimal is mandatory.** Monetary and exchange-rate columns use PostgreSQL `Decimal(20,8)`; JavaScript floating point is not a financial source of truth.
3. **Provider ports, not provider coupling.** The YouPin integration implements `MarketDataProvider` later. No undocumented YouPin HTTP endpoint is assumed.
4. **Inventory availability is transactional.** Reservation and inventory status are explicit. Stage 3 API services must reserve with a row lock and a conditional `AVAILABLE -> RESERVED` transition.
5. **Ledger is the wallet truth.** Wallet balance is derived from immutable entries; cached balances, if added, are projections only.

The upstream repository was empty apart from `.github` when this foundation was created. The local commit cannot be published until a GitHub-authenticated remote is available.
