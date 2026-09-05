# Wallet and ledger

The immutable ledger is the balance source of truth. Credits, debits, releases and purchases are append-only entries keyed idempotently; balances are reconstructed from entries. Holds reduce available balance but do not mutate the ledger balance. Corrections require a new adjustment entry.

Database persistence must use a single transaction, unique idempotency indexes, and row locks for holds/reservations. The in-memory domain service is a deterministic reference implementation.
