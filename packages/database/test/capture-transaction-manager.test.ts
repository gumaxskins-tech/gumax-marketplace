import assert from "node:assert/strict";
import test from "node:test";
import { money } from "../../pricing/src/index.ts";
import {
  PrismaCaptureTransactionManager,
  type PrismaCaptureTransactionRunner,
} from "../src/capture-transaction-manager.ts";
import type { PrismaCaptureTransactionClient } from "../src/capture-transaction-resources.ts";
import { PrismaHoldRepository } from "../src/hold-repository.ts";
import { PrismaLedgerRepository } from "../src/ledger-repository.ts";
import { PrismaLedgerIdempotencyStore } from "../src/ledger-idempotency-store.ts";

const transactionLikeClient = (operations: string[]): PrismaCaptureTransactionClient => ({
  walletHold: {
    async findUnique() { operations.push("hold.findUnique"); return null; },
    async findMany() { operations.push("hold.findMany"); return []; },
    async upsert({ create }) {
      operations.push("hold.upsert");
      return { ...create, amount: { toString: () => create.amount }, createdAt: new Date("2026-09-07T00:00:00.000Z") };
    },
    async count() { operations.push("hold.count"); return 0; },
  },
  ledgerEntry: {
    async create({ data }) {
      operations.push("ledger.create");
      return { ...data, amount: { toString: () => data.amount } };
    },
    async findMany() { operations.push("ledger.findMany"); return []; },
  },
  idempotencyRecord: {
    async createMany() { operations.push("idempotency.createMany"); return { count: 1 }; },
    async findUnique() { operations.push("idempotency.findUnique"); return null; },
    async updateMany() { operations.push("idempotency.updateMany"); return { count: 1 }; },
  },
});

const transactionRunner = (
  tx: PrismaCaptureTransactionClient,
  calls: string[],
): PrismaCaptureTransactionRunner => ({
  async $transaction(operation) {
    calls.push("$transaction");
    return operation(tx);
  },
});

test("manager opens one transaction and returns its operation result", async () => {
  const tx = transactionLikeClient([]);
  const calls: string[] = [];
  const manager = new PrismaCaptureTransactionManager(transactionRunner(tx, calls));

  const result = await manager.run(async (resources) => {
    assert.ok(resources.holdRepository instanceof PrismaHoldRepository);
    assert.ok(resources.ledgerRepository instanceof PrismaLedgerRepository);
    assert.ok(resources.ledgerIdempotencyStore instanceof PrismaLedgerIdempotencyStore);
    return "capture-result";
  });

  assert.equal(result, "capture-result");
  assert.deepEqual(calls, ["$transaction"]);
});

test("manager injects the same minimal transaction client into every capture adapter", async () => {
  const operations: string[] = [];
  const tx = transactionLikeClient(operations);
  const manager = new PrismaCaptureTransactionManager(transactionRunner(tx, operations));
  assert.equal("$transaction" in tx, false);
  assert.equal("$connect" in tx, false);
  assert.equal("$disconnect" in tx, false);

  await manager.run(async (resources) => {
    await resources.holdRepository.save({
      id: "hold-1", walletId: "wallet-1", amount: money("5", "BRL"),
      status: "CAPTURED", idempotencyKey: "hold-key",
    });
    await resources.ledgerRepository.append({
      id: "entry-1", walletId: "wallet-1", type: "PURCHASE", amount: money("5", "BRL"),
      referenceType: "HOLD", referenceId: "hold-1", idempotencyKey: "ledger-key",
      createdAt: new Date("2026-09-07T00:00:00.000Z"),
    });
    await resources.ledgerIdempotencyStore.claim("ledger-key");
  });

  assert.deepEqual(operations, ["$transaction", "hold.upsert", "ledger.create", "idempotency.createMany"]);
});

test("manager propagates an operation error through the transaction host", async () => {
  const manager = new PrismaCaptureTransactionManager(transactionRunner(transactionLikeClient([]), []));
  const error = new Error("capture callback failed");

  await assert.rejects(manager.run(async () => { throw error; }), (received) => received === error);
});

test("manager propagates a transaction host error without running the operation", async () => {
  const error = new Error("transaction host failed");
  const manager = new PrismaCaptureTransactionManager({
    async $transaction() { throw error; },
  });
  let operationRan = false;

  await assert.rejects(
    manager.run(async () => { operationRan = true; return "unexpected"; }),
    (received) => received === error,
  );
  assert.equal(operationRan, false);
});
