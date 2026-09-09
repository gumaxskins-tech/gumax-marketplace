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

const createBarrier = (participants: number) => {
  let arrived = 0;
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });

  return {
    async wait(): Promise<void> {
      arrived += 1;
      if (arrived === participants) release();
      await released;
    },
  };
};

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
    // Ledger claims and entries are immutable financial records. UUID-scoped
    // fixtures intentionally remain in the disposable integration database.
    await prisma.$disconnect();
  }
});

test("POSTGRESQL INTEGRATION: capture resources rollback together on deliberate failure", async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const suffix = randomUUID();
  const userId = `rollback-user-${suffix}`;
  const walletId = `rollback-wallet-${suffix}`;
  const holdId = `rollback-hold-${suffix}`;
  const entryId = `rollback-entry-${suffix}`;
  const ledgerKey = `rollback-ledger-${suffix}`;
  let transactionCalls = 0;
  const delegateAccesses: string[] = [];
  const rollbackProbe = new Error("ROLLBACK_PROBE");
  const retryAbort = new Error("ROLLBACK_RETRY_PROBE");

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
        amount: "9.87654321",
        currency: "BRL",
        status: "ACTIVE",
        idempotencyKey: `rollback-hold-key-${suffix}`,
      },
    });

    await assert.rejects(
      manager.run(async (tx) => {
        const hold = await tx.holdRepository.getById(holdId);
        assert.ok(hold);
        assert.equal(hold.status, "ACTIVE");

        const claim = await tx.ledgerIdempotencyStore.claim(ledgerKey);
        assert.equal(claim.kind, "CLAIMED");
        const entry = {
          id: entryId,
          walletId,
          type: "DEBIT" as const,
          amount: money("9.87654321", "BRL"),
          referenceType: "HOLD",
          referenceId: holdId,
          idempotencyKey: ledgerKey,
          createdAt: new Date("2026-09-09T00:00:00.000Z"),
        };
        await tx.ledgerRepository.append(entry);
        await tx.ledgerIdempotencyStore.complete(claim, entry);
        await tx.holdRepository.save({ ...hold, status: "CAPTURED" });
        throw rollbackProbe;
      }),
      (received) => received === rollbackProbe,
    );

    assert.equal(transactionCalls, 1);
    assert.deepEqual(new Set(delegateAccesses), new Set(["walletHold", "ledgerEntry", "idempotencyRecord"]));

    const [persistedHold, ledgerEntryCount, claimCount] = await Promise.all([
      prisma.walletHold.findUnique({ where: { id: holdId } }),
      prisma.ledgerEntry.count({ where: { idempotencyKey: ledgerKey } }),
      prisma.idempotencyRecord.count({ where: { scope: "LEDGER", key: ledgerKey } }),
    ]);
    assert.equal(persistedHold?.status, "ACTIVE");
    assert.equal(ledgerEntryCount, 0);
    assert.equal(claimCount, 0);

    await assert.rejects(
      manager.run(async (tx) => {
        const retryClaim = await tx.ledgerIdempotencyStore.claim(ledgerKey);
        assert.equal(retryClaim.kind, "CLAIMED");
        throw retryAbort;
      }),
      (received) => received === retryAbort,
    );
  } finally {
    // UUID-scoped fixtures remain in the disposable database. No immutable
    // ledger entry or idempotency record can be deleted by this harness.
    await prisma.$disconnect();
  }
});

test("POSTGRESQL INTEGRATION: same ledger idempotency key converges under concurrent transactions", async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const suffix = randomUUID();
  const userId = `concurrency-user-${suffix}`;
  const walletId = `concurrency-wallet-${suffix}`;
  const sameKey = `concurrency-same-key-${suffix}`;
  const sameReferenceId = `concurrency-reference-${suffix}`;
  const sameEntryIds = [`concurrency-entry-a-${suffix}`, `concurrency-entry-b-${suffix}`] as const;
  const differentKeys = [`concurrency-different-a-${suffix}`, `concurrency-different-b-${suffix}`] as const;
  let transactionCalls = 0;

  const runner: PrismaCaptureTransactionRunner = {
    async $transaction(operation) {
      transactionCalls += 1;
      return prisma.$transaction((realTx) => operation(realTx as PrismaCaptureTransactionClient));
    },
  };
  const manager = new PrismaCaptureTransactionManager(runner);

  const post = async (
    key: string,
    entryId: string,
    referenceId: string,
    barrier: ReturnType<typeof createBarrier>,
  ): Promise<string> => manager.run(async (tx) => {
    await barrier.wait();
    const claim = await tx.ledgerIdempotencyStore.claim(key);
    if (claim.kind === "COMPLETED") return claim.entry.id;
    assert.equal(claim.kind, "CLAIMED");
    const entry = {
      id: entryId,
      walletId,
      type: "DEBIT" as const,
      amount: money("7.00000001", "BRL"),
      referenceType: "CONCURRENCY_PROBE",
      referenceId,
      idempotencyKey: key,
      createdAt: new Date("2026-09-09T00:00:00.000Z"),
    };
    await tx.ledgerRepository.append(entry);
    return (await tx.ledgerIdempotencyStore.complete(claim, entry)).id;
  });

  try {
    await prisma.user.create({ data: { id: userId, email: `${userId}@example.test` } });
    await prisma.wallet.create({ data: { id: walletId, userId, currency: "BRL" } });

    const sameKeyBarrier = createBarrier(2);
    const sameKeyResults = await Promise.allSettled([
      post(sameKey, sameEntryIds[0], sameReferenceId, sameKeyBarrier),
      post(sameKey, sameEntryIds[1], sameReferenceId, sameKeyBarrier),
    ]);
    const sameKeyResultIds = sameKeyResults.map((result) => {
      if (result.status === "rejected") throw result.reason;
      return result.value;
    });
    assert.equal(transactionCalls, 2);
    assert.equal(new Set(sameKeyResultIds).size, 1);

    const [sameClaim, sameEntryCount] = await Promise.all([
      prisma.idempotencyRecord.findUnique({
        where: { scope_key: { scope: "LEDGER", key: sameKey } },
        include: { ledgerEntry: true },
      }),
      prisma.ledgerEntry.count({ where: { idempotencyKey: sameKey } }),
    ]);
    assert.equal(sameClaim?.status, "COMPLETED");
    assert.ok(sameClaim?.ledgerEntryId);
    assert.equal(sameEntryCount, 1);
    assert.equal(sameClaim?.ledgerEntryId, sameKeyResultIds[0]);

    const thirdClaim = await manager.run((tx) => tx.ledgerIdempotencyStore.claim(sameKey));
    assert.equal(thirdClaim.kind, "COMPLETED");
    if (thirdClaim.kind === "COMPLETED") {
      assert.equal(thirdClaim.entry.id, sameClaim?.ledgerEntryId);
    }

    const differentKeyBarrier = createBarrier(2);
    const differentKeyResults = await Promise.allSettled([
      post(differentKeys[0], `concurrency-different-entry-a-${suffix}`, `concurrency-different-reference-a-${suffix}`, differentKeyBarrier),
      post(differentKeys[1], `concurrency-different-entry-b-${suffix}`, `concurrency-different-reference-b-${suffix}`, differentKeyBarrier),
    ]);
    for (const result of differentKeyResults) {
      if (result.status === "rejected") throw result.reason;
    }
    const [differentClaims, differentEntryCount] = await Promise.all([
      prisma.idempotencyRecord.findMany({ where: { scope: "LEDGER", key: { in: [...differentKeys] } } }),
      prisma.ledgerEntry.count({ where: { idempotencyKey: { in: [...differentKeys] } } }),
    ]);
    assert.equal(differentClaims.length, 2);
    assert.equal(differentClaims.filter((claim) => claim.status === "COMPLETED" && claim.ledgerEntryId).length, 2);
    assert.equal(differentEntryCount, 2);
  } finally {
    // UUID-scoped financial artifacts are retained in the disposable database.
    await prisma.$disconnect();
  }
});
