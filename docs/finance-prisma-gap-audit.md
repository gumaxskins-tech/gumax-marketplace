# Finance Prisma/PostgreSQL persistence gap audit

## 1. Executive status

Audited at commit `aaf2263c635a60da23c1fff3ee7f2e209d50a20a`. All 13 finance ports are asynchronous and the in-memory composition boundaries cover capture, inventory orders, verified webhooks, and refunds. They are not durable or rollback-safe. No Prisma adapter, Prisma finance transaction manager, schema change, or migration is implemented by this audit. P0 mapping decisions are recorded in [finance-p0-mapping-decisions.md](finance-p0-mapping-decisions.md).

The current schema has 15 directly relevant models: `Wallet`, `LedgerEntry`, `WalletHold`, `Order`, `OrderItem`, `PricingSnapshot`, `Purchase`, `Sale`, `Payment`, `PaymentEvent`, `Refund`, `InventoryItem`, `InventoryReservation`, `IdempotencyRecord`, and `AuditLog`. It contains useful foundations but no port is safe to implement as production persistence without the gaps below being resolved.

## 2. 13-port matrix

| Port | Current methods / domain result | Candidate model(s) | Existing support | Missing or decision required | Atomicity and status |
| --- | --- | --- | --- | --- | --- |
| `LedgerRepository` | `append`, `listByWallet`, `listAll` / `LedgerEntry` | `LedgerEntry`, `Wallet` | UUID key; wallet FK; `Decimal(20,8)` amount; currency, type, reference, metadata, timestamp; `@@index([walletId, createdAt])`; globally unique entry key | `PrismaLedgerRepository` is implemented with a create/read-only structural client surface, compatible with `PrismaClient` and `Prisma.TransactionClient`; it validates that rows do not use the Prisma-only `FEE` type and that metadata remains a string record. Persistent ledger idempotency and PostgreSQL integration testing remain pending | Same transaction as capture and any justified money mutation. **IMPLEMENTED_NOT_INTEGRATION_TESTED** |
| `WalletRepository` | `getById`, `save` / `Wallet` | `Wallet` | UUID key; unique `userId`; currency; no balance/cache field | `PrismaWalletRepository` is implemented with a wallet-only structural client surface, compatible with `PrismaClient` and `Prisma.TransactionClient`; PostgreSQL integration testing remains pending. Current port has no user lookup, so the schema's one-wallet-per-user rule is merely observed, not exposed. User cascade must be reviewed before financial history is made durable | Simple read/write; balance remains ledger-derived. **IMPLEMENTED_NOT_INTEGRATION_TESTED** |
| `HoldRepository` | `getById`, `save`, `listActiveByWallet`, `count` / `Hold` | `WalletHold` | Wallet FK; amount/currency; timestamps; idempotency key | `ReservationStatus` has `CONSUMED`, not domain `CAPTURED`; no `@@index([walletId, status])`; no update timestamp / captured timestamp | Hold update and ledger append require one transaction. **PARTIAL** |
| `OrderRepository` | `getById`, `save` / immutable `Order` | `Order`, `OrderItem`, `PricingSnapshot`, `Purchase`, `Sale` | Order/user/pricing snapshot relations; currency; persisted total and exchange rate; item inventory FK | Domain order lacks required `operationType` and `total`; domain item fees, discount, final price, item snapshot, and `source` have no lossless columns; inventory/encomenda mapping between `OrderItem`, `Purchase`, and `Sale` is not defined; `Sale.inventoryItemId` is not an `InventoryItem` relation | Save must share a transaction with reservation and order idempotency. **DESIGN_DECISION_REQUIRED** |
| `PaymentRepository` | `getById`, `save` / `Payment` | `Payment` | Order FK; provider/reference unique pair; amount/currency/status; timestamps; idempotency key | Explicit converter needed for `providerPaymentId` ↔ `providerReference`; no separate provider intent data beyond reference | Payment and order transition must share webhook transaction. **PARTIAL** |
| `RefundRepository` | `getById`, `save`, `listByPayment`, `count` / `Refund` | `Refund`, `Payment` | Payment FK; amount/currency; idempotency key; timestamp | Approved mapping requires a dedicated `RefundStatus.COMPLETED` and `@@index([paymentId])`; future settlement is intentionally absent | Payment/refund aggregate validation and insert require one transaction/lock. **PARTIAL** |
| `InventoryReservationRepository` | `getByItemId`, `reserve`, `release` / `InventoryReservation` | `InventoryReservation`, `InventoryItem`, `Order`/`Sale` | Inventory FK; `orderId` scalar; lifecycle enum; status index | Domain has only `itemId`; schema requires `expiresAt`; no ownership/release policy mapping; no one-active-reservation uniqueness; `orderId` has no `Order` relation or FK | Must atomically claim item with Order persistence. **DESIGN_DECISION_REQUIRED** |
| `LedgerIdempotencyStore` | `claim`, `complete` / `LedgerIdempotencyClaim`, `LedgerEntry` | `IdempotencyRecord`, `LedgerEntry` | `@@unique([scope, key])`, typed nullable-during-transaction `ledgerEntryId` FK, unique result reference, deferred Ledger lifecycle triggers, and runtime claim/complete contract are prepared | `PrismaLedgerIdempotencyStore` is implemented with the approved `createMany({ skipDuplicates: true })` claim primitive and a transaction-client-compatible delegate surface. PostgreSQL migration execution/concurrency integration testing and the transaction manager remain pending; credit/debit remain outside a production transaction boundary | **IMPLEMENTED_NOT_POSTGRES_INTEGRATION_TESTED** |
| `HoldIdempotencyStore` | `get`, `set` / `Hold` | `IdempotencyRecord`, `WalletHold` | Same scoped uniqueness foundation | Fixed `HOLD` scope and typed result mapping are not represented/enforced; hold enum mismatch remains | Claim/complete with hold write. **PARTIAL** |
| `OrderIdempotencyStore` | `get`, `set` / `Order` | `IdempotencyRecord`, `Order` | Same scoped uniqueness foundation | Fixed `ORDER` scope/result mapping plus lossless Order mapping are required | Claim/complete with reservation and order write. **PARTIAL** |
| `PaymentIdempotencyStore` | `get`, `set` / `Payment` | `IdempotencyRecord`, `Payment` | Same scoped uniqueness foundation | Fixed `PAYMENT` scope/result mapping required; existing `Payment.idempotencyKey` is globally unique and conflicts with independent scope semantics | Claim/complete with payment creation. **PARTIAL** |
| `PaymentEventDedupStore` | `has`, `record` / boolean | `PaymentEvent` or `IdempotencyRecord` | `PaymentEvent.providerEventId` global unique; `IdempotencyRecord` scoped unique | `PaymentEvent` requires `paymentId` and payload that the narrow port does not receive; provider-aware uniqueness requires a provider dimension if global event IDs are not contractual | Unique insert/claim in verified-webhook transaction. **PARTIAL** |
| `RefundIdempotencyStore` | `get`, `set` / `Refund` | `IdempotencyRecord`, `Refund` | Same scoped uniqueness foundation | Fixed `REFUND` scope/result mapping; Refund enum mismatch blocks typed result persistence | Claim/complete with refund validation and insert. **PARTIAL** |

Classification after P0 decisions: **3 IMPLEMENTED_NOT_POSTGRES_INTEGRATION_TESTED, 8 PARTIAL, 0 MISSING, 2 DESIGN_DECISION_REQUIRED**. `AuditLog` is outside the 13 ports and is a separate gap. The remaining design decisions are `OrderRepository` (`OperationType`) and `InventoryReservationRepository` (owner/order/expiry lifecycle). The approved Ledger claim/complete design is recorded in [ledger-idempotency-persistence-design.md](ledger-idempotency-persistence-design.md).

## 3. Current Prisma model mapping and money audit

`LedgerEntry`, `WalletHold`, `Order.total`, `OrderItem.unitPrice`, `Payment`, `Refund`, `InventoryItem`, `PricingSnapshot`, and pricing market fields use `@db.Decimal(20, 8)`. Currency is stored using `Currency`. This supports Decimal/numeric storage and avoids a required JavaScript-float conversion, provided adapters convert the pricing `Decimal` value without `Number`.

The schema exposes precision and scale for money fields. The domain `Money` converter must preserve the decimal string/value and currency, map dates to `Date`, map JSON metadata safely, and recreate readonly/frozen domain snapshots after reading. No runtime converter exists yet. `LedgerEntry.metadata` can map to JSON only while metadata remains string-valued in the domain.

## 4. Enum and domain mapping gaps

| Domain concept | FinanceService | Prisma | Gap |
| --- | --- | --- | --- |
| Order initial state | `PENDING_PAYMENT` | `PAYMENT_PENDING` | Different literal; mapping policy required |
| Order statuses | includes `DRAFT`, `PENDING_PAYMENT`, `AUTHORIZED`, `PROCESSING`, `UNDER_REVIEW` | includes `PAYMENT_PENDING`, `ORDER_AUTHORIZED`; lacks several domain literals | Lossless status mapping is not defined |
| Order source | item `INVENTORY` or `ORDER` | no `OrderItem.source`; `Purchase`/`Sale` models exist | Required design decision for persisting current behavior |
| Hold terminal state | `CAPTURED` | `ReservationStatus.CONSUMED` | Incompatible without mapping or schema change |
| Refund state | `COMPLETED` | `PaymentStatus` has no `COMPLETED` | Incompatible |
| Payment state | domain values match the Prisma payment enum values used today | same literals | Compatible, subject to reference converter |
| Ledger type | domain includes all current financial types | Prisma also includes `FEE` | Prisma is a superset; adapter must reject or map unsupported reads deliberately |

## 5. Unique/index requirements

The current schema already has the useful `Wallet.userId`, `LedgerEntry.idempotencyKey`, `Order.idempotencyKey`, `Payment(provider, providerReference)`, `Payment.idempotencyKey`, `Refund.idempotencyKey`, `PaymentEvent.providerEventId`, `IdempotencyRecord(scope, key)`, and `LedgerEntry(walletId, createdAt)` constraints/indexes.

Six additional or revised access constraints are required before safe adapters:

1. A PostgreSQL partial unique index for one `ACTIVE` `InventoryReservation` per `inventoryItemId`; Prisma schema annotations do not express this partial index directly.
2. `WalletHold(walletId, status)` index for active-hold reads.
3. `Refund(paymentId)` index for refund aggregation.
4. A provider-aware `PaymentEvent` uniqueness decision: retain global event ID only if globally guaranteed, otherwise add provider identity and `@@unique([provider, providerEventId])`.
5. Lossless order-item source/inventory lookup indexing after the Order mapping decision; current `OrderItem` only indexes `orderId`.
6. Idempotency result integrity: fixed scope/entity type plus non-null result reference for completed records, enforced by schema or a reviewed transaction invariant.

## 6. Transaction and concurrency requirements

| Concern | Race or partial state | Required constraint/primitive | Transaction | Locking |
| --- | --- | --- | --- | --- |
| Ledger idempotency | Two ledger requests use the same key | `IdempotencyRecord(scope,key)` unique claim plus typed result reference | Ledger append + idempotency completion | DEPENDE on claim conflict handling |
| Hold idempotency | Repeated hold creates more than one hold | Scoped unique idempotency | Hold write + idempotency | DEPENDE; available-funds decision separately needs serialization |
| Order idempotency | Retry reserves/saves twice | Scoped unique idempotency | Reservation + Order + idempotency | YES for inventory item |
| Payment idempotency | Payment intent creation duplicates | Scoped unique idempotency and provider reference unique pair | Payment + idempotency | DEPENDE on provider-reference semantics |
| Refund idempotency | Retry produces another refund | Scoped unique idempotency | Payment read + refund aggregate + insert + idempotency | YES: payment/refund serialization or equivalent |
| Payment event dedup | Two workers apply one webhook twice | Unique event claim | Event + Payment + Order | DEPENDE; unique insert is the primary claim primitive |
| Exclusive inventory reservation | Two orders reserve one item | Partial active-reservation unique index plus item-state validation | Item claim + reservation + Order + idempotency | YES: lock `InventoryItem` row or safe conditional update |

For inventory, `find` then `insert` is insufficient. Recommended PostgreSQL primitive: in one transaction, lock the target `InventoryItem` row (or conditional-update it from `AVAILABLE`), validate state, insert an active reservation, persist the Order and idempotency result, then commit. The partial unique active-reservation index remains a necessary backstop against lifecycle bugs and concurrent writers.

For refunds, lock/serialize the Payment and its refund aggregate before validating the maximum. For capture, update the hold and append the ledger entry with idempotency in the same transaction. For webhook, claim the event and persist payment/order transitions together after provider verification. These are DB-only boundaries today; provider verification is external and stays outside. Future provider refund, Pix, Steam, YouPin, FX, and notification calls are DB-plus-external-side-effect workflows and cannot be rolled back by PostgreSQL.

## 7. Audit persistence gap

`FinanceService.audit` is an in-memory `string[]`. The schema does have `AuditLog`, but no finance `AuditRepository`, no mapper, and no reference in `FinanceTransactionContext`. Therefore audit is currently neither persistent nor transaction-scoped. The minimum future design is a finance audit port bound to the same transaction client, mapping action/entity/before/after/metadata without external side effects. This audit does not add that port.

## 8. P0/P1/P2 schema gaps

### P0 schema gaps (7)

1. No active-inventory-reservation exclusion constraint or transaction-safe claim primitive.
2. `InventoryReservation.expiresAt` is required while the domain reservation has no expiry/owner/order lifecycle mapping, and its `orderId` is not an `Order` relation.
3. Order/OrderItem cannot persist current immutable financial snapshot, fees, discounts, final price, and source losslessly.
4. `WalletHold.CAPTURED` cannot map to `ReservationStatus`.
5. `Refund.COMPLETED` cannot map to the current Prisma refund status field.
6. Completed idempotency records do not enforce a typed, non-null original-result reference.
7. Payment-event persistence/dedup lacks a settled provider-identity contract for safe multi-provider operation.

### P1 schema gaps (4)

1. Missing `WalletHold(walletId, status)` and `Refund(paymentId)` read indexes.
2. `PaymentEvent` payload/verified time are not expressible through the narrow current dedup port.
3. `Wallet.user` cascade needs a finance-history retention decision.
4. `AuditLog` exists but has no finance port, transaction-context member, or mapper.

### P2 optional improvements (3)

1. Non-authoritative reconciled balance read model after ledger aggregation correctness is proven.
2. Explicit captured/released timestamps and a decided inventory reservation expiry policy.
3. Provider-aware event identity even if the provider currently guarantees global event IDs.

## 9. Recommended migration order (no migrations created)

1. Reconcile finance enum and lossless Order/OrderItem/PricingSnapshot mapping requirements, including inventory versus encomenda representation.
2. Add idempotency result integrity and provider-event identity prerequisites.
3. Add inventory reservation lifecycle fields and the PostgreSQL partial active-reservation unique index.
4. Add hold/refund read indexes and resolve hold/refund enum mappings.
5. Add finance audit persistence mapping after a transaction-scoped audit port is approved.

## 10. Recommended Prisma adapter order

1. `PrismaFinanceTransactionManager` composition only, built from one `Prisma.TransactionClient` and transaction-scoped adapter instances.
2. `PrismaWalletRepository` and `PrismaLedgerRepository` after Decimal converters are tested; ledger remains append-only.
3. `PrismaHoldRepository` with the resolved hold-state mapping, then capture integration tests.
4. `PrismaOrderRepository` and `PrismaInventoryReservationRepository` together after the lossless order and exclusivity prerequisites.
5. `PrismaPaymentRepository` and persistent payment-event dedup together for webhook boundaries.
6. `PrismaRefundRepository` plus refund idempotency after refund enum/index and payment-locking decisions.
7. Typed persistent idempotency adapters should be bound to every transaction-scoped workflow; implementation may be introduced with the first dependent adapter but must use the same scoped primitive.

## 11. PrismaFinanceTransactionManager requirements

The future manager should call the existing database infrastructure with one transaction client, build a `FinanceTransactionContext` whose adapters all capture that client, and invoke the domain callback. It must not let adapters capture the global `PrismaClient`, open nested independent transactions, or issue external provider/Steam/YouPin/FX calls inside the database transaction. The caller must keep provider verification outside the webhook transaction. Audit remains outside until its port is added.

## 12. Exact next micro-step

The mapping decisions are now recorded in [finance-p0-mapping-decisions.md](finance-p0-mapping-decisions.md). `PrismaWalletRepository` is implemented against the existing Wallet model and a transaction-scoped client surface. The next prerequisite is a PostgreSQL integration test for that adapter; no remaining port should be implemented before its approved mapping and schema prerequisites are satisfied.
