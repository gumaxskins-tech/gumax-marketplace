/** Provider-agnostic, fixed-point pricing domain. */
export type Currency = "BRL" | "CNY" | "USD";
export type PricingOperation = "INVENTORY" | "ORDER" | "BUY" | "UPGRADE" | "DOWNGRADE";
export type RiskMarginAction = "FLOOR" | "REVIEW" | "BLOCK";
const SCALE = 100_000_000n;

export class Decimal {
  private readonly value: bigint;
  private constructor(value: bigint) { this.value = value; }
  static from(value: Decimal | string): Decimal { if (value instanceof Decimal) return value; if (!/^-?\d+(\.\d+)?$/.test(value)) throw new Error(`Invalid decimal: ${value}`); const negative = value.startsWith("-"); const [whole, fraction = ""] = (negative ? value.slice(1) : value).split("."); if (fraction.length > 8) throw new Error("Decimal supports at most 8 fractional digits"); const units = BigInt(whole ?? "0") * SCALE + BigInt((fraction + "00000000").slice(0, 8)); return new Decimal(negative ? -units : units); }
  static zero(): Decimal { return new Decimal(0n); }
  add(other: Decimal | string): Decimal { return new Decimal(this.value + Decimal.from(other).value); }
  subtract(other: Decimal | string): Decimal { return new Decimal(this.value - Decimal.from(other).value); }
  multiply(other: Decimal | string): Decimal { return new Decimal(this.value * Decimal.from(other).value / SCALE); }
  divide(other: Decimal | string): Decimal { const divisor = Decimal.from(other).value; if (!divisor) throw new Error("Division by zero"); return new Decimal(this.value * SCALE / divisor); }
  compare(other: Decimal | string): number { const difference = this.value - Decimal.from(other).value; return difference === 0n ? 0 : difference > 0n ? 1 : -1; }
  max(other: Decimal | string): Decimal { return this.compare(other) >= 0 ? this : Decimal.from(other); }
  isNegative(): boolean { return this.value < 0n; }
  toString(): string { const negative = this.value < 0n; const raw = (negative ? -this.value : this.value).toString().padStart(9, "0"); const fraction = raw.slice(-8).replace(/0+$/, ""); return `${negative ? "-" : ""}${raw.slice(0, -8)}${fraction ? `.${fraction}` : ""}`; }
}
export type Money = Readonly<{ amount: Decimal; currency: Currency }>;
export const money = (amount: Decimal | string, currency: Currency): Money => Object.freeze({ amount: Decimal.from(amount), currency });
const sameCurrency = (...values: Money[]) => { if (new Set(values.map((value) => value.currency)).size !== 1) throw new Error("Currency mismatch"); };

export interface MarketDataPoint { skinVariantId: string; price: Money; observedAt: Date; volume?: number; availability?: number; }
export interface MarketDataProvider { getCurrentPrice(skinVariantId: string): Promise<MarketDataPoint | null>; getHistory(skinVariantId: string, from: Date, to: Date): Promise<readonly MarketDataPoint[]>; }
export interface ExchangeRate { baseCurrency: Currency; quoteCurrency: Currency; rate: Decimal; observedAt: Date; provider: string; }
export interface ExchangeRateProvider { getRate(base: Currency, quote: Currency, at: Date): Promise<ExchangeRate | null>; }
export class MockMarketDataProvider implements MarketDataProvider {
  private readonly data: readonly MarketDataPoint[];
  constructor(data: readonly MarketDataPoint[]) { this.data = data; }
  async getCurrentPrice(id: string): Promise<MarketDataPoint | null> { return this.data.filter((point) => point.skinVariantId === id).sort((a, b) => b.observedAt.getTime() - a.observedAt.getTime())[0] ?? null; }
  async getHistory(id: string, from: Date, to: Date): Promise<readonly MarketDataPoint[]> { return this.data.filter((point) => point.skinVariantId === id && point.observedAt >= from && point.observedAt <= to).sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime()); }
}
export class MockExchangeRateProvider implements ExchangeRateProvider {
  private readonly rates: readonly ExchangeRate[];
  constructor(rates: readonly ExchangeRate[]) { this.rates = rates; }
  async getRate(base: Currency, quote: Currency, at: Date): Promise<ExchangeRate | null> { return this.rates.filter((rate) => rate.baseCurrency === base && rate.quoteCurrency === quote && rate.observedAt <= at).sort((a, b) => b.observedAt.getTime() - a.observedAt.getTime())[0] ?? null; }
}

export interface MarketSnapshot { periodStart: Date; periodEnd: Date; sampleCount: number; minimum: Money; maximum: Money; average: Money; median: Money; variation: Decimal; volatility: Decimal; totalVolume?: number; }
const averageOf = (values: readonly Decimal[]) => values.reduce((sum, value) => sum.add(value), Decimal.zero()).divide(String(values.length));
/** Analyses exactly the points supplied by the seven-day query. */
export function analyzeMarketHistory(points: readonly MarketDataPoint[], periodStart: Date, periodEnd: Date): MarketSnapshot {
  if (!points.length) throw new Error("Market history is required"); sameCurrency(...points.map((point) => point.price)); const values = points.map((point) => point.price.amount); const sorted = [...values].sort((a, b) => a.compare(b)); const average = averageOf(values); const middle = Math.floor(sorted.length / 2); const median = sorted.length % 2 ? sorted[middle]! : sorted[middle - 1]!.add(sorted[middle]!).divide("2"); const minimum = sorted[0]!; const maximum = sorted.at(-1)!; const variance = averageOf(values.map((value) => value.subtract(average).multiply(value.subtract(average))));
  // Newton iteration over Decimal makes standard deviation repeatable without floats.
  let root = variance.compare("0") === 0 ? Decimal.zero() : Decimal.from("1"); for (let i = 0; i < 32 && root.compare("0") !== 0; i++) root = root.add(variance.divide(root)).divide("2");
  const volumeAvailable = points.every((point) => point.volume !== undefined); const totalVolume = volumeAvailable ? points.reduce((sum, point) => sum + (point.volume ?? 0), 0) : undefined; const currency = points[0]!.price.currency;
  return Object.freeze({ periodStart, periodEnd, sampleCount: points.length, minimum: money(minimum, currency), maximum: money(maximum, currency), average: money(average, currency), median: money(median, currency), variation: minimum.compare("0") === 0 ? Decimal.zero() : maximum.subtract(minimum).divide(minimum), volatility: average.compare("0") === 0 ? Decimal.zero() : root.divide(average), ...(totalVolume === undefined ? {} : { totalVolume }) });
}

export interface LiquidityRule { volumeWeight: number; stabilityWeight: number; availabilityWeight: number; volumeTarget: number; availabilityTarget: number; lowAt: number; mediumAt: number; liquidAt: number; veryLiquidAt: number; }
export interface LiquidityAssessment { score: number; band: "ILLIQUID" | "LOW" | "MEDIUM" | "LIQUID" | "VERY_LIQUID"; inputs: Readonly<{ volumeScore: number; stabilityScore: number; availabilityScore: number }>; ruleVersionId: string; }
const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));
export function assessLiquidity(snapshot: MarketSnapshot, availability: number | undefined, rule: LiquidityRule, ruleVersionId: string): LiquidityAssessment { if (rule.volumeTarget <= 0 || rule.availabilityTarget <= 0) throw new Error("Liquidity targets must be positive"); const volumeScore = clamp((snapshot.totalVolume ?? 0) / rule.volumeTarget * 100); const stabilityScore = clamp(100 - Number(snapshot.variation.multiply("100").toString())); const availabilityScore = clamp((availability ?? 0) / rule.availabilityTarget * 100); const totalWeight = rule.volumeWeight + rule.stabilityWeight + rule.availabilityWeight; if (totalWeight <= 0) throw new Error("Liquidity weights must be positive"); const score = clamp((volumeScore * rule.volumeWeight + stabilityScore * rule.stabilityWeight + availabilityScore * rule.availabilityWeight) / totalWeight); const band = score >= rule.veryLiquidAt ? "VERY_LIQUID" : score >= rule.liquidAt ? "LIQUID" : score >= rule.mediumAt ? "MEDIUM" : score >= rule.lowAt ? "LOW" : "ILLIQUID"; return Object.freeze({ score, band, inputs: Object.freeze({ volumeScore, stabilityScore, availabilityScore }), ruleVersionId }); }

export interface PricingConfiguration { inventoryRiskMargin: Decimal; orderMarkup: Decimal; liquidPurchaseDiscount: Decimal; illiquidPurchaseDiscount: Decimal; liquidity: LiquidityRule; minimumOffer?: Money; minimumOfferAction: RiskMarginAction; }
export interface PricingRuleVersion { id: string; version: number; configuration: PricingConfiguration; effectiveFrom: Date; }
export interface PricingRequest { operation: PricingOperation; skinVariantId: string; now: Date; acquisitionCost?: Money; riskAdjustment?: Decimal; }
export interface PricingSnapshot { readonly operation: PricingOperation; readonly ruleVersionId: string; readonly ruleVersion: number; readonly calculatedAt: Date; readonly market: Readonly<{ current: MarketDataPoint; history: MarketSnapshot }>; readonly liquidity: LiquidityAssessment; readonly exchangeRate?: ExchangeRate; readonly inputs: Readonly<Record<string, string | undefined>>; readonly output: Money; readonly decision: RiskMarginAction | "ALLOW"; }
export interface PricingResult { referencePrice: Money; finalPrice: Money; pricingSnapshot: PricingSnapshot; }
const freeze = (snapshot: PricingSnapshot) => Object.freeze({ ...snapshot, inputs: Object.freeze({ ...snapshot.inputs }), market: Object.freeze({ ...snapshot.market }) });

export class PricingEngine {
  private readonly market: MarketDataProvider;
  private readonly exchange: ExchangeRateProvider;
  constructor(market: MarketDataProvider, exchange: ExchangeRateProvider) { this.market = market; this.exchange = exchange; }
  async price(request: PricingRequest, rule: PricingRuleVersion): Promise<PricingResult> {
    const current = await this.market.getCurrentPrice(request.skinVariantId); if (!current) throw new Error("Current market price unavailable"); const from = new Date(request.now.getTime() - 604800000); const points = await this.market.getHistory(request.skinVariantId, from, request.now); const history = analyzeMarketHistory(points.length ? points : [current], from, request.now); const liquidity = assessLiquidity(history, current.availability, rule.configuration.liquidity, rule.id); let reference = current.price; let finalPrice = current.price; let rate: ExchangeRate | undefined; let decision: PricingSnapshot["decision"] = "ALLOW";
    if (request.operation === "ORDER") { if (current.price.currency !== "CNY") throw new Error("Supplier order requires CNY market price"); const found = await this.exchange.getRate("CNY", "BRL", request.now); if (!found) throw new Error("CNY/BRL rate unavailable"); rate = found; reference = money(current.price.amount.multiply(rate.rate), "BRL"); finalPrice = money(reference.amount.multiply(Decimal.from("1").add(rule.configuration.orderMarkup)), "BRL"); }
    if (request.operation === "INVENTORY") { if (!request.acquisitionCost) throw new Error("Inventory pricing requires acquisition cost"); sameCurrency(current.price, request.acquisitionCost); const floor = request.acquisitionCost.amount.multiply(Decimal.from("1").add(rule.configuration.inventoryRiskMargin)); finalPrice = money(current.price.amount.max(floor), current.price.currency); }
    if (["BUY", "UPGRADE", "DOWNGRADE"].includes(request.operation)) { const discount = liquidity.score >= rule.configuration.liquidity.liquidAt ? rule.configuration.liquidPurchaseDiscount : rule.configuration.illiquidPurchaseDiscount; finalPrice = money(current.price.amount.multiply(Decimal.from("1").subtract(discount)).multiply(Decimal.from("1").subtract(request.riskAdjustment ?? Decimal.zero())), current.price.currency); if (request.operation === "BUY" && rule.configuration.minimumOffer && rule.configuration.minimumOffer.currency === finalPrice.currency && finalPrice.amount.compare(rule.configuration.minimumOffer.amount) < 0) { decision = rule.configuration.minimumOfferAction; if (decision === "BLOCK") throw new Error("Risk margin protection blocked offer"); if (decision === "FLOOR") finalPrice = rule.configuration.minimumOffer; } }
    const pricingSnapshot = freeze({ operation: request.operation, ruleVersionId: rule.id, ruleVersion: rule.version, calculatedAt: request.now, market: { current, history }, liquidity, ...(rate ? { exchangeRate: rate } : {}), inputs: { marketPrice: current.price.amount.toString(), marketCurrency: current.price.currency, orderMarkup: rule.configuration.orderMarkup.toString(), liquidPurchaseDiscount: rule.configuration.liquidPurchaseDiscount.toString(), illiquidPurchaseDiscount: rule.configuration.illiquidPurchaseDiscount.toString(), acquisitionCost: request.acquisitionCost?.amount.toString(), riskAdjustment: request.riskAdjustment?.toString() }, output: finalPrice, decision }); return Object.freeze({ referencePrice: reference, finalPrice, pricingSnapshot });
  }
}
