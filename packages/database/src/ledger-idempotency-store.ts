import { randomUUID } from "node:crypto";
import {
  toDomainLedgerEntry,
  type LedgerDomainEntry,
  type LedgerPrismaEntry,
} from "./ledger-repository.ts";

export type LedgerIdempotencyClaim =
  | { readonly kind: "CLAIMED"; readonly key: string; readonly claimId: string }
  | { readonly kind: "COMPLETED"; readonly entry: LedgerDomainEntry }
  | { readonly kind: "IN_PROGRESS"; readonly key: string; readonly claimId: string };

export interface LedgerIdempotencyPrismaRecord {
  id: string;
  status: string;
  ledgerEntry: LedgerPrismaEntry | null;
}

export interface LedgerIdempotencyPrismaDelegate {
  createMany(args: {
    data: {
      id: string;
      scope: "LEDGER";
      key: string;
      entityId: null;
      ledgerEntryId: null;
      status: "PENDING";
    };
    skipDuplicates: true;
  }): Promise<{ count: number }>;
  findUnique(args: {
    where: { scope_key: { scope: "LEDGER"; key: string } };
    include: { ledgerEntry: true };
  }): Promise<LedgerIdempotencyPrismaRecord | null>;
  updateMany(args: {
    where: {
      id: string;
      scope: "LEDGER";
      key: string;
      status: "PENDING";
      ledgerEntryId: null;
    };
    data: { status: "COMPLETED"; ledgerEntryId: string; entityId: null };
  }): Promise<{ count: number }>;
}

export interface LedgerIdempotencyPrismaClient {
  idempotencyRecord: LedgerIdempotencyPrismaDelegate;
}

const scope = "LEDGER" as const;

export class PrismaLedgerIdempotencyStore {
  private readonly prisma: LedgerIdempotencyPrismaClient;

  constructor(prisma: LedgerIdempotencyPrismaClient) {
    this.prisma = prisma;
  }

  async claim(key: string): Promise<LedgerIdempotencyClaim> {
    const claimId = randomUUID();
    const result = await this.prisma.idempotencyRecord.createMany({
      data: {
        id: claimId,
        scope,
        key,
        entityId: null,
        ledgerEntryId: null,
        status: "PENDING",
      },
      skipDuplicates: true,
    });

    if (result.count === 1) return { kind: "CLAIMED", key, claimId };

    const record = await this.findRecord(key);
    if (!record) throw new Error("Ledger idempotency claim disappeared");
    if (record.status === "COMPLETED") {
      if (!record.ledgerEntry) throw new Error("Completed ledger idempotency claim has no result");
      return { kind: "COMPLETED", entry: toDomainLedgerEntry(record.ledgerEntry) };
    }
    return { kind: "IN_PROGRESS", key, claimId: record.id };
  }

  async complete(
    claim: Extract<LedgerIdempotencyClaim, { kind: "CLAIMED" }>,
    entry: LedgerDomainEntry,
  ): Promise<LedgerDomainEntry> {
    if (entry.idempotencyKey !== claim.key) throw new Error("Ledger idempotency key mismatch");

    const result = await this.prisma.idempotencyRecord.updateMany({
      where: {
        id: claim.claimId,
        scope,
        key: claim.key,
        status: "PENDING",
        ledgerEntryId: null,
      },
      data: { status: "COMPLETED", ledgerEntryId: entry.id, entityId: null },
    });
    if (result.count === 1) return entry;

    const record = await this.findRecord(claim.key);
    if (!record) throw new Error("Ledger idempotency claim is missing");
    if (record.status !== "COMPLETED" || !record.ledgerEntry) {
      throw new Error("Ledger idempotency claim is not completable");
    }
    const original = toDomainLedgerEntry(record.ledgerEntry);
    if (original.id !== entry.id) throw new Error("Ledger idempotency result mismatch");
    return original;
  }

  private async findRecord(key: string): Promise<LedgerIdempotencyPrismaRecord | null> {
    return this.prisma.idempotencyRecord.findUnique({
      where: { scope_key: { scope, key } },
      include: { ledgerEntry: true },
    });
  }
}
