# Finance persistence

Completed: ledger, hold, order and payment idempotency extraction, plus payment event/webhook deduplication, each behind an explicit in-memory adapter for tests.

Pending: refund idempotency, main financial state persistence, transactional persistence and Prisma adapters. Payment event deduplication remains an in-memory adapter; persistent database uniqueness is pending. P0-A1 is not complete.
