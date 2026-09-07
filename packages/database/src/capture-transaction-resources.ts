import {
  PrismaHoldRepository,
  type HoldPrismaClient,
} from "./hold-repository.ts";
import {
  PrismaLedgerRepository,
  type LedgerPrismaClient,
} from "./ledger-repository.ts";
import {
  PrismaLedgerIdempotencyStore,
  type LedgerIdempotencyPrismaClient,
} from "./ledger-idempotency-store.ts";

export type PrismaCaptureTransactionClient =
  & HoldPrismaClient
  & LedgerPrismaClient
  & LedgerIdempotencyPrismaClient;

export interface PrismaCaptureTransactionResources {
  holdRepository: PrismaHoldRepository;
  ledgerRepository: PrismaLedgerRepository;
  ledgerIdempotencyStore: PrismaLedgerIdempotencyStore;
}

export const createPrismaCaptureTransactionResources = (
  client: PrismaCaptureTransactionClient,
): PrismaCaptureTransactionResources => ({
  holdRepository: new PrismaHoldRepository(client),
  ledgerRepository: new PrismaLedgerRepository(client),
  ledgerIdempotencyStore: new PrismaLedgerIdempotencyStore(client),
});
