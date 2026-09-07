import {
  createPrismaCaptureTransactionResources,
  type PrismaCaptureTransactionClient,
  type PrismaCaptureTransactionResources,
} from "./capture-transaction-resources.ts";

/** The smallest transaction-host surface needed by the capture boundary. */
export interface PrismaCaptureTransactionRunner {
  $transaction<T>(
    operation: (tx: PrismaCaptureTransactionClient) => Promise<T>,
  ): Promise<T>;
}

/**
 * Runs the narrow capture resource bundle in one host-provided Prisma transaction.
 * It intentionally does not construct a PrismaClient or own application composition.
 */
export class PrismaCaptureTransactionManager {
  private readonly transactionRunner: PrismaCaptureTransactionRunner;

  constructor(transactionRunner: PrismaCaptureTransactionRunner) {
    this.transactionRunner = transactionRunner;
  }

  async run<T>(
    operation: (tx: PrismaCaptureTransactionResources) => Promise<T>,
  ): Promise<T> {
    return this.transactionRunner.$transaction(async (tx) =>
      operation(createPrismaCaptureTransactionResources(tx)));
  }
}
