-- Preserve the domain Hold lifecycle without equating capture to consumption.
ALTER TYPE "ReservationStatus" ADD VALUE 'CAPTURED';

-- Supports HoldRepository.listActiveByWallet(walletId).
CREATE INDEX "WalletHold_walletId_status_idx" ON "WalletHold"("walletId", "status");
