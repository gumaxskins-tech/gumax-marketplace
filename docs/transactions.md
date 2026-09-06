# Transactions
Critical workflows run in one PostgreSQL transaction. Inventory reservation locks the item, verifies `AVAILABLE`, records an idempotency record and inserts its reservation. Payment webhooks deduplicate first, then transition payment/order and append ledger/audit effects atomically.
