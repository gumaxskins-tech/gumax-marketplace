# Commercial operations

BUY, SELL, UPGRADE and DOWNGRADE create idempotent commercial intentions that retain their pricing snapshot. Inventory is reserved before a trade operation is created; Steam execution remains in the Trade Engine. Risk BLOCK prevents creation and REVIEW prevents automatic completion. Cancellation releases reservations unless the operation is already completed.
