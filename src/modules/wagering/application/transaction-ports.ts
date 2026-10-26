import type { WagerTransaction } from "../domain/transactions/wager-transaction.ts";
import type { Wallet } from "../domain/wallet/wallet.ts";
import type { WalletRepositoryPort } from "./wallet-ports.ts";
export interface TransactionRepositoryPort extends WalletRepositoryPort {
  findByKey(key: string): Promise<WagerTransaction | undefined>;
  findTransaction(id: string): Promise<WagerTransaction | undefined>;
  findExternal(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined>;
  lockWallet(id: string): Promise<Wallet | undefined>;
  hasProcessedReversal(referenceId: string): Promise<boolean>;
  claim(transaction: WagerTransaction): Promise<boolean>;
  saveTransaction(transaction: WagerTransaction): Promise<void>;
  saveWallet(wallet: Wallet): Promise<void>;
}
export interface TransactionUnitOfWork {
  execute<T>(
    operation: (repository: TransactionRepositoryPort) => Promise<T>,
  ): Promise<T>;
}
