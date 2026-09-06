export type WalletCurrency = "BRL" | "CNY" | "USD";

export interface WalletPrismaWallet {
  id: string;
  userId: string;
  currency: WalletCurrency;
}

export interface WalletPrismaWalletUpdate {
  userId: string;
  currency: WalletCurrency;
}

export interface WalletPrismaDelegate {
  findUnique(args: { where: { id: string } }): Promise<WalletPrismaWallet | null>;
  upsert(args: {
    where: { id: string };
    create: WalletPrismaWallet;
    update: WalletPrismaWalletUpdate;
  }): Promise<WalletPrismaWallet>;
}

export interface WalletPrismaClient {
  wallet: WalletPrismaDelegate;
}

const toDomainWallet = (wallet: WalletPrismaWallet): WalletPrismaWallet => ({
  id: wallet.id,
  userId: wallet.userId,
  currency: wallet.currency,
});
export class PrismaWalletRepository {
  private readonly prisma: WalletPrismaClient;

  constructor(prisma: WalletPrismaClient) {
    this.prisma = prisma;
  }

  async getById(walletId: string): Promise<WalletPrismaWallet | undefined> {
    const wallet = await this.prisma.wallet.findUnique({ where: { id: walletId } });
    return wallet ? toDomainWallet(wallet) : undefined;
  }

  async save(wallet: WalletPrismaWallet): Promise<WalletPrismaWallet> {
    return toDomainWallet(await this.prisma.wallet.upsert({
      where: { id: wallet.id },
      create: toDomainWallet(wallet),
      update: { userId: wallet.userId, currency: wallet.currency },
    }));
  }
}
