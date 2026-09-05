# Payment flow

Payments are provider-neutral intents with idempotency keys. Webhook events store provider event IDs and verified timestamps. The API must verify a signed webhook and atomically advance payment and order state before supplier acquisition is authorized.
