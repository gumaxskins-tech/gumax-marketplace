import assert from "node:assert/strict";
import test from "node:test";
import { money } from "../../pricing/src/index.ts";
import {
  createPrismaCaptureTransactionResources,
  type PrismaCaptureTransactionClient,
} from "../src/capture-transaction-resources.ts";
import { PrismaHoldRepository } from "../src/hold-repository.ts";
import { PrismaLedgerRepository } from "../src/ledger-repository.ts";
import { PrismaLedgerIdempotencyStore } from "../src/ledger-idempotency-store.ts";

const transactionLikeClient = (operations: string[]): PrismaCaptureTransactionClient => ({
  walletHold: {
    async findUnique() { operations.push("hold.findUnique"); return null; },
    async findMany() { operations.push("hold.findMany"); return []; },
    async upsert({ create }) {
      operations.push("hold.upsert");
      return { ...create, amount: { toString: () => create.amount }, createdAt: new Date("2026-09-06T00:00:00.000Z") };
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

test("capture transaction factory returns only the three capture adapters", () => {
  const resources = createPrismaCaptureTransactionResources(transactionLikeClient([]));

  assert.ok(resources.holdRepository instanceof PrismaHoldRepository);
  assert.ok(resources.ledgerRepository instanceof PrismaLedgerRepository);
  assert.ok(resources.ledgerIdempotencyStore instanceof PrismaLedgerIdempotencyStore);
  assert.deepEqual(Object.keys(resources).sort(), ["holdRepository", "ledgerIdempotencyStore", "ledgerRepository"]);
});

test("capture transaction factory injects one transaction-like client into every adapter", async () => {
  const operations: string[] = [];
  const client = transactionLikeClient(operations);
  assert.equal("$transaction" in client, false);
  assert.equal("$connect" in client, false);
  assert.equal("$disconnect" in client, false);
  const resources = createPrismaCaptureTransactionResources(client);

  await resources.holdRepository.save({
    id: "hold-1", walletId: "wallet-1", amount: money("5", "BRL"),
    status: "CAPTURED", idempotencyKey: "hold-key",
  });
  await resources.ledgerRepository.append({
    id: "entry-1", walletId: "wallet-1", type: "PURCHASE", amount: money("5", "BRL"),
    referenceType: "HOLD", referenceId: "hold-1", idempotencyKey: "ledger-key",
    createdAt: new Date("2026-09-06T00:00:00.000Z"),
  });
  await resources.ledgerIdempotencyStore.claim("ledger-key");

  assert.deepEqual(operations, ["hold.upsert", "ledger.create", "idempotency.createMany"]);
});

test("errors from a composed client propagate through its adapter", async () => {
  const client = transactionLikeClient([]);
  client.ledgerEntry.create = async () => { throw Error("transaction client unavailable"); };
  const resources = createPrismaCaptureTransactionResources(client);

  await assert.rejects(
    resources.ledgerRepository.append({
      id: "entry-1", walletId: "wallet-1", type: "PURCHASE", amount: money("5", "BRL"),
      referenceType: "HOLD", referenceId: "hold-1", idempotencyKey: "ledger-key",
      createdAt: new Date("2026-09-06T00:00:00.000Z"),
    }),
    /transaction client unavailable/,
  );
});
