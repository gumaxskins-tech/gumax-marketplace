# Pricing engine

The pricing engine is introduced in Stage 2. Its persistent foundation already exists:

- `MarketSnapshot` is an immutable provider observation and supports a seven-day evaluation window.
- `MarketPrice` is the latest provider price projection.
- `LiquidityAssessment` records score, band, inputs and the applied rule version.
- `PricingRuleVersion` holds admin-managed configuration and `PricingSnapshot` captures every financial evaluation.

Inventory pricing and supplier pricing are separate paths. Inventory uses current market price plus margin protection and acquisition-cost floor. Supplier orders use CNY market price × persisted RMB/BRL rate × (1 + versioned markup). The Stage 2 engine will make a transaction fail closed when input freshness, rule version, or currency data is unavailable.

## Provider setup

Configure a real YouPin adapter only after its supported credentials/API contract are available. The adapter is injected through `MarketDataProvider`; development uses a deterministic mock. No provider URL or credential is committed here.
