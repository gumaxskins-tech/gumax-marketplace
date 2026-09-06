import assert from "node:assert/strict";
import test from "node:test";
import { money } from "../../pricing/src/index.ts";
import {
  PrismaLedgerRepository,
  type LedgerDomainEntry,
  type LedgerPrismaClient,
  type LedgerPrismaCreate,
  type LedgerPrismaEntry,
} from "../src/ledger-repository.ts";

const entry = (overrides: Partial<LedgerDomainEntry> = {}): LedgerDomainEntry => ({
  id: "entry",
  walletId: "wallet",
  type: "CREDIT",
  amount: money("12.3456789", "BRL"),
  referenceType: "PAYMENT",
  referenceId: "payment",
  idempotencyKey: "ledger-key",
  createdAt: new Date("2026-01-02T03:04:05.000Z"),
  metadata: Object.freeze({ source: "test" }),
  ...overrides,
});

const toRow = (data: LedgerPrismaCreate): LedgerPrismaEntry => ({
  ...data,
  amount: { toString: () => data.amount },
});

const toPrismaEntry = (domain: LedgerDomainEntry): LedgerPrismaCreate => ({
  id: domain.id,
  walletId: domain.walletId,
  type: domain.type,
  amount: domain.amount.amount.toString(),
  currency: domain.amount.currency,
  idempotencyKey: domain.idempotencyKey,
  referenceType: domain.referenceType,
  referenceId: domain.referenceId,
  metadata: domain.metadata ? { ...domain.metadata } : null,
  createdAt: domain.createdAt,
});

const client = (
  rows: LedgerPrismaEntry[] = [],
  created: LedgerPrismaCreate[] = [],
): LedgerPrismaClient => ({
  ledgerEntry: {
    async create({ data }) {
      created.push(data);
      const row = toRow(data);
      rows.push(row);
      return row;
    },
    async findMany({ where }) {
      return rows
        .filter((row) => where === undefined || row.walletId === where.walletId)
        .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id));
    },
  },
});

test("PrismaLedgerRepository appends a lossless Prisma mapping", async () => {
  const created: LedgerPrismaCreate[] = [];
  const repository = new PrismaLedgerRepository(client([], created));

  await repository.append(entry());

  assert.deepEqual(created, [{
    id: "entry",
    walletId: "wallet",
    type: "CREDIT",
    amount: "12.3456789",
    currency: "BRL",
    idempotencyKey: "ledger-key",
    referenceType: "PAYMENT",
    referenceId: "payment",
    metadata: { source: "test" },
    createdAt: new Date("2026-01-02T03:04:05.000Z"),
  }]);
});

test("PrismaLedgerRepository lists and reconstructs wallet entries deterministically", async () => {
  const early = toRow({ ...toPrismaEntry(entry({ id: "b" })), createdAt: new Date("2026-01-01T00:00:00.000Z") });
  const later = toRow({ ...toPrismaEntry(entry({ id: "a" })), createdAt: new Date("2026-01-02T00:00:00.000Z") });
  const unrelated = toRow(toPrismaEntry(entry({ id: "other", walletId: "other" })));
  const repository = new PrismaLedgerRepository(client([later, unrelated, early]));

  const entries = await repository.listByWallet("wallet");

  assert.deepEqual(entries.map((item) => item.id), ["b", "a"]);
  assert.equal(entries[0]?.amount.amount.toString(), "12.3456789");
  assert.equal(entries[0]?.amount.currency, "BRL");
  assert.equal(entries[0]?.type, "CREDIT");
  assert.deepEqual(entries[0]?.metadata, { source: "test" });
});

test("PrismaLedgerRepository lists all entries without a mutable balance surface", async () => {
  const prisma = client([toRow(toPrismaEntry(entry()))]);
  const repository = new PrismaLedgerRepository(prisma);
  assert.equal("update" in repository, false);
  assert.equal("delete" in repository, false);
  assert.equal("upsert" in repository, false);
  assert.equal("update" in prisma.ledgerEntry, false);
  assert.equal("delete" in prisma.ledgerEntry, false);
  assert.equal("upsert" in prisma.ledgerEntry, false);
  assert.equal((await repository.listAll()).length, 1);
});

test("PrismaLedgerRepository works with a transaction-like client", async () => {
  const txLike = { ledgerEntry: client().ledgerEntry };
  assert.equal("$transaction" in txLike, false);
  assert.equal("$connect" in txLike, false);
  assert.equal("$disconnect" in txLike, false);

  const repository = new PrismaLedgerRepository(txLike);
  await repository.append(entry());

  assert.equal((await repository.listByWallet("wallet")).length, 1);
});

test("PrismaLedgerRepository propagates Prisma create and read errors", async () => {
  const repository = new PrismaLedgerRepository({
    ledgerEntry: {
      async create() {
        throw Error("prisma create failed");
      },
      async findMany() {
        throw Error("prisma read failed");
      },
    },
  });

  await assert.rejects(repository.append(entry()), /prisma create failed/);
  await assert.rejects(repository.listByWallet("wallet"), /prisma read failed/);
});
