# Idempotency
`IdempotencyRecord` persists `(scope, key)` uniqueness for orders, payments, webhooks, wallets, trades, operations and settlements. A repeated request returns the recorded outcome; it never repeats a financial or state-changing effect.
