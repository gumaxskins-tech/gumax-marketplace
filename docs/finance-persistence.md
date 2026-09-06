# Finance persistence

Completed: ledger, hold, order, payment and refund idempotency extraction, plus payment event/webhook deduplication, each behind an explicit in-memory adapter for tests. P0-A1.1a is complete: all six idempotency/deduplication mechanisms are decoupled from FinanceService. LedgerRepository, WalletRepository, HoldRepository, OrderRepository and PaymentRepository are also extracted and currently use in-memory adapters; they are not PostgreSQL persistence. Wallet balance remains derived from the ledger.

Pending: refund and inventory-reservation storage; an async repository boundary; Prisma adapters; and PostgreSQL transactions. Webhook event deduplication, payment/order transitions and `capture()` have no PostgreSQL transaction atomicity yet. The extracted stores remain in-memory adapters; persistent database uniqueness is pending. P0-A1 is not complete.
