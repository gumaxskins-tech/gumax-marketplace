# Finance persistence

Ledger idempotency is now behind `LedgerIdempotencyStore`, with an explicit in-memory adapter for tests. Prisma persistence remains pending. Holds, orders, payments, refunds, webhook deduplication and reservations remain internal stores until later P0-A1 micro-steps.
