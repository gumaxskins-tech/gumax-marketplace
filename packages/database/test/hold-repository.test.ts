import assert from "node:assert/strict";
import test from "node:test";
import { money } from "../../pricing/src/index.ts";
import {
  PrismaHoldRepository,
  type HoldDomain,
  type HoldPrismaClient,
  type HoldPrismaCreate,
  type HoldPrismaRow,
} from "../src/hold-repository.ts";

const hold = (overrides: Partial<HoldDomain> = {}): HoldDomain => ({
  id: "hold-1",
  walletId: "wallet-1",
  amount: money("12.3456789", "BRL"),
  status: "ACTIVE",
  idempotencyKey: "hold-key-1",
  ...overrides,
});

const toRow = (data: HoldPrismaCreate): HoldPrismaRow => ({
  ...data,
  amount: { toString: () => data.amount },
  createdAt: new Date("2026-09-06T00:00:00.000Z"),
});

const client = (rows: HoldPrismaRow[] = [], calls = { findMany: [] as unknown[], upsert: [] as unknown[] }): HoldPrismaClient => ({
  walletHold: {
    async findUnique({ where }) {
      return rows.find((row) => row.id === where.id) ?? null;
    },
    async findMany(args) {
      calls.findMany.push(args);
      return rows.filter((row) => row.walletId === args.where.walletId && row.status === args.where.status);
    },
    async upsert(args) {
      calls.upsert.push(args);
      const index = rows.findIndex((row) => row.id === args.where.id);
      const persisted = index === -1
        ? toRow(args.create)
        : toRow({ id: args.where.id, ...args.update });
      if (index === -1) rows.push(persisted); else rows[index] = persisted;
      return persisted;
    },
    async count() { return rows.length; },
  },
});

test("PrismaHoldRepository maps a Hold by id and returns undefined when absent", async () => {
  const repository = new PrismaHoldRepository(client([
    toRow({
      id: "hold-1", walletId: "wallet-1", amount: "12.3456789", currency: "BRL",
      status: "ACTIVE", idempotencyKey: "hold-key-1", expiresAt: null,
    }),
  ]));

  const found = await repository.getById("hold-1");
  assert.equal(found?.id, "hold-1");
  assert.equal(found?.amount.amount.toString(), "12.3456789");
  assert.equal(found?.amount.currency, "BRL");
  assert.equal(found?.status, "ACTIVE");
  assert.equal(await repository.getById("missing"), undefined);
});

test("PrismaHoldRepository filters active Holds in Prisma and preserves their mapping", async () => {
  const calls = { findMany: [] as unknown[], upsert: [] as unknown[] };
  const repository = new PrismaHoldRepository(client([
    toRow({ id: "active", walletId: "wallet-1", amount: "2.5", currency: "USD", status: "ACTIVE", idempotencyKey: "a", expiresAt: null }),
    toRow({ id: "released", walletId: "wallet-1", amount: "3", currency: "USD", status: "RELEASED", idempotencyKey: "r", expiresAt: null }),
  ], calls));

  const active = await repository.listActiveByWallet("wallet-1");

  assert.deepEqual(active.map((item) => item.id), ["active"]);
  assert.deepEqual(calls.findMany, [{ where: { walletId: "wallet-1", status: "ACTIVE" } }]);
});

test("PrismaHoldRepository save preserves create and replacement semantics including RELEASED and CAPTURED", async () => {
  const rows: HoldPrismaRow[] = [];
  const calls = { findMany: [] as unknown[], upsert: [] as unknown[] };
  const repository = new PrismaHoldRepository(client(rows, calls));

  await repository.save(hold());
  const released = await repository.save(hold({ status: "RELEASED" }));
  const captured = await repository.save(hold({ status: "CAPTURED", amount: money("7.25", "CNY") }));

  assert.equal(await repository.count(), 1);
  assert.equal(released.status, "RELEASED");
  assert.equal(captured.status, "CAPTURED");
  assert.equal(captured.amount.amount.toString(), "7.25");
  assert.equal(captured.amount.currency, "CNY");
  assert.equal(calls.upsert.length, 3);
  assert.equal("balance" in captured, false);
});

test("PrismaHoldRepository works with a transaction-like client only", async () => {
  const txLike = { walletHold: client().walletHold };
  assert.equal("$transaction" in txLike, false);
  assert.equal("$connect" in txLike, false);
  assert.equal("$disconnect" in txLike, false);

  const repository = new PrismaHoldRepository(txLike);
  await repository.save(hold());
  assert.equal((await repository.listActiveByWallet("wallet-1")).length, 1);
});

test("PrismaHoldRepository propagates Prisma read and write errors", async () => {
  const repository = new PrismaHoldRepository({
    walletHold: {
      async findUnique() { throw Error("prisma read failed"); },
      async findMany() { throw Error("prisma read failed"); },
      async upsert() { throw Error("prisma write failed"); },
      async count() { throw Error("prisma read failed"); },
    },
  });

  await assert.rejects(repository.getById("hold-1"), /prisma read failed/);
  await assert.rejects(repository.listActiveByWallet("wallet-1"), /prisma read failed/);
  await assert.rejects(repository.save(hold()), /prisma write failed/);
});
