# Finance async repository migration audit

## Scope and current state

This is a read-only architecture audit at commit `05e753781ab9e245fa4d1263877646f633ce0be6`. `FinanceService` has no internal `Map` or `Set` for its six idempotency/deduplication mechanisms or its main wallet, ledger, hold, order, payment, refund, and inventory-reservation state. All 13 ports are currently synchronous and are implemented only by explicit in-memory adapters. They are not PostgreSQL persistence.

**Progress note (P0-A1.2b):** P0-A1.1d is complete: the six idempotency/deduplication ports, all seven main repositories, and their in-memory adapters have been converted to async. FinanceService awaits every affected store and repository call, including its separate item-only `reserve()` operation. `capture()` runs through FinanceTransactionManager and uses `tx.holdRepository`, `tx.ledgerRepository`, and `tx.ledgerIdempotencyStore` for its boundary. `createOrder()` also runs through the manager and uses `tx.orderIdempotencyStore`, `tx.inventoryReservationRepository`, and `tx.orderRepository`. For `OrderItem.source === "INVENTORY"`, the required `inventoryItemId` is reserved before the Order is saved; `source === "ORDER"` does not reserve inventory. This is composition only: InMemoryFinanceTransactionManager has no rollback or production atomicity. Reservation/order, webhook payment/order/event-dedup/audit, and refund idempotency/refund/audit remain non-atomic. In-memory reservation exclusivity applies only to a shared adapter in one process; it is neither distributed nor crash-safe. Refunds retain record-only semantics with no ledger or settlement effect. The signature tables and propagation counts below describe the audited pre-conversion baseline.

`FinanceService` retains `audit: string[]`, which is an in-memory audit trail and is not represented by a repository port. It is therefore outside the extracted-state claim and must be replaced by an audit port before a production finance workflow is considered persistent.

## 1. Current ports inventory

All signatures below are exact TypeScript signatures from `packages/payments/src/index.ts`. Every method is synchronous today.

### Idempotency and deduplication ports

| Port | Method | Parameters | Return | FinanceService call sites (approx.) |
| --- | --- | --- | --- | --- |
| `LedgerIdempotencyStore` | `get` | `key: string` | `LedgerEntry \| undefined` | `post()` (1) |
|  | `set` | `key: string, entry: LedgerEntry` | `void` | `post()` (1) |
| `HoldIdempotencyStore` | `get` | `key: string` | `Hold \| undefined` | `hold()` (1) |
|  | `set` | `key: string, hold: Hold` | `void` | `hold()` (1) |
| `OrderIdempotencyStore` | `get` | `key: string` | `Order \| undefined` | `createOrder()` (1) |
|  | `set` | `key: string, order: Order` | `void` | `createOrder()` (1) |
| `PaymentIdempotencyStore` | `get` | `key: string` | `Payment \| undefined` | `createPayment()` (1) |
|  | `set` | `key: string, payment: Payment` | `void` | `createPayment()` (1) |
| `PaymentEventDedupStore` | `has` | `providerEventId: string` | `boolean` | `webhook()` (1) |
|  | `record` | `providerEventId: string` | `void` | `webhook()` (1) |
| `RefundIdempotencyStore` | `get` | `key: string` | `Refund \| undefined` | `refund()` (1) |
|  | `set` | `key: string, refund: Refund` | `void` | `refund()` (1) |

### Main-state repositories

| Port | Method | Parameters | Return | FinanceService call sites (approx.) |
| --- | --- | --- | --- | --- |
| `LedgerRepository` | `append` | `entry: LedgerEntry` | `void` | `post()` (1) |
|  | `listByWallet` | `walletId: string` | `readonly LedgerEntry[]` | `balance()` (1) |
|  | `listAll` | none | `readonly LedgerEntry[]` | `post()`, `getEntries()` (2) |
| `WalletRepository` | `getById` | `walletId: string` | `Wallet \| undefined` | `balance()`, `available()` (2) |
|  | `save` | `wallet: Wallet` | `Wallet` | `createWallet()` (1) |
| `HoldRepository` | `getById` | `holdId: string` | `Hold \| undefined` | `release()`, `capture()` (2) |
|  | `save` | `hold: Hold` | `Hold` | `hold()`, `release()`, `capture()` (3) |
|  | `listActiveByWallet` | `walletId: string` | `readonly Hold[]` | `available()` (1) |
|  | `count` | none | `number` | `hold()` (1) |
| `OrderRepository` | `getById` | `orderId: string` | `Order \| undefined` | `webhook()`, `cancel()`, `getOrder()` (3) |
|  | `save` | `order: Order` | `Order` | `createOrder()`, `webhook()`, `cancel()` (3) |
| `PaymentRepository` | `getById` | `paymentId: string` | `Payment \| undefined` | `webhook()`, `refund()`, `getPayment()` (3) |
|  | `save` | `payment: Payment` | `Payment` | `createPayment()`, `webhook()` (2) |
| `RefundRepository` | `getById` | `refundId: string` | `Refund \| undefined` | none currently (0) |
|  | `save` | `refund: Refund` | `Refund` | `refund()` (1) |
|  | `listByPayment` | `paymentId: string` | `readonly Refund[]` | `refund()` (1) |
|  | `count` | none | `number` | `refund()` (1) |
| `InventoryReservationRepository` | `getByItemId` | `itemId: string` | `InventoryReservation \| undefined` | none currently (0) |
|  | `reserve` | `reservation: InventoryReservation` | `void` | `reserve()` (1) |
|  | `release` | `itemId: string` | `void` | none currently (0) |

The unused `getById` / `getByItemId` methods are part of the current extracted contracts but do not have FinanceService callers. PostgreSQL adapters should not expand their public surface merely because a database makes additional queries convenient.

## 2. FinanceService call graph and async propagation

| Public method | Current port call graph | Async classification | Reason |
| --- | --- | --- | --- |
| `createWallet()` | `WalletRepository.save()` | A — must become async | Persisting a wallet requires database I/O. |
| `balance()` | `WalletRepository.getById()` → `LedgerRepository.listByWallet()` | A | Both existence lookup and ledger read become database I/O. |
| `available()` | `balance()` → `HoldRepository.listActiveByWallet()` → `WalletRepository.getById()` | A | It calls the asynchronous `balance()` and queries holds. |
| `credit()` | `post()` → `LedgerIdempotencyStore.get()` → `LedgerRepository.listAll()` → `LedgerRepository.append()` → `LedgerIdempotencyStore.set()` | A | The idempotency check and append must be durable. |
| `debit()` | `available()` → `post()` | A | It relies on asynchronous balance/hold reads and a durable append. |
| `hold()` | `HoldIdempotencyStore.get()` → `available()` → `HoldRepository.count()` → `HoldRepository.save()` → `HoldIdempotencyStore.set()` | A | Requires a transactional availability check and state write. |
| `release()` | `HoldRepository.getById()` → `HoldRepository.save()` | A | Hold lookup/transition are database operations. |
| `capture()` | `HoldRepository.getById()` → `HoldRepository.save()` → `post()` | A | Hold transition and ledger append need one transaction. |
| `createOrder()` | `OrderIdempotencyStore.get()` → `OrderRepository.save()` → `OrderIdempotencyStore.set()` | A | Both idempotency and order persistence become database I/O. |
| `reserve()` | `InventoryReservationRepository.reserve()` | A | PostgreSQL must atomically claim the item. |
| `createPayment()` | `PaymentIdempotencyStore.get()` → `PaymentRepository.save()` → `PaymentIdempotencyStore.set()` | A | Payment/idempotency persistence requires I/O. |
| `webhook()` | `PaymentProvider.verifyWebhook()` → `PaymentEventDedupStore.has()` → `PaymentRepository.getById()` → `PaymentEventDedupStore.record()` → `PaymentRepository.save()` → `OrderRepository.getById()` → `OrderRepository.save()` | B — already async, but must await ports | Provider verification is already asynchronous; all repository calls will also require `await`. |
| `refund()` | `RefundIdempotencyStore.get()` → `PaymentRepository.getById()` → `RefundRepository.listByPayment()` → `RefundRepository.count()` → `RefundRepository.save()` → `RefundIdempotencyStore.set()` | A | Concurrent database reads/writes require a transaction. |
| `cancel()` | `OrderRepository.getById()` → `OrderRepository.save()` | A | Order lookup/transition require database I/O. |
| `getOrder()` | `OrderRepository.getById()` | A | It is a database read. |
| `getPayment()` | `PaymentRepository.getById()` | A | It is a database read. |
| `getEntries()` | `LedgerRepository.listAll()` | A | It is a database read. |

`post()` is private but is also A: it is called by `credit()`, `debit()`, and `capture()` and will await the ledger/idempotency ports. There are no FinanceService methods that can safely remain synchronous once repositories are real; **16 currently synchronous public methods must become async**, while `webhook()` remains async and gains awaited storage calls.

## 3. Breaking surface

The immediate breaking surface is `packages/payments/test/finance.test.ts`: it contains 25 tests and calls `createWallet`, `balance`, `available`, `credit`, `debit`, `hold`, `release`, `capture`, `createOrder`, `reserve`, `createPayment`, `refund`, `cancel`, `getOrder`, `getPayment`, and `getEntries` synchronously. Approximately 80–100 call expressions will need `await` or awaited assertion callbacks after conversion. Existing direct `new FinanceService(...)` constructions also need to use the async-capable in-memory adapters.

No other production caller was found in the inspected payment package. Cross-package callers must nevertheless be searched immediately before each migration commit; the current public API itself is a broad breaking surface.

## 4. Idempotency persistence recommendation

**Recommendation: B — replace the six in-memory stores in production with one scoped persistent idempotency primitive, while keeping typed service-facing adapters during migration.**

The existing Prisma model `IdempotencyRecord` already establishes `@@unique([scope, key])`. A persistent port should reserve or retrieve a record by a fixed scope such as `LEDGER`, `HOLD`, `ORDER`, `PAYMENT`, `PAYMENT_EVENT`, or `REFUND`, inside the same transaction as its business effect. It needs a durable entity type/reference (not merely an optional `entityId`) to reload the typed original result. It should also retain or add a payload fingerprint before treating a repeated key as equivalent.

The current six narrow interfaces should not be collapsed blindly in the domain before that primitive exists. During transition, typed adapters can delegate to the scoped primitive. `PaymentEventDedupStore` is related but remains semantically distinct: its durable uniqueness must be provider-aware, not only `providerEventId` if different providers can emit the same identifier.

## 5. Required transaction boundaries

### Ledger and wallet

`LedgerRepository.append()` is an append-only `INSERT` in PostgreSQL. It must participate in the caller's transaction for `capture()`, debit/hold workflows, payment settlement, and future refunds. A successful ledger entry must not be committed separately from the state transition that justified it.

`Wallet` has no authoritative balance field in the source model. For P0, use **A — aggregate ledger entries in a query**, then subtract active holds in the same transaction where availability matters. A materialized balance or cache may be introduced later only as a non-authoritative optimization with reconciliation; it is not safe as the first persistent implementation.

### Holds

The minimum transaction boundary for `hold()` is: durable idempotency claim → lock/serialize the wallet's available-funds decision → create active hold → complete idempotency record → audit. `release()` needs hold load and valid state transition in one transaction. `capture()` requires hold load/valid transition → append purchase ledger entry → audit in **one** transaction. The current sequence transitions a hold before appending the ledger and is not rollback-safe until this boundary exists.

### Order and inventory reservation

For an inventory order, the minimum boundary is: validate/retrieve immutable pricing snapshot and inventory item → atomically reserve the item → persist the order (and its items) → persist idempotency/audit → commit. This prevents one inventory item from being sold by two orders and ensures an order never points at a reservation that failed to persist.

The current `FinanceService.reserve()` is a separate item-only operation and has no owner/order linkage or FinanceService release path. It must not be represented as a production order-reservation workflow unchanged.

### Payment webhook

Current exact flow:

`verifyWebhook` → event dedup lookup → payment lookup → event record → payment transition → order lookup/transition → audit → return.

Verification happens outside the database transaction. After verification, event claim/deduplication, payment lookup and validated transition, payment event persistence, payment update, order update, ledger effect when the relevant business flow requires it, and audit must be in **one database transaction**. Provider amount/currency reconciliation must occur before status transition. A duplicate event must resolve to the prior durable result without repeating effects.

### Refund

Current exact flow:

`RefundIdempotencyStore.get` → payment lookup → previous refunds lookup → maximum validation → refund create → idempotency set → audit.

The payment read, previous-refund aggregate, maximum validation, refund insert, idempotency completion, and audit need one transaction with a lock or serialization primitive on the payment/refund set. Without it, two concurrent requests can both observe available refundable value and exceed the payment amount. This audit does not add a ledger effect for refunds.

## 6. Inventory reservation atomic primitive

Use a future **atomic reserve command** implemented by a Prisma/PostgreSQL adapter, not `getByItemId()` followed by `reserve()` in application code. The recommended implementation is: begin transaction → lock the `InventoryItem` row with parameterized `SELECT ... FOR UPDATE` (or a safe equivalent conditional update) → validate `AVAILABLE` and absence of an active reservation → insert reservation → update the necessary item state → commit.

The schema's ordinary `@@index([inventoryItemId, status])` is not exclusive. Add a PostgreSQL partial unique index for one `ACTIVE` reservation per inventory item in a reviewed migration, or use the locked item state as the authoritative exclusion. A partial unique constraint is not directly represented by Prisma schema annotations and will require a deliberate migration SQL step. The lock and state validation remain necessary to coordinate the inventory lifecycle.

## 7. Conversion order in low-risk micro-commits

1. Define the async finance transaction/context abstraction and repository composition contract; retain all existing in-memory adapters as test doubles.
2. Convert the scoped idempotency primitive plus typed adapters and tests. Do not yet remove typed behavior.
3. Convert wallet, ledger, and hold ports together, then convert `createWallet`, balances, credit/debit, hold, release, and capture to async.
4. Convert inventory reservation and order ports together, then make reservation/order creation transactional and async.
5. Convert payment, payment-event dedup, and order transition paths together; migrate `webhook()` to await durable work in one transaction.
6. Convert refund plus refund idempotency with a locked/serialized payment-refund boundary.
7. Implement Prisma adapters, integration tests against a dedicated PostgreSQL database, and only then retire any production in-memory composition.

Converting repositories one by one without grouping their workflow dependencies would leave temporary flows that mix asynchronous durable reads with synchronous in-memory decisions. The grouped order reduces that risk.

## 8. Transaction abstraction recommendation

**SIM.** Introduce a small finance-scoped `FinanceTransactionManager` before Prisma adapters are wired into application workflows. Conceptually:

```ts
interface FinanceTransactionManager {
  withTransaction<T>(work: (repositories: FinanceRepositories) => Promise<T>): Promise<T>;
}
```

`FinanceRepositories` is a finite finance-only set of transaction-bound ports, not a cross-domain generic repository. The Prisma implementation creates one `Prisma.TransactionClient`, binds its finance adapters to that client, and invokes `work`. The in-memory implementation can execute the callback directly for unit tests, while rollback tests require a dedicated transactional test double. This prevents FinanceService from importing Prisma and prevents each repository from starting an independent transaction.

## 9. Prisma compatibility gaps

### Models that substantially support a future repository

- `Wallet`, `LedgerEntry`, `WalletHold`, `Order`, `OrderItem`, `Payment`, `PaymentEvent`, `Refund`, `InventoryItem`, `InventoryReservation`, and `IdempotencyRecord` exist.
- `Wallet.userId`, `LedgerEntry.idempotencyKey`, `WalletHold.idempotencyKey`, `Order.idempotencyKey`, `Payment.idempotencyKey`, `Refund.idempotencyKey`, and `Payment(provider, providerReference)` have useful uniqueness constraints.
- `LedgerEntry(walletId, createdAt)`, `Order(userId, status)`, and `InventoryReservation(inventoryItemId, status)` have useful read indexes.
- `packages/database/src/index.ts` exposes `getPrisma()`, `disconnectPrisma()`, and `withTransaction()`. Its `withTransaction()` currently passes `Prisma.TransactionClient` and is suitable as infrastructure, not as a domain dependency.

### Schema/model mismatches and missing constraints

1. `WalletHold.status` uses `ReservationStatus` (`ACTIVE`, `RELEASED`, `CONSUMED`, `EXPIRED`), while FinanceService uses `ACTIVE`, `RELEASED`, `CAPTURED`. A mapped state policy or schema update is required.
2. FinanceService `Order` is materially smaller than the Prisma `Order`, which requires `operationType`, `total`, and a persisted `PricingSnapshot` relation. The in-memory `OrderItem` includes fees, discount, final price, source, and item-level snapshot identity not represented fully by Prisma `OrderItem`.
3. FinanceService `Payment.providerPaymentId` maps conceptually to Prisma `providerReference`; adapter mapping must be explicit. `PaymentEvent.providerEventId` is globally unique, whereas cross-provider safety may require `@@unique([provider, providerEventId])` or a provider field on the event.
4. FinanceService `Refund.status` is `COMPLETED`; Prisma `Refund.status` uses `PaymentStatus`, which does not include `COMPLETED`. This is incompatible without a dedicated refund status or explicit mapping.
5. `InventoryReservation.expiresAt` is required in Prisma, but the in-memory reservation only has `itemId`. Prisma also permits `orderId` to be null and lacks a unique active-reservation constraint.
6. `IdempotencyRecord` lacks `entityType`, payload fingerprint, and completed-result metadata sufficient to reload a typed prior result safely. Existing per-entity `idempotencyKey` uniqueness is global and does not model all current scopes.
7. No finance `AuditRepository` or direct AuditLog adapter exists; `FinanceService.audit` is only an in-memory string array.
8. Schema foreign-key choices must be re-reviewed before migrations: finance history should not be removed through a user deletion cascade. `Wallet.user` currently uses `onDelete: Cascade`.
9. Identifier generation currently depends on `listAll().length` / `count()`. PostgreSQL adapters must use database-generated IDs; this cannot be retained safely under concurrency.

Operations that will likely need parameterized raw SQL or an equivalent reviewed PostgreSQL primitive are inventory row locking / partial active-reservation uniqueness and potentially wallet/payment locking for aggregate-sensitive hold/refund decisions. Raw SQL must never interpolate application input.

## 10. Risks

### P0

1. Non-atomic `capture()` can persist a captured hold without its required ledger entry, or the converse after partial failure.
2. Non-atomic payment-webhook handling can duplicate or lose payment/order/ledger/audit effects.
3. Refund aggregate validation is vulnerable to concurrent over-refund without payment/refund locking or serializable isolation.
4. Item-only in-memory reservation is process-local and has no production-safe double-sale protection.
5. Non-durable idempotency and event deduplication permit duplicate money movement after restart or across containers.

### P1

1. Payment-event uniqueness is not provider-scoped in the existing schema.
2. Order/OrderItem schema does not preserve all in-memory pricing/item fields required by historical operations.
3. `WalletHold` and `Refund` enum incompatibilities can corrupt or block state mapping.
4. No persistent finance audit adapter exists.

### P2

1. Ledger balance aggregation may need a reconciled non-authoritative read model after correctness is validated at scale.
2. Positional FinanceService constructor makes dependency composition error-prone; a typed options object can be considered after async conversion.
3. Expiration/release lifecycle for inventory reservations remains unspecified in the in-memory finance model.

## 11. Next recommended micro-step

Create only the async **finance transaction/composition contracts** and async in-memory test-double interfaces, without Prisma adapters or schema changes. This establishes one transaction-bound repository set before any public FinanceService method becomes asynchronous, avoiding a temporary design where cross-repository financial effects use unrelated transactions.
