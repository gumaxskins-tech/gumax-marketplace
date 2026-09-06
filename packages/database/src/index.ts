import { PrismaClient, Prisma } from "@prisma/client";
export { PrismaWalletRepository, type WalletPrismaClient, type WalletPrismaDelegate, type WalletPrismaWallet, type WalletPrismaWalletUpdate } from "./wallet-repository.ts";
export { PrismaClient, Prisma };
let client: PrismaClient | undefined;
export const getPrisma = (): PrismaClient => (client ??= new PrismaClient());
export const disconnectPrisma = async (): Promise<void> => { if (client) { await client.$disconnect(); client = undefined; } };
export const withTransaction = async <T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> => getPrisma().$transaction(work);
