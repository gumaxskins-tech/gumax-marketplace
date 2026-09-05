# Order lifecycle

Orders retain item amount, fees, discounts, source, and pricing snapshot ID. Payment webhooks are provider-verified and deduplicated by provider event ID before a payment/order transition. Inventory reservation must be a conditional transactional reservation; an already reserved item is unavailable. Cancellation preserves records and emits an audit event.
