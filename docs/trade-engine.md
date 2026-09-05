# Trade engine

Trade processing is isolated from orders. A trade owns its items, events and protection record. Received assets stay in `TRADE_PROTECTED` or `QUARANTINED` until a verified release event changes them to `AVAILABLE`; visual confirmation is never sufficient.
