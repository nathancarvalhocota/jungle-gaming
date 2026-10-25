import type { Wallet } from "../domain/wallet/wallet.ts";

export interface WalletRepositoryPort {
  create(wallet: Wallet): Promise<void>;
  findById(id: string): Promise<Wallet | undefined>;
}

export interface WalletUnitOfWork {
  execute<T>(
    operation: (repository: WalletRepositoryPort) => Promise<T>,
  ): Promise<T>;
}
