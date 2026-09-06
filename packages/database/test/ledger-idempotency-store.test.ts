import assert from "node:assert/strict";
import test from "node:test";
import {
  PrismaLedgerIdempotencyStore,
  type LedgerIdempotencyPrismaClient,
  type LedgerIdempotencyPrismaRecord,
} from "../src/ledger-idempotency-store.ts";
import { money } from "../../pricing/src/index.ts";

const entry = (id = "entry-a") => ({
  id,
  walletId: "wallet-1",
  type: "CREDIT",
  amount: money("12.34567890", "BRL"),
  referenceType: "TEST",
  referenceId: "reference-1",
  idempotencyKey: "key-1",
  createdAt: new Date("2026-09-06T00:00:00.000Z"),
  metadata: Object.freeze({ source: "test" }),
});

const row = (id = "entry-a") => ({
  id,
  walletId: "wallet-1",
  type: "CREDIT",
  amount: { toString: () => "12.34567890" },
  currency: "BRL",
  idempotencyKey: "key-1",
  referenceType: "TEST",
  referenceId: "reference-1",
  metadata: { source: "test" },
  createdAt: new Date("2026-09-06T00:00:00.000Z"),
});

const record = (status: string, ledgerEntry = null): LedgerIdempotencyPrismaRecord => ({
  id: "claim-1",
  status,
  ledgerEntry,
});

const client = (overrides: Partial<LedgerIdempotencyPrismaClient["idempotencyRecord"]> = {}) => {
  const calls: { createMany: unknown[]; findUnique: unknown[]; updateMany: unknown[] } = {
    createMany: [], findUnique: [], updateMany: [],
  };
  const idempotencyRecord = {
    async createMany(args: unknown) { calls.createMany.push(args); return { count: 1 }; },
    async findUnique(args: unknown) { calls.findUnique.push(args); return null; },
    async updateMany(args: unknown) { calls.updateMany.push(args); return { count: 1 }; },
    ...overrides,
  } as LedgerIdempotencyPrismaClient["idempotencyRecord"];
  return { client: { idempotencyRecord }, calls };
};

test("claim uses createMany skipDuplicates and returns CLAIMED for the winner", async () => {
  const fake = client();
  const claim = await new PrismaLedgerIdempotencyStore(fake.client).claim("key-1");

  assert.equal(claim.kind, "CLAIMED");
  assert.equal(claim.key, "key-1");
  assert.equal(fake.calls.findUnique.length, 0);
  assert.deepEqual(fake.calls.createMany[0], {
    data: {
      id: claim.claimId,
      scope: "LEDGER",
      key: "key-1",
      entityId: null,
      ledgerEntryId: null,
      status: "PENDING",
    },
    skipDuplicates: true,
  });
});

test("claim returns the losslessly mapped original entry when already completed", async () => {
  const fake = client({
    async createMany() { return { count: 0 }; },
    async findUnique() { return record("COMPLETED", row()); },
  });
  const claim = await new PrismaLedgerIdempotencyStore(fake.client).claim("key-1");

  assert.equal(claim.kind, "COMPLETED");
  if (claim.kind !== "COMPLETED") throw new Error("expected completed claim");
  assert.equal(claim.entry.amount.amount.toString(), "12.3456789");
  assert.equal(claim.entry.amount.currency, "BRL");
  assert.equal(claim.entry.type, "CREDIT");
  assert.deepEqual(claim.entry.metadata, { source: "test" });
});

test("claim returns IN_PROGRESS for an existing pending claim", async () => {
  const fake = client({
    async createMany() { return { count: 0 }; },
    async findUnique() { return record("PENDING"); },
  });
  const claim = await new PrismaLedgerIdempotencyStore(fake.client).claim("key-1");

  assert.deepEqual(claim, { kind: "IN_PROGRESS", key: "key-1", claimId: "claim-1" });
});

test("complete conditionally links an existing LedgerEntry without appending", async () => {
  const fake = client();
  const store = new PrismaLedgerIdempotencyStore(fake.client);
  const claim = { kind: "CLAIMED" as const, key: "key-1", claimId: "claim-1" };

  const completed = await store.complete(claim, entry());

  assert.equal(completed.id, "entry-a");
  assert.deepEqual(fake.calls.updateMany[0], {
    where: {
      id: "claim-1", scope: "LEDGER", key: "key-1", status: "PENDING", ledgerEntryId: null,
    },
    data: { status: "COMPLETED", ledgerEntryId: "entry-a", entityId: null },
  });
});

test("complete is idempotent only for the original LedgerEntry and rejects missing or conflicting claims", async () => {
  const original = row();
  const same = client({
    async updateMany() { return { count: 0 }; },
    async findUnique() { return record("COMPLETED", original); },
  });
  const store = new PrismaLedgerIdempotencyStore(same.client);
  const claim = { kind: "CLAIMED" as const, key: "key-1", claimId: "claim-1" };
  assert.equal((await store.complete(claim, entry())).id, "entry-a");

  await assert.rejects(() => store.complete(claim, entry("entry-b")), /result mismatch/);

  const missing = client({
    async updateMany() { return { count: 0 }; },
    async findUnique() { return null; },
  });
  await assert.rejects(
    () => new PrismaLedgerIdempotencyStore(missing.client).complete(claim, entry()),
    /claim is missing/,
  );
});

test("transaction-like client and Prisma read/write errors propagate without a local fallback", async () => {
  const txLike = client();
  assert.equal((await new PrismaLedgerIdempotencyStore(txLike.client).claim("key-1")).kind, "CLAIMED");
  assert.equal("$transaction" in txLike.client, false);
  assert.equal("$connect" in txLike.client, false);
  assert.equal("$disconnect" in txLike.client, false);

  const readError = new Error("read failed");
  const read = client({
    async createMany() { return { count: 0 }; },
    async findUnique() { throw readError; },
  });
  await assert.rejects(() => new PrismaLedgerIdempotencyStore(read.client).claim("key-1"), readError);

  const writeError = new Error("write failed");
  const write = client({ async createMany() { throw writeError; } });
  await assert.rejects(() => new PrismaLedgerIdempotencyStore(write.client).claim("key-1"), writeError);

  const completeError = new Error("complete failed");
  const complete = client({ async updateMany() { throw completeError; } });
  await assert.rejects(
    () => new PrismaLedgerIdempotencyStore(complete.client).complete(
      { kind: "CLAIMED", key: "key-1", claimId: "claim-1" }, entry(),
    ),
    completeError,
  );
});
