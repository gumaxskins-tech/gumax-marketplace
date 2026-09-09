import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import { money } from "../../pricing/src/index.ts";
import {
  PrismaCaptureTransactionManager,
  type PrismaCaptureTransactionRunner,
} from "../src/capture-transaction-manager.ts";
import type { PrismaCaptureTransactionClient } from "../src/capture-transaction-resources.ts";

const databaseUrl = process.env.GUMAX_TEST_DATABASE_URL;

if (!databaseUrl) {
  throw new Error(
    "GUMAX_TEST_DATABASE_URL is required for the PostgreSQL capture integration test",
  );
}

test("POSTGRESQL INTEGRATION: capture resources commit on one real transaction", async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const suffix = randomUUID();
  const userId = `capture-user-${suffix}`;
  const walletId = `capture-wallet-${suffix}`;
  const holdId = `capture-hold-${suffix}`;
  const entryId = `capture-entry-${suffix}`;
  const ledgerKey = `capture-ledger-${suffix}`;
  let transactionCalls = 0;
  const delegateAccesses: string[] = [];

  const runner: PrismaCaptureTransactionRunner = {
    async $transaction(operation) {
      transactionCalls += 1;
      return prisma.$transaction(async (realTx) => {
        const tx = new Proxy(realTx, {
          get(target, property, receiver) {
            if (property === "walletHold" || property === "ledgerEntry" || property === "idempotencyRecord") {
              delegateAccesses.push(String(property));
            }
            return Reflect.get(target, property, receiver);
          },
        });
        return operation(tx as PrismaCaptureTransactionClient);
      });
    },
  };
  const manager = new PrismaCaptureTransactionManager(runner);

  try {
    await prisma.user.create({ data: { id: userId, email: `${userId}@example.test` } });
    await prisma.wallet.create({ data: { id: walletId, userId, currency: "BRL" } });
    await prisma.walletHold.create({
      data: {
        id: holdId,
        walletId,
        amount: "12.3456789",
        currency: "BRL",
        status: "ACTIVE",
        idempotencyKey: `capture-hold-key-${suffix}`,
      },
    });

    const firstResult = await manager.run(async (tx) => {
      const hold = await tx.holdRepository.getById(holdId);
      assert.ok(hold);
      assert.equal(hold.status, "ACTIVE");

      const claim = await tx.ledgerIdempotencyStore.claim(ledgerKey);
      assert.equal(claim.kind, "CLAIMED");

      const entry = {
        id: entryId,
        walletId,
        type: "DEBIT" as const,
        amount: money("12.3456789", "BRL"),
        referenceType: "HOLD",
        referenceId: holdId,
        idempotencyKey: ledgerKey,
        createdAt: new Date("2026-09-08T00:00:00.000Z"),
      };
      await tx.ledgerRepository.append(entry);
      await tx.ledgerIdempotencyStore.complete(claim, entry);
      await tx.holdRepository.save({ ...hold, status: "CAPTURED" });
      return entry.id;
    });

    assert.equal(firstResult, entryId);
    assert.equal(transactionCalls, 1);
    assert.deepEqual(new Set(delegateAccesses), new Set(["walletHold", "ledgerEntry", "idempotencyRecord"]));

    const [persistedHold, ledgerEntries, persistedClaim] = await Promise.all([
      prisma.walletHold.findUnique({ where: { id: holdId } }),
      prisma.ledgerEntry.findMany({ where: { idempotencyKey: ledgerKey } }),
      prisma.idempotencyRecord.findUnique({
        where: { scope_key: { scope: "LEDGER", key: ledgerKey } },
        include: { ledgerEntry: true },
      }),
    ]);
    assert.equal(persistedHold?.status, "CAPTURED");
    assert.equal(ledgerEntries.length, 1);
    assert.equal(ledgerEntries[0]?.id, entryId);
    assert.equal(persistedClaim?.status, "COMPLETED");
    assert.equal(persistedClaim?.ledgerEntryId, entryId);

    const secondClaim = await manager.run((tx) => tx.ledgerIdempotencyStore.claim(ledgerKey));
    assert.equal(secondClaim.kind, "COMPLETED");
    if (secondClaim.kind === "COMPLETED") {
      assert.equal(secondClaim.entry.id, entryId);
      assert.equal(secondClaim.entry.amount.amount.toString(), "12.3456789");
      assert.equal(secondClaim.entry.amount.currency, "BRL");
    }
    assert.equal(transactionCalls, 2);
    assert.equal(await prisma.ledgerEntry.count({ where: { idempotencyKey: ledgerKey } }), 1);
    assert.equal(await prisma.idempotencyRecord.count({ where: { scope: "LEDGER", key: ledgerKey } }), 1);
  } finally {
    await prisma.idempotencyRecord.deleteMany({ where: { scope: "LEDGER", key: ledgerKey } });
    await prisma.ledgerEntry.deleteMany({ where: { id: entryId } });
    await prisma.walletHold.deleteMany({ where: { id: holdId } });
    await prisma.wallet.deleteMany({ where: { id: walletId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  }
});
