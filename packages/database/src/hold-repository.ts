import { money, type Currency, type Money } from "../../pricing/src/index.ts";

export type HoldStatus = "ACTIVE" | "RELEASED" | "CAPTURED";

export interface HoldDomain {
  id: string;
  walletId: string;
  amount: Money;
  status: HoldStatus;
  idempotencyKey: string;
}

export interface HoldPrismaRow {
  id: string;
  walletId: string;
  amount: { toString(): string };
  currency: string;
  status: string;
  idempotencyKey: string;
  expiresAt: Date | null;
  createdAt: Date;
}

export interface HoldPrismaCreate {
  id: string;
  walletId: string;
  amount: string;
  currency: Currency;
  status: HoldStatus;
  idempotencyKey: string;
  expiresAt: null;
}

export interface HoldPrismaUpdate {
  walletId: string;
  amount: string;
  currency: Currency;
  status: HoldStatus;
  idempotencyKey: string;
  expiresAt: null;
}

export interface HoldPrismaDelegate {
  findUnique(args: { where: { id: string } }): Promise<HoldPrismaRow | null>;
  findMany(args: { where: { walletId: string; status: "ACTIVE" } }): Promise<readonly HoldPrismaRow[]>;
  upsert(args: {
    where: { id: string };
    create: HoldPrismaCreate;
    update: HoldPrismaUpdate;
  }): Promise<HoldPrismaRow>;
  count(): Promise<number>;
}

export interface HoldPrismaClient {
  walletHold: HoldPrismaDelegate;
}

const currencies = new Set<Currency>(["BRL", "CNY", "USD"]);
const statuses = new Set<HoldStatus>(["ACTIVE", "RELEASED", "CAPTURED"]);

const toCurrency = (value: string): Currency => {
  if (!currencies.has(value as Currency)) throw new Error(`Unsupported hold currency: ${value}`);
  return value as Currency;
};

const toStatus = (value: string): HoldStatus => {
  if (!statuses.has(value as HoldStatus)) throw new Error(`Unsupported hold status: ${value}`);
  return value as HoldStatus;
};

export const toDomainHold = (row: HoldPrismaRow): HoldDomain => ({
  id: row.id,
  walletId: row.walletId,
  amount: money(row.amount.toString(), toCurrency(row.currency)),
  status: toStatus(row.status),
  idempotencyKey: row.idempotencyKey,
});

const toCreate = (hold: HoldDomain): HoldPrismaCreate => ({
  id: hold.id,
  walletId: hold.walletId,
  amount: hold.amount.amount.toString(),
  currency: hold.amount.currency,
  status: hold.status,
  idempotencyKey: hold.idempotencyKey,
  expiresAt: null,
});

const toUpdate = (hold: HoldDomain): HoldPrismaUpdate => {
  const { id: _id, ...data } = toCreate(hold);
  return data;
};

export class PrismaHoldRepository {
  private readonly prisma: HoldPrismaClient;

  constructor(prisma: HoldPrismaClient) {
    this.prisma = prisma;
  }

  async getById(holdId: string): Promise<HoldDomain | undefined> {
    const hold = await this.prisma.walletHold.findUnique({ where: { id: holdId } });
    return hold ? toDomainHold(hold) : undefined;
  }

  async save(hold: HoldDomain): Promise<HoldDomain> {
    return toDomainHold(await this.prisma.walletHold.upsert({
      where: { id: hold.id },
      create: toCreate(hold),
      update: toUpdate(hold),
    }));
  }

  async listActiveByWallet(walletId: string): Promise<readonly HoldDomain[]> {
    const holds = await this.prisma.walletHold.findMany({
      where: { walletId, status: "ACTIVE" },
    });
    return holds.map(toDomainHold);
  }

  async count(): Promise<number> {
    return this.prisma.walletHold.count();
  }
}
