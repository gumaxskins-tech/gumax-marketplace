# Pricing engine

## Architecture

`PricingEngine` depends only on `MarketDataProvider` and `ExchangeRateProvider` ports. The production YouPin adapter is intentionally not implemented: no official configured API contract is available. `MockMarketDataProvider` and `MockExchangeRateProvider` provide deterministic local/test data.

All financial values are an internal fixed-point `Decimal` (eight fractional digits) and never JavaScript floating point. A `PricingRuleVersion` supplies every commercial percentage and threshold. The engine produces an immutable `PricingSnapshot`, containing rule identity, observations, seven-day analysis, liquidity, exchange rate when used, input values and output. A snapshot is a historical record and cannot be changed by later rule versions.

## Formulas

- **Inventory:** current market reference price; final price is never lower than acquisition cost × (1 + configured inventory-risk margin).
- **Supplier order:** CNY market price × persisted CNY/BRL rate × (1 + configured order markup).
- **Buy / upgrade / downgrade valuation:** current price × (1 − configured liquidity-class discount) × (1 − explicit risk adjustment).
- **Risk margin protection:** a versioned minimum offer can floor, send for review, or block a purchase offer.

## Seven-day market and liquidity

The engine requests the last seven days and calculates min, max, arithmetic average, median, variation, fixed-point volatility and volume when every observation exposes it. Liquidity combines configurable weights for traded volume, price stability and availability, yielding a 0–100 score. Every band threshold (low, medium, liquid, and very-liquid) is stored in the versioned rule configuration; the default policy can therefore use 0–19 illiquid, 20–39 low, 40–59 medium, 60–79 liquid, and 80–100 very liquid without embedding thresholds in domain code.

Inventory and supplier orders deliberately remain separate: supplier foreign-exchange markup never replaces live pricing for assets already owned by Gumax.

- `MarketSnapshot` is an immutable provider observation and supports a seven-day evaluation window.
- `MarketPrice` is the latest provider price projection.
- `LiquidityAssessment` records score, band, inputs and the applied rule version.
- `PricingRuleVersion` holds admin-managed configuration and `PricingSnapshot` captures every financial evaluation.

Inventory pricing and supplier pricing are separate paths. Inventory uses current market price plus margin protection and acquisition-cost floor. Supplier orders use CNY market price × persisted RMB/BRL rate × (1 + versioned markup). The Stage 2 engine will make a transaction fail closed when input freshness, rule version, or currency data is unavailable.

## Provider setup

Configure a real YouPin adapter only after its supported credentials/API contract are available. The adapter is injected through `MarketDataProvider`; development uses a deterministic mock. No provider URL or credential is committed here.
