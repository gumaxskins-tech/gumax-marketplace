import { money, type Currency, type Money } from "../../pricing/src/index.ts";

export type LedgerType =
  | "CREDIT"
  | "DEBIT"
  | "HOLD"
  | "RELEASE"
  | "REFUND"
  | "PURCHASE"
  | "SALE"
  | "UPGRADE"
  | "DOWNGRADE"
  | "WITHDRAWAL"
  | "ADJUSTMENT";

export interface LedgerDomainEntry {
  id: string;
  walletId: string;
  type: LedgerType;
  amount: Money;
  referenceType: string;
  referenceId: string;
  idempotencyKey: string;
  createdAt: Date;
  metadata?: Readonly<Record<string, string>>;
}

export interface LedgerPrismaEntry {
  id: string;
  walletId: string;
  type: string;
  amount: { toString(): string };
  currency: string;
  idempotencyKey: string;
  referenceType: string;
  referenceId: string;
  metadata: unknown;
  createdAt: Date;
}

export interface LedgerPrismaCreate {
  id: string;
  walletId: string;
  type: LedgerType;
  amount: string;
  currency: Currency;
  idempotencyKey: string;
  referenceType: string;
  referenceId: string;
  metadata: Record<string, string> | null;
  createdAt: Date;
}

export interface LedgerPrismaDelegate {
  create(args: { data: LedgerPrismaCreate }): Promise<LedgerPrismaEntry>;
  findMany(args: {
    where?: { walletId: string };
    orderBy: readonly [{ createdAt: "asc" }, { id: "asc" }];
  }): Promise<readonly LedgerPrismaEntry[]>;
}

export interface LedgerPrismaClient {
  ledgerEntry: LedgerPrismaDelegate;
}

const ledgerTypes = new Set<LedgerType>([
  "CREDIT", "DEBIT", "HOLD", "RELEASE", "REFUND", "PURCHASE", "SALE",
  "UPGRADE", "DOWNGRADE", "WITHDRAWAL", "ADJUSTMENT",
]);
const currencies = new Set<Currency>(["BRL", "CNY", "USD"]);

const toCurrency = (value: string): Currency => {
  if (!currencies.has(value as Currency)) throw new Error(`Unsupported ledger currency: ${value}`);
  return value as Currency;
};

const toLedgerType = (value: string): LedgerType => {
  if (!ledgerTypes.has(value as LedgerType)) throw new Error(`Unsupported ledger type: ${value}`);
  return value as LedgerType;
};

const toMetadata = (value: unknown): Readonly<Record<string, string>> | undefined => {
  if (value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("Ledger metadata must be a string record");
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.some(([, item]) => typeof item !== "string")) throw new Error("Ledger metadata must be a string record");
  return Object.freeze(Object.fromEntries(entries) as Record<string, string>);
};

const toPrismaEntry = (entry: LedgerDomainEntry): LedgerPrismaCreate => ({
  id: entry.id,
  walletId: entry.walletId,
  type: entry.type,
  amount: entry.amount.amount.toString(),
  currency: entry.amount.currency,
  idempotencyKey: entry.idempotencyKey,
  referenceType: entry.referenceType,
  referenceId: entry.referenceId,
  metadata: entry.metadata ? { ...entry.metadata } : null,
  createdAt: entry.createdAt,
});

export const toDomainLedgerEntry = (entry: LedgerPrismaEntry): LedgerDomainEntry => {
  const metadata = toMetadata(entry.metadata);
  return {
    id: entry.id,
    walletId: entry.walletId,
    type: toLedgerType(entry.type),
    amount: money(entry.amount.toString(), toCurrency(entry.currency)),
    referenceType: entry.referenceType,
    referenceId: entry.referenceId,
    idempotencyKey: entry.idempotencyKey,
    createdAt: entry.createdAt,
    ...(metadata ? { metadata } : {}),
  };
};

const chronologicalOrder = [{ createdAt: "asc" }, { id: "asc" }] as const;

export class PrismaLedgerRepository {
  private readonly prisma: LedgerPrismaClient;

  constructor(prisma: LedgerPrismaClient) {
    this.prisma = prisma;
  }

  async append(entry: LedgerDomainEntry): Promise<void> {
    await this.prisma.ledgerEntry.create({ data: toPrismaEntry(entry) });
  }

  async listByWallet(walletId: string): Promise<readonly LedgerDomainEntry[]> {
    const entries = await this.prisma.ledgerEntry.findMany({
      where: { walletId },
      orderBy: chronologicalOrder,
    });
    return entries.map(toDomainLedgerEntry);
  }

  async listAll(): Promise<readonly LedgerDomainEntry[]> {
    const entries = await this.prisma.ledgerEntry.findMany({ orderBy: chronologicalOrder });
    return entries.map(toDomainLedgerEntry);
  }
}
