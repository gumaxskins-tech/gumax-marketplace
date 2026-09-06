# Finance P0 Prisma mapping decisions

## 1. Executive decision

This document approves the mappings that can be derived without changing finance behavior. `Hold` is **SCHEMA_CHANGE_PREPARED**: its approved enum and read-index migration artifacts exist, but its adapter and PostgreSQL validation remain pending. `Refund` is **APPROVED_WITH_SCHEMA_CHANGE**. `Order` and `InventoryReservation` are **BLOCKED_BY_DOMAIN_DECISION** because required semantics are absent from the current FinanceService domain and cannot be safely guessed.

No runtime code, Prisma schema, adapter, or migration is changed by these decisions. P0-A1 remains incomplete until durable PostgreSQL adapters, transactions, constraints, and migrations exist.

## 2. Order mapping

### Current model and divergence

The domain `Order` has `id`, `userId`, `currency`, `status`, `idempotencyKey`, `pricingSnapshotId`, and immutable `items`. Each `OrderItem` has `skinVariantId`, `quantity`, `unitPrice`, `fees`, `discount`, `finalPrice`, `pricingSnapshotId`, `source` (`INVENTORY` or `ORDER`), and optional `inventoryItemId`.

Prisma `Order` has a required `operationType` and `total` that the domain does not expose. Prisma `OrderItem` stores only `unitPrice` and optional `inventoryItemId`; it lacks the domain item snapshot, fees, discount, final price, currency, and source. `Sale.inventoryItemId` is not an `InventoryItem` relation.

### Approved subordinate mappings

| Domain field | Prisma target | Nullable | Immutable after creation | Decision |
| --- | --- | --- | --- | --- |
| `Order.id`, `userId`, `currency`, `idempotencyKey` | existing `Order` fields | no | yes except status | Direct |
| `Order.pricingSnapshotId` | existing `Order.pricingSnapshotId` → `PricingSnapshot.id` | no | yes | Direct FK; never recalculate pricing |
| `OrderItem.unitPrice.amount` | existing `OrderItem.unitPrice` `Decimal(20,8)` | no | yes | Decimal converter |
| `OrderItem` currency | new non-null `OrderItem.currency` | no | yes | Required for lossless `Money` persistence rather than relying on an unstated equality invariant |
| `fees`, `discount`, `finalPrice` | new non-null decimal fields on `OrderItem` | no | yes | Preserve the historical item calculation |
| `OrderItem.pricingSnapshotId` | new non-null FK to `PricingSnapshot` | no | yes | Preserve the item-level immutable snapshot reference |
| `OrderItem.source` | new `OrderItemSource` enum with exactly `INVENTORY`, `ORDER` | no | yes | Do not infer source from price or skin identity |
| `OrderItem.inventoryItemId` | existing nullable field plus `InventoryItem` FK | conditional | yes | Required only for `INVENTORY` |
| domain `Order.total` absent | existing required `Order.total` | no | yes | Compute once as `sum(finalPrice × quantity)` during persistence; this is a stored snapshot, not a later recalculation |

`PricingSnapshot` is the existing historical model and remains the authoritative persisted snapshot. Its `input`, `output`, market values, exchange rate, and rule-version relationship are retained by its existing row. The Order adapter must only reference it; it must never consult pricing again.

### INVENTORY versus ENCOMENDA

The approved representation is item-level `OrderItemSource`: `INVENTORY` maps to the real `InventoryItem.id`; `ORDER` is encomenda and maps to `inventoryItemId = NULL`. A PostgreSQL CHECK constraint is required: `(source = 'INVENTORY' AND inventory_item_id IS NOT NULL) OR (source = 'ORDER' AND inventory_item_id IS NULL)`. No skin name, market identifier, price, or Order ID can substitute for the inventory identity.

### BLOCKED_BY_DOMAIN_DECISION

`Order.operationType` is required by Prisma, but FinanceService exposes no equivalent field. `INVENTORY` and `ORDER` are fulfillment sources, not evidence that the commercial operation is `PURCHASE`, `SALE`, `UPGRADE`, or `DOWNGRADE`. The adapter must not write an invented operation type. The domain owner must define the value or approve making the existing Prisma field optional before the Order adapter or its migration is implemented.

**Status: BLOCKED_BY_DOMAIN_DECISION.** The subordinate snapshot/source mapping above is approved, but the full Order mapping cannot be implemented until `operationType` is decided.

## 3. Hold mapping

| Domain | Prisma | Direction | Conversion | Lossless | Notes |
| --- | --- | --- | --- | --- | --- |
| `id` | `WalletHold.id` | both | direct | yes | UUID/string |
| `walletId` | `WalletHold.walletId` | both | direct FK | yes | Wallet owns Hold; Wallet never gains a balance |
| `amount.amount`, `amount.currency` | `amount`, `currency` | both | Decimal + currency enum | yes | Never use JS `number` |
| `ACTIVE` | `ReservationStatus.ACTIVE` | both | direct | yes | |
| `RELEASED` | `ReservationStatus.RELEASED` | both | direct | yes | |
| `CAPTURED` | new `ReservationStatus.CAPTURED` | both | enum addition | yes | Do not map to `CONSUMED`; meanings are not proven equivalent |
| `idempotencyKey` | existing field | both | direct | yes | Scoped idempotency remains separate |
| domain creation moment | `createdAt` | DB → domain | `Date` | yes | Domain does not currently expose it |
| domain expiry absent | `expiresAt = NULL` | domain → DB | null | yes | No expiry policy is introduced |

Add `@@index([walletId, status])` for `listActiveByWallet(walletId)`. The capture boundary must mutate `WalletHold.status`, append `LedgerEntry`, and complete ledger idempotency using the same transaction client. `CONSUMED` and `EXPIRED` are unsupported reads for the current adapter and must be rejected or handled only after a future domain decision.

**Status: SCHEMA_CHANGE_PREPARED.** `CAPTURED` is added to `ReservationStatus` and `@@index([walletId, status])` is prepared by the focused Hold migration. The migration is additive: existing hold rows retain their current lifecycle value and require no backfill. `PrismaHoldRepository`, PostgreSQL migration execution, and integration validation remain pending.

## 4. Refund mapping

| Domain | Prisma | Direction | Conversion | Lossless | Notes |
| --- | --- | --- | --- | --- | --- |
| `id`, `paymentId`, `idempotencyKey` | existing `Refund` fields | both | direct | yes | Payment FK retained |
| `amount.amount`, `amount.currency` | `amount`, `currency` | both | Decimal + currency enum | yes | `Decimal(20,8)`, no JS float |
| `COMPLETED` | new `RefundStatus.COMPLETED` | both | new enum and field type | yes | Exact domain status, not a Payment status |
| creation moment | `createdAt` | DB → domain | `Date` | yes | Domain does not currently expose it |

Replace the Prisma `Refund.status PaymentStatus` field type with a dedicated `RefundStatus` enum containing `COMPLETED`. Add `@@index([paymentId])` for `listByPayment(paymentId)` and the accumulated-refund aggregate. `RefundIdempotencyStore` remains a separate scoped idempotency concern.

The refund transaction reads the Payment, serializes/locks the Payment plus refund aggregate, validates the cumulative amount, inserts the Refund, and completes refund idempotency. This phase deliberately adds no ledger entry, Wallet credit, provider refund, or settlement status.

**Status: APPROVED_WITH_SCHEMA_CHANGE.**

## 5. InventoryReservation mapping

### Strategy finalized

The exclusivity strategy is approved: one PostgreSQL transaction locks the target `InventoryItem` row (or performs a safe conditional update from `AVAILABLE`), validates its state, inserts an active reservation, persists the Order and idempotency result, and commits. A PostgreSQL partial unique index is a mandatory backstop:

```sql
UNIQUE (inventory_item_id) WHERE status = 'ACTIVE'
```

Prisma schema annotations cannot express that partial unique index; **RAW SQL MIGRATION REQUIRED**. `find` followed by `insert` is not safe.

### BLOCKED_BY_DOMAIN_DECISION

The current domain reservation contains only `itemId`. It has no reservation ID, order/owner identity, expiry, or foreign-release rule, while Prisma requires `expiresAt` and has an unenforced scalar `orderId`. The current `createOrder()` reserves before saving but does not pass an owner to the repository. Defining how release verifies ownership and how expiry works would create domain behavior not present today.

The next domain decision must define reservation ownership (`orderId` or an explicit reservation ID) and expiry semantics. The resulting schema must make `orderId` a real `Order` FK, keep `INVENTORY` order items tied to the same `InventoryItem`, and permit a released reservation to be followed by a new active reservation. Until then, the transaction/partial-index strategy is approved but the repository mapping is not.

**Status: BLOCKED_BY_DOMAIN_DECISION.**

## 6. Enum mapping decisions

| Domain enum/value | Prisma mapping | Migration needed | Risk |
| --- | --- | --- | --- |
| Hold `ACTIVE` | `ReservationStatus.ACTIVE` | no | none |
| Hold `RELEASED` | `ReservationStatus.RELEASED` | no | none |
| Hold `CAPTURED` | add `ReservationStatus.CAPTURED` | yes | must not silently become `CONSUMED` |
| Refund `COMPLETED` | add `RefundStatus.COMPLETED`; change `Refund.status` type | yes | current `PaymentStatus` is semantically wrong |
| Item source `INVENTORY` / `ORDER` | add `OrderItemSource` with exactly those values | yes | preserves fulfillment distinction |
| Order statuses | current exact literals need schema enum reconciliation | yes, blocked with `operationType` decision | lossless Order persistence is blocked |
| Reservation lifecycle | existing `ACTIVE` / `RELEASED` are usable | depends on blocked owner/expiry policy | do not invent `CAPTURED` reservation semantics |

Two of four P0 domain mappings are fully resolved (Hold and Refund); Order and InventoryReservation remain blocked.

## 7. Decimal/money mapping

All P0 amount fields map to existing or approved `Decimal(20,8)` columns and explicit `Currency` values. Converter rule: domain `Decimal` serializes to Prisma Decimal from its exact decimal string and deserializes from Prisma Decimal string; no intermediate `Number` is permitted. The required `OrderItem.currency` addition resolves the only losslessness gap for item-level money values.

## 8. Nullability rules

| Field | Rule | Enforcement |
| --- | --- | --- |
| `Order.pricingSnapshotId` | always present | existing non-null FK |
| `OrderItem.pricingSnapshotId` | always present | new non-null FK |
| `OrderItem.inventoryItemId` | non-null only when source is `INVENTORY` | new PostgreSQL CHECK plus FK |
| `InventoryReservation.orderId` | cannot be approved until ownership is decided | pending domain decision; then non-null FK for order-created reservations |
| `InventoryReservation.expiresAt` | cannot be filled with invented value | pending expiry decision |
| `WalletHold.expiresAt` | null for current domain holds | existing nullable field |

## 9. P0 database invariants

| Invariant | App enforced | DB enforced | State |
| --- | --- | --- | --- |
| Wallet has no authoritative mutable balance | yes | model has no balance field | BOTH |
| Ledger entry is append-only | yes | no adapter/update API yet | PENDING |
| Hold belongs to a Wallet | yes | existing FK | BOTH |
| Active holds are found by wallet | yes | composite index prepared | SCHEMA_CHANGE_PREPARED |
| Refund belongs to a Payment | yes | existing FK | BOTH |
| Refund amount preserves Decimal/currency | yes | existing decimal/currency columns | BOTH |
| Inventory item has at most one active reservation | yes in shared memory | partial unique index + transaction lock pending | PENDING |
| `INVENTORY` item references actual inventory and `ORDER` item does not | yes | source enum/FK/CHECK pending | PENDING |
| Order historical pricing is never recalculated | yes | snapshot/item persistence mapping pending | PENDING |

## 10. Required indexes and constraints

1. `ReservationStatus.CAPTURED` and `@@index([walletId, status])` are prepared by the Hold migration.
2. Add `RefundStatus.COMPLETED` and change `Refund.status` to that enum.
3. Add `@@index([walletId, status])` to `WalletHold`.
4. Add `@@index([paymentId])` to `Refund`.
5. Add OrderItem snapshot, money, currency, and source fields plus the item `PricingSnapshot` and `InventoryItem` FKs.
6. Add `OrderItemSource(INVENTORY, ORDER)` and the source/inventory nullability CHECK.
7. Add `InventoryReservation.orderId` → `Order.id` FK after ownership is defined.
8. Add one-active-reservation partial unique index by raw SQL.

## 11. Raw SQL requirements

The active-reservation partial unique index requires raw SQL in a reviewed PostgreSQL migration. The conditional source/inventory CHECK is also PostgreSQL SQL if Prisma schema support is insufficient for the chosen Prisma version. Row locking/conditional inventory-state update belongs in the future adapter/transaction manager, not in this decision document.

## 12. Domain ↔ Prisma converters

| Domain | Prisma | Direction | Conversion required? | Lossless? | Notes |
| --- | --- | --- | --- | --- | --- |
| `Hold` | `WalletHold` | both | Decimal, enum, `Date` | yes after schema change | `expiresAt` reads as absent domain policy |
| `Refund` | `Refund` | both | Decimal, dedicated enum, `Date` | yes after schema change | no settlement mapping |
| `Order` | `Order` + `OrderItem` + `PricingSnapshot` | both | Decimal, readonly item array, enum, nested snapshot IDs | no until blocked fields resolved | no pricing lookup on read or transition |
| reservation `{itemId}` | `InventoryReservation` | both | lifecycle/owner/expiry | no | blocked; do not fabricate defaults |

## 13. Updated 13-port status

| Status | Ports |
| --- | --- |
| READY (1) | `WalletRepository` |
| PARTIAL (10) | `LedgerRepository`, `HoldRepository`, `PaymentRepository`, `RefundRepository`, all five typed idempotency stores, `PaymentEventDedupStore` |
| DESIGN_DECISION_REQUIRED (2) | `OrderRepository`, `InventoryReservationRepository` |
| MISSING (0) | none |

## 14. Updated P0 schema gaps

All seven P0 gaps remain until migrations and adapters are implemented. Decisions resolve the ambiguity for Hold and Refund but do not remove their required schema changes. The seven are: exclusive inventory reservation; reservation owner/expiry/FK lifecycle; lossless Order/OrderItem snapshot persistence; Hold `CAPTURED`; Refund `COMPLETED`; typed idempotency result integrity; and provider-event identity.

## 15. Refined migration sequence

1. **Finance enum and Order snapshot prerequisites** — add Hold/Refund/source enums, OrderItem history/source fields, snapshot/inventory FKs, and resolve the blocked `Order.operationType` mapping. Risk: historical data semantics.
2. **Scoped idempotency and provider-event prerequisites** — make completed-result integrity enforceable and settle provider event identity. Risk: duplicate effects.
3. **Inventory reservation integrity** — add approved owner/expiry fields and FKs after the domain decision, then add partial active-reservation unique index by raw SQL. Depends on migrations 1–2. Risk: double-sell.
4. **Finance read/index prerequisites** — add active-hold and payment-refund indexes. Depends on enum changes. Risk: low correctness/high query cost.
5. **Transaction-scoped audit persistence** — add the audit mapping only after the finance audit port is approved. Risk: incomplete audit history.

## 16. Approved next micro-step

Implement `PrismaWalletRepository` using the existing `Wallet` model and a transaction-scoped Prisma client; no schema prerequisite blocks this port.
