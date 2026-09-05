/** Domain primitives intentionally independent from HTTP, Prisma, and providers. */
export type Currency = "BRL" | "CNY" | "USD";
export type ActorRole = "USER" | "SUPPORT" | "OPERATOR" | "FINANCE" | "RISK" | "ADMIN" | "SUPER_ADMIN";
export type Money = Readonly<{ amount: string; currency: Currency }>;
export type VersionedConfiguration = Readonly<{ ruleVersionId: string; effectiveAt: Date }>;
export type RequestContext = Readonly<{ requestId: string; actorId?: string; ipAddress?: string }>;

export interface MarketDataPoint {
  skinVariantId: string;
  price: Money;
  observedAt: Date;
  volume?: number;
  availability?: number;
}

export interface MarketDataProvider {
  getCurrentPrice(skinVariantId: string): Promise<MarketDataPoint | null>;
  getHistory(skinVariantId: string, from: Date, to: Date): Promise<readonly MarketDataPoint[]>;
}

