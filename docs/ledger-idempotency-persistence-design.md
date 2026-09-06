# Ledger idempotency persistence design

## 1. Decision

**Approved design:** retain the generic `IdempotencyRecord(scope, key)` uniqueness, use the canonical fixed scope `LEDGER`, and add a nullable-during-transaction, typed `ledgerEntryId` foreign key to `LedgerEntry`. A PostgreSQL transaction claims the `(LEDGER, key)` record before appending the ledger row, then completes that same record with the immutable ledger result before commit.

This is the Ledger pilot for a future scoped idempotency foundation. It does not change any current runtime port or schema in this decision-only step.

## 2. Current blocker and schema facts

`IdempotencyRecord` currently has:

| Field or constraint | Current state |
| --- | --- |
| `id` | UUID primary key |
| `scope`, `key` | strings with `@@unique([scope, key])` |
| `entityId` | nullable, untyped string with no FK |
| `status` | `PENDING`, `COMPLETED`, `FAILED` |
| `metadata`, `createdAt`, `expiresAt` | nullable JSON, creation timestamp, nullable expiry |
| indexes | unique `(scope, key)` and `createdAt` |

`LedgerEntry` has a UUID primary key, wallet FK, append-only financial fields, unique `idempotencyKey`, `createdAt`, and `@@index([walletId, createdAt])`. It has no current relationship to `IdempotencyRecord`.

The current generic `entityId` cannot safely identify the original Ledger result: it is optional, has no entity type, and has no referential integrity. The current `get → append → set` sequence is therefore rejected for production: the append can occur before an idempotency conflict is observed.

## 3. Required invariants

For each `(scope = 'LEDGER', key = K)`:

1. Exactly one transaction may append a LedgerEntry.
2. A completed record must reference exactly one existing LedgerEntry whose `idempotencyKey` equals `K`.
3. A completed result cannot be replaced by another LedgerEntry.
4. A failed transaction leaves neither a LedgerEntry nor a durable Ledger claim.
5. A duplicate caller observes the winning LedgerEntry and must not append another row.

The application and database both enforce these invariants: the application uses only claim/complete through one transaction client; the database retains unique key protection, adds the typed FK, and uses transaction-end triggers for Ledger-specific lifecycle checks.

## 4. Approved claim/complete contract

The future Ledger-specific port replaces `get()` and `set()` in one coordinated runtime migration; it does not keep those methods on the persistent implementation.

```ts
type LedgerIdempotencyClaim =
  | { readonly kind: "CLAIMED"; readonly key: string; readonly claimId: string }
  | { readonly kind: "COMPLETED"; readonly entry: LedgerEntry }
  | { readonly kind: "IN_PROGRESS"; readonly key: string; readonly claimId: string };

interface LedgerIdempotencyStore {
  claim(key: string): Promise<LedgerIdempotencyClaim>;
  complete(
    claim: Extract<LedgerIdempotencyClaim, { kind: "CLAIMED" }>,
    entry: LedgerEntry,
  ): Promise<LedgerEntry>;
}
```

`CLAIMED` authorizes exactly one append in the current transaction. `COMPLETED` returns the original, losslessly reconstructed LedgerEntry. `IN_PROGRESS` is a safe failure/retry state for an invalid legacy or manually committed pending row; the caller must not append. In the approved transaction boundary, normal concurrent callers do not observe a committed `PENDING` row.

`complete()` verifies that the claim is still pending, the supplied entry uses the same idempotency key, and the row was appended with the same transaction client. A repeated complete for the same result reads and returns that result without mutation; a complete for a different result fails. The method never changes a completed result.

## 5. PostgreSQL concurrency and lifecycle

`claim()` uses `IdempotencyRecord.createMany({ skipDuplicates: true })` with `scope = 'LEDGER'`, `status = PENDING`, and no result reference. PostgreSQL implements the duplicate suppression through its real `(scope, key)` unique index without a unique-violation exception that would abort the transaction.

- `count = 1`: this transaction owns the claim and returns `CLAIMED`.
- `count = 0`: it reads the same `(scope, key)` record. After a normal competing transaction commits, it is `COMPLETED` and the adapter loads the referenced LedgerEntry. If a malformed committed pending row exists, it returns `IN_PROGRESS` and performs no append.

Under PostgreSQL `READ COMMITTED`, an `INSERT ... ON CONFLICT DO NOTHING` waits for a conflicting uncommitted insert. If the winner commits after `complete()`, the loser reads `COMPLETED`; if the winner rolls back, the waiting transaction inserts and becomes `CLAIMED`. This avoids the transaction-aborting unique-violation path of a plain Prisma `create()`.

The approved lifecycle is `PENDING → COMPLETED` entirely inside one PostgreSQL transaction. `PENDING` is physically necessary after claim and before the Ledger insert, but it must never be committed by a valid finance boundary. A crash, exception, or rollback after claim or after append but before complete rolls back both rows.

## 6. Typed result and schema delta

The future migration changes only the generic record as needed for this pilot:

```text
IdempotencyRecord
  + ledgerEntryId String? @unique
  + ledgerEntry LedgerEntry? @relation("LedgerIdempotencyResult", fields: [ledgerEntryId], references: [id], onDelete: Restrict)

LedgerEntry
  + ledgerIdempotencyResults IdempotencyRecord[] @relation("LedgerIdempotencyResult")
```

`entityId` remains for legacy/non-Ledger scopes and is not read or written for `LEDGER`. The current `@@unique([scope, key])` remains unchanged. `ledgerEntryId` is nullable only while a valid transaction has a pending claim; its unique constraint prevents one LedgerEntry from becoming the result of multiple records.

A raw SQL migration is required for deferred constraint triggers because Prisma schema annotations cannot express all required cross-row and commit-time invariants. For `scope = 'LEDGER'`, the triggers must:

1. reject commit unless status is `COMPLETED`, `ledgerEntryId` is non-null, and `entityId` is null;
2. require the referenced `LedgerEntry.idempotencyKey` to equal `IdempotencyRecord.key`;
3. prohibit every mutation that changes a completed Ledger record or its result reference.

A plain CHECK constraint is not sufficient because it cannot inspect `LedgerEntry` or defer the `PENDING` validation until transaction commit. No partial unique index is needed: the existing unique `(scope, key)` is the claim key. Prisma schema can express the field, relation, and unique constraint; `Prisma.TransactionClient` is sufficient for the runtime operations. The raw SQL triggers are the only migration feature Prisma cannot model.

## 7. Rollback and immutability semantics

The future `PrismaFinanceTransactionManager` must invoke `claim`, ledger append, and `complete` with adapters constructed from the same `Prisma.TransactionClient`. It must not call external services inside this boundary.

If any operation fails, the transaction rolls back. Thus no orphan LedgerEntry and no durable claim survive a failed finance operation. The deferred trigger rejects any accidental transaction commit containing a Ledger `PENDING` record. After completion, application conditional writes and the database trigger jointly preserve result immutability.

## 8. Migration and backfill considerations

The migration is non-destructive only after data preflight. Existing non-Ledger records are unaffected. For existing `scope = 'LEDGER'` rows, a backfill may copy a valid legacy `entityId` into `ledgerEntryId` only when it references an existing LedgerEntry whose `idempotencyKey` equals the record key.

Rows with a null, missing, ambiguous, or mismatched legacy reference cannot be guessed. They must be remediated or quarantined before enabling the Ledger lifecycle trigger. Do not assume production data is empty. The nullable field is added first; preflight and backfill occur before installing the commit-time trigger.

## 9. FinanceService migration impact

The affected current call graph has five functions: `postWithContext()`, `post()`, `credit()`, `debit()`, and `capture()`.

The future `postWithContext()` flow becomes:

```text
claim key
→ COMPLETED: return original entry
→ CLAIMED: validate amount
→ append LedgerEntry
→ complete claim with that entry
→ return entry
```

`capture()` already has a Hold + Ledger transaction boundary and will use this flow with its supplied transaction context. `credit()` and `debit()` must later run through `FinanceTransactionManager.run()` too; otherwise their claim and append cannot be atomic. This is a remaining P0 integration gap, not work in this decision step.

## 10. Future test plan

Unit tests (5): claim winner; completed-result retrieval; complete immutability; transaction-client-only composition; and read/write error propagation.

PostgreSQL integration tests (6): two concurrent same-key operations; exactly one LedgerEntry; both callers converge to the same entry; rollback after claim; rollback after append before complete; and independent success for different keys.

## 11. Rejected alternatives

- `get → append → set`: rejected because the append precedes durable claim conflict detection.
- Plain Prisma `create()` followed by unique-error recovery: rejected because a PostgreSQL unique violation aborts the transaction unless a separate valid recovery boundary is used.
- Generic nullable `entityId`: rejected because it does not identify or protect a typed original result.
- JSON snapshot of LedgerEntry: rejected because it duplicates financial history instead of referencing the append-only source of truth.
- A separate Ledger idempotency model: rejected because the approved generic `(scope, key)` foundation should be retained; the Ledger-specific FK makes its result typed without duplicating claim infrastructure.

## 12. Exact next micro-step

P0-A1.3g: alter `schema.prisma` and prepare the first P0 migration for `IdempotencyRecord.ledgerEntryId`, its LedgerEntry relation, and the deferred Ledger lifecycle triggers described above.
