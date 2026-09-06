# Finance persistence

Completed: ledger, hold, order, payment and refund idempotency extraction, plus payment event/webhook deduplication, each behind an explicit in-memory adapter for tests. P0-A1.1a is complete: all six idempotency/deduplication mechanisms are decoupled from FinanceService. LedgerRepository is also extracted and currently uses an in-memory adapter; it is not PostgreSQL persistence.

Pending: wallet, hold, order, payment, refund and inventory-reservation storage; an async repository boundary; Prisma adapters; and PostgreSQL transactions. The extracted stores remain in-memory adapters; persistent database uniqueness is pending. P0-A1 is not complete.
