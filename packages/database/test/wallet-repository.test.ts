import assert from "node:assert/strict";
import test from "node:test";
import {
  PrismaWalletRepository,
  type WalletPrismaClient,
  type WalletPrismaWallet,
} from "../src/wallet-repository.ts";

const wallet = (
  id = "wallet",
  userId = "user",
  currency: WalletPrismaWallet["currency"] = "BRL",
): WalletPrismaWallet => ({ id, userId, currency });

const client = (rows = new Map<string, WalletPrismaWallet>()): WalletPrismaClient => ({
  wallet: {
    async findUnique({ where }) {
      return rows.get(where.id) ?? null;
    },
    async upsert({ where, create, update }) {
      const persisted = rows.has(where.id)
        ? { ...rows.get(where.id)!, ...update }
        : { ...create };
      rows.set(where.id, persisted);
      return persisted;
    },
  },
});

test("PrismaWalletRepository maps an existing wallet by id", async () => {
  const rows = new Map([["wallet", wallet("wallet", "owner", "CNY")]]);
  const repository = new PrismaWalletRepository(client(rows));

  assert.deepEqual(await repository.getById("wallet"), wallet("wallet", "owner", "CNY"));
});

test("PrismaWalletRepository returns undefined for a missing wallet", async () => {
  assert.equal(await new PrismaWalletRepository(client()).getById("missing"), undefined);
});

test("PrismaWalletRepository saves wallet ownership and currency without a balance", async () => {
  const rows = new Map<string, WalletPrismaWallet>();
  const repository = new PrismaWalletRepository(client(rows));
  const saved = await repository.save(wallet("wallet", "owner", "USD"));

  assert.deepEqual(saved, wallet("wallet", "owner", "USD"));
  assert.deepEqual(rows.get("wallet"), wallet("wallet", "owner", "USD"));
  assert.equal("balance" in saved, false);
});

test("PrismaWalletRepository works with a transaction-like client", async () => {
  const txLike = { wallet: client().wallet };
  assert.equal("$transaction" in txLike, false);
  assert.equal("$connect" in txLike, false);
  assert.equal("$disconnect" in txLike, false);

  const repository = new PrismaWalletRepository(txLike);
  await repository.save(wallet());

  assert.deepEqual(await repository.getById("wallet"), wallet());
});

test("PrismaWalletRepository propagates Prisma delegate errors", async () => {
  const repository = new PrismaWalletRepository({
    wallet: {
      async findUnique() {
        throw Error("prisma unavailable");
      },
      async upsert() {
        throw Error("prisma unavailable");
      },
    },
  });

  await assert.rejects(repository.getById("wallet"), /prisma unavailable/);
  await assert.rejects(repository.save(wallet()), /prisma unavailable/);
});
